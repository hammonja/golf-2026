/* Camera capture is limited to installed touch apps; the gallery is public. */
const Media = (() => {
  const queue = new MediaQueue.Queue();
  const cameraIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 5l1.5-2h5L16 5h4a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z"/><circle cx="12" cy="12" r="4"/></svg>';
  let records=[], storageError='', refreshId=0, lastGallery=[], galleryLoaded=false, galleryBusy=false, galleryFetched=0;
  let captureSaving=false, lastSequence=null, lastVersion=null;
  const mobilePWA=()=> typeof PWA!=='undefined' && PWA.isRunningStandalone() && (navigator.maxTouchPoints>0 || window.matchMedia?.('(pointer: coarse)').matches);
  const connection=()=>navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const canSend=()=>mobilePWA() && navigator.onLine!==false && !document.hidden && connection()?.type!=='cellular';
  const uploader=new MediaQueue.Uploader(queue,{canSend,changed:()=> {refreshQueue();if(!uploader.running) refreshGallery(true);}});
  const sizeLabel=bytes=>bytes<1024*1024 ? `${Math.ceil(bytes/1024)} KB` : `${(bytes/1024/1024).toFixed(1)} MB`;
  function countLabel() {
    const photos=records.filter(r=>r.meta.mime.startsWith('image/')).length, videos=records.length-photos;
    return [photos || !videos ? `${photos} ${photos===1 ? 'picture' : 'pictures'}` : '',videos ? `${videos} ${videos===1 ? 'video' : 'videos'}` : ''].filter(Boolean).join(' · ')+' to upload';
  }
  async function refreshQueue() {
    const id=++refreshId;
    try {const result=await queue.list();if(id!==refreshId)return;records=result;storageError='';}
    catch {storageError='Phone storage is unavailable. Captures cannot be saved yet.';}
    updateBanner(); updateQueueDialog();
  }
  function updateBanner() {
    const bar=document.querySelector('.media-upload-bar');if(!bar)return;
    const current=records.find(r=>r.id===uploader.current);
    const progress=current ? ` · ${Math.min(100,Math.floor(current.offset/current.meta.size*100))}%` : '';
    const failed=records.some(r=>r.status==='failed');
    bar.innerHTML=`<div><strong role="status">${storageError || countLabel()}</strong><small>${uploader.running ? 'Uploading — keep the app open'+progress : failed ? 'Some uploads need retrying. Your copies are still on this phone.' : 'Saved on this phone. Connect to Wi-Fi before uploading.'}</small></div><div class="media-upload-actions">${records.length ? `<button type="button" class="text-button" data-media-upload>${uploader.running ? 'Pause' : 'Upload now'}</button><button type="button" class="text-button" data-media-queue>View queue</button>` : ''}</div>`;
  }
  function captureButton(ri,hole) {
    return `<button type="button" class="hole-camera" data-capture-round="${ri}" data-capture-hole="${hole}" aria-label="Take a photo or video of ${COURSES[ri]}, hole ${hole}">${cameraIcon}</button>`;
  }
  function decorate() {
    if(!app.querySelector)return;
    app.querySelectorAll('.hole-camera,.hole-camera-row,.media-upload-bar').forEach(el=>el.remove());
    if(mobilePWA()) {
      app.querySelector('.live-bar')?.insertAdjacentHTML('afterend','<aside class="media-upload-bar" aria-label="Captures waiting to upload"></aside>');
      updateBanner();
      if(page==='scorecard') {
        const hole=(mobileHoles[selected] ?? firstUnfinishedHole(selected))+1;
        app.querySelector('.mobile-hole-editor .hole-toolbar')?.insertAdjacentHTML('afterend',`<div class="hole-camera-row"><span>Capture hole ${hole}</span>${captureButton(selected,hole)}</div>`);
        app.querySelectorAll('.score-table .hole-number').forEach((cell,i)=>cell.insertAdjacentHTML('beforeend',captureButton(selected,i+1)));
      }
    }
    if(page==='gallery') {paintGallery();refreshGallery();}
  }
  function modal(title,body,returnTo) {
    if(document.getElementById('media-dialog'))return null;
    const dialog=document.createElement('dialog');dialog.id='media-dialog';dialog.className='media-dialog';dialog.setAttribute('aria-labelledby','media-dialog-title');
    dialog.innerHTML=`<div class="media-dialog-header"><h2 id="media-dialog-title">${escapeHTML(title)}</h2><button type="button" class="text-button" data-media-close aria-label="Close media window" autofocus>Close ×</button></div><div class="media-dialog-body">${body}</div>`;
    document.body.append(dialog);document.body.classList.add('media-open');
    dialog.mediaCanClose=()=>!captureSaving;
    const close=()=> {if(dialog.mediaCanClose())dialog.close();};
    dialog.querySelector('[data-media-close]').onclick=close;
    dialog.addEventListener('cancel',event=> {if(!dialog.mediaCanClose())event.preventDefault();});
    dialog.addEventListener('click',event=> {
      if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();
      if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)close();
    });
    dialog.addEventListener('close',()=> {dialog.remove();document.body.classList.remove('media-open');document.querySelector(returnTo)?.focus({preventScroll:true});});
    dialog.showModal();return dialog;
  }
  async function makeThumbnail(file) {
    if(!MediaQueue.mimeFor(file).startsWith('image/'))return null;
    const url=URL.createObjectURL(file), img=new Image();
    try {
      await new Promise((resolve,reject)=> {const timer=setTimeout(()=>reject(Error('Preview unavailable')),8000);img.onload=()=> {clearTimeout(timer);resolve();};img.onerror=()=> {clearTimeout(timer);reject(Error());};img.src=url;});
      const scale=Math.min(1,480/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.65));
      return blob && blob.size<=100*1024 ? blob : null;
    } catch {return null;} finally {URL.revokeObjectURL(url);}
  }
  function capture(ri,hole) {
    if(!mobilePWA() || !Number.isInteger(ri) || ri<0 || ri>3 || !Number.isInteger(hole) || hole<1 || hole>18)return;
    const selector=`[data-capture-round="${ri}"][data-capture-hole="${hole}"]`;
    const dialog=modal(`${COURSES[ri]} · Hole ${hole}`,`<p>Capture a moment from this hole. It stays on this phone until you choose <strong>Upload now</strong>.</p><div class="capture-choices"><button type="button" class="button green-button" data-camera-photo>${cameraIcon} Take photo</button><button type="button" class="button outline" data-camera-video>▷ Record video</button></div><p class="fine-print">Photos up to 25 MB · videos up to 200 MB. Short clips work best. Keep this app’s data until uploads finish.</p><p class="media-capture-message" role="status"></p><input type="file" accept="image/*" capture="environment" data-camera-input="photo" hidden><input type="file" accept="video/*" capture="environment" data-camera-input="video" hidden>`,selector);
    if(!dialog)return;
    let context=null, unsaved=null, backupUrl=null;
    const message=dialog.querySelector('.media-capture-message');
    dialog.mediaCanClose=()=>!captureSaving && (!unsaved || confirm('This capture could not be saved in the app. Close only if you have kept another copy. Close now?'));
    dialog.addEventListener('close',()=> {if(backupUrl)URL.revokeObjectURL(backupUrl);});
    async function saveFile(file) {
      captureSaving=true;message.textContent='Saving on this phone…';
      dialog.querySelectorAll('.capture-choices button').forEach(button=>button.disabled=true);
      try {
        const record=await queue.add(file,context);
        unsaved=null; // The original has committed to IndexedDB before reporting success.
        navigator.storage?.persist?.().catch(()=>{});
        const thumbnail=await makeThumbnail(file);
        if(thumbnail)await queue.thumbnail(record.id,thumbnail).catch(()=>{});
        await refreshQueue();captureSaving=false;dialog.close();toast('Saved on this phone. Tap Upload now when you are on Wi-Fi.');
      } catch(error) {
        unsaved=file;message.replaceChildren();
        const explanation=document.createElement('span');explanation.textContent=`Not saved in the app: ${error.name==='QuotaExceededError' ? 'phone storage is full.' : error.message} Save a copy before closing.`;
        const download=document.createElement('a');download.className='button outline';download.textContent='Save a copy';
        if(backupUrl)URL.revokeObjectURL(backupUrl);backupUrl=URL.createObjectURL(file);download.href=backupUrl;download.download=file.name || 'golf-capture';
        const retry=document.createElement('button');retry.type='button';retry.className='button outline';retry.textContent='Try saving again';retry.onclick=()=>saveFile(file);
        message.append(explanation,download,retry);
      } finally {captureSaving=false;dialog.querySelectorAll('.capture-choices button').forEach(button=>button.disabled=Boolean(unsaved));}
    }
    for(const kind of ['photo','video']) {
      const input=dialog.querySelector(`[data-camera-input="${kind}"]`);
      dialog.querySelector(`[data-camera-${kind}]`).onclick=()=> {
        context={round:ri,hole,capturedAt:new Date().toISOString(),timezoneOffsetMinutes:new Date().getTimezoneOffset(),historySequenceAtCapture:lastSequence,stateVersionAtCapture:lastVersion};
        input.value='';input.click(); // Native camera request remains inside the user's tap gesture.
      };
      input.onchange=()=> {if(input.files?.[0])saveFile(input.files[0]);};
    }
  }
  function upload() {
    if(uploader.running){uploader.stop();return;}
    if(!mobilePWA()){toast('Open the installed phone app to upload its captures.');return;}
    if(navigator.onLine===false){toast('Connect to Wi-Fi, then tap Upload now.');return;}
    if(connection()?.type==='cellular'){toast('Your phone reports mobile data. Connect to Wi-Fi before uploading.');return;}
    uploader.start().catch(()=>toast('Upload paused. Your captures remain on this phone.'));
  }
  function showQueue() {
    const dialog=modal('Captures on this phone','<p>Connect to Wi-Fi, then choose Upload now. Keep the app open while uploading. On iPhone the app cannot check your connection type.</p><div class="queue-controls"><button type="button" class="button green-button" data-media-upload>Upload now</button></div><div class="media-queue-items"></div>','[data-media-queue]');
    if(dialog)updateQueueDialog();
  }
  function updateQueueDialog() {
    const container=document.querySelector('.media-queue-items');if(!container)return;
    container.innerHTML=records.length ? records.map(record=>`<article class="queued-capture"><div><strong>${COURSES[record.meta.round]} · Hole ${record.meta.hole}</strong><small>${record.meta.mime.startsWith('image/') ? 'Photo' : 'Video'} · ${sizeLabel(record.meta.size)} · ${Math.min(100,Math.floor(record.offset/record.meta.size*100))}% transferred</small>${record.error ? `<p>${escapeHTML(record.error)}</p>` : ''}</div><button type="button" class="text-button" data-save-capture="${record.id}">Save a copy</button></article>`).join('') : '<p>All captures have uploaded.</p>';
    const button=document.querySelector('.queue-controls [data-media-upload]');button.textContent=uploader.running ? 'Pause uploads' : 'Upload now';button.disabled=!records.length;
  }
  async function saveCopy(id) {
    const record=records.find(r=>r.id===id), files=await queue.read('files',id);
    if(!record || !files?.blob)return;
    const url=URL.createObjectURL(files.blob), link=document.createElement('a');link.href=url;link.download=record.meta.originalName;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  function gallery() {
    shell('<div class="page-heading"><div class="eyebrow green">MOMENTS FROM THE COURSE</div><h1>The gallery<span>.</span></h1><p>Photos and videos, grouped by course and hole.</p></div><div class="gallery-tools"><button type="button" class="button outline" data-gallery-refresh>Refresh gallery</button><a class="text-button" href="/api/media/manifest.json" download>Download media metadata ↗</a></div><div id="media-gallery" aria-live="polite"></div>');
  }
  function paintGallery(error) {
    const root=document.getElementById('media-gallery');if(!root)return;
    const fingerprint=JSON.stringify(lastGallery);
    if(root.dataset.fingerprint===fingerprint && !error)return;
    if(!galleryLoaded){root.innerHTML=`<p class="notice">${error ? 'Gallery could not load. Reconnect and tap Refresh gallery.' : 'Loading the gallery…'}</p>`;return;}
    const open=new Set(Array.from(root.querySelectorAll('details[open]')).map(el=>el.dataset.group));
    root.innerHTML=COURSES.map((course,ri)=> {
      const photos=lastGallery.filter(item=>item.round===ri);
      return `<section class="gallery-course"><h2>${course} <small>Round ${ri+1} · ${photos.length} ${photos.length===1 ? 'capture' : 'captures'}</small></h2>${photos.length ? Array.from(new Set(photos.map(p=>p.hole))).sort((a,b)=>a-b).map(hole=> {
        const items=photos.filter(p=>p.hole===hole),group=`${ri}-${hole}`;
        return `<details class="gallery-hole card" data-group="${group}" ${open.has(group) ? 'open' : ''}><summary>Hole ${hole}<span>${items.length} ${items.length===1 ? 'capture' : 'captures'}</span></summary><div class="gallery-grid">${items.map(item=>`<button type="button" class="gallery-item" data-media-view="${item.id}" aria-label="View ${item.kind==='video' ? 'video' : 'photo'} of ${course}, hole ${hole}">${item.thumbnailUrl ? `<img src="/api/media/${item.id}/thumbnail" alt="" loading="lazy" decoding="async">` : `<span class="gallery-placeholder">${item.kind==='video' ? '▷' : cameraIcon}</span>`}<span>${item.kind==='video' ? 'Video' : 'Photo'} · ${sizeLabel(item.size)}</span></button>`).join('')}</div></details>`;
      }).join('') : '<p class="gallery-empty">No captures uploaded yet.</p>'}</section>`;
    }).join('');
    root.dataset.fingerprint=fingerprint;
  }
  async function refreshGallery(force=false) {
    if(typeof page==='undefined' || page!=='gallery' || galleryBusy || (!force && Date.now()-galleryFetched<15000))return;
    galleryBusy=true;
    try {
      const response=await fetch('/api/media',{cache:'no-store'});if(!response.ok)throw Error();
      const result=await response.json();if(!Array.isArray(result.items))throw Error();
      lastGallery=result.items.filter(item=>/^[a-f0-9]{32}$/.test(item.id) && Number.isInteger(item.round) && item.round>=0 && item.round<4 && Number.isInteger(item.hole) && item.hole>=1 && item.hole<=18);
      galleryLoaded=true;galleryFetched=Date.now();paintGallery();
    } catch {paintGallery(true);} finally {galleryBusy=false;}
  }
  function view(id) {
    const item=lastGallery.find(item=>item.id===id);if(!item)return;
    const file=`/api/media/${id}/file`,title=`${COURSES[item.round]} · Hole ${item.hole}`;
    const display=item.kind==='video' ? `<video controls playsinline preload="metadata" src="${file}"></video>` : `<img class="media-original" src="${file}" alt="${title}">`;
    const date=new Date(item.capturedAt), dateText=Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    const dialog=modal(title,`${display}<p class="media-view-error" hidden>This format may need downloading to view on your device.</p><p class="fine-print">Captured ${escapeHTML(dateText)} · ${sizeLabel(item.size)}</p><a class="button outline" href="${file}?download=1" download>Download original ↗</a>`,`[data-media-view="${id}"]`);
    if(dialog){dialog.querySelector('video,img').onerror=()=> {dialog.querySelector('.media-view-error').hidden=false;};dialog.addEventListener('close',()=>dialog.querySelector('video')?.pause());}
  }
  function observe(snapshot) {
    lastSequence=snapshot.sequence;lastVersion=snapshot.version;
    refreshGallery();
  }
  function start() {
    refreshQueue();
    document.addEventListener('click',event=> {
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.captureRound!==undefined)capture(Number(button.dataset.captureRound),Number(button.dataset.captureHole));
      if(button.hasAttribute('data-media-upload'))upload();
      if(button.hasAttribute('data-media-queue'))showQueue();
      if(button.dataset.saveCapture)saveCopy(button.dataset.saveCapture).catch(()=>toast('The local copy could not be opened.'));
      if(button.hasAttribute('data-gallery-refresh'))refreshGallery(true);
      if(button.dataset.mediaView)view(button.dataset.mediaView);
    });
    // Going into the background ends this manual upload session, particularly on iOS.
    document.addEventListener('visibilitychange',()=> {if(document.hidden)uploader.stop();else {refreshQueue();refreshGallery();}});
    window.addEventListener('offline',()=>uploader.stop());
    connection()?.addEventListener?.('change',()=> {if(!canSend())uploader.stop();updateBanner();});
    window.addEventListener('appinstalled',()=> {decorate();refreshQueue();});
    window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change',()=> {decorate();refreshQueue();});
    window.addEventListener('beforeunload',event=> {if(captureSaving){event.preventDefault();event.returnValue='';}});
    setInterval(()=> {if(!document.hidden)refreshGallery();},15000);
  }
  return {start,decorate,gallery,refreshGallery,observe,mobilePWA};
})();
