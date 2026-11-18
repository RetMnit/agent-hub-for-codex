import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// The installed client is synthetic. It never imports Common or starts DSH.
export const fakeBridgeState = root => path.join(root, 'bridge-state');
export function fakeConfig(root, overrides = {}) {
  const state=fakeBridgeState(root), runtimeRoot=path.join(root,'fake bridge runtime');
  fs.mkdirSync(path.join(runtimeRoot,'lib'),{recursive:true});fs.mkdirSync(state,{recursive:true});
  const defaults={workspace:root,permission:'danger-full-access'};
  fs.writeFileSync(path.join(state,'install.json'),JSON.stringify({root:runtimeRoot,version:'0.4.0',protocol:2}));
  fs.writeFileSync(path.join(state,'fake.json'),JSON.stringify({defaults,...overrides}));
  fs.writeFileSync(path.join(runtimeRoot,'lib/client.mjs'),'export { connect } from '+JSON.stringify(new URL('./fake-bridge-client.mjs',import.meta.url).href)+';');
  return {defaults,token:randomUUID()};
}

export function fakeCodexState(root, endpoint) {
  const state = path.join(root, 'codex-bridge-state');
  const runtime = path.join(root, 'codex-runtime');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(state, 'install.json'), JSON.stringify({ root: runtime, version: '0.5.0' }));
  fs.writeFileSync(path.join(state, 'fake.json'), JSON.stringify({ endpoint }));
  fs.writeFileSync(path.join(runtime, 'lib/client.mjs'), 'export { connectCodex as connect } from ' + JSON.stringify(new URL('./fake-bridge-client.mjs', import.meta.url).href));
  return state;
}
