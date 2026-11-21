import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { ApiError } from "./server/logic.ts";
import { ProvidersStore } from "./server/providers.ts";
import { registerTaskPlanningRoutes, TaskPlanningStore } from "./server/task-planning.ts";
import type {
  AgentMetricsSummary,
  DailyTrendResponse,
  KanbanBoardResponse,
  PatrolReport,
  PlanningAgentOption,
  RoiDashboardResponse,
  StaleTaskAlert,
} from "./task-planning-types.ts";

test("Epic -> SubTask hierarchy, 5-column Kanban grouping, state transitions, completedAt, and cascade delete", () => {
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  const agents: PlanningAgentOption[] = [
    { id: "agent-codex", name: "Codex Builder", status: "idle", capabilities: ["code", "test"] },
  ];
  const store = new TaskPlanningStore(db, providers, { listAgents: () => agents });

  // 1. Transactional Epic + Subtasks creation
  const { epic, subtasks } = store.createEpicWithSubtasks({
    project: "pagelens",
    title: "商业化首单闭环",
    description: "跑通支付、离线授权与 GTM 页面",
    priority: 9,
    tags: ["monetization", "p0", "monetization"],
    sourceRef: "prd://pagelens-billing",
    subtasks: [
      { title: "接入虎皮椒回调验签", priority: 10, type: "task" },
      { title: "修复 Safari 剪贴板权限异常", priority: 8, type: "bug" },
      { title: "撰写 Pricing FAQ PRD", priority: 6, type: "prd" },
    ],
  });

  assert.equal(epic.type, "epic");
  assert.equal(epic.project, "pagelens");
  assert.deepEqual(epic.tags, ["monetization", "p0"]);
  assert.equal(subtasks.length, 3);
  assert.equal(epic.subtaskStats.total, 3);
  assert.equal(epic.subtaskStats.done, 0);

  // Mark one subtask done and verify parent subtaskStats updates
  const subDone = store.updateStatus(subtasks[0].id, "done");
  assert.equal(subDone.status, "done");
  assert.ok(subDone.completedAt, "completedAt should be set when status becomes done");

  const reloadedEpic = store.getTask(epic.id);
  assert.equal(reloadedEpic.subtaskStats.total, 3);
  assert.equal(reloadedEpic.subtaskStats.done, 1);

  // Invalid parentId must throw 404 ApiError
  assert.throws(
    () => store.createTask({ title: "孤儿任务", parentId: "nonexistent-parent" }),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );

  // Create standalone tasks spanning all special statuses
  const tAssigned = store.createTask({ project: "pagelens", title: "人工设计着陆页", status: "assigned" });
  const tPrOpen = store.createTask({ project: "pagelens", title: "PR 待合并特性", status: "pr_open" });
  const tReview = store.createTask({ project: "pagelens", title: "安全审计复核", status: "review" });
  const tPublished = store.createTask({ project: "pagelens", title: "发布 Chrome 商店 v1.2", status: "published" });
  const tFailed = store.createTask({ project: "pagelens", title: "CI 构筑失败任务", status: "failed" });
  const tArchived = store.createTask({ project: "other-proj", title: "旧实验归档", status: "archived" });

  assert.ok(tPublished.completedAt, "published initial status should set completedAt");

  // Reopen published task -> clears completedAt
  const reopened = store.updateStatus(tPublished.id, "in_progress");
  assert.equal(reopened.completedAt, null);
  const republished = store.updateStatus(tPublished.id, "published");
  assert.ok(republished.completedAt);

  // Check Kanban grouping (pr_open -> in_progress, published -> done)
  const kanbanAll = store.getKanban();
  assert.deepEqual(kanbanAll.projects, ["other-proj", "pagelens"]);
  assert.equal(kanbanAll.agents.length, 1);
  assert.equal(kanbanAll.todo.length, 1); // epic
  assert.equal(kanbanAll.assigned.map((t) => t.id).includes(tAssigned.id), true);
  assert.equal(kanbanAll.in_progress.map((t) => t.id).includes(tPrOpen.id), true);
  assert.equal(kanbanAll.review.map((t) => t.id).includes(tReview.id), true);
  assert.equal(kanbanAll.done.map((t) => t.id).includes(tPublished.id), true);
  assert.equal(kanbanAll.failed.map((t) => t.id).includes(tFailed.id), true);
  assert.equal(kanbanAll.archived.map((t) => t.id).includes(tArchived.id), true);

  // Filter Kanban by project
  const kanbanPageLens = store.getKanban("pagelens");
  assert.equal(kanbanPageLens.archived.length, 0);
  assert.equal(kanbanPageLens.counts.total, 6);

  // Cascade delete epic deletes its 3 subtasks too
  const delRes = store.deleteTask(epic.id);
  assert.equal(delRes.deleted, true);
  assert.equal(delRes.deletedIds.length, 4);
  assert.throws(() => store.getTask(subtasks[1].id), (err: unknown) => err instanceof ApiError && err.status === 404);
});

