/* Captures are durable before any upload. Only an explicit user action starts a transfer. */
const MediaQueue = (() => {
  const PHOTO_LIMIT = 25 * 1024 * 1024, VIDEO_LIMIT = 200 * 1024 * 1024;
  const TYPES = ['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm'];
  function randomHex(bytes) { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n=>n.toString(16).padStart(2,'0')).join(''); }
  function mimeFor(file) {
    if (TYPES.includes(file.type)) return file.type;
    return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm'})[file.name.split('.').pop().toLowerCase()] || '';
  }
  class Queue {
    constructor(factory = globalThis.indexedDB, name = 'portugal2026-captures') { this.factory=factory; this.name=name; this.opening=null; }
    open() {
      if (this.opening) return this.opening;
      this.opening = new Promise((resolve,reject)=> {
        if (!this.factory) return reject(Error('This phone cannot store captures in the app.'));
        const request=this.factory.open(this.name,1);
        request.onupgradeneeded=()=> {
          request.result.createObjectStore('queue',{keyPath:'id'});
          request.result.createObjectStore('files',{keyPath:'id'});
        };
        request.onerror=()=>reject(request.error);
        request.onblocked=()=>reject(Error('Close other windows of this app and try again.'));
        request.onsuccess=()=> { request.result.onversionchange=()=>request.result.close(); resolve(request.result); };
      }).catch(error=> {this.opening=null; throw error;});
      return this.opening;
    }
    async read(store, id) {
      const db=await this.open();
      return new Promise((resolve,reject)=> {
        const tx=db.transaction(store), request=id===undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(id);
        request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
      });
    }
    async write(callback) {
      const db=await this.open();
      return new Promise((resolve,reject)=> {
        const tx=db.transaction(['queue','files'],'readwrite');
        tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error || Error('Capture was not saved.'));
        try {callback(tx);} catch(error) {tx.abort();reject(error);}
      });
    }
    async add(file, context) {
      const mime=mimeFor(file), limit=mime.startsWith('image/') ? PHOTO_LIMIT : VIDEO_LIMIT;
      if (!mime || !file.size || file.size>limit) throw Error('Use a supported photo up to 25 MB or a video up to 200 MB. Short clips work best.');
      const id=randomHex(16), key=randomHex(32);
      const record={id,key,meta:{id,round:context.round,hole:context.hole,mime,size:file.size,
        capturedAt:context.capturedAt,timezoneOffsetMinutes:context.timezoneOffsetMinutes,
        historySequenceAtCapture:context.historySequenceAtCapture ?? null,stateVersionAtCapture:context.stateVersionAtCapture ?? null,
        originalName:(file.name || `capture.${mime.split('/')[1]}`).slice(-180)},status:'queued',offset:0,error:null};
      await this.write(tx=> {tx.objectStore('queue').add(record);tx.objectStore('files').add({id,blob:file,thumbnail:null});});
      return record;
    }
    async update(id, patch) {
      await this.write(tx=> {
        const store=tx.objectStore('queue'), request=store.get(id);
        request.onsuccess=()=> {if(request.result) store.put({...request.result,...patch,id});};
      });
    }
    async thumbnail(id, thumbnail) {
      await this.write(tx=> {
        const store=tx.objectStore('files'), request=store.get(id);
        request.onsuccess=()=> {if(request.result) store.put({...request.result,thumbnail});};
      });
    }
    async list() { return (await this.read('queue')).sort((a,b)=>a.meta.capturedAt.localeCompare(b.meta.capturedAt)); }
    async remove(id) { await this.write(tx=> {tx.objectStore('queue').delete(id);tx.objectStore('files').delete(id);}); }
  }
  async function base64(blob) {
    if (!blob) return undefined;
    const bytes=new Uint8Array(await blob.arrayBuffer());
    let binary=''; for(const byte of bytes) binary+=String.fromCharCode(byte);
    return btoa(binary);
  }
  class Uploader {
    constructor(queue, options={}) {
      this.queue=queue; this.fetch=options.fetch || ((...args)=>fetch(...args));
      this.canSend=options.canSend || (()=>false); this.changed=options.changed || (()=>{});
      this.delay=options.delay || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
      this.running=false; this.controller=null; this.current=null;
    }
    stop() { this.controller?.abort(); }
    async request(url, key, options={}) {
      if (!this.canSend() || this.controller.signal.aborted) throw new DOMException('Upload paused.','AbortError');
      const control=new AbortController(), cancel=()=>control.abort();
      this.controller.signal.addEventListener('abort',cancel,{once:true});
      const timer=setTimeout(cancel,60000);
      try {
        const response=await this.fetch(url,{...options,signal:control.signal,cache:'no-store',credentials:'omit',
          headers:{...options.headers,'X-Media-Key':key}});
        const body=await response.json();
        if (!response.ok) {const error=Error(body.error || 'Upload interrupted. Try again on Wi-Fi.');error.status=response.status;throw error;}
        return body;
      } finally {clearTimeout(timer);this.controller.signal.removeEventListener('abort',cancel);}
    }
    async transfer(record) {
      const files=await this.queue.read('files',record.id);
      if (!files?.blob || files.blob.size!==record.meta.size) throw Error('The local file is unavailable. Keep any original copy on your phone.');
      const root=`/api/media/uploads/${record.id}`;
      let state=await this.request('/api/media/uploads',record.key,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...record.meta,thumbnail:await base64(files.thumbnail)})});
      while (state.status!=='ready' && state.offset<record.meta.size) {
        if (!Number.isInteger(state.offset) || state.offset<0 || !Number.isInteger(state.chunkSize) || state.chunkSize<1 || state.chunkSize>2*1024*1024) throw Error('Invalid upload response.');
        const chunk=files.blob.slice(state.offset,Math.min(state.offset+state.chunkSize,record.meta.size));
        state=await this.request(root,record.key,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Upload-Offset':String(state.offset)},body:chunk});
        await this.queue.update(record.id,{offset:state.offset,status:'uploading',error:null}); this.changed();
      }
      if (state.status!=='ready') state=await this.request(root+'/complete',record.key,{method:'POST'});
      if (state.id!==record.id || state.status!=='ready' || state.size!==record.meta.size || state.offset!==record.meta.size || !/^[a-f0-9]{64}$/.test(state.item?.sha256 || '')) throw Error('The server has not confirmed a complete saved copy.');
      await this.queue.remove(record.id); // Only after the server durably confirms the complete original.
    }
    async start() {
      if(this.running || !this.canSend()) return;
      this.running=true; this.controller=new AbortController();this.changed();
      try {
        const captures=await this.queue.list();
        for(const record of captures) {
          if(!this.canSend() || this.controller.signal.aborted) break;
          this.current=record.id;
          for(let attempt=0;attempt<3;attempt++) {
            try {await this.transfer(record);break;}
            catch(error) {
              const paused=this.controller.signal.aborted || !this.canSend();
              if(paused) {await this.queue.update(record.id,{status:'queued',error:null});break;}
              if(attempt<2 && (!error.status || error.status===409 || error.status>=500)) {await this.delay(1000*(attempt+1));continue;}
              await this.queue.update(record.id,{status:'failed',error:error.message});break;
            }
          }
          this.changed();
        }
      } finally {this.running=false;this.current=null;this.changed();}
    }
  }
  return {Queue,Uploader,mimeFor,PHOTO_LIMIT,VIDEO_LIMIT};
})();
if (typeof module !== 'undefined') module.exports=MediaQueue;
