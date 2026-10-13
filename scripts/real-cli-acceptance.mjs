// Explicitly invoked real-model acceptance; isolated server, credentials and repo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'kunlun-real-acceptance-'));
const repo = join(dir, 'repo'); mkdirSync(repo);
const output = resolve(root, 'data/validation/full-2026-10-12'); mkdirSync(output, { recursive: true });
const children = [];
const evidence = { startedAt: new Date().toISOString(), directory: dir, checks: [], status: 'running' };
const save = () => writeFileSync(join(output, 'real-cli.json'), JSON.stringify(evidence, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const launch = (bin, args, env, log, cwd = root) => {
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push(child); const stream = createWriteStream(join(output, log)); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false }); child.on('close', () => stream.end()); return child;
};
const command = async (bin, args, env, log, cwd, timeout = 180000) => {
  const child = launch(bin, args, env, log, cwd);
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout);
  try { const code = await new Promise((done, fail) => { child.on('error', fail); child.on('close', done); }); assert.equal(code, 0, `${bin} failed; see ${log}`); } finally { clearTimeout(timer); }
};
try {
  await command('git', ['init', '-q', '-b', 'main'], {}, 'git.log', repo);
  const port = await new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const creds = join(dir, 'credentials.json');
  launch(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], { PORT: String(port), DATA_PATH: join(dir, 'test.db'), DEMO_MODE: '0', AGENT_CHATROOM_CREDENTIALS: creds }, 'server.log');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(100); }
  const enter = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '真实自动验收' }) });
  assert.ok(enter.ok); const cookie = enter.headers.get('set-cookie').split(';')[0];
  const call = async (path, data, token) => { const r = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : { cookie }) }, body: data ? JSON.stringify(data) : undefined }); const out = await r.json(); assert.ok(r.ok, `${path}: ${JSON.stringify(out)}`); return out; };
  const room = await call('/api/rooms', { name: '真实 CLI 全链路验收', topic: '隔离验收，禁止演示代答', project: 'acceptance', directories: [repo], branch: 'main' });
  evidence.roomId = room.id;
  const agents = {};
  for (const [handle, tags, runtime] of [['real-build', 'build', 'codex-cli'], ['real-review', 'review', 'claude-cli'], ['real-test', 'test', 'claude-cli']]) {
    const code = await call(`/api/rooms/${room.id}/join-codes`, {});
    const a = await call('/api/enroll', { code: code.code, handle, tags, runtime, cwd: repo });
    agents[handle] = { token: a.token, roomId: room.id, runtime };
  }
  writeFileSync(creds, JSON.stringify({ url: base, agents }), { mode: 0o600 });
  launch(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/adapter.ts', '--handle', 'real-build'], { ADAPTER: 'codex', AGENT_CHATROOM_CREDENTIALS: creds, CLI_TIMEOUT_MS: '180000', ADAPTER_STATE_DIR: join(dir, 'adapter-state') }, 'build-adapter.log');
  const posted = await call(`/api/rooms/${room.id}/messages`, { kind: 'instruction', body: '@real-build 在当前目录实现 src/normalize-title.mjs，导出 normalizeTitle(input)：只接受字符串，否则抛 TypeError；去掉首尾空白，内部连续空白（含换行与制表符）合并成一个空格；结果为空时抛 TypeError。不得破坏中文和 emoji。添加 Node 内置测试并实际运行 node --test。不要安装依赖。交付实际代码路径和测试结果。', acceptance: '独立检查字符串规范化、中文/emoji 保留、非字符串和空白输入拒绝；node --test 通过。' });
  evidence.taskId = posted.task.id; save(); console.log(`真实 Codex 任务已创建：${posted.task.id}`);
  let task;
  const deadline = Date.now() + 210000;
  do { task = (await call(`/api/rooms/${room.id}`)).tasks.find(t => t.id === evidence.taskId); if (task.status === 'in_review') break; await sleep(1000); } while (Date.now() < deadline);
  assert.equal(task.status, 'in_review', '真实实现未交付到评审阶段');
  const modulePath = join(repo, 'src/normalize-title.mjs');
  const oracle = join(dir, 'oracle.mjs');
  writeFileSync(oracle, `import assert from 'node:assert/strict';\nimport {normalizeTitle} from ${JSON.stringify(modulePath)};\nassert.equal(normalizeTitle('  hello\\t world\\n next  '),'hello world next');\nassert.equal(normalizeTitle('  昆仑   🤖 团队  '),'昆仑 🤖 团队');\nassert.equal(normalizeTitle('x'),'x');\nfor(const value of ['', ' \\n\\t ', null, undefined, 42, {}, []]) assert.throws(()=>normalizeTitle(value),TypeError);\nconsole.log('独立 oracle 全部通过');\n`);
  await command(process.execPath, [oracle], {}, 'independent-oracle.log', repo);
  await command(process.execPath, ['--test'], {}, 'independent-node-tests.log', repo);
  evidence.checks.push('真实 Codex 实现、实际文件、独立 oracle 与 Node 测试通过'); save(); console.log('实际文件独立验证通过，开始真实 Claude 评审');
  const inspect = async (handle, role, tool, verdict, log) => {
    const config = join(dir, `${handle}-mcp.json`);
    writeFileSync(config, JSON.stringify({ mcpServers: { 'agent-chatroom': { command: process.execPath, args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), 'mcp', '--credentials', creds, '--handle', handle] } } }), { mode: 0o600 });
    const prompt = `只做真实任务验收，不修改任何文件。用 agent-chatroom whoami 确认 ${handle}，get_task 读取任务 ${evidence.taskId}；实际读取 ${modulePath} 和测试文件，运行 node --test 以及 node ${oracle}。如果实际通过，用 claim(taskId,role=${role}) 认领，然后 ${tool}(taskId,verdict=${verdict},body=你的独立验收理由和实际测试结果)。不通过就如实提交拒绝/失败，禁止假通过，不要 wait。`;
    await command('claude', ['--print', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', config, '--allowedTools', 'Read', 'Bash', 'mcp__agent-chatroom__*', '--', prompt], {}, log, repo);
  };
  await inspect('real-review', 'reviewer', 'review', 'approve', 'claude-review.log');
  task = (await call(`/api/rooms/${room.id}`)).tasks.find(t => t.id === evidence.taskId);
  assert.equal(task.status, 'in_test', 'Claude 没有提交真实通过评审');
  evidence.checks.push('独立 Claude CLI 评审后进入测试'); save(); console.log('真实评审完成，开始独立 Claude 测试会话');
  await inspect('real-test', 'tester', 'report_test', 'pass', 'claude-test.log');
  task = (await call(`/api/rooms/${room.id}`)).tasks.find(t => t.id === evidence.taskId);
  assert.equal(task.status, 'done', '独立客户端未将任务测试通过');
  assert.ok(task.evidence.some(e => e.handle === 'real-review') && task.evidence.some(e => e.handle === 'real-test'));
  evidence.checks.push('独立 Claude CLI 测试，任务 done，评审/测试原文存在');
  evidence.task = task; evidence.status = 'passed'; evidence.finishedAt = new Date().toISOString(); save();
  console.log('真实三客户端全链路验收通过');
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; evidence.finishedAt = new Date().toISOString(); save(); console.error(error.message); process.exitCode = 1; }
finally { for (const child of children) { if (child.exitCode == null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } } await sleep(1200); for (const child of children) { if (child.exitCode == null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } } }
