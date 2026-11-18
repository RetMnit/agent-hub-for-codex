// Explicit Windows acceptance: uses the real status window, never starts a model.
import assert from 'node:assert/strict';
import {api, connectSupervisor} from '../plugins/agent-hub/server/client.mjs';
import {STATE, VERSION} from '../plugins/agent-hub/server/common.mjs';
import {statusPanel, findStatusWindow} from '../plugins/agent-hub/server/panel.mjs';

const conversationId=process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if(!conversationId)throw new Error('Current Codex conversation ID is required');
const doctor=await api('doctor');
const supervisor=await connectSupervisor();
const dashboardUrl=supervisor.url+'/?conversationId='+encodeURIComponent(conversationId);
assert.equal(doctor.version,VERSION,'Restart the idle supervisor from this source before live acceptance');
await api('open',{conversationId});
const existing=await findStatusWindow(dashboardUrl,STATE);
assert.equal(existing.exists,true,'real Edge app belongs to this conversation');
assert.equal(existing.originMatches,true);
let launches=0;
// New objects have no heartbeat receipts, exactly as after lost heartbeats/restart.
for(let i=0;i<2;i++) {
  const panel=statusPanel({url:()=>dashboardUrl,state:STATE,timeoutMs:30,
    launch:async()=>{launches++;throw new Error('Unexpected duplicate window');}});
  const status=await panel.ensure();
  assert.equal(status.display,'background');assert.equal(status.connected,false);
  const receipt=await panel.rendered(['not-rendered']);
  assert.equal(receipt.jobsRendered,false);assert.equal(receipt.renderPending,true);
  assert.equal(panel.status().launches,0);
  assert.equal(panel.status().reuses,1);
}
assert.equal(launches,0);
const after=await findStatusWindow(dashboardUrl,STATE);
assert.equal(after.processCount,existing.processCount);
console.log(JSON.stringify({passed:true,version:doctor.version,scopeProcesses:after.processCount,
  realWindowConfirmed:after.windowConfirmed,simulatedLostHeartbeatRetries:2,duplicateLaunches:launches,modelCalls:0}));
