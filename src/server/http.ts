import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ChatApi } from "../mcp.ts";
import { createMcpServer } from "../mcp.ts";
import { normalizeGroups } from "../groups.ts";
import { connectInstalled, listLocalAgents, LocalAgentError, machineName, serverUrl, savedCredential } from "./local-agents.ts";
import { ApiError, PRESENCE_MS, type Principal, type Store } from "./logic.ts";
import { waitInbox } from "./wait.ts";
import { CoordinatorService, type CoordinatorModel } from "./coordinator.ts";

const COOKIE = "ac_session";

type Watcher = { userId: string; rooms: Set<string>; send: (data: string) => void };

export function createApp(store: Store, options: { coordinatorModel?: () => CoordinatorModel } = {}) {
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
  const coordinator = new CoordinatorService(store, { model: options.coordinatorModel, onChanged: nudge });

  const requireUser = (cookie: string | undefined) => {
    const principal = store.userBySession(cookie);
    if (!principal || principal.type !== "user") throw new ApiError(401, "auth", "先进入工作室");
    return principal;
  };

  const requireAgent = (header: string | undefined) => {
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const principal = store.agentByToken(token);
    if (!principal || principal.type !== "agent") throw new ApiError(401, "auth", "agent token 无效");
    store.touchSeen(principal.id);
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
  app.get("/api/coordinator", c => { requireUser(getCookie(c,COOKIE)); return c.json(coordinator.info()); });
  app.get("/api/rooms/:id/coordination", c => { const user=requireUser(getCookie(c,COOKIE)); return c.json({runs:coordinator.list(user,c.req.param("id"))}); });
  app.post("/api/rooms/:id/coordination", async c => { const user=requireUser(getCookie(c,COOKIE)); const body=await c.req.json(); return c.json(coordinator.start(user,c.req.param("id"),String(body.prompt??"")),202); });
  app.get("/api/coordination/:id", c => c.json(coordinator.get(requireUser(getCookie(c,COOKIE)),c.req.param("id"))));
  app.post("/api/coordination/:id/stop", async c => c.json(await coordinator.stop(requireUser(getCookie(c,COOKIE)),c.req.param("id"))));
  app.post("/api/coordination/:id/apply", c => c.json(coordinator.apply(requireUser(getCookie(c,COOKIE)),c.req.param("id"))));

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
        currentTopic: body.currentTopic,
      }),
    );
  });

  app.patch("/api/rooms/:id", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    const roomId = c.req.param("id");
    if (body.topic !== undefined || body.currentTopic !== undefined) {
      store.setChannelText(user, roomId, { topic: body.topic, currentTopic: body.currentTopic });
    }
    if (body.archived !== undefined) store.setArchived(user, roomId, Boolean(body.archived));
    if (body.project !== undefined || body.directories !== undefined || body.branch !== undefined) {
      store.setScope(user, roomId, {
        project: body.project,
        directories: body.directories,
        branch: body.branch,
      });
    }
    return c.json(store.roomView(user, roomId));
  });

  app.get("/api/rooms/:id", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.snapshot(user, c.req.param("id"), online()));
  });

  app.post("/api/rooms/:id/read", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(store.markRead(user, c.req.param("id"), Number(body.through)));
  });

  app.get("/api/rooms/:id/messages/search", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json({ messages: store.searchMessages(user, c.req.param("id"), c.req.query("q") ?? "") });
  });
  app.post("/api/rooms/:id/conversations", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(store.userConversation(user, c.req.param("id"), String(body.handle ?? "")));
  });
  app.post("/api/rooms/:id/close", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.closeConversation(user, c.req.param("id")));
  });

  app.post("/api/rooms/:id/messages", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(
      store.postMessage(user, c.req.param("id"), {
        body: String(body.body ?? ""),
        kind: body.kind ? String(body.kind) : "chat",
        taskId: body.taskId ? String(body.taskId) : null,
        group: body.group == null ? undefined : String(body.group),
        acceptance: body.acceptance ? String(body.acceptance) : undefined,
        parallel: Boolean(body.parallel),
        tags: body.tags ? String(body.tags) : undefined,
        complex: Boolean(body.complex),
        steps: body.steps,
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

  app.get("/api/rooms/:id/local-agents", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const snap = store.snapshot(user, c.req.param("id"), online());
    const connected = new Set(snap.members.agents.map((agent) => agent.handle));
    const path = process.env.AGENT_CHATROOM_CREDENTIALS ?? "data/credentials.json";
    const credentials = existsSync(path) ? readFileSync(path, "utf8") : null;
    return c.json({ agents: listLocalAgents(connected).map((local) => {
      const saved = savedCredential(credentials, local.handle);
      const principal = saved ? store.agentByToken(saved.token) : null;
      const valid = principal?.type === "agent" && principal.ownerUserId === user.id && principal.handle === local.handle;
      const member = snap.members.agents.find((agent) => agent.handle === local.handle);
      return { ...local, connected: local.connected && valid, credentialValid: valid,
        online: Boolean(member?.online && valid),
        stateNote: saved && !valid ? "本地凭证归属不匹配或已失效；同名登记不代表实际接入。" : !saved ? "本机没有这个句柄的凭证。" : member?.online ? "最近 5 分钟有实际 API 活动，执行能力仍需任务验收。" : "配置与凭证已登记；当前未观察到客户端活动。" };
    }) });
  });

  app.post("/api/rooms/:id/local-agents/:agentId", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const roomId = c.req.param("id");
    let level: unknown = 1;
    let group = "build";
    let replace = false;
    try {
      const body = await c.req.json();
      if (body && typeof body === "object") {
        replace = (body as { replace?: unknown }).replace === true;
        if ("level" in body) level = (body as { level?: unknown }).level;
        if ("group" in body && (body as { group?: unknown }).group != null && String((body as { group?: unknown }).group).trim() !== "") {
          const id = normalizeGroups((body as { group?: unknown }).group);
          if (!id) throw new ApiError(400, "bad_group", "没有这个身份");
          group = id;
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      level = 1;
      group = "build";
    }
    const snap = store.snapshot(user, roomId, online());
    const connected = new Set(snap.members.agents.map((agent) => agent.handle));
    try {
      const result = connectInstalled({
        id: c.req.param("agentId"),
        home: homedir(),
        repo: process.cwd(),
        node: process.execPath,
        url: serverUrl(),
        credPath: process.env.AGENT_CHATROOM_CREDENTIALS ?? "data/credentials.json",
        connected,
        level,
        group,
        ownerId: user.id,
        replace,
        inspectToken: (token) => store.credentialOwner(token),
        enroll: (spec) => {
          const issued = store.createJoinCode(user, roomId);
          const enrolled = store.enroll(
            issued.code,
            spec.handle,
            spec.runtime,
            spec.group,
            spec.level,
            machineName(),
            process.cwd(),
          );
          return { token: enrolled.token, roomId: enrolled.roomId };
        },
        placeExisting: (handle) => {
          store.placeExisting(user, roomId, handle);
        },
      });
      return c.json({ handle: result.handle, already: result.already, path: result.path, note: result.note });
    } catch (error) {
      if (error instanceof LocalAgentError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
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

  app.post("/api/agents/:id/stop", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.stopAgent(user, c.req.param("id")));
  });

  app.patch("/api/agents/:id", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    const id = c.req.param("id");
    let result: { id: string; paused?: boolean; level?: number; group?: string; label?: string } = { id };
    if (body.level !== undefined) result = { ...result, ...store.setLevel(user, id, body.level as number | string) };
    if (body.group !== undefined) result = { ...result, ...store.setGroup(user, id, body.group) };
    if (body.paused !== undefined) result = { ...result, ...store.setPaused(user, id, Boolean(body.paused)) };
    return c.json(result);
  });

  app.patch("/api/agents/:id/level", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(store.setLevel(user, c.req.param("id"), body.level));
  });

  app.patch("/api/agents/:id/group", async (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    const body = await c.req.json();
    return c.json(store.setGroup(user, c.req.param("id"), body.group));
  });

  app.post("/api/tasks/:id/cancel", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.cancel(user, c.req.param("id")));
  });

  app.post("/api/tasks/:id/done", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.forceDone(user, c.req.param("id")));
  });

  app.post("/api/tasks/:id/handoff", (c) => {
    const user = requireUser(getCookie(c, COOKIE));
    return c.json(store.handOffDesign(user, c.req.param("id")));
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

  app.post("/api/agent/ping", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    return c.json({ ok: true, presenceMs: PRESENCE_MS, id: agent.id });
  });

  app.get("/api/agent/me", (c) => c.json(store.whoami(requireAgent(c.req.header("authorization")))));

  app.get("/api/agent/peers", (c) => c.json({ peers: store.listPeers(requireAgent(c.req.header("authorization"))) }));

  app.post("/api/agent/ask", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.ask(agent, { handle: body.handle, handles: body.handles, body: body.body }));
  });

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
        group: body.group == null ? undefined : String(body.group),
      }),
    );
  });

  app.get("/api/agent/rooms/:id/messages/:messageId", (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    return c.json(store.readMessage(agent, c.req.param("id"), c.req.param("messageId")));
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

  app.post("/api/agent/tasks/:id/design", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.submitDesign(agent, c.req.param("id"), String(body.body ?? ""), body.group));
  });

  app.post("/api/agent/tasks/:id/bid", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.bid(agent, c.req.param("id"), String(body.approach ?? "")));
  });

  app.post("/api/agent/tasks/:id/deliver", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(
      store.deliver(agent, c.req.param("id"), String(body.ref ?? ""), String(body.summary ?? ""), {
        body: body.body ? String(body.body) : undefined,
        verdict: body.verdict ? String(body.verdict) : undefined,
        screenshots: body.screenshots,
      }),
    );
  });

  app.post("/api/agent/tasks/:id/conclude", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.conclude(agent, c.req.param("id"), String(body.verdict ?? ""), String(body.body ?? "")));
  });

  app.post("/api/agent/tasks/:id/decline", async (c) => {
    const agent = requireAgent(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(store.decline(agent, c.req.param("id"), body.note ? String(body.note) : ""));
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
    listPeers: async () => store.listPeers(agent),
    ask: async (input) => store.ask(agent, input),
    read: async (roomId, afterSeq) => store.readMessages(agent, roomId, afterSeq),
    say: async (input) => store.postMessage(agent, input.roomId, input),
    wait: async (after, timeoutMs) => waitInbox(store, agent.id, after, timeoutMs),
    listTasks: async (roomId) => store.listTasks(agent, roomId),
    getTask: async (taskId) => store.getTask(agent, taskId),
    submitDesign: async (taskId, body, group) => store.submitDesign(agent, taskId, body, group),
    claim: async (taskId, role) => store.claim(agent, taskId, role as "implementer"),
    bid: async (taskId, approach) => store.bid(agent, taskId, approach),
    deliver: async (taskId, ref, summary, extra) => store.deliver(agent, taskId, ref, summary, extra),
    conclude: async (taskId, verdict, body) => store.conclude(agent, taskId, verdict, body),
    decline: async (taskId, note) => store.decline(agent, taskId, note),
    heartbeat: async (taskId) => store.heartbeat(agent, taskId),
    ready: async (taskId) => store.markReady(agent, taskId),
    review: async (taskId, verdict, body) => store.review(agent, taskId, verdict, body),
    test: async (taskId, verdict, body) => store.reportTest(agent, taskId, verdict, body),
    release: async (taskId, role) => store.release(agent, taskId, role as "implementer"),
    lock: async (path, taskId) => store.lockFile(agent, path, taskId),
    unlock: async (path) => store.unlockFile(agent, path),
  };
}
