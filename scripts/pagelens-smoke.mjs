#!/usr/bin/env node
// Feature smoke for 工位 driven through the owner's real Chrome via the PageLens bridge.
//
//   node scripts/pagelens-smoke.mjs --url http://localhost:5173 --expect-name 彭磊 --db data/chatroom.db
//       Live pass. Read-only: opens/closes the 这台电脑 dialog, types "@" in the composer and clears it,
//       toggles the 下指令/发言/提问 radio, reads panels. It never sends, creates, invites, connects, stops, or leaves.
//
//   node scripts/pagelens-smoke.mjs --spawn-temp
//       Starts a throwaway API + Vite on 127.0.0.1 (random ports, temp DB), enters as --name (default 彭磊) in a
//       fresh tab, and also exercises posting. Writes only to that temp DB. Cookies are per host, so the
//       127.0.0.1 origin never touches the localhost:5173 session.
//
// Needs the PageLens helper (default ~/.pagelens/plcall.py). Exit code 1 when any check FAILs.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const LIVE_PORTS = new Set(["5173", "8791"]);
const PRESENCE_MS = 5 * 60 * 1000;

const args = parseArgs(process.argv.slice(2));
const plcall = args["plcall"] ?? join(homedir(), ".pagelens/plcall.py");
const spawnTemp = args["spawn-temp"] === true;
const expectName = typeof args["expect-name"] === "string" ? args["expect-name"] : "";
const tempName = typeof args["name"] === "string" ? args["name"] : "彭磊";
const expectAgents = typeof args["expect-agents"] === "string" ? args["expect-agents"].split(",").filter(Boolean) : [];
const dbArg = typeof args["db"] === "string" ? args["db"] : "";
let baseUrl = typeof args["url"] === "string" ? args["url"].replace(/\/$/, "") : "http://localhost:5173";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function bridge(tool, payload, retries = 1) {
  for (let attempt = 0; ; attempt += 1) {
    const { stdout } = await run("python3", ["-W", "ignore", plcall, tool, JSON.stringify(payload)], { maxBuffer: 16 * 1024 * 1024 });
    const reply = JSON.parse(stdout.slice(stdout.indexOf("{")));
    if (reply.ok) return reply.result;
    const message = reply.error?.message ?? JSON.stringify(reply.error ?? reply);
    if (attempt >= retries) throw new Error(`${tool}: ${message}`);
    await sleep(1500);
  }
}

const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...(root || document).querySelectorAll(s)];
const tid = (id) => $('[data-testid="' + id + '"]');
const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
const setValue = (el, value) => {
  const proto = Object.getPrototypeOf(el);
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.focus();
  if (el.setSelectionRange && el.type !== 'checkbox') { try { el.setSelectionRange(value.length, value.length); } catch {} }
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v = fn(); while (!v && Date.now() < end) { await sleep(150); v = fn(); } return v; };
const api = async (path) => { const r = await fetch(path); return r.ok ? r.json() : { __status: r.status }; };
const expandTasks = async () => { const all = $$('button', $('.task-filters')).find((b) => text(b) === '全部'); if (all) { all.click(); await sleep(200); } for (const b of $$('.task-detail-toggle[aria-expanded="false"]')) b.click(); await sleep(200); };
const roomSnap = async () => { const me = await api('/api/me'); const room = me.rooms.find((r) => r.general) || me.rooms[0]; return { me, room, snap: await api('/api/rooms/' + room.id) }; };
`;

let tabId = null;
async function js(body, timeoutNote = "") {
  const reply = await bridge("run_js", { tabId, code: `${HELPERS}\n${body}` });
  if (reply && reply.ok === false) throw new Error(`page error ${timeoutNote}: ${reply.error ?? JSON.stringify(reply)}`);
  return reply && "result" in reply ? reply.result : reply;
}

const results = [];
function record(status, feature, detail) {
  results.push({ status, feature, detail });
  console.log(`${status.padEnd(4)} ${feature} — ${detail}`);
}
async function check(feature, fn) {
  try {
    const out = await fn();
    if (out === "skip") return;
    if (out && out.skip) record("SKIP", feature, out.skip);
    else if (out && out.ok) record("PASS", feature, out.detail ?? "ok");
    else record("FAIL", feature, out?.detail ?? "check returned falsy");
  } catch (error) {
    record("FAIL", feature, `exception: ${error instanceof Error ? error.message : error}`);
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const temp = { dir: "", api: null, web: null, apiUrl: "", cookie: "", dbPath: "" };

async function startTemp() {
  temp.dir = mkdtempSync(join(tmpdir(), "gongwei-pagelens-"));
  temp.dbPath = join(temp.dir, "chatroom.db");
  const apiPort = await freePort();
  const webPort = await freePort();
  if (LIVE_PORTS.has(String(apiPort)) || LIVE_PORTS.has(String(webPort))) throw new Error("picked a live port");
  temp.apiUrl = `http://127.0.0.1:${apiPort}`;
  baseUrl = `http://127.0.0.1:${webPort}`;
  const quiet = { cwd: ROOT, stdio: "ignore", detached: true };
  temp.api = spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/server/index.ts"], {
    ...quiet,
    env: { ...process.env, PORT: String(apiPort), DATA_PATH: temp.dbPath, AGENT_CHATROOM_CREDENTIALS: join(temp.dir, "credentials.json") },
  });
  temp.web = spawn(join(ROOT, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    ...quiet,
    env: { ...process.env, VITE_PORT: String(webPort), AGENT_CHATROOM_API: temp.apiUrl },
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${temp.apiUrl}/api/health`)).ok && (await fetch(`${baseUrl}/`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("temporary stack did not start");
}

function stopTemp() {
  for (const child of [temp.api, temp.web]) {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  if (temp.dir) rmSync(temp.dir, { recursive: true, force: true });
}

async function tempApi(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  else if (temp.cookie) headers.cookie = temp.cookie;
  const response = await fetch(`${temp.apiUrl}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }
  return { status: response.status, data, headers: response.headers };
}