test("Pomodoro tracking increments task count, records energy level, and aggregates high/low stats", () => {
  const db = new DatabaseSync(":memory:");
  const store = new TaskPlanningStore(db);

  const task = store.createTask({ project: "opc-os", title: "打磨看板交互动效" });
  assert.equal(task.pomodoroCount, 0);
  assert.equal(task.energyLevel, null);

  // Missing energy level must fail validation
  assert.throws(
    () => store.recordPomodoro(task.id, { durationMins: 25 }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );

  const r1 = store.recordPomodoro(task.id, { energyLevel: "high", durationMins: 25, note: "状态极佳" });
  assert.equal(r1.task.pomodoroCount, 1);
  assert.equal(r1.task.energyLevel, "high");
  assert.equal(r1.session.durationMins, 25);

  const r2 = store.recordPomodoro(task.id, { energyLevel: "high", durationMins: 30 });
  assert.equal(r2.task.pomodoroCount, 2);

  const r3 = store.recordPomodoro(task.id, { energyLevel: "low", durationMins: 25, note: "午后略困" });
  assert.equal(r3.task.pomodoroCount, 3);
  assert.equal(r3.task.energyLevel, "low");

  const summary = store.listPomodoros(30);
  assert.equal(summary.totalSessions, 3);
  assert.equal(summary.totalMinutes, 80);
  assert.equal(summary.estimatedHours, 1.33);
  assert.equal(summary.highEnergyCount, 2);
  assert.equal(summary.lowEnergyCount, 1);
  assert.equal(summary.highEnergyRate, 66.7);
});

test("Human assignment, Dark Factory dispatch hook, and syncRunOutcome status/PR/cost accumulation", async () => {
  const db = new DatabaseSync(":memory:");
  const dispatched: Array<{ taskId: string; agentId: string; autoCreatePr?: boolean }> = [];
  const store = new TaskPlanningStore(db, undefined, {
    listAgents: () => [{ id: "df-claude", name: "Claude Factory", status: "online", capabilities: ["ts", "react"] }],
    dispatchToAgent: async (task, agentId, autoCreatePr) => {
      dispatched.push({ taskId: task.id, agentId, autoCreatePr });
      return { runId: "run_df_001", status: "running" };
    },
  });

  const task = store.createTask({ project: "opc-os", title: "实现自动巡检卡片" });
  assert.equal(task.status, "todo");

  // Assign human auto-transitions todo -> assigned
  const assigned = store.assignHuman(task.id, "彭磊");
  assert.equal(assigned.assigneeType, "human");
  assert.equal(assigned.assigneeName, "彭磊");
  assert.equal(assigned.status, "assigned");

  // Dispatch to Dark Factory agent
  const dispRes = await store.dispatchTask(task.id, { agentId: "df-claude", autoCreatePr: true });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].autoCreatePr, true);
  assert.equal(dispRes.runId, "run_df_001");
  assert.equal(dispRes.task.assigneeType, "agent");
  assert.equal(dispRes.task.assigneeId, "df-claude");
  assert.equal(dispRes.task.assigneeName, "Claude Factory");
  assert.equal(dispRes.task.status, "in_progress");
  assert.equal(dispRes.task.latestRunId, "run_df_001");

  // Sync run outcome: pr_open -> pr_open, accumulates tokens/cost & sets prUrl
  const afterPr = store.syncRunOutcome({
    taskId: task.id,
    runId: "run_df_001",
    status: "pr_open",
    prUrl: "https://github.com/opc/os/pull/42",
    tokenUsed: 18_500,
    costUsd: 0.1425,
  });
  assert.equal(afterPr.status, "pr_open");
  assert.equal(afterPr.prUrl, "https://github.com/opc/os/pull/42");
  assert.equal(afterPr.tokenUsed, 18_500);
  assert.equal(afterPr.costUsd, 0.1425);

  // Sync run outcome: completed -> review, accumulates additional tokens/cost
  const afterComplete = store.syncRunOutcome({
    taskId: task.id,
    runId: "run_df_002",
    status: "completed",
    tokenUsed: 4_500,
    costUsd: 0.0375,
  });
  assert.equal(afterComplete.status, "review");
  assert.equal(afterComplete.tokenUsed, 23_000);
  assert.equal(afterComplete.costUsd, 0.18);
  assert.equal(afterComplete.prUrl, "https://github.com/opc/os/pull/42");

  // Sync run outcome: failed -> failed
  const afterFailed = store.syncRunOutcome({
    taskId: task.id,
    runId: "run_df_003",
    status: "failed",
    tokenUsed: 1_000,
    costUsd: 0.01,
  });
  assert.equal(afterFailed.status, "failed");
  assert.equal(afterFailed.tokenUsed, 24_000);
  assert.equal(afterFailed.costUsd, 0.19);
});

