import type { Principal, Store } from "./logic.ts";
import { ApiError } from "./logic.ts";
import { waitInbox } from "./wait.ts";

const running = new Set<string>();

export function startDemo(store: Store) {
  const scan = () => {
    const rows = store.db.prepare("SELECT id FROM agents WHERE demo = 1").all() as Array<{ id: string }>;
    for (const row of rows) {
      if (running.has(row.id)) continue;
      running.add(row.id);
      void run(store, row.id);
    }
  };
  scan();
  const timer = setInterval(scan, 400);
  timer.unref?.();
}

async function run(store: Store, agentId: string) {
  let after = 0;
  const busy = new Set<string>();
  for (;;) {
    const agent = loadAgent(store, agentId);
    if (!agent) return;
    if (agent.paused) {
      await sleep(800);
      continue;
    }
    try {
      const events = await waitInbox(store, agentId, after, 8000);
      if (events.length > 0) after = events[events.length - 1].id;
      await act(store, agent, busy);
    } catch (error) {
      console.error(`demo ${agent.handle}`, error);
      await sleep(1000);
    }
  }
}

async function act(store: Store, agent: Principal & { type: "agent" }, busy: Set<string>) {
  const rooms = store.whoami(agent).rooms as Array<{ id: string }>;
  for (const room of rooms) {
    const tasks = store.listTasks(agent, room.id);
    for (const task of tasks) {
      if (busy.has(task.id)) continue;
      const mine = task.claims.some((claim) => claim.agentId === agent.id && claim.role === "implementer");
      if (agent.handle === "builder" && (task.status === "open" || (task.status === "changes" && mine))) {
        busy.add(task.id);
        try {
          await implement(store, agent, task.id, task.title, task.status === "changes");
        } catch (error) {
          if (!quiet(error)) console.error(error);
        } finally {
          busy.delete(task.id);
        }
      } else if (agent.handle === "reviewer" && task.status === "in_review") {
        const implementer = task.claims.find((claim) => claim.role === "implementer");
        if (implementer?.agentId === agent.id) continue;
        busy.add(task.id);
        try {
          await review(store, agent, task.id, task.title);
        } catch (error) {
          if (!quiet(error)) console.error(error);
        } finally {
          busy.delete(task.id);
        }
      } else if (agent.handle === "qa" && task.status === "in_test") {
        const implementer = task.claims.find((claim) => claim.role === "implementer");
        if (implementer?.agentId === agent.id) continue;
        busy.add(task.id);
        try {
          await test(store, agent, task.id, task.title);
        } catch (error) {
          if (!quiet(error)) console.error(error);
        } finally {
          busy.delete(task.id);
        }
      }
    }
  }
}

async function implement(
  store: Store,
  agent: Principal & { type: "agent" },
  taskId: string,
  title: string,
  revising: boolean,
) {
  await sleep(700);
  if (revising) {
    store.postMessage(agent, roomOf(store, taskId), {
      kind: "progress",
      taskId,
      body: `按评审意见改了一版「${title}」。`,
    });
    await sleep(500);
    store.markReady(agent, taskId);
    return;
  }
  store.claim(agent, taskId, "implementer");
  await sleep(800);
  store.postMessage(agent, roomOf(store, taskId), {
    kind: "progress",
    taskId,
    body: `我来做「${title}」。先按指令改，做完交给评审。`,
  });
  store.heartbeat(agent, taskId);
  await sleep(900);
  store.postMessage(agent, roomOf(store, taskId), {
    kind: "progress",
    taskId,
    body: `改动在我这边的工作区，变更引用 workspace:${taskId.slice(0, 8)}。`,
  });
  await sleep(500);
  store.markReady(agent, taskId);
}

async function review(store: Store, agent: Principal & { type: "agent" }, taskId: string, title: string) {
  await sleep(700);
  const task = store.listTasks(agent, roomOf(store, taskId)).find((item) => item.id === taskId);
  const held = task?.claims.some((claim) => claim.role === "reviewer" && claim.agentId === agent.id);
  if (!held) store.claim(agent, taskId, "reviewer");
  await sleep(600);
  store.review(
    agent,
    taskId,
    "approve",
    `评审「${title}」：范围和指令一致，没有看到缺了的验收点。通过。`,
  );
}

async function test(store: Store, agent: Principal & { type: "agent" }, taskId: string, title: string) {
  await sleep(700);
  const task = store.listTasks(agent, roomOf(store, taskId)).find((item) => item.id === taskId);
  const held = task?.claims.some((claim) => claim.role === "tester" && claim.agentId === agent.id);
  if (!held) store.claim(agent, taskId, "tester");
  await sleep(500);
  store.reportTest(agent, taskId, "pass", `测试「${title}」：主路径和空输入都走了一遍。通过。`);
}

function roomOf(store: Store, taskId: string) {
  const row = store.db.prepare("SELECT room_id FROM tasks WHERE id = ?").get(taskId) as { room_id: string };
  return row.room_id;
}

function loadAgent(store: Store, agentId: string): (Principal & { type: "agent" }) | null {
  const row = store.db
    .prepare("SELECT id, handle, owner_user_id, org_id, paused FROM agents WHERE id = ?")
    .get(agentId) as
    | { id: string; handle: string; owner_user_id: string; org_id: string; paused: number }
    | undefined;
  if (!row) return null;
  return {
    type: "agent",
    id: row.id,
    handle: row.handle,
    ownerUserId: row.owner_user_id,
    orgId: row.org_id,
    paused: row.paused === 1,
  };
}

function quiet(error: unknown) {
  return error instanceof ApiError && (error.status === 409 || error.status === 403);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
