/* Server-authoritative scores, live snapshots and admin controls. */
const Live = (() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  let admin = false, csrf = null, connected = false, ready = false, version = 0, sequence = -1;
  let queue = [], saving = false, deferred = null, stream = null, lastSubmitted = null;
  let draft = null, legacy = null, legacyProblem = false;
  try { legacy = JSON.parse(localStorage.getItem('portugal2026-v1')); } catch { legacyProblem = true; }
  try { draft = JSON.parse(localStorage.getItem('portugal2026-unsaved-draft')); } catch { /* Storage is optional. */ }
  const editableSelector = '[data-score],[data-hcp],#ctp,#course-tee,[data-mobile-score],[data-mobile-step],[data-mobile-clear],[data-course-upload],[data-new-tee],[data-reapply-tee],#tee-editor input,#tee-editor select,#tee-editor button,[data-action="setup"],[data-action="import"],#import,[data-action="migrate"]';

  function canEdit() { return admin && connected && ready; }
  function access() {
    if (!app.querySelectorAll) return;
    app.querySelectorAll(editableSelector).forEach(el => { el.disabled = !canEdit(); });
    app.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = !admin; });
    app.querySelectorAll('[data-action="migrate"]').forEach(el => { el.hidden = !admin || !legacy || !valid(legacy); });
    app.querySelectorAll('[data-action="draft"]').forEach(el => { el.hidden = !admin || !draft; });
    const login = app.querySelector('[data-action="login"]');
    if (login) login.textContent = admin ? 'Log out' : 'Log in';
    const exportButton = app.querySelector('[data-action="export"]');
    if (exportButton) exportButton.disabled = !ready;
    const status = !connected ? (ready ? 'Connection lost · reconnecting' : 'Connecting to live scores…') : saving || queue.length ? 'Saving to server…' : 'Live · saved on server';
    app.querySelectorAll('.save-status').forEach(el => { el.textContent = status; });
    const mode = app.querySelector('.access-mode');
    if (mode) mode.textContent = admin ? (canEdit() ? 'Admin · editing enabled' : 'Admin · waiting for connection') : 'Viewing live scores · log in to edit';
    app.classList.toggle('view-only', !canEdit());
    syncRoundReportDialog();
  }
  async function request(url, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {...options, signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
        headers: {...options.headers, ...(csrf ? {'X-CSRF-Token': csrf} : {})}});
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 && url !== '/api/login') { admin = false; csrf = null; access(); }
        const error = new Error(result.error || 'The server could not complete the request.');
        error.status = response.status; error.snapshot = result.snapshot; throw error;
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  function editingDraft() {
    const active = document.activeElement;
    return setup || (app.contains(active) && active.matches('input,select') && active.type !== 'file');
  }
  function accept(snapshot, force = false) {
    if (!snapshot || !valid(snapshot.state) || !Array.isArray(snapshot.courses) || snapshot.courses.length !== 4) throw Error('Invalid live score response.');
    connected = true;
    if (!force && (saving || queue.length || editingDraft())) {
      if (!deferred || snapshot.sequence >= deferred.sequence) deferred = snapshot;
      access(); return;
    }
    if (!force && snapshot.sequence <= sequence && ready) { access(); return; }
    version = snapshot.version; sequence = snapshot.sequence;
    data = clone(snapshot.state); lastSubmitted = clone(data); courseLibrary = snapshot.courses; ready = true;
    roundSummaries = clone(snapshot.summaries || [null, null, null, null]); summaryBasis = clone(snapshot.state);
    updateRankMovement(); render();
  }
  async function refresh() {
    const [session, snapshot] = await Promise.all([request('/api/session'), request('/api/state')]);
    admin = session.admin; csrf = session.csrf;
    accept(snapshot); access();
  }
  function rememberDraft(value) {
    draft = clone(value);
    try { localStorage.setItem('portugal2026-unsaved-draft', JSON.stringify(draft)); } catch { /* Download remains available. */ }
  }
  function save(action = 'scores.updated') {
    updateRankMovement();
    decorateRoundReports();
    if (!canEdit()) { if (lastSubmitted) data = clone(lastSubmitted); access(); return; }
    if (JSON.stringify(data) === JSON.stringify(lastSubmitted) && action === 'scores.updated') return;
    lastSubmitted = clone(data);
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
    queue.push({state: clone(data), action, requestId});
    flush();
  }
  async function flush() {
    if (saving || !queue.length) return;
    saving = true; access();
    while (queue.length) {
      const item = queue[0], payload = {...item, version};
      try {
        let snapshot;
        try { snapshot = await request('/api/state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}); }
        catch (error) {
          if (error.status) throw error;
          // A lost response may already have committed. Retry the identical request ID.
          snapshot = await request('/api/state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
        }
        version = snapshot.version; sequence = Math.max(sequence, snapshot.sequence);
        queue.shift();
        if (!queue.length) {
          data = clone(snapshot.state); lastSubmitted = clone(data); courseLibrary = snapshot.courses;
          roundSummaries = clone(snapshot.summaries || [null, null, null, null]); summaryBasis = clone(snapshot.state);
          decorateRoundReports();
          updateRankMovement();
        }
      } catch (error) {
        rememberDraft(queue[queue.length - 1].state);
        queue = []; saving = false; deferred = null;
        if (error.snapshot) accept(error.snapshot, true);
        else {
          connected = false;
          try { accept(await request('/api/state'), true); } catch { /* Keep reconnecting. */ }
        }
        render();
        toast((error.message || 'Save could not be confirmed.') + ' Your draft is available from Download unsaved draft.');
        access(); return;
      }
    }
    saving = false;
    // Preserve the focused score input. Updates to other fields are applied on blur.
    if (deferred && deferred.sequence > sequence) { const next = deferred; deferred = null; accept(next); }
    access();
  }
  function download(value, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type:'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function login() {
    if (admin) {
      if (saving || queue.length) return toast('Wait for the current save to finish before logging out.');
      try { await request('/api/logout', {method:'POST'}); admin = false; csrf = null; setup = false; render(); }
      catch (error) { toast(error.message); }
      return;
    }
    if (document.getElementById('login-dialog')) return;
    const dialog = document.createElement('dialog'); dialog.id = 'login-dialog'; dialog.className = 'login-dialog';
    dialog.innerHTML = '<form id="login-form"><div class="eyebrow green">PORTUGAL 2026</div><h2>Admin login</h2><p>Sign in to update scores, handicaps and course details.</p><label for="login-name">Username</label><input id="login-name" name="username" autocomplete="username" required><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required><p class="login-error" role="alert"></p><div class="login-actions"><button type="button" class="button outline" data-cancel-login>Cancel</button><button class="button green-button" type="submit">Log in</button></div></form>';
    document.body.append(dialog);
    dialog.querySelector('[data-cancel-login]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { dialog.remove(); app.querySelector('[data-action="login"]')?.focus(); });
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const button = dialog.querySelector('[type="submit"]'); button.disabled = true;
      try {
        const result = await request('/api/login', {method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({username:dialog.querySelector('[name="username"]').value, password:dialog.querySelector('[name="password"]').value})});
        admin = result.admin; csrf = result.csrf;
        await refresh(); dialog.close(); render(); toast('Logged in. Changes are shared with everyone.');
      } catch (error) { dialog.querySelector('.login-error').textContent = error.message; button.disabled = false; }
    };
    dialog.showModal();
  }
  function startStream() {
    if (typeof EventSource !== 'function' || stream) return;
    stream = new EventSource('/api/events');
    stream.addEventListener('snapshot', event => {
      try { accept(JSON.parse(event.data)); } catch { connected = false; access(); }
    });
    stream.onerror = () => { connected = false; access(); };
  }
  async function start() {
    // Guard all entry paths, including delegated mobile controls and file/form events.
    for (const eventName of ['click', 'input', 'change', 'submit']) {
      document.addEventListener(eventName, event => {
        if (!canEdit() && (event.target.closest(editableSelector) || event.target.id === 'tee-editor')) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      }, true);
    }
    try { await refresh(); } catch { connected = false; access(); toast('Could not load live scores. Reconnecting…'); }
    startStream();
    // Also recovers from proxy buffering, suspended phones and expired login sessions.
    setInterval(() => refresh().catch(() => { connected = false; access(); }), 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => { connected = false; access(); }); });
    window.addEventListener('online', () => refresh().catch(() => {}));
    document.addEventListener('focusout', () => setTimeout(() => {
      if (deferred && !saving && !queue.length && !editingDraft()) { const next = deferred; deferred = null; accept(next); }
    }, 0));
    window.addEventListener('beforeunload', event => { if (saving || queue.length) { rememberDraft(data); event.preventDefault(); event.returnValue = ''; } });
    if (legacyProblem) toast('An older browser backup could not be read. Live server scores are unaffected.');
  }
  async function action(name) {
    const retry = /^summary-retry-([0-3])$/.exec(name);
    if (retry && admin) {
      try { accept(await request(`/api/summaries/${retry[1]}/retry`, {method:'POST'}), true); }
      catch (error) { toast(error.message); }
      return;
    }
    if (name === 'login') return login();
    if (name === 'history' && admin) {
      try { download(await request('/api/history'), 'portugal-2026-history.json'); } catch (error) { toast(error.message); }
    }
    if (name === 'draft' && admin && draft) download(draft, 'portugal-2026-unsaved-draft.json');
    if (name === 'migrate' && canEdit() && legacy && valid(legacy)) {
      const holes = legacy.rounds.reduce((sum,r) => sum + r.scores.flat().filter(Golf.played).length + r.teamScores.flat().filter(Golf.played).length, 0);
      if (confirm(`Import this browser's previous backup (${holes} entered scores; handicaps ${legacy.handicaps.join(', ')})? This replaces the shared scores and settings for everyone and is recorded in history.`)) {
        data = clone(legacy); save('browser.imported'); render();
      }
    }
  }
  return {start, save, access, canEdit, request, action, download};
})();
