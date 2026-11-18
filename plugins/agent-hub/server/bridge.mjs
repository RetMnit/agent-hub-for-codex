import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadClient(name, state) {
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(state, 'install.json'), 'utf8')); }
  catch (cause) { throw new Error('Install Common/' + name + ' first (node setup.mjs); its install.json could not be read', { cause }); }
  const { root, version } = receipt;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Invalid ' + name + ' install.json root; rerun its setup.mjs');
  const { connect } = await import(pathToFileURL(path.join(root, 'lib/client.mjs')).href);
  return { connect, version };
}

// Load the shared runtime by its installer receipt, never a bundled copy.
export async function loadBridge({ state = process.env.DSH_BRIDGE_STATE_DIR || path.join(os.homedir(), '.dsh-bridge') } = {}) {
  const { connect } = await loadClient('dsh-bridge', state);
  const client = connect({ state });
  const fields = {
    doctor: [], catalog: [], sessions: ['workspace', 'query', 'limit'],
    start: ['requestId', 'prompt', 'title', 'sessionId', 'workspace', 'preset', 'model', 'permission'],
    prepare: ['requestId', 'title', 'sessionId', 'workspace', 'preset', 'model', 'permission'],
    list: [], status: ['jobId'], cancel: ['jobId'], open: ['sessionId', 'jobId'],
    events: ['afterCursor', 'instanceId', 'timeoutMs'],
  };
  const tasks = new Set(['start', 'prepare', 'list', 'status', 'events', 'cancel', 'open']);
  return {
    defaults: client.defaults,
    runtime: () => client.runtime(),
    doctor: () => client.doctor(),
    focusDesktop: () => client.focusDesktop(),
    call(mode, method, params = {}, { start = false } = {}) {
      // The hidden Host is shared with other clients; this plugin never shuts it down.
      if (!Object.hasOwn(fields, method)) throw new Error('Unsupported dsh-bridge method: ' + method);
      const selected = Object.fromEntries(fields[method].filter(key => params[key] !== undefined).map(key => [key, params[key]]));
      if (tasks.has(method)) selected.client = 'codex-agent-hub';
      if (method === 'start' || method === 'prepare') {
        const meta = Object.fromEntries(['conversationId', 'configurationId', 'configurationRevision'].filter(key => params[key] !== undefined).map(key => [key, params[key]]));
        if (Object.keys(meta).length) selected.meta = meta;
      }
      return client.call(mode, method, selected, { start });
    },
  };
}

export async function loadCodexBridge({ state = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), '.codex-bridge') } = {}) {
  const { connect, version } = await loadClient('codex-bridge', state);
  function probe() {
    let running;
    try { running = JSON.parse(fs.readFileSync(path.join(state, 'service.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The shared connect() may upgrade an idle older service. Passive calls
    // leave that decision to the next explicit connection.
    if (running?.version && version && running.version !== version) {
      const error = new Error('Codex bridge version changed. Connect explicitly to refresh it.');
      error.code = 'bridge/offline';
      throw error;
    }
    return connect({ state, start: false });
  }
  let connection;
  let connecting;
  return {
    async call(method, params = {}, { start = false } = {}) {
      if (!connection) {
        const pending = connecting ??= Promise.resolve().then(() => start ? connect({ state }) : probe());
        try { connection = await pending; }
        catch (error) {
          // An authorized active request may arrive during an offline probe.
          if (!start || error.code !== 'bridge/offline') throw error;
          if (connecting === pending) connecting = undefined;
          const launch = connecting ??= connect({ state, start: true });
          try { connection = await launch; }
          finally { if (connecting === launch) connecting = undefined; }
        } finally { if (connecting === pending) connecting = undefined; }
      }
      const current = connection;
      try { return await current.call(method, { ...params, client: 'codex-agent-hub' }); }
      catch (error) {
        if ((error.code === 'bridge/offline' || error.cause || error.name === 'TimeoutError') && connection === current) connection = undefined;
        throw error;
      }
    },
  };
}
