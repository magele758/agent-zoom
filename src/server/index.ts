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
const workflow = configureWorkflow(store.db, dataPath, port);
const activityIndexEnabled = process.env.OPC_ACTIVITY_INDEX === "1";
const { app, injectWebSocket, nudge, opportunities, homeRooms, activityIndex, delegations } = createApp(store, { workflow, activityIndexEnabled });

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

const reaper = setInterval(() => store.reap(), 5000);
reaper.unref?.();

const syncRoomDiscussions = () => void homeRooms.tick().catch(error => console.error("房间回执核对", error));
setInterval(syncRoomDiscussions, 5000).unref();
syncRoomDiscussions();

const reconcileDelegations = () => void delegations.tick().catch(error => console.error("委派回执核对", error));
setInterval(reconcileDelegations, 5000).unref();
reconcileDelegations();

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
