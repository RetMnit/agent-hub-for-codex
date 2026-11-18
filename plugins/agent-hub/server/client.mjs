import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, STATE, VERSION, config, readJson, terminal } from './common.mjs';

const infoFile = path.join(STATE, 'supervisor.json');
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const older = version => version && version.localeCompare(VERSION, 'en', { numeric: true }) < 0;

async function currentSupervisor(token) {
  try {
    const info = readJson(infoFile);
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url)) return;
    const response = await fetch(info.url + '/health', { headers: { authorization: 'Bearer ' + token, connection: 'close' }, signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      const health = await response.json();
      if (health.instanceId === info.instanceId) return { ...info, version: health.version };
    }
  } catch {}
}

function checkActiveJobs() {
  const mirror = path.join(STATE, 'supervisor-jobs.json');
  const jobs = fs.existsSync(mirror) ? readJson(mirror).jobs : [];
  if (jobs.some(job => !terminal(job.status))) throw new Error('Wait for Agent Hub tasks to finish before rerunning setup');
}

async function waitForLegacyClients(info) {
  if (process.platform !== 'win32') throw new Error('Stop the old Agent Hub supervisor before rerunning setup on this platform');
  const address = new URL(info.url).host;
  const netstat = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'netstat.exe');
  const deadline = Date.now() + 5500;
  do {
    const { stdout } = await run(netstat, ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    const connections = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
      .filter(([protocol, local, , , pid]) => protocol === 'TCP' && local === address && pid === String(info.pid));
    if (!connections.some(([, , remote]) => remote.endsWith(':0'))) throw new Error('Could not verify the old Agent Hub listener. Run setup again');
    // Legacy versions cannot drain HTTP themselves. An open client can still
    // be waiting for a bridge reply even when the job has no local record.
    if (connections.every(([, , remote]) => remote.endsWith(':0'))) return;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error('The old Agent Hub supervisor still has open connections. Close its task panel, let active calls finish, and rerun setup');
}

async function stopForUpgrade(info) {
  checkActiveJobs();
  if (!Number.isInteger(info.pid) || info.pid <= 0) {
    throw new Error('Agent Hub supervisor has an invalid process ID');
  }
  await waitForLegacyClients(info);
  checkActiveJobs();
  const latest = readJson(infoFile);
  if (latest.instanceId !== info.instanceId || latest.pid !== info.pid) {
    throw new Error('Agent Hub supervisor changed during setup. Run setup again');
  }
  try { process.kill(info.pid); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let i = 0; i < 50; i++) {
    try { process.kill(info.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error('Old Agent Hub supervisor did not exit. Run setup again');
}

export async function connectSupervisor({ upgrade = false } = {}) {
  let cfg;
  try { cfg = config(); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Initialize Agent Hub with node <plugin-root>/server/setup.mjs first', { cause: error });
    throw error;
  }
  let info = await currentSupervisor(cfg.token);
  if (upgrade && !info) return;
  if (upgrade && older(info.version)) {
    await stopForUpgrade(info);
    info = undefined;
  }
  if (!info) {
    const logDir = path.join(STATE, 'logs'); fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'supervisor.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server/supervisor.mjs')], { cwd: STATE, detached: true, windowsHide: true, shell: false,
      env: { ...process.env, CODEX_AGENT_HUB_STATE_DIR: STATE }, stdio: ['ignore', log, log] });
    child.unref(); fs.closeSync(log);
    for (let i = 0; i < 50 && !info; i++) { await delay(100); info = await currentSupervisor(cfg.token); }
  }
  if (!info) throw new Error('Could not start the local Agent Hub supervisor; inspect its log');
  if (older(info.version)) throw new Error('Run the installed Agent Hub setup.mjs to upgrade the running supervisor');
  return { ...info, token: cfg.token };
}
export async function api(method, params = {}) {
  const id = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
  if (id && method !== 'doctor' && !params.conversationId) params = { ...params, conversationId: id };
  const info = await connectSupervisor();
  const response = await fetch(info.url + '/api', { method: 'POST', headers: { authorization: 'Bearer ' + info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(method === 'wait' ? 55000 : 80000) });
  const reply = await response.json();
  if (reply.error) { const error = new Error(reply.error.message); error.code = reply.error.code; throw error; }
  return reply.result;
}
