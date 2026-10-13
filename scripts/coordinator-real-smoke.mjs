import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'kunlun-coordination-'));
const output = resolve(root, 'data/validation/full-2026-10-12'); mkdirSync(output, { recursive: true });
const port = await new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_PATH: join(dir, 'test.db'), DEMO_MODE: '0', AGENT_CHATROOM_CREDENTIALS: join(dir, 'credentials.json') }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const log = createWriteStream(join(output, 'coordinator-server.log')); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
const evidence = { status: 'running', startedAt: new Date().toISOString(), checks: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(100); }
  const enter = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '真实协调模型验收' }) });
  const cookie = enter.headers.get('set-cookie').split(';')[0];
  const call = async (path, data) => { const r = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }); const out = await r.json(); assert.ok(r.ok, JSON.stringify(out)); return out; };
  const room = (await call('/api/me')).rooms[0];
  const code = await call(`/api/rooms/${room.id}/join-codes`, {});
  await call('/api/enroll', { code: code.code, handle: 'coord-target', runtime: 'acceptance-fixture-no-executor', tags: 'build', cwd: dir });
  const info = await call('/api/coordinator'); evidence.model = info.model; assert.equal(info.configured, true);
  const started = await call(`/api/rooms/${room.id}/coordination`, { prompt: '生成一条普通 task 派发建议，指定 coord-target。需求是在本频道说明字符串标题规范化函数的实现方案；验收是列出非字符串、空白、中文和 emoji 的处理规则。不要采用 pipeline，不增加客户端。仅生成建议等待确认，不能先派发。' });
  let run; const deadline = Date.now() + 150000;
  do { run = await call(`/api/coordination/${started.id}`); if (run.status !== 'running') break; await sleep(1000); } while (Date.now() < deadline);
  assert.equal(run.status, 'ready', `真实协调模型没有生成待确认建议：${run.error ?? run.status}`);
  assert.equal((await call(`/api/rooms/${room.id}`)).tasks.length, 0);
  const applied = await call(`/api/coordination/${started.id}/apply`, {});
  const again = await call(`/api/coordination/${started.id}/apply`, {});
  assert.equal(applied.task.id, again.task.id);
  assert.equal((await call(`/api/rooms/${room.id}`)).tasks.length, 1);
  evidence.checks.push('真实模型生成待确认建议，确认前零任务，重复确认只创建一条任务');
  evidence.run = run; evidence.taskId = applied.task.id; evidence.execution = 'not tested: target is an isolated registration fixture, not a CLI executor'; evidence.status = 'passed';
  console.log('真实协调模型的建议、确认、防重复派发通过；目标执行不计入本项');
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; process.exitCode = 1; console.error(error.message); }
finally { evidence.finishedAt = new Date().toISOString(); writeFileSync(join(output, 'coordinator-real.json'), JSON.stringify(evidence, null, 2)); try { process.kill(-child.pid, 'SIGTERM'); } catch {} log.end(); }
