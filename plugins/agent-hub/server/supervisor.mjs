import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ROOT, STATE, VERSION, config, readJson, atomic, equal, terminal, backendOf, supervisorLock, enterStateDirectory } from './common.mjs';
import { configurationStore } from './configurations.mjs';
import { requestStore } from './requests.mjs';
import { statusPanel } from './panel.mjs';
import { runtimeRecords, conversationId } from './records.mjs';
import { groupSubagents } from './subagents.mjs';
import { loadBridge, loadCodexBridge } from './bridge.mjs';
import { catalogReader } from './catalogs.mjs';

enterStateDirectory();
const cfg = config();
const instanceId = randomUUID();
const lock = net.createServer();
try { await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(supervisorLock, resolve); }); }
catch { process.exit(0); }

const loaders = { dsh: loadBridge, codex: loadCodexBridge };
const bridges = new Map();
function bridge(backend) {
  if (!bridges.has(backend)) {
    bridges.set(backend, loaders[backend]().catch(error => {
      bridges.delete(backend);
      throw error;
    }));
  }
  return bridges.get(backend);
}

const configurations = configurationStore(STATE, cfg.defaults);
const requests = requestStore(STATE, configurations);
const changes = new EventEmitter();
changes.setMaxListeners(200);
const streams = new Set();
const jobs = new Map();
const providers = { desktop: { connected: false }, headless: { connected: false }, codex: { connected: false } };
const monitoring = new Set();
const dispatching = new Map();
const resuming = new Set();
const panels = new Map();
const views = new Map();
let cursor = 0;
let baseUrl;
const mirror = path.join(STATE, 'supervisor-jobs.json');
if (fs.existsSync(mirror)) for (const job of readJson(mirror).jobs ?? []) jobs.set(job.jobId, job);
const records = runtimeRecords(STATE, jobs, requests);
for (const [id, job] of jobs) jobs.set(id, records.decorate(job));
if (records.cleanup().removed) atomic(mirror, { jobs: [...jobs.values()] });

