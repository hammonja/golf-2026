const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
global.crypto=require('crypto').webcrypto;
global.Blob=require('buffer').Blob;
global.DOMException=require('domexception');
// Node 16 has native structured cloning through message ports, including Blob.
if(!global.structuredClone)global.structuredClone=value=> {
  const {MessageChannel,receiveMessageOnPort}=require('worker_threads'),{port1,port2}=new MessageChannel();
  try {port1.postMessage(value);return receiveMessageOnPort(port2).message;} finally {port1.close();port2.close();}
};
const {indexedDB}=require('fake-indexeddb');
const {Queue,Uploader}=require('./media_queue');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const context={round:2,hole:16,capturedAt:'2026-09-24T10:00:00.000Z',timezoneOffsetMinutes:-60,historySequenceAtCapture:12,stateVersionAtCapture:4};
function photo(){const blob=new Blob([Buffer.from([255,216,255]),'golf photo '.repeat(100)],{type:'image/jpeg'});blob.name='capture.jpg';return blob;}
function serverMock(options={}) {
  let saved=null, offset=0, bytes=[], ready=false, calls=[], lost=false;
  const fetch=async(url,request)=> {
    calls.push({url,method:request.method});let result;
    if(url==='/api/media/uploads')saved=JSON.parse(request.body);
    else if(request.method==='PUT') {
      assert.equal(Number(request.headers['X-Upload-Offset']),offset);
      const body=Buffer.from(await request.body.arrayBuffer());bytes.push(body);offset+=body.length;
      options.onChunk?.();
      if(options.loseChunk && !lost){lost=true;throw Error('Connection lost after saving chunk');}
    } else if(url.endsWith('/complete')) {
      ready=true;
      if(options.loseFinish && !lost){lost=true;throw Error('Connection lost after completion');}
    }
    result={id:options.badReceipt ? 'wrong' : saved.id,status:ready?'ready':'uploading',offset,size:saved.size,chunkSize:256,
      item:ready?{sha256:require('crypto').createHash('sha256').update(Buffer.concat(bytes)).digest('hex')}:null};
    return {ok:!options.reject,status:options.reject || 200,json:async()=>options.reject?{error:'Rejected'}:result};
  };
  return {fetch,calls,get bytes(){return Buffer.concat(bytes);},get offset(){return offset;}};
}
async function queueTests() {
  const queue=new Queue(indexedDB,'persistent-capture-test'), file=photo();
  const first=await queue.add(file,context);
  assert.equal((await queue.list()).length,1);
  (await queue.open()).close();
  const restored=new Queue(indexedDB,'persistent-capture-test');
  assert.equal((await restored.list())[0].meta.hole,16);
  assert.equal((await restored.read('files',first.id)).blob.size,file.size);
  let maySend=false;
  const mock=serverMock();
  const upload=new Uploader(restored,{fetch:mock.fetch,canSend:()=>maySend,delay:async()=>{}});
  await tick();assert.equal(mock.calls.length,0,'Opening a saved queue never uploads');
  await upload.start();assert.equal(mock.calls.length,0,'No transfer without permission/connection');
  maySend=true;await upload.start();
  assert.equal((await restored.list()).length,0);
  assert.deepEqual(mock.bytes,Buffer.from(await file.arrayBuffer()));
  for(const fault of ['loseChunk','loseFinish']) {
    const queue=new Queue(indexedDB,'recover-'+fault), file=photo();await queue.add(file,context);
    const mock=serverMock({[fault]:true});
    await new Uploader(queue,{fetch:mock.fetch,canSend:()=>true,delay:async()=>{}}).start();
    assert.equal((await queue.list()).length,0,fault);
    assert.deepEqual(mock.bytes,Buffer.from(await file.arrayBuffer()),'Lost responses do not repeat already-saved bytes');
  }
  const paused=new Queue(indexedDB,'paused-capture');await paused.add(file,context);
  let allowed=true;
  const pausedMock=serverMock({onChunk:()=> {allowed=false;}});
  await new Uploader(paused,{fetch:pausedMock.fetch,canSend:()=>allowed}).start();
  assert.equal((await paused.list()).length,1,'Going offline retains the original');
  assert.equal((await paused.list())[0].offset,256);
  const previousCalls=pausedMock.calls.length;allowed=true;
  await tick();assert.equal(pausedMock.calls.length,previousCalls,'Returning online never resumes automatically');
  const resumeMock=pausedMock.fetch;
  // Restore connectivity throughout the remainder of the explicit upload session.
  await new Uploader(paused,{fetch:async(...args)=>{const result=await resumeMock(...args);allowed=true;return result;},canSend:()=>allowed}).start();
  assert.equal((await paused.list()).length,0);
  for(const options of [{reject:403},{badReceipt:true}]) {
    const queue=new Queue(indexedDB,'failure-'+JSON.stringify(options));const record=await queue.add(file,context);
    const mock=serverMock(options);
    await new Uploader(queue,{fetch:mock.fetch,canSend:()=>true,delay:async()=>{}}).start();
    assert.equal((await queue.list())[0].status,'failed');
    assert((await queue.read('files',record.id)).blob,'Failed or unconfirmed uploads retain the full local file');
  }
  for(const invalid of [new Blob(['x'],{type:'text/html'}),new Blob([],{type:'image/jpeg'})]) {
    invalid.name='bad.html';await assert.rejects(()=>restored.add(invalid,context));
  }
  const atomic=new Queue(indexedDB,'atomic-save');
  await assert.rejects(()=>atomic.write(tx=> {
    tx.objectStore('queue').add({id:'incomplete'});
    tx.objectStore('files').add({id:'incomplete',uncloneable:()=>{}});
  }));
  assert.deepEqual(await atomic.list(),[],'A failed file save cannot leave an orphaned queue entry');
  console.log('Media queue: persistence, manual-only transfer, interruption recovery, idempotent retry and confirmed-copy deletion passed.');
}
async function browserTests() {
  const {IDBFactory}=require('fake-indexeddb');
  const dom=new JSDOM('<div id="app"></div><div id="toast"></div>',{url:'https://golf.example/',runScripts:'outside-only',pretendToBeVisual:true}), w=dom.window;
  const errors=[], requests=[], streams=[];
  w.addEventListener('error',event=>errors.push(event.error));
  w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.confirm=()=>true;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  Object.defineProperty(w,'indexedDB',{value:new IDBFactory()});
  Object.defineProperty(w.navigator,'maxTouchPoints',{value:1});
  Object.defineProperty(w.navigator,'standalone',{value:false,writable:true});
  Object.defineProperty(w.navigator,'storage',{value:{persist:async()=>true}});
  w.URL.createObjectURL=()=> 'blob:preview';w.URL.revokeObjectURL=()=>{};
  w.Image=class {set src(value){queueMicrotask(()=>this.onerror?.());}};
  w.EventSource=class {constructor(){this.listeners={};streams.push(this);}addEventListener(type,fn){this.listeners[type]=fn;}};
  let snapshot={version:4,sequence:12,courses:JSON.parse(fs.readFileSync('course_defaults.json','utf8')),summaries:[null,null,null,null],
    state:{handicaps:[0,0,0,0],rounds:Array.from({length:4},()=>({scores:Array.from({length:4},()=>Array(18).fill(null)),teamScores:Array.from({length:2},()=>Array(18).fill(null)),pars:Array(18).fill(4),indexes:Array.from({length:18},(_,i)=>i+1),verified:false,ctp:null}))}};
  const uploadMock=serverMock();let published=[];
  w.fetch=async(url,options={})=> {
    requests.push({url,method:options.method});
    if(url.startsWith('/api/media/uploads'))return uploadMock.fetch(url,options);
    const body=url==='/api/session'?{admin:false,csrf:null}:url==='/api/media'?{items:published}:snapshot;
    return {ok:true,status:200,json:async()=>structured(body)};
  };
  function structured(value){return JSON.parse(JSON.stringify(value));}
  const ctx=dom.getInternalVMContext();
  for(const name of ['scoring.js','courses.js','mobile.js','live.js','pwa.js','media_queue.js','media.js','app.js'])vm.runInContext(fs.readFileSync(name,'utf8'),ctx,{filename:name});
  await tick();await tick();
  w.document.querySelector('[data-page="scorecard"]').click();
  assert(!w.document.querySelector('.hole-camera'),'Ordinary browser tabs do not expose camera capture');
  w.dispatchEvent(new w.Event('appinstalled'));await tick();
  assert(!w.document.querySelector('.hole-camera'),'Installing from a browser tab does not turn that tab into the standalone app');
  w.navigator.standalone=true;w.dispatchEvent(new w.Event('appinstalled'));await tick();
  assert.equal(w.document.querySelectorAll('.score-table .hole-camera').length,18);
  assert(!w.document.querySelector('.hole-camera').disabled,'Logged-out visitors can capture');
  assert(w.document.querySelector('[data-mobile-score]').disabled,'Scores remain read-only');
  assert(w.document.querySelector('.media-upload-bar').textContent.includes('0 pictures to upload'));
  w.document.querySelector('.hole-camera-row .hole-camera').click();
  const input=w.document.querySelector('[data-camera-input="photo"]');
  assert.equal(input.getAttribute('capture'),'environment');assert.equal(input.accept,'image/*');
  assert.equal(w.document.querySelector('[data-camera-input="video"]').accept,'video/*');
  w.document.querySelector('[data-camera-photo]').click();
  snapshot.sequence++;streams[0].listeners.snapshot({data:JSON.stringify(snapshot)});
  assert.equal(w.document.querySelector('[data-camera-input="photo"]'),input,'Native camera input survives live score updates');
  Object.defineProperty(input,'files',{value:[photo()]});input.dispatchEvent(new w.Event('change'));
  for(let i=0;i<20 && w.document.getElementById('media-dialog');i++)await tick();
  assert(!w.document.getElementById('media-dialog'),'Capture saved to local queue');
  assert(w.document.querySelector('.media-upload-bar').textContent.includes('1 picture to upload'));
  assert.equal(uploadMock.calls.length,0,'Capture never auto-uploads');
  w.document.querySelector('[data-media-upload]').click();
  for(let i=0;i<50 && !w.document.querySelector('.media-upload-bar').textContent.includes('0 pictures to upload');i++)await tick();
  assert(w.document.querySelector('.media-upload-bar').textContent.includes('0 pictures to upload'));
  assert(uploadMock.calls.length>0);
  published=[{id:'a'.repeat(32),round:2,hole:16,kind:'photo',mime:'image/jpeg',size:1234,capturedAt:context.capturedAt,thumbnailUrl:'/api/media/'+ 'a'.repeat(32)+'/thumbnail'}];
  w.document.querySelector('[data-page="gallery"]').click();await tick();await tick();
  const group=w.document.querySelector('[data-group="2-16"]');assert(group);assert(group.textContent.includes('Hole 16'));
  assert(w.document.querySelector('#media-gallery').textContent.includes('Faldo'));
  assert(!w.document.querySelector('#media-gallery').textContent.includes('James'),'Gallery is not grouped by player');
  assert.equal(w.document.querySelectorAll('#media-gallery video').length,0,'Video originals do not preload in the gallery');
  assert.deepEqual(errors,[]);w.close();
  console.log('Media UI: PWA-only camera, viewer capture, frozen hole metadata, local save, explicit upload and course/hole gallery passed.');
}
queueTests().then(browserTests).catch(error=>{console.error(error);process.exitCode=1;process.exit(1);});
