import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, STATE, config, readJson } from './common.mjs';

export async function connectSupervisor() {
  let cfg;
  try { cfg = config(); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Initialize Agent Hub with node <plugin-root>/server/setup.mjs first', { cause: error });
    throw error;
  }
  const infoFile = path.join(STATE, 'supervisor.json');
  const tryInfo = async () => {
    try {
      const info = readJson(infoFile);
      const response = await fetch(info.url + '/health', { headers: { authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(1500) });
      if (response.ok) { const health = await response.json(); if (health.instanceId === info.instanceId) return info; }
    } catch {}
  };
  let info = await tryInfo();
  if (!info) {
    const logDir = path.join(STATE, 'logs'); fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'supervisor.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server/supervisor.mjs')], { cwd: STATE, detached: true, windowsHide: true, shell: false,
      env: { ...process.env, CODEX_AGENT_HUB_STATE_DIR: STATE }, stdio: ['ignore', log, log] });
    child.unref(); fs.closeSync(log);
    for (let i = 0; i < 50 && !info; i++) { await new Promise(resolve => setTimeout(resolve, 100)); info = await tryInfo(); }
  }
  if (!info) throw new Error('Could not start the local Agent Hub supervisor; inspect its log');
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
