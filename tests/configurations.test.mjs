import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configurationStore } from '../plugins/agent-hub/server/configurations.mjs';
import { requestStore } from '../plugins/agent-hub/server/requests.mjs';

test('settings are scoped per chat and backend, and retries use an immutable snapshot', t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-settings-test-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const defaults = { workspace: state };
  let store = configurationStore(state, defaults);
  const parent = { conversationId: 'chat-A', backend: 'dsh' };
  const codex = { ...parent, backend: 'codex' };
  const other = { ...parent, conversationId: 'chat-B' };
  const task = { ...parent, prompt: 'fake task', requestId: 'one', userAuthorized: true };
  assert.equal(store.read(parent).status, 'missing');
  assert.throws(() => store.resolve(task), /Save this Codex conversation/);
  assert.throws(() => store.resolve({ ...task, userAuthorized: false }), /Explicit user permission/);
  const dshDraft = store.create(parent);
  const codexDraft = store.create({ ...codex, workspace: state });
  assert.equal(codexDraft.initialWorkspace, state);
  assert.notEqual(dshDraft.configurationId, codexDraft.configurationId);
  const dshSave = { ...parent, configurationId: dshDraft.configurationId };
  const dshValues = { ...dshDraft.values, model: { provider: 'fake', model: 'original' } };
  assert.throws(() => store.confirm({ ...dshSave, backend: 'codex', values: dshValues }), /Unknown configuration/);
  assert.throws(() => store.confirm({ ...dshSave, values: { ...dshValues, workspace: 'relative' } }), /existing absolute directory/);
  store.confirm({ ...dshSave, values: dshValues, revision: 0 });
  store.confirm({ ...codex, configurationId: codexDraft.configurationId, values: { workspace: state, model: 'codex-selected', effort: 'high', sandbox: 'read-only' } });
  assert.equal(store.read(other).status, 'missing');
  assert.equal(store.read(codex).values.model, 'codex-selected');

  let requests = requestStore(state, store);
  const first = requests.resolve(task);
  assert.throws(() => store.confirm({ ...dshSave, values: dshValues, revision: 0 }), /Configuration changed/);
  store.confirm({ ...dshSave, values: { ...dshValues, model: { provider: 'fake', model: 'updated' } }, revision: 1 });
  assert.equal(requests.resolve({ ...task, requestId: 'two' }).model.model, 'updated');
  assert.equal(requests.resolve(task).model.model, 'original');
  assert.throws(() => requests.resolve({ ...task, prompt: 'different' }), /different arguments/);
  assert.notEqual(requests.resolve({ ...task, backend: 'codex' }).requestId, first.requestId);
  store = configurationStore(state, defaults);
  requests = requestStore(state, store);
  assert.deepEqual(requests.resolve(task), first);
  assert.equal(store.read(codex).values.effort, 'high');
});

test('existing sessions can resume without configuration and keep their original settings', t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-settings-test-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const store = configurationStore(state, { workspace: state });
  const requests = requestStore(state, store);
  const base = { conversationId: 'chat-A', requestId: 'resume', prompt: 'continue', userAuthorized: true, sessionId: 'existing' };
  assert.throws(() => requests.resolve({ ...base, backend: 'dsh' }, 'resume'), /original|mode/);
  for (const backend of ['dsh', 'codex']) {
    const mode = backend === 'dsh' ? { mode: 'desktop' } : {};
    assert.equal(store.read({ ...base, backend }).status, 'missing');
    const resume = requests.resolve({ ...base, backend, ...mode }, 'resume');
    assert.equal(resume.sessionId, 'existing');
    for (const key of ['workspace', 'preset', 'permission', 'model', 'sandbox', 'configurationId']) assert.equal(resume[key], undefined);
  }
});