test("Patrol Guard detects tasks stale > patrolStaleDays and failed tasks, persists history, and notifies Zoom", () => {
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  providers.update({ system: { patrolStaleDays: 7 } });

  const zoomNotifications: StaleTaskAlert[][] = [];
  const store = new TaskPlanningStore(db, providers, {
    notifyPatrolToZoom: (alerts) => {
      zoomNotifications.push(alerts);
    },
  });

  const staleTask = store.createTask({ project: "pagelens", title: "滞留十天的接入任务", status: "in_progress" });
  const freshTask = store.createTask({ project: "pagelens", title: "刚刚更新的活跃任务", status: "todo" });
  const doneOldTask = store.createTask({ project: "pagelens", title: "已完成的老任务", status: "done" });
  const failedTask = store.createTask({ project: "opc-os", title: "夜间暗工厂构筑失败", status: "failed" });

  // Backdate staleTask and doneOldTask by 10 days directly in SQLite
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  db.prepare("UPDATE opc_planning_tasks SET updated_at = ? WHERE id IN (?, ?)").run(
    tenDaysAgo,
    staleTask.id,
    doneOldTask.id,
  );

  // Run patrol without Zoom notification
  const report1 = store.runPatrol();
  assert.equal(report1.staleDays, 7);
  assert.equal(report1.staleCount, 1);
  assert.equal(report1.failedCount, 1);
  assert.equal(report1.staleTasks[0].taskId, staleTask.id);
  assert.ok(report1.staleTasks[0].staleDays >= 10);
  assert.equal(report1.failedTasks[0].taskId, failedTask.id);
  assert.equal(report1.notifiedZoom, false);
  assert.equal(zoomNotifications.length, 0);

  // Ensure freshTask and doneOldTask were NOT flagged
  assert.equal(
    report1.alerts.some((a) => a.taskId === freshTask.id || a.taskId === doneOldTask.id),
    false,
  );

  // Run patrol with notifyZoom: true
  const report2 = store.runPatrol({ staleDays: 5, notifyZoom: true });
  assert.equal(report2.staleDays, 5);
  assert.equal(report2.notifiedZoom, true);
  assert.equal(zoomNotifications.length, 1);
  assert.equal(zoomNotifications[0].length, 2);

  // History persisted in reverse chronological order
  const history = store.listPatrolHistory(10);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, report2.id);
  assert.equal(history[1].id, report1.id);
});

