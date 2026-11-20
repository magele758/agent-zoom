import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

export async function checkChannelReply(page, origin) {
  const call = async (path, data, headers) => {
    const response = await page.request.fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', data, headers });
    assert.ok(response.ok(), `${path}: HTTP ${response.status()}`);
    return response.json();
  };
  const original = (await call('/api/me')).user;
  const legacyA = await call('/api/session', { name: '旧入口甲' });
  assert.equal(legacyA.user.id, original.id);
  const handle = 'qa-' + randomUUID().slice(0, 8);
  const room = await call('/api/rooms', { name: '原频道回复 ' + handle, project: '浏览器验收' });
  const messages = `/api/rooms/${room.id}/messages`;
  const agentMessages = `/api/agent/rooms/${room.id}/messages`;
  const join = await call(`/api/rooms/${room.id}/join-codes`, {});
  const worker = await call('/api/enroll', { code: join.code, handle, runtime: 'browser-fixture', tags: 'build' });
  const agentHeaders = { authorization: 'Bearer ' + worker.token };
  const { task } = await call(messages, { kind: 'instruction', body: `@${handle} 检查导出格式` });
  await call(`/api/agent/tasks/${task.id}/claim`, { role: 'implementer' }, agentHeaders);
  const { message: question } = await call(agentMessages, { kind: 'blocked', taskId: task.id, body: '验收文件采用哪个导出格式？' }, agentHeaders);
  const reply = { kind: 'chat', body: '导出 CSV，保留表头。', replyTo: question.id };

  const fresh = await page.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  let first;
  try {
    const legacyB = await fresh.request.post(origin + '/api/session', { data: { name: '旧入口乙' } });
    assert.ok(legacyB.ok());
    assert.equal((await legacyB.json()).user.id, original.id);
    await fresh.clearCookies();
    const second = await fresh.newPage();
    await second.goto(origin + '/#inbox');
    await expect(second.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
    await expect(second.getByTestId('name-input')).toHaveCount(0);
    const me = await (await second.request.get(origin + '/api/me')).json();
    assert.equal(me.user.id, original.id);
    assert.ok(me.rooms.some(entry => entry.id === room.id));
    const row = second.getByRole('region', { name: '待处理', exact: true }).getByTestId('zoom-message-channel:' + question.id);
    await row.click();
    await second.getByLabel('回复原任务').fill(reply.body);
    const sent = second.waitForResponse(response => response.url() === origin + messages && response.request().method() === 'POST');
    await second.getByRole('button', { name: '发送回复', exact: true }).click();
    const receipt = await sent;
    assert.ok(receipt.ok(), '从新浏览器回复原频道失败');
    first = (await receipt.json()).message;
    assert.equal(first.taskId, task.id);
    assert.equal(first.authorId, original.id);
  } finally {
    await fresh.close();
  }

  await page.goto(origin + '/#inbox');
  await page.reload();
  await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
  const notices = async () => (await call('/api/inbox/pending', undefined, agentHeaders)).events
    .filter(event => event.summary === reply.body && event.room_id === room.id);
  const initial = await notices();
  assert.equal(initial.length, 1, '一次答复应只通知原提问 agent 一次');
  assert.equal(initial[0].ref_id, task.id, '答复通知应指向原任务');
  const duplicate = await call(messages, reply);
  assert.equal(duplicate.message.id, first.id, '重试应返回之前的频道消息');
  assert.deepEqual(await notices(), [], '重试不能再次通知提问 agent');
  const history = await call(agentMessages, undefined, agentHeaders);
  assert.deepEqual(history.messages.filter(message => message.body === reply.body).map(message => [message.id, message.taskId]), [[first.id, task.id]]);
  const feed = (await call('/api/zoom/messages')).messages;
  assert.equal(feed.find(item => item.id === 'channel:' + question.id)?.pending, false);
  assert.deepEqual(feed.filter(item => item.replyTo === 'channel:' + question.id).map(item => item.id), ['channel:' + first.id]);
}
