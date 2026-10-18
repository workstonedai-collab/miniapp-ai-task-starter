import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { TaskService } from '../src/service.js';
import { createServer } from '../src/server.js';

test('save failure, duplicate request, fresh service and retry reuse generated output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-example-')); let calls = 0;
  try {
    const service = new TaskService(directory, { generate: async () => { calls++; return { text: 'Fictional output' }; } });
    const input = { key: 'fixture-request', topic: 'A garden' }, first = await service.create(input);
    await service.settle(first.id); assert.equal((await service.progress(first.id)).status, 'failed');
    assert.equal((await service.create(input)).replayed, true); assert.equal(calls, 1);
    const reopened = new TaskService(directory, { generate: async () => { throw Error('Must reuse'); } });
    await reopened.retry(first.id); await reopened.settle(first.id);
    assert.equal((await reopened.progress(first.id)).progress, 100);
    assert.equal((await reopened.result(first.id)).result.text, 'Fictional output');
    assert.equal(JSON.stringify(await reopened.progress(first.id)).includes('Fictional output'), false);
    await assert.rejects(service.create({ ...input, topic: 'Different' }), { code: 'CONFLICT' });
    await assert.rejects(service.progress('../outside'), { code: 'INVALID_INPUT' });
    assert.equal(calls, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('local HTTP create/progress/retry/result path and foreign origin rejection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-http-')), service = new TaskService(directory), server = createServer(service);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Demo': '1', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/tasks', {}, { Origin: 'https://example.org' })).status, 403);
    const created = await post('/tasks', { key: 'http-fixture', topic: 'Example' });
    assert.equal(created.status, 202); const { id } = await created.json(); await service.settle(id);
    assert.equal((await (await fetch(base + '/tasks/' + id)).json()).status, 'failed');
    assert.equal((await post('/tasks/' + id + '/retry', {})).status, 202); await service.settle(id);
    assert.equal((await (await fetch(base + '/tasks/' + id + '/result')).json()).version, 1);
    assert.equal((await fetch(base + '/')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
});
test('miniapp hide stops polling and a late response cannot update a hidden page', async () => {
  let definition, success, updates = 0, timers = 0;
  const source = await fs.readFile(new URL('../miniprogram/pages/task/task.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { Page: value => { definition = value; }, wx: { request: value => { success = value.success; } }, setTimeout: () => { timers++; }, clearTimeout: () => {}, Error, Promise, JSON, Date, Math });
  const page = { ...definition, data: { ...definition.data, jobId: 'fixture' }, visible: true, setData: () => { updates++; } };
  const request = page.refresh(); page.onHide(); success({ statusCode: 200, data: { status: 'running', progress: 50 } }); await request;
  assert.equal(updates, 0); assert.equal(timers, 0);
});