test("ROI Dashboard aggregates human hours, agent cost, revenue, Epic/Project ROI, and 112-day trend gap-filling", () => {
  const db = new DatabaseSync(":memory:");
  const todayKey = new Date().toISOString().slice(0, 10);
  const agentMetrics: AgentMetricsSummary = {
    totalRuns: 5,
    totalTokensUsed: 60_000,
    totalCostUsd: 0.75,
    byDay: {
      [todayKey]: { runs: 3, tokens: 40_000, costUsd: 0.5 },
    },
    byProject: {
      pagelens: { runs: 3, tokens: 40_000, costUsd: 0.5 },
      chatroom: { runs: 2, tokens: 20_000, costUsd: 0.25 },
    },
  };

  const store = new TaskPlanningStore(db, undefined, {
    getAgentMetrics: () => agentMetrics,
    getProjectRevenueUsd: () => ({ pagelens: 580, chatroom: 120 }),
  });

  const { epic, subtasks } = store.createEpicWithSubtasks({
    project: "pagelens",
    title: "v2.0 字幕引擎重构",
    subtasks: [
      { title: "WebWorker 音频切分" },
      { title: "离线词典缓存" },
    ],
  });

  // Complete 1 subtask, record pomodoros, and sync agent cost
  store.updateStatus(subtasks[0].id, "done");
  store.recordPomodoro(subtasks[0].id, { energyLevel: "high", durationMins: 30 });
  store.recordPomodoro(subtasks[1].id, { energyLevel: "low", durationMins: 30 });
  store.syncRunOutcome({
    taskId: subtasks[0].id,
    runId: "run_100",
    status: "completed",
    tokenUsed: 15_000,
    costUsd: 0.2,
  });
  store.updateStatus(subtasks[0].id, "done");

  // Another project task completed
  const otherTask = store.createTask({ project: "chatroom", title: "修复 MCP 重连", status: "published" });
  store.recordPomodoro(otherTask.id, { energyLevel: "high", durationMins: 60 });

  const roi = store.getRoiDashboard(30);
  // Window has: epic + 2 subtasks + otherTask = 4 tasks; 2 completed (subtasks[0] done, otherTask published)
  assert.equal(roi.tasks.total, 4);
  assert.equal(roi.tasks.completed, 2);
  assert.equal(roi.tasks.completionRate, 50);

  // Human hours: 30 + 30 + 60 = 120 mins = 2.0 hours, 2/3 high energy = 66.7%
  assert.equal(roi.human.totalPomodoros, 3);
  assert.equal(roi.human.estimatedHours, 2);
  assert.equal(roi.human.highEnergyCount, 2);
  assert.equal(roi.human.lowEnergyCount, 1);
  assert.equal(roi.human.highEnergyRate, 66.7);

  // Agent metrics merged cleanly without double-counting pagelens synced cost
  assert.equal(roi.agents.totalRuns, 5);
  assert.equal(roi.agents.totalTokensUsed, 60_000);
  assert.equal(roi.agents.totalCostUsd, 0.75);

  // Project ROI & Epic ROI
  const pagelensProj = roi.epicRoi.find((r) => r.kind === "project" && r.project === "pagelens");
  assert.ok(pagelensProj);
  assert.equal(pagelensProj.revenueUsd, 580);
  assert.equal(pagelensProj.agentCostUsd, 0.5);
  assert.equal(pagelensProj.pomodoros, 2);
  assert.equal(pagelensProj.humanHours, 1);
  assert.equal(pagelensProj.completedTasks, 1);
  assert.equal(pagelensProj.costPerCompletedTask, 0.5);

  const epicRow = roi.epicRoi.find((r) => r.kind === "epic" && r.id === epic.id);
  assert.ok(epicRow);
  assert.equal(epicRow.totalTasks, 2);
  assert.equal(epicRow.completedTasks, 1);
  assert.equal(epicRow.pomodoros, 2);
  assert.equal(epicRow.humanHours, 1);
  assert.equal(epicRow.agentCostUsd, 0.2);
  assert.equal(epicRow.costPerCompletedTask, 0.2);

  // 112-day trend gap-filling check
  const trend = store.getDailyTrend(112);
  assert.equal(trend.length, 112);
  const todayPoint = trend[trend.length - 1];
  assert.equal(todayPoint.date, todayKey);
  assert.equal(todayPoint.created, 4);
  assert.equal(todayPoint.completed, 2);
  assert.equal(todayPoint.pomodoroCount, 3);
  assert.equal(todayPoint.highEnergyPomodoros, 2);
  assert.equal(todayPoint.agentRuns, 3);

  // Earlier day with no activity is cleanly zero-filled
  const earliestPoint = trend[0];
  assert.equal(earliestPoint.completed, 0);
  assert.equal(earliestPoint.created, 0);
  assert.equal(earliestPoint.pomodoroCount, 0);
  assert.equal(earliestPoint.agentRuns, 0);
});

