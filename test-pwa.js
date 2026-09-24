const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync('pwa.js', 'utf8');

function browser({ ios = false, standalone = false } = {}) {
  const dom = new JSDOM('<div id="app"><main>Live scores</main></div>', {url:'https://golf.example/', runScripts:'outside-only'});
  const w = dom.window;
  Object.defineProperty(w.navigator, 'userAgent', {value:ios ? 'iPhone' : 'Android'});
  Object.defineProperty(w.navigator, 'standalone', {value:standalone});
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  vm.runInContext(source + '\nPWA.decorate();', dom.getInternalVMContext());
  return {dom, w, doc:w.document};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function main() {
  // Safari does not expose a native install prompt. Always offer actionable help.
  const ios = browser({ios:true});
  ios.doc.querySelector('[data-install-app]').click();
  assert(ios.doc.querySelector('#install-dialog').open);
  assert.equal(ios.doc.querySelector('#install-dialog h3').textContent, 'iPhone & iPad');
  assert(ios.doc.querySelector('#install-dialog').textContent.includes('Open as Web App'));
  assert(ios.doc.querySelector('[data-install-native]').hidden);
  ios.doc.querySelector('[data-install-close]').click();
  assert(!ios.doc.querySelector('#install-dialog'));
  assert.equal(ios.doc.activeElement, ios.doc.querySelector('[data-install-app]'));
  ios.dom.window.close();

  const android = browser();
  android.doc.querySelector('[data-install-app]').click();
  assert.equal(android.doc.querySelector('#install-dialog h3').textContent, 'Android');
  // A delayed native prompt updates an already-open help dialog.
  let prompts = 0;
  const event = new android.w.Event('beforeinstallprompt', {cancelable:true});
  event.prompt = async () => { prompts++; };
  event.userChoice = Promise.resolve({outcome:'dismissed'});
  android.w.dispatchEvent(event);
  assert(event.defaultPrevented);
  assert(!android.doc.querySelector('[data-install-native]').hidden);
  android.doc.querySelector('[data-install-native]').click();
  await tick();
  assert.equal(prompts, 1);
  assert(!android.doc.querySelector('#install-dialog'));
  assert(android.doc.querySelector('[data-install-app]'), 'Dismissal must not claim installation');
  android.doc.querySelector('[data-install-app]').click();
  assert(android.doc.querySelector('#install-dialog'), 'Used prompt falls back to manual instructions');
  android.w.dispatchEvent(new android.w.Event('appinstalled'));
  assert(!android.doc.querySelector('.install-banner'));
  assert(!android.doc.querySelector('#install-dialog'));
  vm.runInContext('PWA.decorate()', android.dom.getInternalVMContext());
  assert(!android.doc.querySelector('.install-banner'), 'Live re-renders do not reintroduce installation guidance');
  android.dom.window.close();

  const installed = browser({ios:true, standalone:true});
  assert(!installed.doc.querySelector('.install-banner'));
  assert(installed.doc.documentElement.classList.contains('installed-app'));
  installed.dom.window.close();

  const failure = browser();
  const unavailable = new failure.w.Event('beforeinstallprompt', {cancelable:true});
  unavailable.prompt = async () => { throw new Error('Installation unavailable'); };
  failure.w.dispatchEvent(unavailable);
  failure.doc.querySelector('[data-install-app]').click();
  await tick();
  assert(failure.doc.querySelector('#install-dialog'), 'A failed browser prompt still provides manual installation steps');
  assert(!failure.doc.querySelector('[data-install-app]').disabled);
  failure.dom.window.close();
  console.log('PWA installation: iOS help, Android prompt, dismissal, errors and installed state passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
