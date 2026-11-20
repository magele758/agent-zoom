import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(process.env.KUNLUN_LOCAL_DIR || join(root, "data", "zoom-local"));
const serviceFile = join(directory, "service.env");
const submitFile = join(directory, "submit.env");

function readEnv(file) {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// A second launcher can only observe a complete file. An existing configuration always wins.
function writeNew(file, values) {
  const temporary = file + "." + randomUUID();
  const content =
    Object.entries(values)
      .map(([key, value]) => key + "=" + JSON.stringify(value))
      .join("\n") + "\n";
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    rmSync(temporary);
  }
}

function localPort(raw) {
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT 需要是 1 到 65535 之间的端口");
  return port;
}

function config() {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  let service = readEnv(serviceFile);
  if (!service) {
    const port = localPort(process.env.PORT || 52328);
    writeNew(serviceFile, {
      PORT: String(port),
      KUNLUN_URL: "http://127.0.0.1:" + port,
      DATA_PATH: join(directory, "chatroom.db"),
      WORKFLOW_SUBMIT_TOKEN: randomBytes(32).toString("hex"),
      KUNLUN_SESSION_COOKIE: "zoom_local_" + port,
    });
    service = readEnv(serviceFile);
  }
  const port = localPort(service.PORT || 52328);
  const origin = "http://127.0.0.1:" + port;
  const token = service.WORKFLOW_SUBMIT_TOKEN;
  if (!token || token.length < 24) throw new Error("service.env 缺少有效的 WORKFLOW_SUBMIT_TOKEN");
  if (service.KUNLUN_URL && service.KUNLUN_URL !== origin)
    throw new Error("service.env 中的 KUNLUN_URL 与本机 PORT 不一致");
  if (!readEnv(submitFile)) writeNew(submitFile, { KUNLUN_URL: origin, WORKFLOW_SUBMIT_TOKEN: token });
  const submit = readEnv(submitFile);
  if (submit.KUNLUN_URL !== origin || submit.WORKFLOW_SUBMIT_TOKEN !== token) {
    throw new Error("已有 submit.env 与 service.env 连接不同，请核对这两个文件");
  }
  return { service, port, origin, token };
}

async function running({ port, origin, token }) {
  const occupied = "端口 " + port + " 已被其他服务占用，或与当前资料目录的凭据不匹配";
  const read = (path, headers = {}) =>
    fetch(origin + path, { headers, redirect: "error", signal: AbortSignal.timeout(2500) });
  let health;
  try {
    health = await read("/api/health");
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return false;
    throw new Error(occupied);
  }
  try {
    if (!health.ok || (await health.json()).sharedLocal !== true) throw new Error();
    const projects = "/api/zoom/projects";
    if ((await read(projects)).status !== 401) throw new Error();
    const authorized = await read(projects, { authorization: "Bearer " + token });
    if (!authorized.ok || !Array.isArray((await authorized.json()).projects)) throw new Error();
    return true;
  } catch {
    throw new Error(occupied);
  }
}

function workflowConfig(service) {
  if (process.env.OPC_WORKFLOW_CONFIG) return resolve(process.env.OPC_WORKFLOW_CONFIG);
  if (service.WORKFLOW_CONFIG) return service.WORKFLOW_CONFIG;
  const optional = service.KUNLUN_OPTIONAL_DEMO_CONFIG;
  if (!optional) return;
  try {
    const { workspace } = JSON.parse(readFileSync(optional, "utf8"));
    if (typeof workspace === "string" && statSync(workspace).isDirectory()) return optional;
  } catch {
    // The old demo was temporary. Its saved history and the local business remain available.
  }
  console.log("旧演示目录不可用，执行器已暂停。");
}

async function start() {
  process.chdir(root);
  const local = config();
  const links = "全局看板 " + local.origin + "/\n消息列表 " + local.origin + "/#inbox\n项目目录 " + local.origin + "/#projects";
  if (await running(local)) {
    console.log(links + "\n当前OPC OS已在运行");
    return;
  }
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  if (await running(local)) {
    console.log(links + "\n当前OPC OS已在运行");
    return;
  }
  const { service } = local;
  Object.assign(process.env, {
    PORT: String(local.port),
    KUNLUN_URL: local.origin,
    WORKFLOW_SUBMIT_TOKEN: local.token,
    DATA_PATH: service.DATA_PATH || join(directory, "chatroom.db"),
    DEMO_MODE: "0",
    KUNLUN_PREVIEW: "0",
    OPC_ACTIVITY_INDEX: service.OPC_ACTIVITY_INDEX ?? process.env.OPC_ACTIVITY_INDEX ?? "1",
    KUNLUN_SESSION_COOKIE: service.KUNLUN_SESSION_COOKIE || "zoom_local_" + local.port,
  });
  console.log(links + "\nCLI 连接文件 " + submitFile);
  const workflow = workflowConfig(service);
  if (workflow) process.env.WORKFLOW_CONFIG = workflow;
  else delete process.env.WORKFLOW_CONFIG;
  await import("tsx");
  await import("../src/server/index.ts");
}

try {
  await start();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