function assertSafeTarget(url, write) {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (write && (LIVE_PORTS.has(port) || parsed.hostname === "localhost")) {
    throw new Error(`refusing write checks against ${url}; use --spawn-temp`);
  }
}

// ---------------------------------------------------------------- read-only checks (live and temp)

async function readOnlyChecks() {
  await check("page-load", async () => {
    await js("await until(() => $('.shell') || tid('name-input'), 15000); return 1;");
    const r = await js(`
      return { title: document.title, gate: !!tid('name-input'), shell: !!$('.shell'), mark: text($('.brand .mark')), org: text($('.brand .org')) };`);
    if (r.gate) return { ok: false, detail: "the gate is showing (no session in this browser)" };
    return { ok: r.title === "工位" && r.shell && r.mark === "工位" && !!r.org, detail: `title=${r.title} org=${r.org}` };
  });

  await check("lobby-channels", async () => {
    const r = await js(`
      const { me, room } = await roomSnap();
      const buttons = $$('.rooms .room').map((b) => ({ name: text(b.querySelector('span')), active: b.classList.contains('active') }));
      return { hall: room.name, general: room.general, buttons, plus: !!$('.rooms [aria-label="新建频道"]'), api: me.rooms.filter((x) => !x.archived && !x.direct).length, topic: text($('.channel-head')).slice(0, 80) };`);
    const hall = r.buttons.find((b) => b.name === "大厅");
    const ok = r.general === true && r.hall === "大厅" && hall?.active && r.plus && r.buttons.length >= r.api;
    return { ok, detail: `channels=[${r.buttons.map((b) => b.name + (b.active ? "*" : "")).join(",")}] hall.general=${r.general} 新建频道按钮=${r.plus}` };
  });

  await check("identity-header", async () => {
    const r = await js(`
      const me = await api('/api/me');
      const you = text($('.channel-head .you'));
      return { you, name: me.user && me.user.name, rosterHasSelf: $$('.roster .person-head strong').some((e) => text(e) === (me.user && me.user.name)) };`);
    const shown = r.you.replace(/^你是\s*/, "");
    if (!expectName) return { ok: shown === r.name && r.rosterHasSelf, detail: `页面「${r.you}」, /api/me=${r.name}, 在场里有自己=${r.rosterHasSelf}` };
    return {
      ok: shown === expectName && r.name === expectName,
      detail: `页面「${r.you}」, /api/me=${r.name}, 期望 ${expectName}${shown !== expectName ? "（这个浏览器的 ac_session 属于另一个名字，需要手动离开后用该名字重新进入）" : ""}`,
    };
  });

  await check("presence-grouping", async () => {
    const r = await js(`
      const { snap } = await roomSnap();
      const groups = $$('.roster > .person').map((li) => ({
        name: text(li.querySelector('.person-head strong')),
        meta: text(li.querySelector('.person-head em')),
        headDot: li.querySelector('.person-head .dot').classList.contains('on'),
        agents: $$('.person-agents > li', li).map((a) => ({ handle: text(a.querySelector('.handle strong')), dotOn: a.querySelector('.dot').classList.contains('on') })),
      }));
      const apiOwners = {};
      for (const a of snap.members.agents) (apiOwners[a.ownerName || '未署名'] ||= []).push(a.handle);
      return { groups, apiOwners, users: snap.members.users.map((u) => u.name) };`);
    const problems = [];
    const uiHandles = r.groups.flatMap((g) => g.agents.map((a) => a.handle)).sort();
    const apiHandles = Object.values(r.apiOwners).flat().sort();
    if (JSON.stringify(uiHandles) !== JSON.stringify(apiHandles)) problems.push(`handles ui=${uiHandles} api=${apiHandles}`);
    for (const g of r.groups) {
      const expected = r.apiOwners[g.name] ?? [];
      if (g.agents.length !== expected.length) problems.push(`${g.name}: ${g.agents.length} vs api ${expected.length}`);
      const person = r.users.includes(g.name);
      const want = person ? (g.agents.length ? `人 · ${g.agents.length} 个 agent` : "人") : `${g.agents.length} 个 agent`;
      if (g.meta !== want) problems.push(`${g.name} meta「${g.meta}」应为「${want}」`);
    }
    if (!r.groups.length) problems.push("no groups");
    return { ok: problems.length === 0, detail: problems.join("; ") || r.groups.map((g) => `${g.name}[${g.meta}]`).join(" ") };
  });

  await check("roles-and-levels", async () => {
    const r = await js(`
      const { snap } = await roomSnap();
      const rows = $$('.roster [data-testid^="level-"]').map((sel) => {
        const handle = sel.dataset.testid.slice(6);
        const grp = tid('group-' + handle);
        return { handle, levels: [...sel.options].map((o) => text(o)), level: sel.value, groups: grp ? [...grp.querySelectorAll("label")].map((o) => text(o)) : [], group: grp && [...grp.querySelectorAll("input:checked")].map((o) => o.value).join(",") };
      });
      return { rows, api: Object.fromEntries(snap.members.agents.map((a) => [a.handle, { level: a.level, tags: a.tags }])) };`);
    const wantLevels = ["Lv1", "Lv2", "Lv3", "Lv4", "Lv5"];
    const wantGroups = ["课题研究", "产品设计师", "设计师", "技术架构师", "实现", "评审", "测试"];
    const problems = [];
    for (const row of r.rows) {
      if (JSON.stringify(row.levels) !== JSON.stringify(wantLevels)) problems.push(`${row.handle} levels ${row.levels}`);
      if (JSON.stringify(row.groups) !== JSON.stringify(wantGroups)) problems.push(`${row.handle} groups ${row.groups}`);
      const known = r.api[row.handle];
      if (known && String(known.level ?? 1) !== String(row.level)) problems.push(`${row.handle} level select ${row.level} vs api ${known.level}`);
      if (known && !row.group.split(",").every((id) => String(known.tags).split(/[\s,，]+/).includes(id))) problems.push(`${row.handle} group select ${row.group} vs api ${known.tags}`);
    }
    if (!r.rows.length) return { skip: "no agents in this room" };
    return { ok: problems.length === 0, detail: problems.join("; ") || `${r.rows.length} agents: Lv1–5 and 7 roles, selects agree with the API` };
  });

  await check("local-client-modal(这台电脑)", async () => {
    const opened = await js(`
      const btn = tid('open-local-agents');
      if (!btn) return { missing: true };
      const label = btn.textContent.replace(/\s+/g, " ").trim();
      btn.click();
      const dialog = await until(() => tid('local-agent-dialog'), 5000);
      if (!dialog) return { label, opened: false };
      await until(() => !/正在查找/.test(text(dialog)), 8000);
      const rows = $$('[data-testid="local-agent-list"] > li', dialog);
      const out = {
        label, opened: true, title: text($('#local-agent-title', dialog)), rows: rows.length,
        names: rows.map((li) => text(li.querySelector('.handle-name'))),
        hasLevelAndGroup: rows.every((li) => !!li.querySelector('select')),
        expanded: btn.getAttribute('aria-expanded'),
        note: text(dialog).slice(0, 60),
      };
      tid('local-agent-close').click();
      await until(() => !tid('local-agent-dialog'), 3000);
      out.closed = !tid('local-agent-dialog');
      return out;`);
    if (opened.missing) return { ok: false, detail: "open-local-agents button missing" };
    const countOk = /\d+\/\d+ 已配置并加入|查找中|没读到/.test(opened.label);
    return {
      ok: opened.opened && opened.title === "这台电脑" && opened.closed && countOk && opened.expanded === "true",
      detail: `按钮「${opened.label}」 对话框=${opened.opened} 标题=${opened.title} 客户端=${opened.rows}${opened.names?.length ? ` [${opened.names.join(" ")}]` : ""} 已关闭=${opened.closed}`,
    };
  });

  await check("mention-suggestions", async () => {
    const r = await js(`
      const box = tid('composer');
      const { snap } = await roomSnap();
      setValue(box, '@');
      const menu = await until(() => tid('mention-menu'), 4000);
      const all = menu ? $$('[role=option]', menu).map((o) => ({ handle: text(o.querySelector('strong')), meta: text(o.querySelector('em')) })) : [];
      const total = snap.members.agents.length;
      setValue(box, '@' + (snap.members.agents[0] ? snap.members.agents[0].handle.slice(0, 2) : 'zz'));
      await sleep(250);
      const filtered = tid('mention-menu') ? $$('[role=option] strong', tid('mention-menu')).map(text) : [];
      const prefix = '@' + (snap.members.agents[0] ? snap.members.agents[0].handle.slice(0, 2) : 'zz').toLowerCase();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(250);
      const afterEsc = !!tid('mention-menu');
      setValue(box, '@zz-nobody-pagelens ');
      await sleep(300);
      const hint = text(tid('mention-hint'));
      setValue(box, '@zz-nobody-pagelens ' );
      setValue(box, '');
      await sleep(250);
      return { all, total, filtered, prefix, afterEsc, hint, cleared: box.value === '', menuGone: !tid('mention-menu'), hintGone: !tid('mention-hint') };`);
    const problems = [];
    if (!r.all.length) problems.push("typing @ opened no menu");
    if (r.all.length !== Math.min(r.total, 8)) problems.push(`menu rows ${r.all.length} vs agents ${r.total}`);
    if (r.all.some((o) => !/(在线|离线)/.test(o.meta) || !/Lv\d/.test(o.meta))) problems.push("rows lack 在线/离线 or Lv");
    if (!r.filtered.length || r.filtered.some((h) => !h.toLowerCase().startsWith(r.prefix))) problems.push(`filter ${r.prefix} → ${r.filtered}`);
    if (r.afterEsc) problems.push("Esc did not close the menu");
    if (!/不在这个频道/.test(r.hint)) problems.push(`unknown-name hint missing: 「${r.hint}」`);
    if (!r.cleared || !r.menuGone || !r.hintGone) problems.push("composer was not restored");
    return { ok: problems.length === 0, detail: problems.join("; ") || `菜单 ${r.all.length} 项 (${r.all.slice(0, 3).map((o) => o.handle).join(" ")}…), 前缀过滤, Esc 关闭, 未知名提示「${r.hint}」, 已清空` };
  });

  await check("message-modes(下指令/发言/提问)", async () => {
    const r = await js(`
      const radios = $$('.kinds [role=radio]').map((b) => ({ label: text(b), on: b.getAttribute('aria-checked') === 'true' }));
      const seen = {};
      const read = () => ({ extra: !!tid('acceptance'), tags: !!tid('task-tags'), parallel: !!tid('parallel'), complex: !!tid('complex'), placeholder: tid('composer').placeholder.slice(0, 14), sendDisabled: tid('send').disabled });
      seen.instruction = read();
      tid('kind-chat').click(); await sleep(250); seen.chat = read(); seen.chatOn = tid('kind-chat').getAttribute('aria-checked');
      tid('kind-question').click(); await sleep(250); seen.question = read();
      tid('kind-instruction').click(); await sleep(250); seen.back = tid('kind-instruction').getAttribute('aria-checked');
      return { radios, seen };`);
    const labels = r.radios.map((x) => x.label).join("/");
    const s = r.seen;
    const problems = [];
    if (labels !== "发起任务/发言/提问") problems.push(`radios ${labels}`);
    if (!(s.instruction.extra && s.instruction.tags && s.instruction.parallel && s.instruction.complex)) problems.push("下指令 lacks 验收/标签/并行/复杂");
    if (s.chat.extra || s.question.extra) problems.push("发言/提问 should hide task fields");
    if (s.chatOn !== "true" || s.back !== "true") problems.push("aria-checked did not follow");
    if (!s.instruction.sendDisabled) problems.push("发送 is enabled with an empty box");
    return { ok: problems.length === 0, detail: problems.join("; ") || "三种模式可切换，任务字段只在下指令出现，空输入不能发送" };
  });

  await check("task-panel-slots", async () => {
    const r = await js(`
      await expandTasks();
      const { snap } = await roomSnap();
      const cards = $$('[data-testid="task-list"] > article.task');
      const info = cards.map((c) => ({
        title: text(c.querySelector('header h3')), status: text(c.querySelector('header .pill')),
        slots: $$('.slots > li', c).map((li) => text(li)), steps: $$('.steps > li', c).length, lanes: $$('.lanes', c).length,
      }));
      return { info, top: snap.tasks.filter((t) => !t.parentId).length, empty: text(tid('task-list')).includes('还没有指令') };`);
    if (r.info.length === 0) return r.empty ? { skip: "no tasks in this room to read" } : { ok: false, detail: "task list rendered no cards" };
    const problems = [];
    if (r.info.length !== r.top) problems.push(`cards ${r.info.length} vs api ${r.top}`);
    for (const c of r.info) {
      if (c.lanes) continue;
      const labels = c.slots.map((s) => s.split(" ")[0]).join("/");
      if (labels !== "实现/评审/测试") problems.push(`「${c.title}」slots ${labels}`);
      if (c.steps < 4) problems.push(`「${c.title}」steps ${c.steps}`);
    }
    return { ok: problems.length === 0, detail: problems.join("; ") || `${r.info.length} 张卡，实现/评审/测试三个槽位都在 (${r.info.slice(-1)[0].status}: ${r.info.slice(-1)[0].slots.join(" | ")})` };
  });

  await check("presence-heartbeat-online", async () => {
    const r = await js(`
      const me = await api('/api/me');
      const { snap } = await roomSnap();
      const ui = Object.fromEntries($$('.person-agents > li').map((a) => [text(a.querySelector('.handle strong')), a.querySelector('.dot').classList.contains('on')]));
      return { me: me.agents, snap: snap.members.agents.map((a) => ({ handle: a.handle, online: a.online, paused: a.paused })), ui, now: Date.now() };`);
    const problems = [];
    const rows = [];
    for (const a of r.snap) {
      const mine = r.me.find((m) => m.handle === a.handle);
      const fresh = mine?.last_seen_at ? r.now - Date.parse(mine.last_seen_at) < PRESENCE_MS : false;
      const expected = !a.paused && fresh;
      if (mine && Boolean(a.online) !== expected && Math.abs(r.now - Date.parse(mine.last_seen_at || 0) - PRESENCE_MS) > 15_000) problems.push(`${a.handle} api online=${a.online} but last_seen says ${expected}`);
      if (a.handle in r.ui && r.ui[a.handle] !== Boolean(a.online)) problems.push(`${a.handle} dot ${r.ui[a.handle]} vs api ${a.online}`);
      rows.push(`${a.handle}:${a.online ? "在线" : "离线"}`);
    }
    return { ok: problems.length === 0 && rows.length > 0, detail: problems.join("; ") || `UI 圆点 = API online = 5 分钟内有动静（${rows.join(" ")}）` };
  });

  await check("theme", async () => {
    const r = await js(`
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return { scheme: root.colorScheme, bg: body.backgroundColor, fg: body.color, bgLum: lum(rgb(body.backgroundColor)), fgLum: lum(rgb(body.color)), toggle: !!$('[data-testid*=theme], [aria-label*=主题]') };`);
    const dark = r.bgLum < 0.15 && r.fgLum > 0.5;
    return { ok: r.scheme.includes("dark") && dark, detail: `color-scheme=${r.scheme} bg=${r.bg} fg=${r.fg}${r.toggle ? "" : "（没有主题开关，只有深色）"}` };
  });
}

