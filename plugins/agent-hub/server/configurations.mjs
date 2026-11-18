import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, backendOf, readJson } from './common.mjs';
import { conversationId } from './records.mjs';

const modes = ['desktop', 'headless'];
const sandboxes = ['read-only', 'workspace-write', 'danger-full-access'];
const fields = {
  dsh: ['mode', 'workspace', 'preset', 'model', 'permission'],
  codex: ['workspace', 'model', 'effort', 'sandbox'],
};

function requiredText(key, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid ' + key);
  return value.trim();
}

function directory(value) {
  return typeof value === 'string' && path.isAbsolute(value) && fs.statSync(value, { throwIfNoEntry: false })?.isDirectory();
}

function select(backend, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration values are required');
  const value = {};
  for (const [key, item] of Object.entries(input)) {
    if (!fields[backend].includes(key)) throw new Error('Unknown configuration parameter: ' + key);
    if (backend === 'dsh' && key === 'model') {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).some(name => !['provider', 'model', 'reasoningEffort'].includes(name)) ||
          !item.provider || !item.model) throw new Error('Provider and model must be set together');
      value.model = Object.fromEntries(Object.entries(item).map(([name, text]) => [name, requiredText(name, text)]));
    } else {
      value[key] = requiredText(key, item);
    }
  }
  if (!value.workspace) throw new Error('Workspace is required for new subagents');
  if (backend === 'dsh' && !modes.includes(value.mode)) throw new Error('Choose desktop or headless');
  if (value.sandbox && !sandboxes.includes(value.sandbox)) throw new Error('Unknown Codex sandbox');
  return value;
}

export function configurationStore(state, defaults) {
  const file = path.join(state, 'configurations.json');
  const entries = fs.existsSync(file) ? readJson(file) : {};
  const keyOf = params => JSON.stringify([conversationId(params), backendOf(params)]);
  const get = params => entries[keyOf(params)] ?? { conversationId: conversationId(params), backend: backendOf(params), status: 'missing' };
  const read = params => structuredClone(get(params));
  const store = (params, entry) => {
    const key = keyOf(params);
    atomic(file, { ...entries, [key]: entry });
    entries[key] = entry;
    return read(params);
  };

  return {
    read,
    create(params) {
      const entry = get(params);
      if (entry.status !== 'missing') return read(params);
      const { backend } = entry;
      const current = directory(params.workspace) ? params.workspace : undefined;
      const workspace = current ?? defaults.workspace;
      const values = backend === 'dsh' ? { workspace, mode: 'headless', ...(defaults.permission ? { permission: defaults.permission } : {}) } : { workspace };
      return store(params, { ...entry, initialWorkspace: current, configurationId: 'configuration-' + randomUUID(), status: 'draft', revision: 0, values: select(backend, values) });
    },
    confirm(params) {
      const entry = get(params);
      if (!entry.configurationId || entry.configurationId !== params.configurationId) throw new Error('Unknown configuration for this Codex conversation and backend');
      if (params.revision !== undefined && params.revision !== entry.revision) throw new Error('Configuration changed. Reload the saved settings before editing again.');
      const values = select(entry.backend, params.values);
      if (!directory(values.workspace)) throw new Error('Workspace must be an existing absolute directory');
      return store(params, { ...entry, values, status: 'ready', revision: entry.revision + 1, savedAt: new Date().toISOString() });
    },
    resolve(params, operation = 'start') {
      if (params.userAuthorized !== true) throw new Error('Explicit user permission to dispatch through Agent Hub is required');
      const backend = backendOf(params);
      const entry = get(params);
      if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new Error('prompt is required');
      requiredText('requestId', params.requestId);
      if (params.title !== undefined) requiredText('title', params.title);
      for (const key of ['configurationId', ...fields.dsh, ...fields.codex]) {
        if (params[key] !== undefined && !(key === 'mode' && operation === 'resume' && backend === 'dsh')) throw new Error('Set ' + key + ' in the parameter form, not in dispatch arguments');
      }
      const task = { backend, requestId: params.requestId, prompt: params.prompt, ...(params.title ? { title: params.title } : {}) };
      if (operation === 'resume') {
        const sessionId = requiredText('sessionId', params.sessionId);
        if (backend === 'dsh' && !modes.includes(params.mode)) throw new Error("Specify the existing DSH session's desktop or headless mode");
        return { ...task, sessionId, ...(backend === 'dsh' ? { mode: params.mode } : {}) };
      }
      if (params.sessionId !== undefined) throw new Error('Use resume to continue an existing session');
      if (entry.status !== 'ready') throw new Error("Save this Codex conversation's parameter configuration for " + backend + ' before starting a new session');
      return { ...task, ...select(backend, entry.values), configurationId: entry.configurationId, configurationRevision: entry.revision };
    },
  };
}
