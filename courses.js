let courseLibrary = null, courseLoadError = '', newTee = false;
const escapeHTML = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function teeSnapshotValid(tee) {
  return tee === undefined || tee === null || (typeof tee.id==='string' && typeof tee.name==='string' && tee.name.length<=50 && ['m','yd'].includes(tee.unit) && Array.isArray(tee.distances) && tee.distances.length===18 && tee.distances.every(d=>Number.isInteger(d) && d>0 && d<=1000));
}
function applyTee(ri,tee) {
  const round=data.rounds[ri];
  // A bonus belongs to the last par 3; do not carry it onto a different hole.
  if(round.pars.lastIndexOf(3)!==tee.pars.lastIndexOf(3)) round.ctp=null;
  Object.assign(round,{pars:[...tee.pars],indexes:[...tee.indexes],verified:true,tee:{id:tee.id,name:tee.name,unit:tee.unit,distances:[...tee.distances]}});
  save();
}
function teeDistance(ri,hole) {
  const tee=data.rounds[ri].tee;
  return tee ? `${tee.distances[hole]} ${tee.unit}` : '';
}
async function loadCourseLibrary() {
  try {
    const response=await fetch('/api/courses');
    if(!response.ok) throw Error('Course library unavailable. Check the Python server and try again.');
    const courses=await response.json();
    if(!Array.isArray(courses)||courses.length!==4) throw Error('Invalid course library response.');
    courseLibrary=courses;courseLoadError='';
  } catch(error) {courseLoadError=error.message;}
  // Never replace an in-progress score entry when this background request finishes.
  if(page==='scorecard') {
    const panel=app.querySelector('.course-selection');
    if(panel) panel.outerHTML=courseSelection(selected);
    const holder=app.querySelector('.course-library-setup');
    if(holder) holder.outerHTML=courseLibrarySetup(selected);
  }
}
function courseSelection(ri) {
  const round=data.rounds[ri], course=courseLibrary?.[ri];
  if(!course) return `<section class="course-selection"><p>${escapeHTML(courseLoadError || 'Loading course tees…')}</p>${courseLoadError ? '<button class="button outline" data-course-reload>Retry course library</button>' : ''}</section>`;
  const current=round.tee;
  return `<section class="course-selection"><label for="course-tee">Playing tee · ${COURSES[ri]}</label><select id="course-tee"><option value="">${current ? 'Choose another tee' : 'Select a tee'}</option>${course.tees.map(t=>`<option value="${escapeHTML(t.id)}" ${current?.id===t.id ? 'selected' : ''}>${escapeHTML(t.name)} · ${t.distances.reduce((a,b)=>a+b,0).toLocaleString()} ${t.unit}</option>`).join('')}</select><p>${current ? `Playing ${escapeHTML(current.name)} · ${current.distances.reduce((a,b)=>a+b,0).toLocaleString()} ${current.unit} · par ${round.pars.reduce((a,b)=>a+b,0)}. ` : ''}${course.tees.length ? 'Tee selection updates distances, pars and stroke indexes. Your playing handicaps stay as entered.' : 'Upload your scorecard and add its tees under Course setup.'}</p>${current ? '<button class="text-button" data-reapply-tee>Reapply latest saved tee details</button>' : ''}<div class="course-file-links">${Object.entries(course.assets).map(([kind,file])=>`<a href="${escapeHTML(file.url)}" target="_blank" rel="noopener">${kind==='map' ? 'View course map' : 'View scorecard'} ↗</a>`).join('')}</div>${Object.values(course.assets).filter(file=>file.note).map(file=>`<p class="course-document-note">${escapeHTML(file.note)}</p>`).join('')}</section>`;
}
function courseLibrarySetup(ri) {
  const course=courseLibrary?.[ri];
  if(!course) return `<section class="course-library-setup notice">${escapeHTML(courseLoadError || 'Loading course library…')}<button class="button outline" data-course-reload>Retry</button></section>`;
  const current=course.tees.find(t=>t.id===data.rounds[ri].tee?.id);
  const tee=newTee ? null : current || course.tees[0];
  const pars=tee?.pars || data.rounds[ri].pars;
  const indexes=tee?.indexes || data.rounds[ri].indexes;
  return `<section class="course-library-setup"><h3>Course map & scorecard</h3><p>Upload a PDF, PNG, JPEG or WebP (up to 10 MB each). Files and tee definitions are saved on the webserver for all devices. Images and PDFs are references; enter each tee’s numbers below once.</p><div class="course-upload-grid">${['map','scorecard'].map(kind=>{const file=course.assets[kind];return `<section class="course-upload"><h4>${kind==='map' ? 'Course map' : 'Original scorecard'}</h4>${file ? `<a href="${escapeHTML(file.url)}" target="_blank" rel="noopener">${file.type.startsWith('image/') ? `<img src="${escapeHTML(file.url)}?v=${course.version}" alt="${escapeHTML(course.name)} ${kind}" loading="lazy">` : '<span class="pdf-reference">PDF ↗</span>'}<span>${escapeHTML(file.name)}</span></a>${file.note ? `<p class="course-document-note">${escapeHTML(file.note)}</p>` : ''}${file.source ? `<a class="course-document-source" href="${escapeHTML(file.source)}" target="_blank" rel="noopener">Document source</a>` : ''}` : '<p>No file uploaded yet.</p>'}<label class="upload-label">${file ? 'Replace file' : 'Upload file'}<input type="file" data-course-upload="${kind}" accept="image/png,image/jpeg,image/webp,application/pdf"></label></section>`;}).join('')}</div>${course.source ? `<p class="fine-print">Official ${escapeHTML(course.name)} reference: <a href="${escapeHTML(course.source)}" target="_blank" rel="noopener">course website ↗</a></p>` : ''}<div class="tee-editor-heading"><div><h3>${tee ? `Edit ${escapeHTML(tee.name)} tee` : 'Add a tee'}</h3><p>Save a tee once, then select it whenever you play.</p></div><button class="button outline" data-new-tee>${newTee ? 'Cancel new tee' : 'Add another tee'}</button></div><form id="tee-editor" data-tee-id="${escapeHTML(tee?.id || '')}"><div class="tee-fields"><label>Tee name / colour<input name="teeName" maxlength="50" required value="${escapeHTML(tee?.name || '')}" placeholder="e.g. Yellow or 53"></label><label>Distances in<select name="unit"><option value="m" ${tee?.unit!=='yd' ? 'selected' : ''}>Metres</option><option value="yd" ${tee?.unit==='yd' ? 'selected' : ''}>Yards</option></select></label></div><div class="tee-holes"><div class="tee-hole-header"><span>Hole</span><span>Par</span><span>Stroke index</span><span>Distance</span></div>${pars.map((par,i)=>`<div class="tee-hole-row"><strong>${i+1}</strong><input name="par${i}" aria-label="Hole ${i+1} par" type="number" inputmode="numeric" min="3" max="6" step="1" required value="${par}"><input name="si${i}" aria-label="Hole ${i+1} stroke index" type="number" inputmode="numeric" min="1" max="18" step="1" required value="${indexes[i]}"><input name="distance${i}" aria-label="Hole ${i+1} distance" type="number" inputmode="numeric" min="1" max="1000" step="1" required value="${tee?.distances[i] || ''}"></div>`).join('')}</div><label class="tee-confirm"><input type="checkbox" required> I have checked these 18 holes against the scorecard.</label><p class="fine-print">Use every stroke index from 1 to 18 once. Changing the last par 3 clears an existing nearest-the-pin award so it can be awarded on the correct hole.</p><button type="submit" class="button green-button">Save and play this tee ✓</button></form></section>`;
}
function decorateCourses() {
  if(page!=='scorecard' || !app.querySelector) return;
  app.querySelector('.score-heading').insertAdjacentHTML('afterend',courseSelection(selected));
  app.querySelectorAll('.score-table .hole-number').forEach((cell,hole)=> {
    if(data.rounds[selected].tee) cell.insertAdjacentHTML('beforeend',`<small class="hole-distance">${teeDistance(selected,hole)}</small>`);
  });
}
async function courseRequest(ri,url,options) {
  const response=await fetch(url,options);
  const result=await response.json();
  if(!response.ok) throw Error(result.error || 'Could not save the course. Please retry.');
  courseLibrary[ri]=result;
  return result;
}
document.addEventListener('click',e=> {
  const button=e.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-course-reload')) loadCourseLibrary();
  if(button.hasAttribute('data-new-tee')) {newTee=!newTee;render();}
  if(button.hasAttribute('data-reapply-tee')) {
    const tee=courseLibrary?.[selected]?.tees.find(t=>t.id===data.rounds[selected].tee?.id);
    if(!tee)return toast('This tee is no longer in the library. Select a saved tee.');
    applyTee(selected,tee);render();toast('Latest tee details applied. Scoring updated.');
  }
});
document.addEventListener('change',async e=> {
  const input=e.target;
  if(input.id==='course-tee') {
    const tee=courseLibrary?.[selected]?.tees.find(t=>t.id===input.value);
    if(tee){applyTee(selected,tee);newTee=false;render();toast('Tee selected. Scores recalculated.');}
  }
  if(input.dataset.courseUpload!==undefined && input.files[0]) {
    const ri=selected,kind=input.dataset.courseUpload,file=input.files[0];
    if(file.size>10*1024*1024 || !['image/png','image/jpeg','image/webp','application/pdf'].includes(file.type))return toast('Choose a PNG, JPEG, WebP or PDF up to 10 MB.');
    input.disabled=true;
    try {
      await courseRequest(ri,`/api/courses/${ri}/assets/${kind}`,{method:'PUT',headers:{'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name),'X-Course-Version':String(courseLibrary[ri].version)},body:file});
      render();toast('Course file uploaded to the webserver.');
    }catch(error){toast(error.message);input.disabled=false;}
  }
});
document.addEventListener('submit',async e=> {
  if(e.target.id!=='tee-editor')return;
  e.preventDefault();
  const form=e.target,ri=selected,values=new FormData(form);
  const tee={id:form.dataset.teeId || `tee-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,name:values.get('teeName').trim(),unit:values.get('unit'),pars:[],indexes:[],distances:[]};
  for(let i=0;i<18;i++){tee.pars.push(Number(values.get('par'+i)));tee.indexes.push(Number(values.get('si'+i)));tee.distances.push(Number(values.get('distance'+i)));}
  if(new Set(tee.indexes).size!==18)return toast('Each stroke index from 1 to 18 must appear exactly once.');
  const course=courseLibrary[ri],tees=course.tees.filter(t=>t.id!==tee.id).concat(tee);
  const button=form.querySelector('[type=submit]');button.disabled=true;
  try {
    await courseRequest(ri,`/api/courses/${ri}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:course.version,tees})});
    applyTee(ri,tee);newTee=false;setup=false;render();toast('Tee saved and selected for this course.');
  }catch(error){toast(error.message);button.disabled=false;}
});
