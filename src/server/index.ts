import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { startDemo } from "./demo.ts";
import { createApp } from "./http.ts";
import { openStore } from "./logic.ts";
import { poke } from "./wait.ts";
import { repositoryInterval } from "./company-activity-index.ts";
import { configureWorkflow } from "./workflow/http.ts";

const port = Number(process.env.PORT ?? 8791);
const dataPath = process.env.DATA_PATH ?? "data/chatroom.db";
const demoEnabled = process.env.DEMO_MODE === "1";
const store = openStore(dataPath, { demo: demoEnabled });
// Workflow DAG remains off by default unless WORKFLOW_CONFIG is explicitly supplied (and not disabled)
const workflow = process.env.OPC_DISABLE_WORKFLOW === "1" ? undefined : configureWorkflow(store.db, dataPath, port);
const activityIndexEnabled = process.env.OPC_ACTIVITY_INDEX === "1";
const {
  app,
  injectWebSocket,
  nudge,
  opportunities,
  homeRooms,
  activityIndex,
  delegations,
  darkFactory,
  taskPlanning,
  company,
  taskTriage,
  botArbitrator,
  plannotatorBridge,
} = createApp(store, { workflow, activityIndexEnabled });

store.hooks = {
  onInbox: poke,
  onRoom: nudge,
};

if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ root: "./web/dist", path: "index.html" }));
}

if (demoEnabled) {
  store.ensureDemoCast();
  startDemo(store);
} else {
  store.stopDemoAgents();
}

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`工位服务 http://127.0.0.1:${info.port}`);
});
injectWebSocket(server);

// Start Micro-Kernel & 6 Functional Departments lifecycle
company.kernel.startAll();

const reaper = setInterval(() => store.reap(), 5000);
reaper.unref?.();

const syncRoomDiscussions = () => void homeRooms.tick().catch(error => console.error("房间回执核对", error));
setInterval(syncRoomDiscussions, 5000).unref();
syncRoomDiscussions();

const reconcileDelegations = () => void delegations.tick().catch(error => console.error("委派回执核对", error));
setInterval(reconcileDelegations, 5000).unref();
reconcileDelegations();

const drainDarkFactory = () => {
  try { darkFactory.tickQueue(); }
  catch (error) { console.error("暗工厂队列调度", error); }
};
setInterval(drainDarkFactory, 3000).unref();

const patrolStaleTasks = () => {
  try { taskPlanning.runPatrol({ notifyZoom: true }); }
  catch (error) { console.error("后台巡检卫士", error); }
};
setInterval(patrolStaleTasks, 6 * 60 * 60 * 1000).unref();

// Dept 05 · Continuous Self-Healing Ops Watchdog (every 5 minutes)
const runOpsWatchdog = () => void company.ops.runWatchdogCycle().catch(error => console.error("运维自愈守护", error));
setInterval(runOpsWatchdog, 5 * 60 * 1000).unref();

// Dept 02 · Signal Collector runs on ProductDepartment's internal 15-minute timer via company.kernel.startAll()

// Dept 04 · Expiring Subscription Quota Harvester (every 15 minutes)
const harvestExpiringQuota = () => {
  try {
    if (!company.kernel.decisions.getPolicy().autoHarvestQuota) return;
    company.resources.harvestExpiringQuota({ windowHours: 6, minRemainingPct: 25 });
  } catch (error) {
    console.error("临期配额自动调度", error);
  }
};
setInterval(harvestExpiringQuota, 15 * 60 * 1000).unref();

// Layer 0 + 1 + 2 · Task Triage & Rolling Engine (every 30 minutes when enabled)
let triageCycleRunning = false;
const runScheduledTriageCycle = () => {
  if (triageCycleRunning) return;
  try {
    if (!taskTriage.getConfig().autoSweepEnabled) return;
    triageCycleRunning = true;
    void taskTriage
      .runRollingCycle()
      .catch((error) => console.error("任务审查漏斗轮动", error))
      .finally(() => {
        triageCycleRunning = false;
      });
  } catch (error) {
    triageCycleRunning = false;
    console.error("任务审查漏斗轮动", error);
  }
};
setInterval(runScheduledTriageCycle, 30 * 60 * 1000).unref();

// Bot Auto-Arbitrator (every 10 minutes when mode != 'off')
let arbitratorRunning = false;
const runScheduledBotArbitrator = () => {
  if (arbitratorRunning) return;
  try {
    if (botArbitrator.getPolicy().arbitrationMode === "off") return;
    arbitratorRunning = true;
    void botArbitrator
      .arbitratePending({ trigger: "scheduled" })
      .catch((error) => console.error("Bot 自动拍板巡检", error))
      .finally(() => {
        arbitratorRunning = false;
      });
  } catch (error) {
    arbitratorRunning = false;
    console.error("Bot 自动拍板巡检", error);
  }
};
setInterval(runScheduledBotArbitrator, 10 * 60 * 1000).unref();

// Plannotator Inbox Sync & Stale Auto-Reconciler (every 2 minutes when enabled)
let plannotatorSyncRunning = false;
const runScheduledPlannotatorSync = () => {
  if (plannotatorSyncRunning) return;
  try {
    const cfg = plannotatorBridge.getConfig();
    if (!cfg.enabled) return;
    plannotatorSyncRunning = true;
    void (async () => {
      await plannotatorBridge.syncReplies();
      if (plannotatorBridge.getConfig().autoReconcileStale) {
        await plannotatorBridge.reconcileStaleItems({ dryRun: false });
      }
    })()
      .catch((error) => console.error("Plannotator 同步与过期收敛", error))
      .finally(() => {
        plannotatorSyncRunning = false;
      });
  } catch (error) {
    plannotatorSyncRunning = false;
    console.error("Plannotator 同步与过期收敛", error);
  }
};
setInterval(runScheduledPlannotatorSync, 2 * 60 * 1000).unref();

if (activityIndexEnabled) {
  const refresh = () => void activityIndex.sync().catch(() => console.error("仓库索引暂未刷新"));
  refresh();
  setInterval(refresh, repositoryInterval).unref();
}

if (workflow) {
  const selectNext = () => {
    try { opportunities.tick(); }
    catch (error) { console.error("自动选题暂缓，下一轮重试", error); }
  };
  setInterval(selectNext, 5000).unref();
  selectNext();
  const dispatch = () => void workflow.service.tick().catch(error => console.error("工作流调度", error));
  setInterval(dispatch, 750).unref();
  dispatch();
}
