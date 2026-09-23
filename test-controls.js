const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', {url:'https://golf-2026.hammonja.com/', runScripts:'outside-only'});
  const {window} = dom;
  const errors=[];
  window.addEventListener('error',event=>errors.push(event.error));
  window.scrollTo=()=>{};
  window.HTMLElement.prototype.scrollIntoView=()=>{};
  window.fetch=async()=>({ok:true,json:async()=>JSON.parse(fs.readFileSync('course_defaults.json','utf8'))});
  const context=dom.getInternalVMContext();
  for(const file of ['scoring.js','courses.js','mobile.js','app.js']) vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  await new Promise(resolve=>setTimeout(resolve,0));
  window.document.querySelector('[data-page="scorecard"]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  const tee=window.document.querySelector('#course-tee');
  assert(tee,'Tee selector should be visible');
  tee.value='ombria-53';
  tee.dispatchEvent(new window.Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(window.document.querySelector('#course-tee').value,'ombria-53');
  assert(window.document.querySelector('.course-selection').textContent.includes('Playing 53'));
  assert(window.document.querySelector('.hole-distance').textContent.includes('418 m'));
  assert(window.document.querySelector('.hole-facts').textContent.includes('418 m'));
  window.document.querySelector('[data-action="setup"]').click();
  assert(window.document.querySelector('#tee-editor'),'Course setup opens the tee editor');
  window.document.querySelector('[data-action="setup"]').click();
  assert(!window.document.querySelector('#tee-editor'),'Course setup closes the tee editor');
  window.document.querySelector('[data-round="3"]').click();
  assert(window.document.querySelector('a[href="/assets/salgados-scorecard.pdf"]'));
  assert(window.document.querySelector('a[href="/assets/salgados-course.gif"]'));
  assert(window.document.querySelector('.course-selection').textContent.includes('Stroke indexes are not included'));
  window.document.querySelector('[data-action="setup"]').click();
  assert(window.document.querySelector('.course-library-setup').textContent.includes('Official Salgados reference'));
  assert(window.document.querySelector('.course-library-setup img').getAttribute('src').startsWith('/assets/salgados-course.gif'));
  for (const [round,slug,total,firstDistance,pinHole] of [[1,'oconnor',5939,497,17],[2,'faldo',5858,388,16],[3,'salgados',5615,270,17]]) {
    window.document.querySelector(`[data-round="${round}"]`).click();
    const selector=window.document.querySelector('#course-tee');
    selector.value=slug+'-yellow';
    selector.dispatchEvent(new window.Event('change',{bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,0));
    assert(window.document.querySelector('.course-selection').textContent.includes(total.toLocaleString()));
    assert.equal(window.document.querySelector('.hole-distance').textContent,`${firstDistance} m`);
    assert(window.document.querySelector('.hole-facts').textContent.includes(`${firstDistance} m`));
    assert(window.document.querySelector('.pin-card').textContent.includes(`hole ${pinHole}`));
    assert(window.document.querySelector(`a[href="/assets/${slug}-scorecard.pdf"]`));
    assert(window.document.querySelector(`a[href="/assets/${slug}-course.${slug==='salgados' ? 'gif' : 'png'}"]`));
    assert.equal(window.document.querySelectorAll('.score-panel > .notice').length,0);
  }
  assert.deepEqual(errors,[]);
  dom.window.close();
  console.log('DOM interaction checks passed: tee selection and setup open/close.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