const dashboardUrl = id => baseUrl + '/?conversationId=' + encodeURIComponent(id) + '#' + cfg.token;
const compact = job => {
  const { events, reservation, prompt, ...rest } = job;
  return { ...rest, ...(events ? { recentEvents: events.slice(-12) } : {}) };
};
function snapshot(id) {
  const owned = [...jobs.values()].filter(job => records.owns(job, id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(compact);
  return { instanceId, cursor, conversationId: id, providers, viewRequest: views.get(id), panel: getPanel(id).status(),
    retention: records.status(), jobs: owned, subagents: groupSubagents(owned) };
}
function sendSnapshot(stream) {
  if (stream.response.destroyed || stream.response.writableEnded) return;
  if (stream.blocked) { stream.needsSnapshot = true; return; }
  if (stream.response.write('data: ' + JSON.stringify(snapshot(stream.conversationId)) + '\n\n')) return;
  stream.blocked = true;
  stream.response.once('drain', () => {
    stream.blocked = false;
    if (stream.needsSnapshot) { stream.needsSnapshot = false; sendSnapshot(stream); }
  });
}
function refresh(id) {
  for (const stream of streams) if (stream.conversationId === id) sendSnapshot(stream);
}
function publish() {
  records.cleanup();
  cursor++;
  atomic(mirror, { jobs: [...jobs.values()] });
  changes.emit('change');
  for (const stream of streams) sendSnapshot(stream);
}
function getPanel(id) {
  if (!panels.has(id)) panels.set(id, statusPanel({ url: () => dashboardUrl(id), state: STATE, refresh: () => refresh(id) }));
  return panels.get(id);
}
async function showPanel(id, view, backend) {
  views.set(id, { id: randomUUID(), view, backend });
  cursor++;
  refresh(id);
  return getPanel(id).ensure({ focus: true });
}
const modeOf = (mode, fallback = 'headless') => {
  const selected = mode ?? fallback;
  if (!['desktop', 'headless'].includes(selected)) throw new Error('Choose desktop or headless');
  return selected;
};
const normalize = (backend, { conversationId: _owner, ...job }) => ({
  ...job,
  backend,
  ...(backend === 'codex' ? { jobId: 'codex:' + job.jobId,
    updatedAt: job.updatedAt ?? job.finishedAt ?? job.activity?.at(-1)?.at ?? job.startedAt ?? job.createdAt } : {}),
});
const bridgeId = job => job.backend === 'codex' ? job.jobId.slice('codex:'.length) : job.jobId;
async function call(backend, mode, method, params, options) {
  const adapter = await bridge(backend);
  return backend === 'codex' ? adapter.call(method, params, options) : adapter.call(mode, method, params, options);
}
function accept(key, result) {
  const backend = key === 'codex' ? 'codex' : 'dsh';
  let updated = !providers[key].connected || providers[key].instanceId !== result.instanceId;
  for (const incoming of result.jobs) {
    const job = normalize(backend, incoming);
    if (!requests.conversationOf(job.requestId) || !records.accepts(job)) continue;
    const previous = jobs.get(job.jobId);
    if (records.remember(job) !== previous) updated = true;
  }
  providers[key] = { connected: true, instanceId: result.instanceId, sourceCursor: result.cursor };
  if (updated) publish();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function monitor(key) {
  if (monitoring.has(key)) return;
  monitoring.add(key);
  const backend = key === 'codex' ? 'codex' : 'dsh';
  for (;;) {
    try {
      const current = providers[key];
      const result = await call(backend, key, 'events', { afterCursor: current.sourceCursor ?? -1, ...(current.instanceId ? { instanceId: current.instanceId } : {}), timeoutMs: 25000 });
      accept(key, result);
      if (result.cursor === current.sourceCursor) await pause(250);
    } catch (error) {
      if (providers[key].connected || providers[key].error !== error.message) {
        providers[key] = { connected: false, error: error.message };
        publish();
      }
      await pause(1500);
    }
  }
}
const catalog = catalogReader((backend, mode, start) => call(backend, mode, 'catalog', {}, { start }));

function locate(params) {
  const id = conversationId(params);
  const job = jobs.get(params.jobId);
  if (!job || !records.owns(job, id)) throw new Error('Unknown jobId in this Codex conversation');
  return job;
}
const waitChange = timeoutMs => new Promise(resolve => {
  const done = () => { clearTimeout(timer); changes.off('change', done); resolve(); };
  const timer = setTimeout(done, timeoutMs);
  changes.once('change', done);
});

async function dispatch(params) {
  const { backend, conversationId: id, requestId, mode, sessionId, ...task } = params;
  const existing = [...jobs.values()].find(job => job.requestId === requestId);
  if (existing) return compact(existing);
  if (dispatching.has(requestId)) return dispatching.get(requestId);
  // When resuming, reserve the same session across all parent chats that use this Hub.
  const target = sessionId && JSON.stringify([backend, mode, sessionId]);
  if (target && (resuming.has(target) || [...jobs.values()].some(job =>
    job.backend === backend && job.mode === mode && job.sessionId === sessionId && !terminal(job.status)))) {
    throw new Error('Another bridge task is active in this session');
  }
  if (target) resuming.add(target);
  const pending = (async () => {
    if (backend === 'dsh') {
      const host = await call(backend, mode, 'doctor', {}, { start: true });
      if (!host.capabilities?.includes('concurrent-sessions')) throw new Error('DSH must reload its current bridge plugin before dispatch');
    }
    const args = { ...task, requestId, ...(sessionId ? { sessionId } : {}) };
    if (backend === 'dsh') args.conversationId = id;
    else { delete args.configurationId; delete args.configurationRevision; }
    const incoming = await call(backend, mode, backend === 'codex' && sessionId ? 'resume' : 'start', args, { start: true });
    if (incoming.requestId !== requestId) throw new Error("Bridge returned a different request ID");
    const job = records.remember(normalize(backend, incoming));
    publish();
    void monitor(mode ?? 'codex');
    return compact(job);
  })();
  dispatching.set(requestId, pending);
  try { return await pending; }
  finally { dispatching.delete(requestId); if (target) resuming.delete(target); }
}
async function submit(params, operation) {
  const id = conversationId(params);
  const selected = requests.resolve(params, operation);
  const panel = getPanel(id);
  const display = panel.ensure();
  const job = await dispatch(selected);
  await display;
  return { ...job, panel: await panel.rendered([job.jobId]) };
}
async function updateJob(params, method, extra = {}) {
  const job = locate(params);
  const reply = await call(job.backend, job.mode, method, { ...extra, jobId: bridgeId(job) });
  const current = records.remember(normalize(job.backend, reply));
  if (current !== job) publish();
  return compact(current);
}

const methods = {
  async doctor() {
    const [dsh, codex] = await Promise.allSettled([
      bridge('dsh').then(adapter => adapter.doctor()),
      call('codex', undefined, 'health', {}),
    ]);
    const describe = result => result.status === 'fulfilled' ? result.value : { error: result.reason.message };
    return { version: VERSION, dsh: describe(dsh), codex: describe(codex), retention: records.status() };
  },
  async configure(params) {
    const entry = configurations.create(params);
    return { ...entry, panel: await showPanel(entry.conversationId, 'settings', entry.backend) };
  },
  configuration: params => configurations.read(params),
  configurationDraft: params => configurations.create(params),
  saveConfiguration: params => configurations.confirm(params),
  panelHeartbeat(params) {
    const id = conversationId(params);
    const owned = Array.isArray(params.jobs) ? params.jobs.filter(job => jobs.has(job.jobId) && records.owns(jobs.get(job.jobId), id)) : params.jobs;
    return getPanel(id).heartbeat({ ...params, jobs: owned });
  },
  catalog: params => { conversationId(params); return catalog(params); },
  sessions(params) {
    conversationId(params);
    const backend = backendOf(params);
    const { workspace, query, limit } = params;
    return call(backend, backend === 'dsh' ? modeOf(params.mode, 'desktop') : undefined, 'sessions', { workspace, query, limit }, { start: true });
  },
  start: params => submit(params, 'start'),
  resume: params => submit(params, 'resume'),
  async start_many(params) {
    const id = conversationId(params);
    const backend = backendOf(params);
    if (params.userAuthorized !== true) throw new Error('Explicit user permission to dispatch through Agent Hub is required');
    if (!Array.isArray(params.tasks) || !params.tasks.length || params.tasks.length > 16) throw new Error('Provide 1 to 16 tasks');
    if (new Set(params.tasks.map(task => task.requestId)).size !== params.tasks.length) throw new Error('Every task needs a distinct requestId');
    const selected = requests.resolveMany(params.tasks.map(task => ({ ...task, backend, userAuthorized: true, conversationId: id })));
    const panel = getPanel(id);
    const display = panel.ensure();
    const settled = await Promise.allSettled(selected.map(task => dispatch(task)));
    const accepted = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const errors = settled.flatMap((result, index) => result.status === 'rejected' ? [{ requestId: params.tasks[index].requestId, code: result.reason.code, message: result.reason.message }] : []);
    await display;
    return { jobs: accepted, errors, panel: await panel.rendered(accepted.map(job => job.jobId)) };
  },
  list: params => snapshot(conversationId(params)),
  async status(params) {
    const job = locate(params);
    if (terminal(job.status)) return compact(job);
    try { return await updateJob(params, 'status'); }
    catch (error) { return { ...compact(job), connection: 'disconnected', connectionError: error.message }; }
  },
  result: params => methods.status(params),
  async wait(params) {
    const id = conversationId(params);
    const ids = params.jobIds ?? [...jobs.values()].filter(job => records.owns(job,id)).map(job => job.jobId);
    if (!Array.isArray(ids) || !ids.length) return { instanceId, cursor, reason: 'no-jobs', jobs: [] };
    for (const jobId of ids) locate({ conversationId: id, jobId });
    const deadline = Date.now() + Math.max(0, Math.min(params.timeoutMs ?? 45000, 45000));
    const actionable = () => ids.some(jobId => {
      const job = jobs.get(jobId);
      return !job || terminal(job.status) || job.status.startsWith('waiting-');
    });
    while (!(actionable() && params.afterCursor !== cursor) && Date.now() < deadline) await waitChange(deadline - Date.now());
    return { instanceId, cursor, reason: actionable() ? 'attention-or-completion' : 'timeout', jobs: ids.flatMap(jobId => jobs.has(jobId) ? [compact(jobs.get(jobId))] : []) };
  },
  cancel: params => updateJob(params, 'cancel'),
  steer(params) {
    if (params.userAuthorized !== true) throw new Error('Explicit user permission to steer the task is required');
    if (locate(params).backend !== 'codex') throw new Error('Steering is available for independent Codex tasks');
    if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new Error('prompt is required');
    return updateJob(params, 'steer', { prompt: params.prompt });
  },
  async open(params) {
    const id = conversationId(params);
    if (!params.jobId) return { conversationId: id, panel: await showPanel(id, 'tasks') };
    const job = locate(params);
    if (!job.sessionId) throw new Error('This task does not have a session yet');
    if (job.backend === 'codex') throw new Error('View independent Codex sessions in the Agent Hub dashboard');
    if (job.mode === 'headless') throw new Error('Use the task dashboard to inspect a hidden DSH session');
    const reply = await call(job.backend, job.mode, 'open', { jobId: bridgeId(job) }, { start: true });
    (await bridge('dsh')).focusDesktop();
    return reply;
  },
};
const browserMethods = new Set(['list', 'configuration', 'configurationDraft', 'saveConfiguration', 'catalog', 'panelHeartbeat', 'cancel', 'open']);
const server = http.createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  const host = request.headers.host;
  if (baseUrl && host !== new URL(baseUrl).host) { response.writeHead(403); return response.end('Forbidden host'); }
  if (request.url.split('?')[0] === '/' && request.method === 'GET') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'");
    return response.end(fs.readFileSync(path.join(ROOT, 'ui/dashboard.html')));
  }
  if (request.method === 'GET' && ['/dashboard.js', '/settings.js'].includes(request.url)) {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    return response.end(fs.readFileSync(path.join(ROOT, 'ui', request.url.slice(1))));
  }
  if (!equal(request.headers.authorization, 'Bearer ' + cfg.token)) { response.writeHead(401); return response.end(JSON.stringify({ error: { message: 'Unauthorized' } })); }
  if (request.headers.origin && request.headers.origin !== baseUrl) { response.writeHead(403); return response.end('Forbidden origin'); }
  if (request.url === '/health') { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify({ instanceId, version: VERSION })); }
  if (request.url.split('?')[0] === '/events' && request.method === 'GET') {
    let id;try{id=conversationId({conversationId:new URL(request.url,baseUrl).searchParams.get('conversationId')})}catch(error){response.writeHead(400);return response.end(error.message)}
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    const stream = { response, conversationId: id };
    streams.add(stream);
    sendSnapshot(stream);
    const keepalive = setInterval(() => { if (!stream.blocked) response.write(': heartbeat\n\n'); }, 20000);
    request.on('close', () => { clearInterval(keepalive); streams.delete(stream); });
    return;
  }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.url !== '/api' || request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) {
    response.writeHead(404); return response.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
  try {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Request too large'); }
    const call = JSON.parse(body);
    // Browser calls manage UI and existing jobs; only the MCP exposes dispatch.
    if (request.headers.origin && !browserMethods.has(call.method)) throw new Error('This method is not available in the dashboard');
    if (!Object.hasOwn(methods, call.method)) throw new Error('Unknown supervisor method');
    response.end(JSON.stringify({ result: await methods[call.method](call.params ?? {}) }));
  } catch (error) { response.end(JSON.stringify({ error: { code: error.code ?? 'supervisor/error', message: error.message } })); }
});
let previousPort = 0;
try { previousPort = Number(new URL(readJson(path.join(STATE, 'supervisor.json')).url).port); } catch {}
const listen = port => new Promise((resolve, reject) => { const fail = error => {server.off('listening', ready); reject(error)}; const ready = () => {server.off('error', fail); resolve()}; server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1'); });
try { await listen(previousPort); } catch (error) { if (!previousPort || error.code !== 'EADDRINUSE') throw error; await listen(0); }
baseUrl = 'http://127.0.0.1:' + server.address().port;
atomic(path.join(STATE, 'supervisor.json'), { instanceId, pid: process.pid, url: baseUrl, sourceRoot: ROOT, startedAt: new Date().toISOString() });
void monitor('desktop'); void monitor('headless'); void monitor('codex');
setInterval(() => {if(records.cleanup().removed)publish()},3600000).unref();
console.error('Agent Hub supervisor ready at ' + baseUrl);
