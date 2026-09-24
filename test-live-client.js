const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {JSDOM} = require('jsdom');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const blank = () => ({handicaps:[0,0,0,0], rounds:Array.from({length:4}, () => ({scores:Array.from({length:4},()=>Array(18).fill(null)),teamScores:Array.from({length:2},()=>Array(18).fill(null)),pars:Array(18).fill(4),indexes:Array.from({length:18},(_,i)=>i+1),verified:false,ctp:null}))});

async function main() {
  const courses = JSON.parse(fs.readFileSync('course_defaults.json','utf8'));
  let snapshot = {version:0,sequence:1,state:blank(),courses}, signedIn = false, failure = null, hold = null;
  const clients = [], writes = [], errors = [], persisted = new Map();
  function push() { for (const client of clients) client.listeners.snapshot?.({data:JSON.stringify(snapshot)}); }
  async function client(legacy = null) {
    const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', {url:'https://golf.example/',runScripts:'outside-only'});
    const w = dom.window;
    w.scrollTo = ()=>{}; w.HTMLElement.prototype.scrollIntoView = ()=>{};
    w.confirm = ()=>true;
    w.HTMLDialogElement.prototype.showModal = function(){this.open=true;};
    w.HTMLDialogElement.prototype.close = function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
    w.addEventListener('error', event => errors.push(event.error));
    if(legacy) w.localStorage.setItem('portugal2026-v1',JSON.stringify(legacy));
    w.EventSource = class { constructor(){this.listeners={};clients.push(this);} addEventListener(type,fn){this.listeners[type]=fn;} };
    w.fetch = async (url, options={}) => {
      let status=200, result;
      if(url==='/api/session') result={admin:signedIn,csrf:signedIn?'test-csrf':null};
      else if(url==='/api/login') { signedIn=true; result={admin:true,csrf:'test-csrf'}; }
      else if(url==='/api/logout') { signedIn=false; result={admin:false}; }
      else if(url==='/api/state' && options.method==='PUT') {
        const payload=JSON.parse(options.body);writes.push(payload);
        assert.equal(options.headers['X-CSRF-Token'],'test-csrf');
        if(hold) { const waiting=hold; hold=null; await waiting; }
        if(failure==='network') { failure=null; if(!persisted.has(payload.requestId)){snapshot={...snapshot,state:clone(payload.state),version:snapshot.version+1,sequence:snapshot.sequence+1};persisted.set(payload.requestId,true);} throw Error('Connection interrupted'); }
        if(failure==='conflict') {failure=null;status=409;result={error:'Another admin changed the scores.',snapshot:clone(snapshot)};}
        else if(!signedIn) {status=401;result={error:'Log in as admin to edit.'};}
        else if(persisted.has(payload.requestId)) result=clone(snapshot);
        else {
          assert.equal(payload.version,snapshot.version);
          snapshot={...snapshot,state:clone(payload.state),version:snapshot.version+1,sequence:snapshot.sequence+1};
          persisted.set(payload.requestId,true);result=clone(snapshot);push();
        }
      } else if(/^\/api\/courses\/[0-3]$/.test(url) && options.method==='PUT') {
        const ri=Number(url.split('/').at(-1)), payload=JSON.parse(options.body);
        assert.equal(options.headers['X-CSRF-Token'],'test-csrf');
        assert.equal(payload.version,snapshot.courses[ri].version);
        snapshot.courses[ri]={...snapshot.courses[ri],tees:clone(payload.tees),version:payload.version+1};
        snapshot.sequence++;result=clone(snapshot.courses[ri]);push();
      } else if(url==='/api/state') result=clone(snapshot);
      else if(url==='/api/courses') result=clone(courses);
      else throw Error(`Unexpected request ${url}`);
      return {ok:status<400,status,json:async()=>clone(result)};
    };
    const context=dom.getInternalVMContext();
    for(const file of ['scoring.js','courses.js','mobile.js','live.js','pwa.js','app.js']) vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
    await tick(); await tick();
    return {dom,w,context,document:w.document};
  }
  const old = blank(); old.handicaps[0]=40;old.rounds[0].scores[0][0]=8;
  const editor=await client(old), viewer=await client();
  const click=(c,selector)=>c.document.querySelector(selector).click();
  const change=(c,selector,value)=>{const input=c.document.querySelector(selector);input.value=value;input.dispatchEvent(new c.w.Event('change',{bubbles:true}));};
  click(editor,'[data-page="players"]');await tick();
  assert.equal(editor.document.querySelector('#hcp-0').value,'0','Server data must win over legacy browser scores');
  assert(editor.document.querySelector('#hcp-0').disabled);
  change(editor,'#hcp-0','22');assert.equal(writes.length,0,'Synthetic viewer edits must also be ignored');
  click(editor,'[data-action="login"]');
  editor.document.querySelector('#login-name').value='admin';editor.document.querySelector('#login-password').value='test';
  editor.document.querySelector('#login-form').dispatchEvent(new editor.w.Event('submit',{bubbles:true,cancelable:true}));
  await tick();await tick();
  assert(!editor.document.querySelector('#hcp-0').disabled);
  assert(!editor.document.querySelector('[data-action="migrate"]').hidden);
  click(viewer,'[data-page="players"]');await tick();
  change(editor,'#hcp-0','18');await tick();await tick();
  assert.equal(viewer.document.querySelector('#hcp-0').value,'18');
  assert(viewer.document.querySelector('#hcp-0').disabled,'SSE must not grant admin permissions');
  assert.equal(editor.w.localStorage.getItem('portugal2026-v1'),JSON.stringify(old),'Keep the legacy backup');
  // Serialize fast entry while responses are delayed, preserving every accepted value.
  let release;hold=new Promise(resolve=>release=resolve);
  change(editor,'#hcp-1','8');change(editor,'#hcp-2','10');release();await tick();await tick();
  assert.deepEqual(snapshot.state.handicaps,[18,8,10,0]);
  assert.equal(writes.at(-1).version,writes.at(-2).version+1);
  // A lost success response retries the same identifier without duplicating a save.
  failure='network';const priorVersion=snapshot.version;
  change(editor,'#hcp-3','11');await tick();await tick();
  assert.equal(writes.at(-1).requestId,writes.at(-2).requestId);
  assert.equal(snapshot.version,priorVersion+1);
  // Remote changes must not destroy an in-progress field or hide conflicts.
  const active=editor.document.querySelector('#hcp-0');active.focus();active.value='20';
  snapshot={...snapshot,state:clone(snapshot.state),version:snapshot.version+1,sequence:snapshot.sequence+1};snapshot.state.handicaps[0]=19;push();
  assert.equal(editor.document.querySelector('#hcp-0').value,'20');
  failure='conflict';active.dispatchEvent(new editor.w.Event('change',{bubbles:true}));await tick();await tick();
  assert.equal(editor.document.querySelector('#hcp-0').value,'19');
  assert.equal(JSON.parse(editor.w.localStorage.getItem('portugal2026-unsaved-draft')).handicaps[0],20);
  assert(!editor.document.querySelector('[data-action="draft"]').hidden);
  click(editor,'[data-page="scorecard"]');await tick();
  change(editor,'#course-tee','ombria-53');await tick();await tick();
  assert.equal(snapshot.state.rounds[0].tee.id,'ombria-53');
  click(editor,'[data-mobile-step="1"][data-player="0"]');await tick();await tick();
  assert.equal(snapshot.state.rounds[0].scores[0][0],5);
  assert.equal(editor.document.querySelector('.score-table [data-score="0"][data-hole="0"]').value,'5');
  change(editor,'#ctp','0');await tick();await tick();
  assert.equal(snapshot.state.rounds[0].ctp,0);
  // Standings and all viewer controls refresh from the pushed state.
  click(viewer,'[data-page="scorecard"]');await tick();
  for(const selector of ['#course-tee','#ctp','[data-score]','[data-mobile-score]','[data-mobile-step]','[data-mobile-clear]','[data-action="setup"]']) assert(viewer.document.querySelector(selector).disabled,selector);
  const count=writes.length;click(viewer,'[data-mobile-step="1"][data-player="0"]');assert.equal(writes.length,count);
  // Converting and saving a tee must update both clients without changing scores.
  const previous=clone(snapshot.state);
  const yardDistances=previous.rounds[0].tee.distances.map(value=>Math.round(value/0.9144));
  click(editor,'[data-action="setup"]');
  change(editor,'#tee-editor [name="unit"]','yd');
  assert.equal(editor.document.querySelector('[name="distance0"]').value,'457');
  assert.equal(viewer.document.querySelector('.hole-distance').textContent,'418 m','Viewers see the saved tee until conversion is committed');
  editor.document.querySelector('.tee-confirm input').checked=true;
  editor.document.querySelector('#tee-editor').dispatchEvent(new editor.w.Event('submit',{bubbles:true,cancelable:true}));
  await tick();await tick();
  assert.equal(snapshot.state.rounds[0].tee.unit,'yd');
  assert.deepEqual(snapshot.state.rounds[0].tee.distances,yardDistances);
  for(const client of [editor,viewer]) {
    assert.equal(client.document.querySelector('.hole-distance').textContent,'457 yd');
    assert(client.document.querySelector('.hole-facts').textContent.includes('457 yd'));
    assert(client.document.querySelector('.course-selection').textContent.includes(yardDistances.reduce((a,b)=>a+b,0).toLocaleString()+' yd'));
  }
  for(const key of ['scores','teamScores','pars','indexes','ctp']) assert.deepEqual(snapshot.state.rounds[0][key],previous.rounds[0][key]);
  assert.deepEqual(snapshot.state.handicaps,previous.handicaps);
  click(editor,'[data-action="setup"]');
  assert.equal(editor.document.querySelector('#tee-editor [name="unit"]').value,'yd');
  assert.equal(editor.document.querySelector('#tee-editor [name="distance0"]').value,'457');
  click(editor,'[data-action="login"]');await tick();await tick();
  assert(editor.document.querySelector('#course-tee').disabled);
  assert(editor.document.querySelector('[data-action="history"]').hidden);
  // Reports arrive through the existing live snapshots, only for completed rounds.
  click(viewer,'[data-page="dashboard"]');await tick();
  const report={status:'ready',report:{title:'<script>unsafe</script>',paragraphs:['James led at the turn.','Ben drew level.','The finish was tied.']}};
  snapshot.summaries=[null,null,report,null];snapshot.sequence++;push();await tick();
  assert(!viewer.document.querySelector('.round-report'),'An incomplete round never shows a report');
  snapshot.state.rounds[2].scores.forEach(row=>row.fill(4));snapshot.sequence++;push();await tick();
  assert(viewer.document.querySelector('#round-report-2'));
  assert.equal(viewer.document.querySelector('#round-report-2 h3').textContent,'<script>unsafe</script>');
  assert(!viewer.document.querySelector('#round-report-2 script'),'AI text is escaped');
  assert(viewer.document.querySelector('a[href="#round-report-2"]'));
  snapshot.summaries[2]={status:'pending'};snapshot.sequence++;push();await tick();
  assert(!viewer.document.querySelector('#round-report-2').textContent.includes('James led'));
  snapshot.summaries[2]=report;snapshot.state.rounds[2].scores[0][17]=null;snapshot.sequence++;push();await tick();
  assert(!viewer.document.querySelector('.round-report'),'Clearing a score removes the report');
  assert.deepEqual(errors,[]);
  editor.dom.window.close();viewer.dom.window.close();
  console.log('Live browser checks passed: read-only controls, login/logout, legacy preservation, queued saves, dropped responses, conflicts, two viewers, tee/mobile/pin updates.');
}
main().catch(error=>{console.error(error);process.exitCode=1;process.exit(1);});