// ---------------------------------------------------------------- DB (read-only) owner migration

async function ownerMigrationCheck() {
  await check("owner-migration (db, read-only)", async () => {
    const db = new DatabaseSync(resolve(ROOT, dbArg), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT a.handle, a.level, a.paused, a.demo, u.name AS owner FROM agents a JOIN users u ON u.id = a.owner_user_id WHERE u.name = ?")
        .all(expectName || "彭磊");
      const by = Object.fromEntries(rows.map((r) => [r.handle, r]));
      const want = expectAgents.length ? expectAgents : ["cursor", "chatgpt", "claude-desk"];
      const problems = [];
      for (const handle of want) {
        const row = by[handle];
        if (!row) problems.push(`${handle} not owned`);
        else if (row.level !== 1 || row.paused) problems.push(`${handle} level=${row.level} paused=${row.paused}`);
      }
      const old = rows.filter((r) => r.handle.endsWith("-old"));
      if (old.some((r) => !r.paused)) problems.push("an -old agent is not paused");
      return { ok: problems.length === 0, detail: problems.join("; ") || `${want.join("/")} 属于 ${expectName || "彭磊"} 且 Lv1；旧的 ${old.map((r) => `${r.handle}(Lv${r.level},已暂停)`).join(" ") || "无"}` };
    } finally {
      db.close();
    }
  });
}

