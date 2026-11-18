import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFile, spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {fakeConfig,fakeBridgeState,fakeCodexState} from './fixtures.mjs';
import {VERSION} from '../plugins/agent-hub/server/common.mjs';

test('new-machine setup accepts a custom workspace and preserves it and its token on later setup',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-setup-test-'));
  try{
    const config=fakeConfig(root);const state=path.join(root,'state'),workspace=path.join(root,'workspace');
    const env={...process.env,DSH_BRIDGE_STATE_DIR:fakeBridgeState(root),DSH_HOME:path.join(root,'dsh'),CODEX_AGENT_HUB_STATE_DIR:state,CODEX_AGENT_HUB_WORKSPACE:workspace};
    fs.mkdirSync(workspace);
    env.CODEX_BRIDGE_STATE_DIR = path.join(root, 'missing-codex');
    const run=()=>{const result=spawnSync(process.execPath,[fileURLToPath(new URL('../plugins/agent-hub/server/setup.mjs',import.meta.url))],{env,windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(fs.readFileSync(path.join(state,'config.json')))};
    const profile=path.join(env.DSH_HOME,'profiles/desktop/package.json');fs.mkdirSync(path.dirname(profile),{recursive:true});fs.writeFileSync(profile,'keep profile');
    const first=run();assert.equal(fs.readFileSync(profile,'utf8'),'keep profile');assert.equal(fs.existsSync(path.join(env.DSH_HOME,'profiles/codex-worker')),false);assert.deepEqual(Object.keys(first).sort(),['defaults','sourceRoot','token']);assert.equal(first.defaults.workspace,workspace);assert.ok(fs.statSync(workspace).isDirectory());
    delete env.CODEX_AGENT_HUB_WORKSPACE;const again=run();assert.equal(again.defaults.workspace,workspace);assert.equal(again.token,first.token);
    const backups=fs.readdirSync(path.join(state,'backups')).map(name=>path.join(state,'backups',name,'config.json')).filter(file=>fs.existsSync(file));
    assert.equal(backups.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(backups[0])),first);
  }finally{
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-setup-test-'));fs.rmSync(root,{recursive:true,force:true});
  }
});

test('setup preserves an in-flight legacy retry, then replaces the idle supervisor', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-upgrade-test-'));
  const state = path.join(root, 'state');
  const legacy = path.join(root, 'legacy');
  const server = fileURLToPath(new URL('../plugins/agent-hub/server/', import.meta.url));
  const receipt = path.join(state, 'supervisor.json');
  const mirror = path.join(state, 'supervisor-jobs.json');
  const configFile = path.join(state, 'config.json');
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  const env = { ...process.env, CODEX_AGENT_HUB_STATE_DIR: state, CODEX_THREAD_ID: 'upgrade-chat',
    CODEX_AGENT_HUB_WORKSPACE: root, DSH_BRIDGE_STATE_DIR: path.join(root, 'missing-dsh'), CODEX_BRIDGE_STATE_DIR: path.join(root, 'missing-codex') };
  const run = (name, ...args) => promisify(execFile)(process.execPath, [path.join(server, name), ...args], { env, windowsHide: true, timeout: 12000 });
  t.after(async () => {
    if (fs.existsSync(receipt)) {
      const { pid } = read(receipt);
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
        await delay(20);
      }
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('codex-dsh-upgrade-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(state);
  fs.cpSync(server, legacy, { recursive: true });
  const common = path.join(legacy, 'common.mjs');
  fs.writeFileSync(common, fs.readFileSync(common, 'utf8').replace("VERSION = '" + VERSION + "'", "VERSION = '0.8.0'"));
  fs.writeFileSync(path.join(legacy, 'panel.mjs'), 'export const statusPanel = () => ({ ensure: async () => ({}), rendered: async () => ({}), status: () => ({}) });');
  let started = 0;
  let onRetry;
  const retryArrived = new Promise(resolve => { onRetry = resolve; });
  const bridge = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { method, params } = JSON.parse(body);
    if (method !== 'start') return response.end(JSON.stringify({ result: { cursor: 0, jobs: [] } }));
    if (++started === 1) return response.end(JSON.stringify({ error: { message: 'fake start failed' } }));
    const job = { jobId: 'test-job', sessionId: 'test-session', requestId: params.requestId, status: 'completed', createdAt: new Date().toISOString(), result: 'fake result' };
    onRetry(() => response.end(JSON.stringify({ result: job })));
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.closeAllConnections(); bridge.close(); });
  env.CODEX_BRIDGE_STATE_DIR = fakeCodexState(root, 'http://127.0.0.1:' + bridge.address().port);
  write(configFile, { token: 'test-token', sourceRoot: root, defaults: { workspace: root } });
  const configuration = { conversationId: 'upgrade-chat', backend: 'codex', configurationId: 'prior', revision: 2, status: 'ready', values: { workspace: root } };
  write(path.join(state, 'configurations.json'), { [JSON.stringify(['upgrade-chat', 'codex'])]: configuration });
  const child = spawn(process.execPath, [path.join(legacy, 'supervisor.mjs')], { env, windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  for (let i = 0; i < 100 && !(fs.existsSync(receipt) && fs.existsSync(mirror)); i++) await delay(50);
  const before = read(receipt);
  assert.equal(before.pid, child.pid);
  const headers = { authorization: 'Bearer test-token', connection: 'close' };
  const health = info => fetch(info.url + '/health', { headers }).then(response => response.json());
  assert.equal((await health(before)).version, '0.8.0');
  const legacyMirror = read(mirror);
  write(mirror, { jobs: [{ status: 'running' }] });
  await assert.rejects(run('setup.mjs'), /Wait for Agent Hub tasks to finish/);
  assert.equal(read(receipt).pid, before.pid);
  assert.equal((await health(before)).version, '0.8.0');
  await assert.rejects(run('control.mjs', 'configuration', '{"backend":"codex"}'), /setup\.mjs to upgrade/);
  write(mirror, legacyMirror);
  const dispatch = () => fetch(before.url + '/api', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'start', params: { conversationId: 'upgrade-chat', backend: 'codex', requestId: 'retry', prompt: 'fake prompt', userAuthorized: true } }) }).then(response => response.json());
  assert.match((await dispatch()).error.message, /fake start failed/);
  const expired = new Date(Date.now() - 120000);
  const requests = path.join(state, 'dispatch-requests.json');
  fs.utimesSync(requests, expired, expired);
  const retry = dispatch();
  const finishRetry = await retryArrived;
  try {
    await assert.rejects(run('setup.mjs'), /old Agent Hub supervisor still has open connections/);
    assert.equal(read(receipt).pid, before.pid);
    assert.ok(fs.statSync(requests).mtimeMs < Date.now() - 100000);
  } finally {
    finishRetry();
    assert.equal((await retry).result.result, 'fake result');
  }
  await run('setup.mjs');
  const after = read(receipt);
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal(after.url, before.url);
  assert.equal((await health(after)).version, VERSION);
  assert.equal(read(configFile).token, 'test-token');
  assert.deepEqual(JSON.parse((await run('control.mjs', 'configuration', '{"backend":"codex"}')).stdout),
    { ...configuration, subagentRoute: 'agent-hub' });
  assert.equal(read(mirror).jobs[0].result, 'fake result');
  await run('setup.mjs');
  assert.equal(read(receipt).instanceId, after.instanceId);
});
