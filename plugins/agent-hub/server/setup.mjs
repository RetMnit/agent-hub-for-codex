import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, STATE, atomic, readJson } from './common.mjs';
import { loadBridge, loadCodexBridge } from './bridge.mjs';
import { connectSupervisor } from './client.mjs';

if (process.argv.length > 2) throw new Error('Usage: node <plugin-root>/server/setup.mjs');
const dsh = await loadBridge().catch(() => null);
const codex = await loadCodexBridge().catch(() => null);
const settingsPath = path.join(STATE, 'config.json');
const old = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
if (fs.existsSync(settingsPath)) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex');
  const backup = path.join(STATE, 'backups', stamp, 'config.json');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(settingsPath, backup);
}
const defaults = { ...dsh?.defaults, ...old.defaults };
const workspace = path.resolve(process.env.CODEX_AGENT_HUB_WORKSPACE || defaults.workspace || os.homedir());
if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Choose an existing workspace directory');
atomic(settingsPath, { sourceRoot: ROOT, token: old.token || randomBytes(32).toString('hex'), defaults: { ...defaults, workspace } });
await connectSupervisor({ upgrade: true });
console.log(JSON.stringify({ configured: true, stateDir: STATE, installed: { dsh: Boolean(dsh), codex: Boolean(codex) } }));
