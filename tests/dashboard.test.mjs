import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {groupSubagents} from '../plugins/agent-hub/server/subagents.mjs';

test('dashboard renders all independent tasks and reports actual DOM results without dispatching', async () => {
  const elements=new Map();const requests=[];
  const element=tag=>({tag,textContent:'',dataset:{},children:[],append(...items){this.children.push(...items)},replaceChildren(){this.children=[]}});
  const document={hidden:false,createElement:element,getElementById:id=>{if(!elements.has(id))elements.set(id,element('div'));return elements.get(id)},addEventListener(name,fn){handlers[name]=fn}};
  const handlers={};
  const context={window:{addEventListener(name,fn){handlers[name]=fn}},document,location:{hash:'#private',pathname:'/',search:'?conversationId=chat-A'},sessionStorage:{getItem(){return ''},setItem(){}},history:{replaceState(){}},crypto:{randomUUID:()=> 'fake-window'},URLSearchParams,TextDecoder,AbortController,encodeURIComponent,setInterval(){},setTimeout,
    fetch:async(url,options)=>{if(url.startsWith('/events'))return new Promise(()=>{});const request=JSON.parse(options.body);requests.push(request);return{json:async()=>({result:request.method==='list'?context.testData:{accepted:true}})}}};
  document.querySelector=()=>({textContent:''});
  vm.runInNewContext(fs.readFileSync(new URL('../plugins/agent-hub/ui/dashboard.js',import.meta.url),'utf8'),context);
  const jobs=[1,2].map(number=>({jobId:'job-'+number,sessionId:'session-'+number,title:'任务 '+number,status:'completed',mode:'desktop',createdAt:new Date(number*1000).toISOString(),finishedAt:new Date(number*1000).toISOString(),promptSummary:'只回复 '+number,result:String(number),
    effective:{model:{provider:'dsh',model:'default-model'}},actualModel:{provider:'dsh',model:'actual-model',reasoningEffort:'high'}}));
  context.testData={conversationId:'chat-A',providers:{desktop:{connected:true}},jobs,subagents:groupSubagents(jobs)};vm.runInNewContext('draw(testData)',context);
  const cards=elements.get('jobs').children;assert.equal(cards.length,2);assert.deepEqual(cards.map(card=>card.dataset.jobId),['job-2','job-1']);
  assert.deepEqual(cards.map(card=>card.children.find(child=>child.className==='result').textContent),['2','1']);
  const facts = cards[0].children.find(child => child.className === 'details').children;
  assert.equal(facts[facts.findIndex(item => item.textContent === '推理档位') + 1].textContent, 'high');
  assert.equal(facts[facts.findIndex(item => item.textContent === '模型') + 1].textContent, 'actual-model');
  const receipt=requests.find(request=>request.method==='panelHeartbeat');assert.ok(receipt.params.jobs.every(job=>job.hasResult));assert.equal(receipt.params.jobs.length,2);
  assert.ok(!requests.some(request=>/start|saveConfiguration/.test(request.method)));
  const all=[...jobs,...jobs.map((job,index)=>({...job,jobId:'job-'+(index+3),title:'续接 '+(index+3),createdAt:new Date((index+3)*1000).toISOString(),result:String(index+3)}))];
  context.testData={conversationId:'chat-A',providers:{desktop:{connected:true}},jobs:all,subagents:groupSubagents(all)};vm.runInNewContext('draw(testData)',context);
  const updated=elements.get('jobs').children;assert.equal(updated.length,2);
  assert.deepEqual(updated.map(card=>card.children.find(child=>child.className==='result').textContent),['4','3']);
  assert.deepEqual(updated.map(card=>card.children[0].children[0].textContent),['任务 2','任务 1']);
  assert.ok(updated.every(card=>card.children.find(child=>child.className==='turn-history').children.length===2));
  assert.equal(requests.filter(request=>request.method==='panelHeartbeat').at(-1).params.jobs.length,4);
  assert.match(elements.get('providers').textContent,/2 项已完成/);
  updated[0].children.find(child=>child.className==='turn-history').open=true;
  vm.runInNewContext('draw(testData)',context);assert.ok(elements.get('jobs').children[0].children.find(child=>child.className==='turn-history').open);
  for(const status of ['starting','running','waiting-approval','completed']){
    const changing=all.map(job=>job.jobId==='job-3'?{...job,status,...(status==='completed'?{result:'3'}:{result:undefined,finishedAt:undefined})}:job);
    context.testData={conversationId:'chat-A',providers:{desktop:{connected:true}},jobs:changing,subagents:groupSubagents(changing)};vm.runInNewContext('draw(testData)',context);
    const resumed=elements.get('jobs').children.find(card=>card.dataset.jobId==='job-3');assert.equal(resumed.dataset.status,status);
    assert.equal(resumed.children.find(child=>child.className==='result')?.textContent,status==='completed'?'3':undefined);
    assert.equal(elements.get('jobs').children.length,2);
    if(status!=='completed')assert.match(elements.get('providers').textContent,/1 项进行中 · 1 项已完成/);
  }
  context.testData={conversationId:'chat-B',providers:{},jobs:[]};vm.runInNewContext('draw(testData)',context);assert.equal(elements.get('jobs').children.length,2);
  // Browser timers did not run in the background. A foreground event fetches
  // authoritative completed state without waiting for the existing SSE reader.
  const finalJobs=jobs.map(job=>({...job,result:'latest '+job.result}));
  context.testData={conversationId:'chat-A',providers:{},jobs:finalJobs,subagents:groupSubagents(finalJobs)};
  document.hidden=true;handlers.visibilitychange();assert.equal(requests.some(r=>r.method==='list'),false);
  document.hidden=false;handlers.visibilitychange();
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(requests.filter(r=>r.method==='list').length,1);
  assert.ok(elements.get('jobs').children.every(card=>card.children.find(child=>child.className==='result').textContent.startsWith('latest')));
  context.testData={...context.testData,instanceId:'server',cursor:8};vm.runInNewContext('draw(testData)',context);
  context.testData={conversationId:'chat-A',instanceId:'server',cursor:7,providers:{},jobs,subagents:groupSubagents(jobs)};vm.runInNewContext('draw(testData)',context);
  assert.ok(elements.get('jobs').children.every(card=>card.children.find(child=>child.className==='result').textContent.startsWith('latest')),'queued stale SSE frames cannot roll back foreground snapshot');
  handlers.focus();for(let i=0;i<10;i++)await Promise.resolve();assert.equal(requests.filter(r=>r.method==='list').length,2);
  assert.ok(!requests.some(r=>/start|resume|saveConfiguration/.test(r.method)));
  handlers.pagehide();assert.ok(requests.some(request=>request.method==='panelHeartbeat'&&request.params.closed===true&&request.params.conversationId==='chat-A'));
});

