/* Installation is optional; live scores always come directly from the server. */
const PWA = (() => {
  const standalone = window.matchMedia?.('(display-mode: standalone)');
  const fullscreen = window.matchMedia?.('(display-mode: fullscreen)');
  let installPrompt = null, installed = false, prompting = false;
  const isRunningStandalone = () => navigator.standalone === true || standalone?.matches || fullscreen?.matches;
  const isInstalled = () => installed || isRunningStandalone();

  function decorate() {
    document.documentElement.classList.toggle('installed-app', Boolean(isInstalled()));
    document.querySelector('.install-banner')?.remove();
    if (isInstalled()) return;
    const main = document.querySelector('#app > main');
    if (!main) return;
    const banner = document.createElement('aside');
    banner.className = 'install-banner';
    banner.setAttribute('aria-label', 'Install Portugal 2026');
    banner.innerHTML = '<img src="/assets/app-icon-192.png" alt="" width="36" height="36"><p><strong>Portugal ’26, on your home screen.</strong><span>One tap to the fairways.</span></p><button class="button outline" type="button" data-install-app>Install app</button>';
    main.before(banner);
    banner.querySelector('button').disabled = prompting;
  }

  function showHelp() {
    if (document.getElementById('install-dialog') || isInstalled()) return;
    const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/.test(navigator.userAgent);
    const iosSteps = '<section><h3>iPhone &amp; iPad</h3><ol><li>Open this site in <strong>Safari</strong>.</li><li>Tap <strong>Share</strong> (it may be inside the page menu).</li><li>Choose <strong>Add to Home Screen</strong>. Leave <strong>Open as Web App</strong> switched on if shown, then tap <strong>Add</strong>.</li></ol></section>';
    const androidSteps = '<section><h3>Android</h3><ol><li>Open this site in <strong>Chrome</strong>.</li><li>Open the <strong>⋮ menu</strong>, then choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li><li>Confirm <strong>Install</strong>, then open Portugal 26 from your home screen.</li></ol></section>';
    const dialog = document.createElement('dialog');
    dialog.id = 'install-dialog';
    dialog.className = 'login-dialog install-dialog';
    dialog.setAttribute('aria-labelledby', 'install-title');
    dialog.innerHTML = `<div class="eyebrow green">TAKE IT TO THE COURSE</div><h2 id="install-title">Your golf getaway.<br>One tap away.</h2><p>Add Portugal 2026 to your home screen for an app window without the browser address bar.</p>${apple ? iosSteps + androidSteps : androidSteps + iosSteps}${!apple && !android ? '<p>On a computer, use your browser’s install icon or app menu.</p>' : ''}<p class="install-note">Live scores need an internet connection. Admins may need to log in again inside the installed app.</p><div class="login-actions"><button class="button outline" type="button" data-install-close>Got it</button><button class="button green-button" type="button" data-install-native${installPrompt ? '' : ' hidden'}>Install now</button></div>`;
    document.body.append(dialog);
    dialog.querySelector('[data-install-close]').onclick = () => dialog.close();
    dialog.querySelector('[data-install-native]').onclick = () => promptInstall();
    dialog.addEventListener('close', () => {
      dialog.remove();
      document.querySelector('[data-install-app]')?.focus();
    });
    dialog.showModal();
  }

  async function promptInstall() {
    if (prompting || isInstalled()) return;
    if (!installPrompt) return showHelp();
    const event = installPrompt;
    installPrompt = null; // Each browser prompt can only be used once.
    prompting = true;
    document.querySelectorAll('[data-install-app],[data-install-native]').forEach(button => { button.disabled = true; });
    try {
      await event.prompt();
      await event.userChoice;
      document.getElementById('install-dialog')?.close();
      // Only appinstalled / standalone confirms completion, not accepting a prompt.
    } catch {
      showHelp();
    } finally {
      prompting = false;
      const native = document.querySelector('[data-install-native]');
      if (native) { native.hidden = !installPrompt; native.disabled = false; }
      decorate();
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    const native = document.querySelector('[data-install-native]');
    if (native) native.hidden = false;
    decorate();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    installPrompt = null;
    document.getElementById('install-dialog')?.close();
    decorate();
  });
  standalone?.addEventListener('change', decorate);
  fullscreen?.addEventListener('change', decorate);
  document.addEventListener('click', event => {
    if (event.target.closest('[data-install-app]')) promptInstall();
  });
  return { decorate, isRunningStandalone };
})();