// ---------------------------------------------------------------- temp-only write checks

async function tempWriteChecks() {
  const cookieHeader = (await tempApi("/api/session", { body: { name: tempName } })).headers.get("set-cookie");
  temp.cookie = cookieHeader.split(";")[0];
  const me = (await tempApi("/api/me")).data;
  const hall = me.rooms.find((room) => room.general);

  await check("gate-enter (temp)", async () => {
    const r = await js(`
      const gate = await until(() => tid('name-input'), 8000);
      if (!gate) return { gate: false, shell: !!$('.shell') };
      setValue(gate, ${JSON.stringify(tempName)});
      await sleep(200);
      tid('enter').click();
      const shell = await until(() => $('.shell'), 10000);
      await until(() => $('.channel-head .you'), 8000);
      return { gate: true, shell: !!shell, you: text($('.channel-head .you')), demoGroup: text($('.roster .person-head em')) };`);
    return { ok: r.gate && r.shell && r.you === `你是 ${tempName}` && /人 · 4 个 agent/.test(r.demoGroup), detail: `「${r.you}」在场「${r.demoGroup}」` };
  });

  const enroll = async (handle, tags) => {
    const code = (await tempApi(`/api/rooms/${hall.id}/join-codes`, { body: {} })).data.code;
    const joined = await tempApi("/api/enroll", { body: { code, handle, runtime: handle, tags, level: 1, machine: "pagelens-mac", cwd: "/tmp/pagelens" } });
    return joined.data.token;
  };
  const tokens = {};
  for (const [handle, tags] of [["cursor", "build"], ["chatgpt", "build"], ["claude-desk", "build"], ["rev-bot", "review"], ["qa-bot", "test"]]) tokens[handle] = await enroll(handle, tags);
  const snap0 = (await tempApi(`/api/rooms/${hall.id}`)).data;
  for (const a of snap0.members.agents.filter((x) => x.demo && ["reviewer", "qa"].includes(x.handle))) {
    await tempApi(`/api/agents/${a.id}`, { method: "PATCH", body: { paused: true } });
  }

  await check("identity-roster-agents (temp)", async () => {
    const r = await js(`
      const ok = await until(() => $$('.person-agents > li').some((a) => text(a.querySelector('.handle strong')) === 'cursor'), 12000);
      const g = $$('.roster > .person').map((li) => ({ name: text(li.querySelector('.person-head strong')), meta: text(li.querySelector('.person-head em')), handles: $$('.person-agents .handle strong', li).map(text) }));
      return { ok, g };`);
    const self = r.g.find((g) => g.name === tempName);
    return { ok: r.ok && r.g.length === 1 && self?.handles.includes("cursor") && self.handles.length === 9, detail: `${self?.name}「${self?.meta}」${self?.handles.join(" ")}` };
  });

  const onlineOf = (handle) => `(() => { const a = $$('.person-agents > li').find((x) => text(x.querySelector('.handle strong')) === '${handle}'); return a ? a.querySelector('.dot').classList.contains('on') : null; })()`;
  await check("presence-ping (temp)", async () => {
    const before = await js(`return ${onlineOf("cursor")};`);
    await tempApi("/api/agent/ping", { body: {}, token: tokens.cursor });
    const afterPing = await js(`return !!(await until(() => ${onlineOf("cursor")}, 12000));`);
    const others = await js(`return ${onlineOf("chatgpt")};`);
    const db = new DatabaseSync(temp.dbPath);
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE handle = 'cursor'").run(new Date(Date.now() - PRESENCE_MS - 10_000).toISOString());
    db.close();
    const expired = await js(`return !!(await until(() => ${onlineOf("cursor")} === false, 12000));`);
    await tempApi("/api/agent/ping", { body: {}, token: tokens.cursor });
    const back = await js(`return !!(await until(() => ${onlineOf("cursor")}, 12000));`);
    return { ok: before === false && afterPing && others === false && expired && back, detail: `前=${before} ping后在线=${afterPing} 他人=${others} 超时离线=${expired} 再 ping 回来=${back}` };
  });

  const typeAndSend = async (kind, body, extra = {}) =>
    js(`
      tid('kind-${kind}').click(); await sleep(250);
      ${extra.tags ? `setValue(tid('task-tags'), ${JSON.stringify(extra.tags)}); await sleep(100);` : ""}
      setValue(tid('composer'), ${JSON.stringify(body)});
      await sleep(350);
      const hint = text(tid('mention-hint'));
      const disabled = tid('send').disabled;
      tid('send').click();
      await until(() => tid('composer').value === '', 6000);
      return { hint, disabled, cleared: tid('composer').value === '' };`);
  const transcript = (needle) =>
    `(() => { const msgs = $$('[data-testid=transcript] > article.msg').filter((m) => text(m).includes(${JSON.stringify(needle)})); return msgs; })()`;

  await check("named-instruction-direct-dispatch (temp)", async () => {
    const needle = "@cursor 你在线了吗 pagelens-named";
    const sent = await typeAndSend("instruction", needle);
    const r = await js(`
      await until(() => ${transcript(needle)}.length >= 1, 8000);
      await sleep(2500);
      const mine = ${transcript(needle)};
      const own = mine.filter((m) => m.classList.contains('kind-instruction'));
      const bids = $$('[data-testid=transcript] > article.kind-bid').filter((m) => text(m).includes(${JSON.stringify(needle)}));
      const sys = $$('[data-testid=transcript] > p.system').map(text);
      const card = $$('[data-testid=task-list] > article.task').find((c) => text(c.querySelector('h3')) === ${JSON.stringify(needle)});
      return { own: own.length, bids: bids.length, direct: sys.filter((s) => s.includes('不开放投标')).length, open: sys.filter((s) => s.includes('内用 bid')).length,
        pill: card && text(card.querySelector('.pill')), slots: card ? $$('.slots > li', card).map(text) : [], woke: text(tid('composer')) };`);
    const dbRow = new DatabaseSync(temp.dbPath, { readOnly: true });
    const inbox = (handle) =>
      dbRow.prepare("SELECT COUNT(*) n FROM inbox i JOIN agents a ON a.id = i.recipient_id WHERE a.handle = ? AND i.event_type IN ('task_open','bid_open','mention','room')").get(handle).n;
    const counts = { cursor: inbox("cursor"), chatgpt: inbox("chatgpt"), claude: inbox("claude-desk") };
    dbRow.close();
    const ok = sent.cleared && /将叫醒/.test(sent.hint) && sent.hint.includes("@cursor") && r.own === 1 && r.bids === 0 && r.direct === 1 && r.open === 0 && r.pill === "待认领" && r.slots.every((s) => s.endsWith("空")) && counts.chatgpt === 0 && counts.claude === 0 && counts.cursor === 1;
    return { ok, detail: `hint「${sent.hint}」 指令副本=${r.own} 投标=${r.bids} 直派提示=${r.direct} 开放投标提示=${r.open} 卡片=${r.pill} 收件箱 cursor/chatgpt/claude=${counts.cursor}/${counts.chatgpt}/${counts.claude}` };
  });

  await check("open-instruction-bidding (temp)", async () => {
    const needle = "整理一下 README pagelens-open";
    const sent = await typeAndSend("instruction", needle, { tags: "build" });
    const r = await js(`
      await until(() => $$('[data-testid=transcript] > article.kind-bid').length >= 2, 10000);
      await sleep(500);
      const sys = $$('[data-testid=transcript] > p.system').map(text);
      const bids = $$('[data-testid=transcript] > article.kind-bid').filter((m) => text(m).includes(${JSON.stringify(needle)}));
      const own = ${transcript(needle)}.filter((m) => m.classList.contains('kind-instruction'));
      return { own: own.length, bids: bids.length, open: sys.filter((s) => s.includes('内用 bid')).length, direct: sys.filter((s) => s.includes('不开放投标') && s.length > 0).length };`);
    const pill = await js(`
      await expandTasks();
      const card = await until(() => $$('[data-testid=task-list] > article.task').find((c) => text(c.querySelector('h3')) === ${JSON.stringify(needle)}), 5000);
      await until(() => !/投标中/.test(text(card.querySelector('.pill'))), 12000);
      return text(card.querySelector('.pill')) + ' | ' + $$('.slots > li', card).map(text).join(' | ');`);
    return { ok: sent.cleared && r.own === 1 && r.open >= 1 && r.bids >= 2 && !/投标中/.test(pill), detail: `指令副本=${r.own} 开放投标提示=${r.open} 投标=${r.bids} → ${pill}` };
  });

  await check("chat-and-question-modes (temp)", async () => {
    const before = await js("return $$('[data-testid=task-list] > article.task').length;");
    await typeAndSend("chat", "大家好 pagelens-chat");
    await typeAndSend("question", "这个怎么用？ pagelens-question");
    const r = await js(`
      await until(() => ${transcript("pagelens-question")}.length >= 1, 8000);
      return { chat: ${transcript("pagelens-chat")}.map((m) => m.className), q: ${transcript("pagelens-question")}.map((m) => m.className), cards: $$('[data-testid=task-list] > article.task').length };`);
    return { ok: r.chat.length === 1 && /kind-chat/.test(r.chat[0]) && r.q.length === 1 && /kind-question/.test(r.q[0]) && r.cards === before, detail: `发言=${r.chat.length} 提问=${r.q.length} 任务卡 ${before}→${r.cards}（不开新任务）` };
  });

  await check("unknown-name-hint-in-compose (temp)", async () => {
    const r = await js(`
      tid('kind-instruction').click(); await sleep(200);
      setValue(tid('composer'), '@zz-nobody ');
      await sleep(300);
      const solo = text(tid('mention-hint'));
      setValue(tid('composer'), '@cursor @zz-nobody ');
      await sleep(300);
      const mixed = text(tid('mention-hint'));
      setValue(tid('composer'), '');
      await sleep(200);
      return { solo, mixed };`);
    return { ok: /不在这个频道/.test(r.solo) && /所有 agent/.test(r.solo) && /将叫醒.*@cursor/.test(r.mixed) && /不会有人收到/.test(r.mixed), detail: `单个陌生名「${r.solo}」 混合「${r.mixed}」` };
  });

  await check("task-slots-lifecycle (temp)", async () => {
    const needle = "@claude-desk 做个按钮 pagelens-slots";
    await typeAndSend("instruction", needle);
    const list = (await tempApi(`/api/rooms/${hall.id}`)).data;
    const task = list.tasks.find((t) => t.title === needle);
    const call = (path, token, body) => tempApi(path, { body, token });
    await call(`/api/agent/tasks/${task.id}/claim`, tokens["claude-desk"], { role: "implementer" });
    await call(`/api/agent/tasks/${task.id}/deliver`, tokens["claude-desk"], { ref: "workspace:pagelens", summary: "好了" });
    await call(`/api/agent/tasks/${task.id}/claim`, tokens["rev-bot"], { role: "reviewer" });
    const mid = await js(`
      await expandTasks();
      const card = await until(() => $$('[data-testid=task-list] > article.task').find((c) => text(c.querySelector('h3')) === ${JSON.stringify(needle)} && /评审中/.test(text(c.querySelector('.pill')))), 10000);
      return card ? $$('.slots > li', card).map(text) : null;`);
    await call(`/api/agent/tasks/${task.id}/review`, tokens["rev-bot"], { verdict: "approve", body: "过" });
    await call(`/api/agent/tasks/${task.id}/claim`, tokens["qa-bot"], { role: "tester" });
    await call(`/api/agent/tasks/${task.id}/test`, tokens["qa-bot"], { verdict: "pass", body: "过" });
    const end = await js(`
      await expandTasks();
      const card = await until(() => $$('[data-testid=task-list] > article.task').find((c) => text(c.querySelector('h3')) === ${JSON.stringify(needle)} && /完成/.test(text(c.querySelector('.pill')))), 10000);
      return card ? $$('.slots > li', card).map(text) : null;`);
    const ok = mid && mid[0].includes("claude-desk") && mid[0].includes("Lv1") && mid[1].includes("rev-bot") && mid[2].endsWith("空") && end && end[2].includes("qa-bot");
    return { ok: !!ok, detail: `评审中: ${mid?.join(" | ")} → 完成: ${end?.join(" | ")}` };
  });
}

