import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { startDemo } from "./demo.ts";
import { createApp } from "./http.ts";
import { openStore } from "./logic.ts";
import { poke } from "./wait.ts";

const port = Number(process.env.PORT ?? 8791);
const dataPath = process.env.DATA_PATH ?? "data/chatroom.db";
const store = openStore(dataPath);
const { app, injectWebSocket, nudge } = createApp(store);

store.hooks = {
  onInbox: poke,
  onRoom: nudge,
};

if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ root: "./web/dist", path: "index.html" }));
}

startDemo(store);

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`工位服务 http://127.0.0.1:${info.port}`);
});
injectWebSocket(server);

const reaper = setInterval(() => store.reap(), 5000);
reaper.unref?.();
