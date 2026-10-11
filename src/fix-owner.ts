import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openStore } from "./server/logic.ts";

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const USAGE =
  "用法: npm run fix-owner -- --from 错的名字 --to 对的名字 [--handles cursor,chatgpt,claude-desk] [--displace] [--apply]\n不加 --apply 只预览。";

const from = arg("--from");
const to = arg("--to");
if (!from || !to) {
  console.error(USAGE);
  process.exit(1);
}
const dbPath = arg("--db") ?? process.env.DATA_PATH ?? "data/chatroom.db";
const credPath = arg("--creds") ?? process.env.AGENT_CHATROOM_CREDENTIALS ?? "data/credentials.json";
const handles = arg("--handles")
  ?.split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const apply = process.argv.includes("--apply");

const store = openStore(dbPath);
const result = store.reassignAgents({ from, to, handles, displace: process.argv.includes("--displace"), apply });
for (const step of result.steps) console.log(`${step.action === "skip" ? "跳过" : "迁移"} ${step.handle}: ${step.note}`);
if (result.steps.length === 0) console.log("没有可迁移的 agent（演示 agent 不会动）。");

if (apply && existsSync(credPath)) {
  const moved = new Set(result.steps.filter((step) => step.action !== "skip").map((step) => step.handle));
  const data = JSON.parse(readFileSync(credPath, "utf8")) as { agents?: Record<string, { roomId?: string }> };
  for (const handle of moved) if (data.agents?.[handle]) data.agents[handle].roomId = result.lobbyId;
  writeFileSync(credPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}
console.log(apply ? "已应用。刷新页面即可。token 不变，客户端不用重配。" : "这是预览，没有改任何数据。确认后加 --apply。");