test("Hono HTTP routes end-to-end verification under /api/opc/planning", async () => {
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    }
    return c.json({ error: "internal", message: String(err) }, 500);
  });

  let zoomAlertsReceived = 0;
  registerTaskPlanningRoutes(
    app,
    db,
    providers,
    () => ({ id: "u_founder", name: "Founder" }),
    {
      hooks: {
        listAgents: () => [{ id: "agent-alpha", name: "Alpha Worker", status: "online", capabilities: ["code"] }],
        dispatchToAgent: async () => ({ runId: "run_http_01", status: "running" }),
        getProjectRevenueUsd: () => ({ demo: 199 }),
        notifyPatrolToZoom: (alerts) => {
          zoomAlertsReceived += alerts.length;
        },
      },
    },
  );

  // 1. POST /epics
  const epicRes = await app.request("/api/opc/planning/epics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "demo",
      title: "HTTP 端到端 Epic",
      subtasks: [{ title: "子任务 A" }, { title: "子任务 B" }],
    }),
  });
  assert.equal(epicRes.status, 201);
  const epicBody = (await epicRes.json()) as { epic: { id: string }; subtasks: Array<{ id: string }> };
  assert.equal(epicBody.subtasks.length, 2);

  // 2. POST /tasks
  const taskRes = await app.request("/api/opc/planning/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "demo", title: "独立任务", priority: 8 }),
  });
  assert.equal(taskRes.status, 201);
  const createdTask = (await taskRes.json()) as { id: string };

  // 3. GET /tasks/:id & PATCH /tasks/:id
  const patchRes = await app.request(`/api/opc/planning/tasks/${createdTask.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "独立任务（已更新）", priority: 9 }),
  });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()) as { title: string; priority: number };
  assert.equal(patched.title, "独立任务（已更新）");
  assert.equal(patched.priority, 9);

  // 4. POST /assign-human
  const assignRes = await app.request(`/api/opc/planning/tasks/${createdTask.id}/assign-human`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(assignRes.status, 200);
  const assigned = (await assignRes.json()) as { status: string; assigneeName: string };
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.assigneeName, "Founder");

  // 5. POST /dispatch
  const dispatchRes = await app.request(`/api/opc/planning/tasks/${createdTask.id}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "agent-alpha", autoCreatePr: true }),
  });
  assert.equal(dispatchRes.status, 200);
  const dispatched = (await dispatchRes.json()) as { runId: string; task: { status: string } };
  assert.equal(dispatched.runId, "run_http_01");
  assert.equal(dispatched.task.status, "in_progress");

  // 6. POST /pomodoro
  const pomoRes = await app.request(`/api/opc/planning/tasks/${createdTask.id}/pomodoro`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ energyLevel: "high", durationMins: 25, note: "端到端验证" }),
  });
  assert.equal(pomoRes.status, 201);
  const pomoBody = (await pomoRes.json()) as { task: { pomodoroCount: number } };
  assert.equal(pomoBody.task.pomodoroCount, 1);

  // 7. PATCH /status
  const statusRes = await app.request(`/api/opc/planning/tasks/${createdTask.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "done" }),
  });
  assert.equal(statusRes.status, 200);
  const doneTask = (await statusRes.json()) as { status: string; completedAt: string | null };
  assert.equal(doneTask.status, "done");
  assert.ok(doneTask.completedAt);

  // 8. GET /kanban & GET /tasks
  const kanbanRes = await app.request("/api/opc/planning/kanban?project=demo");
  assert.equal(kanbanRes.status, 200);
  const kanban = (await kanbanRes.json()) as KanbanBoardResponse;
  assert.equal(kanban.todo.length, 1);
  assert.equal(kanban.done.length, 1);

  const listRes = await app.request("/api/opc/planning/tasks?project=demo&includeSubtasks=true");
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { tasks: unknown[] };
  assert.equal(listBody.tasks.length, 4);

  // 9. GET /roi & GET /daily-trend
  const roiRes = await app.request("/api/opc/planning/roi?days=30");
  assert.equal(roiRes.status, 200);
  const roi = (await roiRes.json()) as RoiDashboardResponse;
  assert.equal(roi.human.totalPomodoros, 1);
  assert.equal(roi.tasks.completed, 1);

  const trendRes = await app.request("/api/opc/planning/daily-trend?days=112");
  assert.equal(trendRes.status, 200);
  const trend = (await trendRes.json()) as DailyTrendResponse;
  assert.equal(trend.points.length, 112);

  // 10. POST /patrol & GET /patrol/history
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  db.prepare("UPDATE opc_planning_tasks SET updated_at = ? WHERE id = ?").run(tenDaysAgo, epicBody.epic.id);

  const patrolRes = await app.request("/api/opc/planning/patrol", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staleDays: 7, notifyZoom: true }),
  });
  assert.equal(patrolRes.status, 200);
  const patrol = (await patrolRes.json()) as PatrolReport;
  assert.equal(patrol.staleCount, 1);
  assert.equal(patrol.notifiedZoom, true);
  assert.equal(zoomAlertsReceived, 1);

  const historyRes = await app.request("/api/opc/planning/patrol/history?limit=5");
  assert.equal(historyRes.status, 200);
  const historyBody = (await historyRes.json()) as { runs: PatrolReport[] };
  assert.equal(historyBody.runs.length, 1);

  // 11. DELETE /tasks/:id
  const delRes = await app.request(`/api/opc/planning/tasks/${epicBody.epic.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  const delBody = (await delRes.json()) as { deleted: boolean; deletedIds: string[] };
  assert.equal(delBody.deleted, true);
  assert.equal(delBody.deletedIds.length, 3);

  // 12. 404 check on deleted task
  const missingRes = await app.request(`/api/opc/planning/tasks/${epicBody.epic.id}`);
  assert.equal(missingRes.status, 404);
});