// ---------------------------------------------------------------- main

async function main() {
  if (spawnTemp) {
    console.log("starting a temporary API + Vite on 127.0.0.1 …");
    await startTemp();
    assertSafeTarget(baseUrl, true);
  }
  console.log(`target ${baseUrl}  mode ${spawnTemp ? "temp (writes allowed, temp DB only)" : "live (read-only)"}`);

  const opened = await bridge("open_tab", { url: baseUrl + "/", active: false });
  tabId = opened.tabId;
  try {
    await sleep(1500);
    if (spawnTemp) {
      await tempWriteChecks();
      await readOnlyChecks();
    } else {
      await readOnlyChecks();
      if (dbArg) await ownerMigrationCheck();
      await check("no-writes-from-this-run", async () => {
        const r = await js(`
          const { snap } = await roomSnap();
          return { n: snap.messages.filter((m) => /pagelens|zz-nobody/.test(m.body)).length, composer: tid('composer') ? tid('composer').value : null, modal: !!tid('local-agent-dialog') };`);
        return { ok: r.n === 0 && r.composer === "" && !r.modal, detail: `messages containing smoke markers=${r.n}, composer empty=${r.composer === ""}, modal closed=${!r.modal}` };
      });
    }
  } finally {
    try {
      await bridge("close_tab", { tabId });
    } catch {
      /* tab already closed */
    }
  }
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`FATAL ${error instanceof Error ? error.message : error}`);
} finally {
  if (spawnTemp) stopTemp();
}
const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
console.log(`\nsummary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
process.exit(failed || results.some((r) => r.status === "FAIL") ? 1 : 0);