test('settings use mode-specific catalogs, group models, link efforts and save only the selected backend', async () => {
  const elements = new Map();
  const requests = [];
  const element = tag => ({ tag, textContent: '', value: '', children: [], append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; }, setAttribute() {} });
  const get = id => {
    if (!elements.has(id)) elements.set(id, element('div'));
    return elements.get(id);
  };
  const fields = new Map(['mode', 'location', 'workspace', 'preset', 'model', 'effort', 'permission'].map(name => [name, element('field')]));
  const button = { disabled: false };
  const form = get('settings');
  form.elements = { namedItem: name => fields.get(name) };
  form.querySelector = () => button;
  const timers = new Map();
  let nextTimer = 0;
  const model = { id: 'dsh-model', name: 'DSH Model', provider: 'p', providerName: 'Provider', efforts: ['medium', 'high'], defaultEffort: 'high' };
  const catalogs = {
    headless: { workspaces: [{ path: 'test-dsh', title: 'DSH project' }], models: [model, { ...model, provider: 'other', efforts: ['max'] }],
      presets: [{ id: 'preset-1', name: 'Preset' }], defaults: { provider: 'p', model: 'dsh-model' } },
    desktop: { models: [{ ...model, id: 'desktop-model' }] },
    codex: { workspaces: [{ path: 'test-codex', title: 'Codex project' }], models: [{ id: 'codex-model', efforts: ['xhigh'] }] },
  };
  const call = async (method, params) => {
    requests.push({ method, params: structuredClone(params) });
    if (method === 'configurationDraft') return { configurationId: params.backend, revision: 0, initialWorkspace: 'parent-folder',
      values: { workspace: 'parent-folder', ...(params.backend === 'dsh' ? { mode: 'headless' } : {}) } };
    if (method === 'catalog') return catalogs[params.mode ?? params.backend];
    if (method === 'saveConfiguration') return { configurationId: params.backend, values: params.values, revision: params.revision + 1 };
    throw new Error('Unexpected method ' + method);
  };
  const context = vm.createContext({ document: { createElement: element, getElementById: get }, call, structuredClone,
    setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(new URL('../plugins/agent-hub/ui/settings.js', import.meta.url), 'utf8'), context);
  const open = vm.runInContext('createSettings(call)', context);
  const change = (name, value) => form.onchange({ target: { name, value } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await open('dsh');
  await flush();
  assert.equal(fields.get('model').children[1].tag, 'optgroup');
  assert.equal(fields.get('model').children[1].label, 'Provider');
  assert.ok(fields.get('location').children.some(option => option.value === 'test-dsh'));
  assert.equal(fields.get('model').value, '');
  assert.equal(fields.get('effort').disabled, false);
  assert.deepEqual(fields.get('effort').children.map(option => option.value), ['', 'medium', 'high']);
  assert.equal(fields.get('effort').children[0].textContent, '沿用默认（high）');
  change('preset', 'preset-1');
  assert.equal(fields.get('effort').disabled, true);
  change('preset', '');
  change('effort', 'high');
  assert.equal(fields.get('model').value, '["p","dsh-model"]');
  await form.onsubmit({ preventDefault() {} });
  assert.equal(get('saved').textContent, '配置已保存');
  assert.equal([...timers.values()][0].ms, 3000);
  assert.deepEqual(requests.at(-1).params.values.model, { provider: 'p', model: 'dsh-model', reasoningEffort: 'high' });
  change('mode', 'desktop');
  await flush();
  assert.equal(requests.at(-1).params.mode, 'desktop');
  assert.equal(fields.get('model').value, '["p","dsh-model"]');
  assert.ok(fields.get('model').children[1].children.some(option => option.value === '["p","desktop-model"]'));
  await open('codex');
  await flush();
  assert.equal(get('setting-mode').hidden, true);
  change('location', 'test-codex');
  change('model', 'codex-model');
  change('effort', 'xhigh');
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(requests.at(-1).params, { backend: 'codex', configurationId: 'codex', revision: 0,
    values: { workspace: 'test-codex', model: 'codex-model', effort: 'xhigh' } });
  assert.ok(!requests.some(request => /start|resume/.test(request.method)));
});
