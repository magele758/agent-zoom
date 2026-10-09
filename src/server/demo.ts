import type { Principal, Store, TaskView } from "./logic.ts";
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
    const rooms = store.whoami(agent).rooms as Array<{ id: string; archived?: boolean; direct?: boolean }>;
    for (const room of rooms) {
      if (room.archived || room.direct) continue;
    const tasks = store.listTasks(agent, room.id);
    for (const task of tasks) {
      await consider(store, agent, task, busy);
      for (const lane of task.lanes) await consider(store, agent, lane, busy);
    }
  }
}

async function consider(store: Store, agent: Principal & { type: "agent" }, task: TaskView, busy: Set<string>) {
  if (busy.has(task.id)) return;
  const builder = agent.handle === "builder" || agent.handle === "maker";
  const mine = task.claims.some((claim) => claim.agentId === agent.id && claim.role === "implementer");
  if (builder && task.status === "bidding") {
    try {
      store.bid(agent, task.id, approach(agent.handle, task.title));
    } catch (error) {
      if (!quiet(error)) console.error(error);
    }
    return;
  }
  if (builder && mine && ["claimed", "working", "changes"].includes(task.status) && !task.deliverableRef) {
    busy.add(task.id);
    try {
      await deliverWork(store, agent, task);
    } catch (error) {
      if (!quiet(error)) console.error(error);
    } finally {
      busy.delete(task.id);
    }
    return;
  }
  if (builder && task.status === "open") {
    busy.add(task.id);
    try {
      store.claim(agent, task.id, "implementer");
      await deliverWork(store, agent, { ...task, status: "claimed" });
    } catch (error) {
      if (!quiet(error)) console.error(error);
    } finally {
      busy.delete(task.id);
    }
    return;
  }
  if (agent.handle === "reviewer" && task.status === "in_review") {
    const implementer = task.claims.find((claim) => claim.role === "implementer");
    if (implementer?.agentId === agent.id) return;
    busy.add(task.id);
    try {
      await review(store, agent, task);
    } catch (error) {
      if (!quiet(error)) console.error(error);
    } finally {
      busy.delete(task.id);
    }
    return;
  }
  if (agent.handle === "qa" && task.status === "in_test") {
    const implementer = task.claims.find((claim) => claim.role === "implementer");
    if (implementer?.agentId === agent.id) return;
    busy.add(task.id);
    try {
      await test(store, agent, task);
    } catch (error) {
      if (!quiet(error)) console.error(error);
    } finally {
      busy.delete(task.id);
    }
  }
}

function approach(handle: string, title: string) {
  if (handle === "maker") return `「${title}」我从接口往下做，先让验收可测，再补边界。改动放在我自己的工作区。`;
  return `「${title}」我从界面往下做，先满足验收。改动放在我自己的工作区。`;
}

async function deliverWork(store: Store, agent: Principal & { type: "agent" }, task: TaskView) {
  await sleep(500);
  const room = roomOf(store, task.id);
  if (task.status === "claimed") {
    store.postMessage(agent, room, {
      kind: "direction",
      taskId: task.id,
      body: `「${task.title}」我按验收做，改动留在我自己的工作区。`,
    });
    await sleep(300);
  }
  store.heartbeat(agent, task.id);
  store.deliver(
    agent,
    task.id,
    `workspace:${task.id.slice(0, 8)}`,
    `「${task.title}」做完了。房间只留这个引用，不贴过程和 diff。`,
  );
}

async function review(store: Store, agent: Principal & { type: "agent" }, task: TaskView) {
  await sleep(500);
  const current = store.getTask(agent, task.id);
  const held = current.claims.some((claim) => claim.role === "reviewer" && claim.agentId === agent.id);
  if (!held) store.claim(agent, task.id, "reviewer");
  await sleep(400);
  store.review(agent, task.id, "approve", `评审「${task.title}」：对照验收看过，没有缺项。通过。`);
}

async function test(store: Store, agent: Principal & { type: "agent" }, task: TaskView) {
  await sleep(500);
  const current = store.getTask(agent, task.id);
  const held = current.claims.some((claim) => claim.role === "tester" && claim.agentId === agent.id);
  if (!held) store.claim(agent, task.id, "tester");
  await sleep(400);
  store.reportTest(agent, task.id, "pass", `测试「${task.title}」：按验收走了主路径。通过。`);
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
