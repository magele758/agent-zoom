import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ChatApi } from "../mcp.ts";
import { createMcpServer } from "../mcp.ts";
import { ApiError, type Principal, type Store } from "./logic.ts";
import { waitInbox } from "./wait.ts";

const COOKIE = "ac_session";

type Watcher = { userId: string; rooms: Set<string>; send: (data: string) => void };

export function createApp(store: Store) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const watchers = new Set<Watcher>();
  const onlineUsers = new Map<string, number>();

  const nudge = (roomId: string) => {
    const payload = JSON.stringify({ type: "nudge", roomId });
    for (const watcher of watchers) {
      if (watcher.rooms.has(roomId)) watcher.send(payload);
    }
  };

  const online = () => new Set(onlineUsers.keys());

  const requireUser = (cookie: string | undefined) => {
    const principal = store.userBySession(cookie);
    if (!principal || principal.type !== "user") throw new ApiError(401, "auth", "先进入工作室");
    return principal;
  };

  const requireAgent = (header: string | undefined) => {
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const principal = store.agentByToken(token);
    if (!principal || principal.type !== "agent") throw new ApiError(401, "auth", "agent token 无效");
    return principal;
  };

  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: "bad_json", message: "请求体不是合法 JSON" }, 400);
    if (error instanceof ApiError) return c.json({ error: error.code, message: error.message }, error.status as 400);
    console.error(error);
    return c.json({ error: "internal", message: "服务出错了" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/session", async (c) => {
    const body = await c.req.json();
    const result = store.session(String(body.name ?? ""));
    setCookie(c, COOKIE, result.token, { httpOnly: true, path: "/", sameSite: "Lax" });
    return c.json({ user: result.user, orgId: result.orgId, roomId: result.roomId });
  });

  app.post("/api/logout", (c) => {
    store.logout(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => c.json(store.me(requireUser(getCookie(c, COOKIE)))));

  app.get("/api/rooms", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json({ rooms: store.listRooms(user.id) });
  });

  app.post("/api/rooms", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(
      store.createRoom(user, String(body.name ?? ""), String(body.topic ?? ""), {
        project: body.project,
        directories: body.directories,
        branch: body.branch,
      }),
    );
  });

  app.patch("/api/rooms/:id", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(
      store.setScope(user, c.req.param("id"), {
        project: body.project,
        directories: body.directories,
        branch: body.branch,
      }),
    );
  });

  app.get("/api/rooms/:id", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.snapshot(user, c.req.param("id"), online()));
  });

  app.post("/api/rooms/:id/messages", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(
      store.postMessage(user, c.req.param("id"), {
        body: String(body.body ?? ""),
        kind: body.kind ? String(body.kind) : "chat",
        taskId: body.taskId ? String(body.taskId) : null,
        acceptance: body.acceptance ? String(body.acceptance) : undefined,
        parallel: Boolean(body.parallel),
        tags: body.tags ? String(body.tags) : undefined,
        complex: Boolean(body.complex),
      }),
    );
  });

  app.post("/api/rooms/:id/members", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(store.invite(user, c.req.param("id"), String(body.name ?? "")));
  });

  app.post("/api/rooms/:id/join-codes", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.createJoinCode(user, c.req.param("id")));
  });

  app.post("/api/enroll", async (c) => {
    const body = await c.req.json();
    return c.json(
      store.enroll(
        String(body.code ?? ""),
        String(body.handle ?? ""),
        String(body.runtime ?? "custom"),
        body.tags ? String(body.tags) : "",
        body.level,
        body.machine ? String(body.machine) : "",
        body.cwd ? String(body.cwd) : "",
      ),
    );
  });

  app.patch("/api/agents/:id", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    const id = c.req.param("id");
    let result: { id: string; paused?: boolean; level?: number } = { id };
    if (body.level !== undefined) result = { ...result, ...store.setLevel(user, id, body.level as number | string) };
    if (body.paused !== undefined) result = { ...result, ...store.setPaused(user, id, Boolean(body.paused)) };
    return c.json(result);
  });

  app.patch("/api/agents/:id/level", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(store.setLevel(user, c.req.param("id"), body.level));
  });

  app.post("/api/tasks/:id/cancel", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.cancel(user, c.req.param("id")));
  });

  app.post("/api/tasks/:id/done", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.forceDone(user, c.req.param("id")));
  });

  app.get("/api/wait", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const after = Number(c.req.query("after") ?? 0);
    const timeoutMs = Number(c.req.query("timeoutMs") ?? 20_000);
    const events = await waitInbox(store, agent.id, Number.isFinite(after) ? after : 0, timeoutMs);
    return c.json({ events });
  });

  app.get("/api/inbox/pending", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    return c.json({ events: store.takePending(agent.id) });
  });

  app.get("/api/agent/me", (c) => c.json(store.whoami(requireAgent(c.req.header("authorization")))));

  app.post("/api/agent/place", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.setPlace(agent, body.machine, body.cwd));
  });

  app.get("/api/agent/rooms/:id/messages", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const after = Number(c.req.query("afterSeq") ?? 0);
    return c.json({ messages: store.readMessages(agent, c.req.param("id"), after) });
  });

  app.get("/api/agent/rooms/:id/tasks", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    return c.json({ tasks: store.listTasks(agent, c.req.param("id")) });
  });

  app.post("/api/agent/rooms/:id/messages", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(
      store.postMessage(agent, c.req.param("id"), {
        body: String(body.body ?? ""),
        kind: body.kind ? String(body.kind) : "chat",
        taskId: body.taskId ? String(body.taskId) : null,
      }),
    );
  });

  app.post("/api/agent/tasks/:id/claim", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.claim(agent, c.req.param("id"), body.role));
  });

  app.post("/api/agent/tasks/:id/heartbeat", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    return c.json(store.heartbeat(agent, c.req.param("id")));
  });

  app.post("/api/agent/tasks/:id/ready", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    return c.json(store.markReady(agent, c.req.param("id")));
  });

  app.get("/api/agent/tasks/:id", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    return c.json(store.getTask(agent, c.req.param("id")));
  });

  app.post("/api/agent/tasks/:id/bid", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.bid(agent, c.req.param("id"), String(body.approach ?? "")));
  });

  app.post("/api/agent/tasks/:id/deliver", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.deliver(agent, c.req.param("id"), String(body.ref ?? ""), String(body.summary ?? "")));
  });

  app.post("/api/agent/tasks/:id/review", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.review(agent, c.req.param("id"), String(body.verdict ?? ""), String(body.body ?? "")));
  });

  app.post("/api/agent/tasks/:id/test", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.reportTest(agent, c.req.param("id"), String(body.verdict ?? ""), String(body.body ?? "")));
  });

  app.post("/api/agent/tasks/:id/release", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.release(agent, c.req.param("id"), body.role));
  });

  app.post("/api/agent/locks", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.lockFile(agent, String(body.path ?? ""), body.taskId ? String(body.taskId) : null));
  });

  app.delete("/api/agent/locks", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.unlockFile(agent, String(body.path ?? "")));
  });

  app.all("/mcp", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const mcp = createMcpServer(apiFor(store, agent));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      const principal = store.userBySession(getCookie(c, COOKIE));
      const userId = principal?.type === "user" ? principal.id : null;
      const watcher: Watcher = { userId: userId ?? "", rooms: new Set(), send: () => {} };
      return {
        onOpen(_event, ws) {
          watcher.send = (data) => ws.send(data);
          if (userId) {
            onlineUsers.set(userId, (onlineUsers.get(userId) ?? 0) + 1);
            watchers.add(watcher);
          }
        },
        onMessage(event) {
          if (!userId || !principal) return;
          let data: { type?: string; roomId?: string };
          try {
            data = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (data.type === "watch" && data.roomId) {
            try {
              store.snapshot(principal, data.roomId, online());
              watcher.rooms.add(data.roomId);
            } catch {
              /* not a member */
            }
          }
        },
        onClose() {
          watchers.delete(watcher);
          if (!userId) return;
          const next = (onlineUsers.get(userId) ?? 1) - 1;
          if (next <= 0) onlineUsers.delete(userId);
          else onlineUsers.set(userId, next);
        },
      };
    }),
  );

  return { app, injectWebSocket, nudge };
}

