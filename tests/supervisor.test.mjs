import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {once} from 'node:events';
import { fakeConfig, fakeBridgeState, fakeCodexState } from './fixtures.mjs';

test('one saved configuration starts a concurrent batch, shows every task, deduplicates retries and keeps resumed sessions exclusive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-supervisor-test-'));
  const token=randomUUID(); const dispatched=[]; const bridgeCalls=[]; let dispatches=0, offline=false;
  const providerJobs={desktop:[],headless:[]};
  const codexJobs = new Map();
  const codexRequests = new Map();
  const server=http.createServer(async(request,response)=>{
    try{
      let body='';for await(const chunk of request)body+=chunk;const call=JSON.parse(body);bridgeCalls.push(call);
      const {mode,method,params}=call;let result;
      if (mode === 'codex') {
        assert.equal(params.client, 'codex-agent-hub');
        const job = codexJobs.get(params.jobId);
        if (method === 'health') result = { version: '0.4.0' };
        else if (method === 'catalog') result = { models: [{ id: 'fake-codex', efforts: ['high'] }], projects: [{ root, name: 'Test project' }] };
        else if (method === 'events') { await new Promise(resolve => setTimeout(resolve, 50)); result = { cursor: codexJobs.size, jobs: [...codexJobs.values()] }; }
        else if (method === 'status') result = job;
        else if (method === 'open') result = { opened: true };
        else if (method === 'steer') {
          job.activity.push({ kind: 'steer', text: params.prompt, at: new Date().toISOString() });
          result = job;
        } else if (method === 'start' || method === 'resume') {
          result = codexRequests.get(params.requestId);
          if (!result) {
            // Deliberately reuse a raw DSH job ID to verify namespacing.
            const jobId = codexJobs.size ? 'fake-' + codexJobs.size : providerJobs.desktop[0].jobId;
            result = { jobId, requestId: params.requestId, status: 'running', sessionId: params.sessionId || providerJobs.desktop[0].sessionId,
              createdAt: new Date().toISOString(), activity: [], settings: { workspace: root, model: 'fake-codex', effort: 'high', sandbox: 'read-only' } };
            codexJobs.set(jobId, result);
            codexRequests.set(params.requestId, result);
          }
        } else throw new Error('Unexpected fake Codex method ' + method);
        response.end(JSON.stringify({ result }));
        return;
      }
      if(['start','prepare','list','status','events','cancel','open'].includes(method))assert.equal(params.client,'codex-agent-hub');
      if(method==='doctor'){if(offline)throw new Error('pipe offline');result={mode,protocolVersion:2,instanceId:mode,capabilities:['concurrent-sessions']};}
      else if(method==='sessions')result=[];
      else if(method==='status')result=providerJobs[mode].find(job=>job.jobId===params.jobId);
      else if(method==='cancel'){result=providerJobs[mode].find(job=>job.jobId===params.jobId);result.status='cancelled';}
      else if(method==='open')result={opened:true};
      else if(method==='start'){
        dispatches++;await new Promise(resolve=>setTimeout(resolve,60));
        const prior=providerJobs[mode].find(job=>job.requestId===params.requestId);
        if(prior){dispatches--;result=prior}else{
          dispatched.push(params);const job={jobId:'job-'+randomUUID(),client:params.client,meta:params.meta,sessionId:params.sessionId?undefined:'dsh-bridge-'+randomUUID(),requestId:params.requestId,mode,status:params.sessionId?'starting':'running',createdAt:new Date().toISOString(),requested:{workspace:root},events:[]};providerJobs[mode].push(job);result=job;
        }
      }else{await new Promise(resolve=>setTimeout(resolve,40));result={instanceId:mode,cursor:providerJobs[mode].length,jobs:providerJobs[mode]}}
      response.end(JSON.stringify({result}));
    }catch(error){response.end(JSON.stringify({error:{message:error.message}}))}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const base=fakeConfig(root,{endpoint});
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({...base,token}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../plugins/agent-hub/server/supervisor.mjs',import.meta.url))],{env:{...process.env,CODEX_AGENT_HUB_STATE_DIR:root,DSH_BRIDGE_STATE_DIR:fakeBridgeState(root),CODEX_BRIDGE_STATE_DIR:fakeCodexState(root, endpoint)},windowsHide:true,stdio:'ignore'});
  let heartbeat;
  try{
    const infoFile=path.join(root,'supervisor.json');for(let i=0;i<100&&!fs.existsSync(infoFile);i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(fs.existsSync(infoFile));const info=JSON.parse(fs.readFileSync(infoFile));
    const call=async(method,params={})=>{const response=await fetch(info.url+'/api',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({method,params:{conversationId:'chat-A',backend:'dsh',...params}})});return response.json()};
    const blocked=await call('start',{prompt:'fake only'});assert.match(blocked.error.message,/Explicit user permission/);assert.equal(dispatches,0);
    await call('panelHeartbeat',{clientId:'fake-window',visible:true,jobs:[]});
    heartbeat=setInterval(()=>void call('panelHeartbeat',{clientId:'fake-window',visible:true,jobs:Object.values(providerJobs).flat()}).catch(()=>{}),20);
    assert.equal((await call('configuration')).result.status,'missing');
    const entry=(await call('configure')).result;
    assert.equal(entry.status,'draft');
    assert.equal((await call('list')).result.viewRequest.view,'settings');
    const draft=await call('start',{userAuthorized:true,prompt:'fake only',requestId:'draft'});assert.match(draft.error.message,/Save this Codex conversation/);
    await call('saveConfiguration',{configurationId:entry.configurationId,values:{...entry.values,mode:'desktop',model:{provider:'fake',model:'chosen'}}});
    const tasks=[{prompt:'1',requestId:'one'},{prompt:'2',requestId:'two'}];
    assert.equal(dispatches,0);
    const batch=(await call('start_many',{userAuthorized:true,tasks})).result;
    assert.equal(batch.jobs.length,2);assert.equal(batch.errors.length,0);assert.equal(batch.panel.jobsRendered,true);assert.equal(dispatches,2);
    assert.notEqual(batch.jobs[0].sessionId,batch.jobs[1].sessionId);
    const again=(await call('start_many',{userAuthorized:true,tasks})).result;assert.equal(dispatches,2);assert.deepEqual(again.jobs.map(job=>job.jobId),batch.jobs.map(job=>job.jobId));
    assert.equal((await call('configuration')).result.revision,1);
    for(const job of providerJobs.desktop){job.status='completed';job.result=dispatched.find(item=>item.requestId===job.requestId).prompt;job.finishedAt=new Date().toISOString();await call('status',{jobId:job.jobId})}
    const resumed=await Promise.all(batch.jobs.map((job,index)=>call('resume',{userAuthorized:true,mode:'desktop',sessionId:job.sessionId,prompt:String(index+3),requestId:'resume-'+index})));
    assert.ok(resumed.every(reply=>reply.result?.jobId));
    for(const selected of dispatched.slice(2))for(const key of ['workspace','model','preset','permission'])assert.equal(selected[key],undefined);
    const grouped=(await call('list')).result;assert.equal(grouped.jobs.length,4);assert.equal(grouped.subagents.length,2);assert.ok(grouped.subagents.every(agent=>agent.turnCount===2));
    assert.ok(grouped.subagents.every(agent=>agent.status==='starting'&&agent.result===undefined));
    for(const job of providerJobs.desktop.filter(job=>job.status==='starting')){
      job.sessionId=dispatched.find(params=>params.requestId===job.requestId).sessionId;job.status='running';await call('status',{jobId:job.jobId});
    }
    assert.ok((await call('list')).result.subagents.every(agent=>agent.status==='running'));
    assert.equal((await call('configuration')).result.revision,1);assert.equal((await call('configure')).result.configurationId,entry.configurationId);
    const busy=await call('resume',{userAuthorized:true,mode:'desktop',sessionId:batch.jobs[0].sessionId,prompt:'busy',requestId:'busy-resume'});assert.match(busy.error.message,/active.*session/);
    assert.equal((await call('configuration',{conversationId:'chat-B'})).result.status,'missing');
    const unconfigured=await call('start',{conversationId:'chat-B',userAuthorized:true,prompt:'blocked',requestId:'blocked'});assert.match(unconfigured.error.message,/Save this Codex conversation/);assert.equal(dispatches,4);
    await call('panelHeartbeat',{conversationId:'chat-B',clientId:'window-B',visible:true,jobs:[]});
    const fresh=(await call('configure',{conversationId:'chat-B'})).result;
    const cross=await call('saveConfiguration',{conversationId:'chat-B',configurationId:entry.configurationId,values:entry.values});assert.match(cross.error.message,/Unknown configuration/);
    await call('saveConfiguration',{conversationId:'chat-B',configurationId:fresh.configurationId,values:{...fresh.values,mode:'desktop'}});
    const otherParams={conversationId:'chat-B',userAuthorized:true,prompt:'other chat',requestId:'one'};
    const otherPending=call('start',otherParams);
    const otherHeartbeat=setInterval(()=>void call('panelHeartbeat',{conversationId:'chat-B',clientId:'window-B',visible:true,jobs:Object.values(providerJobs).flat()}).catch(()=>{}),20);
    const other=(await otherPending).result;clearInterval(otherHeartbeat);assert.ok(other.jobId);
    assert.equal((await call('list',{conversationId:'chat-B'})).result.jobs.length,1);
    assert.ok((await call('list')).result.jobs.every(job=>job.jobId!==other.jobId));
    const forbidden=await call('status',{jobId:other.jobId});assert.match(forbidden.error.message,/Unknown jobId/);
    const reopened=(await call('open')).result;assert.equal(reopened.conversationId,'chat-A');assert.equal(dispatches,5);
    clearInterval(heartbeat);await new Promise(resolve=>setTimeout(resolve,30));
    await call('panelHeartbeat',{clientId:'fake-window',closed:true,jobs:[]});
    // Native close/reopen launch is covered with an injected launcher in panel.test.mjs.
    await call('panelHeartbeat',{clientId:'reopened-window',visible:true,jobs:providerJobs.desktop.filter(job=>job.jobId!==other.jobId)});
    assert.equal((await call('open',{dashboard:true})).result.conversationId,'chat-A');assert.equal(dispatches,5);
    assert.equal((await fetch(info.url+'/health')).status,401);
    const form=await fetch(info.url+'/?configure=example');assert.equal(form.status,200);assert.match(await form.text(),/保存配置/);
    const wrongOrigin=await fetch(info.url+'/api',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',origin:'https://example.com'},body:'{}'});assert.equal(wrongOrigin.status,403);
    const events=await fetch(info.url+'/events?conversationId=chat-A',{headers:{authorization:'Bearer '+token}});const reader=events.body.getReader();const first=await reader.read();
    const eventText=new TextDecoder().decode(first.value);assert.match(eventText,/job-/);assert.ok(!eventText.includes(other.jobId));await reader.cancel();
    assert.equal((await fetch(info.url+'/events',{headers:{authorization:'Bearer '+token}})).status,400);
    assert.ok(bridgeCalls.filter(call=>call.method==='events'||call.method==='status'||call.method==='list').every(call=>call.options.start===false));
    const doctor=(await call('doctor')).result;assert.equal(doctor.dsh.runtime.version,'fake-runtime');
    assert.equal((await call('cancel',{jobId:batch.jobs[0].jobId})).result.status,'cancelled');
    assert.equal((await call('open',{jobId:batch.jobs[0].jobId})).result.opened,true);
    for(const selected of dispatched){assert.equal(selected.client,'codex-agent-hub');assert.equal(selected.configurationId,undefined);assert.equal(selected.configurationRevision,undefined);assert.equal(Boolean(selected.meta.configurationId),!selected.sessionId);assert.equal(selected.meta.configurationRevision,selected.sessionId?undefined:1);assert.ok(selected.meta.conversationId);}
    const startupFailure={code:'dsh/compatibility',message:'shared bundle startup failed',details:{mode:'desktop'}};
    fakeConfig(root,{endpoint,startupFailures:{desktop:startupFailure}});offline=true;
    const offlineCallIndex=bridgeCalls.length;
    const diagnosis=(await call('doctor')).result;
    assert.deepEqual(diagnosis.dsh.modes.desktop,{connected:false,error:'pipe offline',startupFailure});
    assert.deepEqual(diagnosis.dsh.modes.headless,{connected:false,error:'pipe offline'});
    assert.ok(bridgeCalls.slice(offlineCallIndex).filter(call=>call.method==='doctor').every(call=>call.options.start===false));
    // A connected Host must not bypass the current installation preflight.
    fakeConfig(root, { endpoint, runtimeError: 'shared adapter code changed' });
    const changedRuntime = await call('sessions', { mode: 'desktop' });
    assert.match(changedRuntime.error.message, /adapter code changed/);
    assert.equal(dispatches, 5);

    const codex = { backend: 'codex' };
    const choices = (await call('catalog', codex)).result;
    assert.equal(choices.workspaces[0].path, root);
    const codexConfig = (await call('configure', codex)).result;
    assert.deepEqual((await call('list')).result.viewRequest.backend, 'codex');
    await call('saveConfiguration', { ...codex, configurationId: codexConfig.configurationId,
      values: { workspace: root, model: 'fake-codex', effort: 'high', sandbox: 'read-only' } });
    const launch = { ...codex, userAuthorized: true, requestId: 'one', prompt: 'fake independent task' };
    const codexJob = (await call('start', launch)).result;
    assert.equal((await call('start', launch)).result.jobId, codexJob.jobId);
    assert.equal(codexJobs.size, 1);
    assert.equal(codexJob.jobId, 'codex:' + batch.jobs[0].jobId);
    assert.equal(codexJob.backend, 'codex');
    assert.equal((await call('list')).result.subagents.length, 3);
    assert.equal((await call('open', { jobId: codexJob.jobId })).error.message, 'Open an independent Codex thread after its turn ends');
    assert.match((await call('steer', { jobId: codexJob.jobId, prompt: 'later', userAuthorized: false })).error.message, /explicit user permission/i);
    const steered = (await call('steer', { jobId: codexJob.jobId, prompt: 'later', userAuthorized: true })).result;
    assert.equal(steered.activity.at(-1).text, 'later');
    const bridgeJob = [...codexJobs.values()][0];
    bridgeJob.status = 'completed';
    bridgeJob.finishedAt = new Date().toISOString();
    bridgeJob.result = 'full answer from fake Codex';
    const waited = (await call('wait', { jobIds: [codexJob.jobId], timeoutMs: 1500 })).result;
    assert.equal(waited.jobs[0].result, bridgeJob.result);
    assert.equal((await call('open', { jobId: codexJob.jobId })).result.opened, true);
    const freshResume = (await call('resume', { ...launch, conversationId: 'chat-B', sessionId: codexJob.sessionId })).result;
    assert.equal(freshResume.sessionId, codexJob.sessionId);
    assert.equal((await call('configuration', { ...codex, conversationId: 'chat-B' })).result.status, 'missing');
    assert.equal((await call('status', { jobId: freshResume.jobId })).error.message, 'Unknown jobId in this Codex conversation');
    const launches = bridgeCalls.filter(item => item.mode === 'codex' && ['start', 'resume'].includes(item.method));
    assert.equal(launches.length, 2);
    assert.equal(launches[0].params.sandbox, 'read-only');
    assert.equal(launches[1].params.workspace, undefined);
    assert.equal(launches[1].params.sandbox, undefined);
    assert.ok(bridgeCalls.filter(item => item.mode === 'codex' && item.method === 'events').every(item => item.options.start === false));
  }finally{
    clearInterval(heartbeat);
    if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit')}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-supervisor-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
