import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, symlink, readFile, writeFile, stat, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dirname, "..");
const listen = async server => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const close = server => new Promise(resolve => server.close(resolve));

function launch(dir, port, checkout = root) {
  const child = spawn(process.execPath, [join(checkout, "scripts", "zoom-local.mjs")], {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      KUNLUN_LOCAL_DIR: dir,
      OPC_ACTIVITY_INDEX: "0",
      PORT: String(port),
      WORKFLOW_CONFIG: join(dir, "unrelated-shell-config"),
    },
  });
  let output = "";
  child.stdout.on("data", data => {
    output += data;
  });
  child.stderr.on("data", data => {
    output += data;
  });
  return { child, done: once(child, "close").then(([code]) => ({ code, output })), output: () => output };
}

// Build real UI assets in an isolated checkout, then run the same foreground server as npm run zoom:local.
test(
  "fresh persistent local service survives restart and a second launch identifies it with its saved submit credential",
  { timeout: 45000 },
  async t => {
    const sandbox = await mkdtemp(join(tmpdir(), "kunlun-zoom-local-"));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    const checkout = join(sandbox, "checkout");
    const directory = join(sandbox, "persistent");
    await mkdir(join(checkout, "scripts"), { recursive: true });
    await mkdir(join(checkout, "web"));
    for (const name of ["vite.config.ts", "package.json"]) await copyFile(join(root, name), join(checkout, name));
    await copyFile(join(root, "web", "index.html"), join(checkout, "web", "index.html"));
    await copyFile(join(root, "scripts", "zoom-local.mjs"), join(checkout, "scripts", "zoom-local.mjs"));
    for (const path of ["src", "web/src", "node_modules"]) await symlink(join(root, path), join(checkout, path), "dir");
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    const origin = "http://127.0.0.1:" + port;
    let active;
    const stop = async () => {
      if (!active) return;
      active.child.kill("SIGTERM");
      await active.done;
      active = undefined;
    };
    t.after(stop);
    const start = async () => {
      active = launch(directory, port, checkout);
      for (let i = 0; i < 200; i++) {
        if (active.child.exitCode !== null) assert.fail(active.output());
        if (
          await fetch(origin + "/api/health").then(
            r => r.ok,
            () => false
          )
        )
          return;
        await delay(60);
      }
      assert.fail("startup timeout: " + active.output());
    };
    await start();
    const serviceFile = join(directory, "service.env"),
      submitFile = join(directory, "submit.env");
    const original = await readFile(serviceFile, "utf8"),
      submitText = await readFile(submitFile, "utf8");
    const submit = parseEnv(submitText),
      headers = { authorization: "Bearer " + submit.WORKFLOW_SUBMIT_TOKEN };
    assert.equal((await stat(serviceFile)).mode & 0o777, 0o600);
    assert.equal((await stat(submitFile)).mode & 0o777, 0o600);
    assert.ok(submit.WORKFLOW_SUBMIT_TOKEN.length >= 24);
    assert.equal(submit.KUNLUN_URL, origin);
    assert.deepEqual(await (await fetch(origin + "/api/workflows/enabled")).json(), { enabled: false });
    assert.equal((await fetch(origin + "/", {})).status, 200);
    const response = await fetch(origin + "/api/zoom/projects", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "保留这个产品" }),
    });
    assert.equal(response.status, 200);
    const retry = await launch(directory, port, checkout).done;
    assert.equal(retry.code, 0, retry.output);
    assert.match(retry.output, /已在运行/);
    assert.equal(retry.output.split("\n")[0], "全局看板 " + origin + "/");
    assert.ok(retry.output.includes(origin + "/#projects"));
    assert.equal(retry.output.includes(submit.WORKFLOW_SUBMIT_TOKEN), false);
    assert.equal(await readFile(serviceFile, "utf8"), original);

    await stop();
    const optional = join(sandbox, "old-demo.json");
    await writeFile(optional, JSON.stringify({ workspace: join(sandbox, "missing-workspace"), backend: "local-demo" }));
    const migrated = original + "KUNLUN_OPTIONAL_DEMO_CONFIG=" + JSON.stringify(optional) + "\n";
    await writeFile(serviceFile, migrated);
    await start();
    assert.ok(active.output().includes("执行器已暂停"));
    assert.deepEqual(await (await fetch(origin + "/api/workflows/enabled")).json(), { enabled: false });
    assert.equal(
      (await (await fetch(origin + "/api/zoom/projects", { headers })).json()).projects[0].name,
      "保留这个产品"
    );
    assert.equal(await readFile(serviceFile, "utf8"), migrated);
    assert.equal(await readFile(submitFile, "utf8"), submitText);
    await stop();

    await mkdir(join(sandbox, "missing-workspace"));
    await start();
    assert.deepEqual(await (await fetch(origin + "/api/workflows/enabled")).json(), { enabled: true });
    assert.equal(await readFile(serviceFile, "utf8"), migrated);
    await stop();
  }
);

test(
  "an occupied port never becomes a successful local connection and a foreign HTTP service gets no credential",
  { timeout: 12000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), "kunlun-taken-port-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let pretendKunlun = false;
    const requests = [];
    const other = createServer((req, res) => {
      requests.push({ url: req.url, authorized: !!req.headers.authorization });
      if (pretendKunlun && req.url === "/api/zoom/projects") res.writeHead(401);
      res.end(JSON.stringify(pretendKunlun ? { ok: true, sharedLocal: true } : { unrelated: true }));
    });
    const port = await listen(other);
    t.after(() => close(other));
    const serviceFile = join(directory, "service.env");
    const original = "PORT=" + port + "\nWORKFLOW_SUBMIT_TOKEN=" + randomBytes(24).toString("hex") + "\n";
    await writeFile(serviceFile, original, { mode: 0o600 });
    const occupied = await launch(directory, port).done;
    assert.equal(occupied.code, 1);
    assert.match(occupied.output, /端口.*占用/);
    assert.deepEqual(requests, [{ url: "/api/health", authorized: false }]);
    pretendKunlun = true;
    const wrong = await launch(directory, port).done;
    assert.equal(wrong.code, 1);
    assert.equal(requests.at(-1).url, "/api/zoom/projects");
    assert.equal(await readFile(serviceFile, "utf8"), original);
    await assert.rejects(stat(join(directory, "chatroom.db")), { code: "ENOENT" });
  }
);