function apiFor(store: Store, agent: Principal & { type: "agent" }): ChatApi {
  return {
    whoami: async () => store.whoami(agent),
    listRooms: async () => store.whoami(agent).rooms,
    read: async (roomId, afterSeq) => store.readMessages(agent, roomId, afterSeq),
    say: async (input) => store.postMessage(agent, input.roomId, input),
    wait: async (after, timeoutMs) => waitInbox(store, agent.id, after, timeoutMs),
    listTasks: async (roomId) => store.listTasks(agent, roomId),
    getTask: async (taskId) => store.getTask(agent, taskId),
    claim: async (taskId, role) => store.claim(agent, taskId, role as "implementer"),
    bid: async (taskId, approach) => store.bid(agent, taskId, approach),
    deliver: async (taskId, ref, summary) => store.deliver(agent, taskId, ref, summary),
    heartbeat: async (taskId) => store.heartbeat(agent, taskId),
    ready: async (taskId) => store.markReady(agent, taskId),
    review: async (taskId, verdict, body) => store.review(agent, taskId, verdict, body),
    test: async (taskId, verdict, body) => store.reportTest(agent, taskId, verdict, body),
    release: async (taskId, role) => store.release(agent, taskId, role as "implementer"),
    lock: async (path, taskId) => store.lockFile(agent, path, taskId),
    unlock: async (path) => store.unlockFile(agent, path),
  };
}
