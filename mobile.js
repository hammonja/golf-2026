// A dedicated touch layout, using the same saved scores and scoring engine.
const mobileHoles = [null, null, null, null];
let mobileFullCard = false;
function roundScores(ri) { return ri === 3 ? data.rounds[ri].teamScores : data.rounds[ri].scores; }
function firstUnfinishedHole(ri) {
  const i = data.rounds[ri].pars.findIndex((_, hole) => roundScores(ri).some(s => !Golf.played(s[hole])));
  return i < 0 ? 17 : i;
}
function steppedScore(value, delta, par) {
  return value === null ? par : Math.max(1, Math.min(30, value + delta));
}
function mobileScoreLabel(p, hole) {
  const r = data.rounds[selected], score = roundScores(selected)[p][hole];
  if (!Golf.played(score)) return 'Not entered';
  if (selected === 3) return `${score} gross strokes`;
  const result = Golf.hole(score, r.pars[hole], r.indexes[hole], data.handicaps[p]);
  return `${result.net} net · ${result.points} pts`;
}
function mobileProgress(hole) {
  const scores = roundScores(selected), entered = scores.filter(s => Golf.played(s[hole])).length;
  return entered === scores.length ? '✓ Hole complete' : `${entered} of ${scores.length} scores entered`;
}
function mobileHoleEditor() {
  const r = data.rounds[selected], hole = mobileHoles[selected] ?? firstUnfinishedHole(selected);
  mobileHoles[selected] = hole;
  const scores = roundScores(selected);
  const names = selected === 3 ? TEAMS[3].map(t => t.map(p => SHORT[p]).join(' & ')) : PLAYERS;
  return `<section class="mobile-hole-editor" aria-label="Hole-by-hole scoring">
    <div class="hole-toolbar"><button data-mobile-prev ${hole === 0 ? 'disabled' : ''} aria-label="Previous hole">←</button><div><span class="eyebrow">${COURSES[selected]} · ${hole < 9 ? 'FRONT' : 'BACK'} NINE</span><h2>Hole ${hole+1} <span>/ 18</span></h2><span class="hole-facts">Par ${r.pars[hole]} <b>·</b> Stroke index ${r.indexes[hole]}${r.verified ? '' : ' · provisional'}</span></div><button data-mobile-next ${hole === 17 ? 'disabled' : ''} aria-label="Next hole">→</button></div>
    <details class="hole-picker"><summary>Jump to a hole <span>${mobileProgress(hole)}</span></summary><div class="hole-grid">${r.pars.map((_,i) => `<button data-mobile-hole="${i}" class="${scores.every(s=>Golf.played(s[i])) ? 'complete' : ''} ${hole===i ? 'current' : ''}" aria-label="Hole ${i+1}${scores.every(s=>Golf.played(s[i])) ? ', complete' : ', incomplete'}" ${hole===i ? 'aria-current="true"' : ''}>${i+1}</button>`).join('')}</div></details>
    <p class="mobile-entry-help">Tap a score to type, or tap + to start at par.</p>
    <div class="mobile-player-scores">${names.map((name,p) => `<article class="mobile-score-row"><div class="mobile-player-name">${selected===3 ? `<span class="pair-avatars">${TEAMS[3][p].map(avatar).join('')}</span>` : avatar(p)}<div><strong>${name}</strong><small>${selected===3 ? 'Shared team score' : `HCP ${data.handicaps[p]} · ${Golf.strokes(data.handicaps[p], r.indexes[hole])} handicap strokes`}</small></div></div><div class="mobile-stepper"><button data-mobile-step="-1" data-player="${p}" aria-label="Decrease ${name}'s score">−</button><input data-mobile-score="${p}" type="number" inputmode="numeric" pattern="[0-9]*" min="1" max="30" step="1" placeholder="—" value="${scores[p][hole] ?? ''}" aria-label="${name}, hole ${hole+1} gross strokes"><button data-mobile-step="1" data-player="${p}" aria-label="Increase ${name}'s score">+</button><div class="mobile-score-result" data-mobile-result="${p}">${mobileScoreLabel(p,hole)}</div><button class="mobile-clear" data-mobile-clear="${p}" aria-label="Clear ${name}'s hole ${hole+1} score">Clear</button></div></article>`).join('')}</div>
    <div class="mobile-hole-bottom"><span id="mobile-hole-progress" role="status">${mobileProgress(hole)}</span><button class="button yellow" ${hole===17 ? 'data-page="dashboard"' : 'data-mobile-next'}>${hole===17 ? 'View standings' : 'Next hole'} →</button></div><p class="mobile-save-note">Saves automatically on this phone. You can return to any hole.</p>
    <div id="mobile-live-match">${compCard(selected)}</div>
  </section>`;
}
function decorateMobile() {
  if (!app.querySelector) return;
  app.querySelector('main').dataset.page = page;
  app.querySelectorAll('.nav-link').forEach(el => { if(el.dataset.page===page) el.setAttribute('aria-current','page'); });
  if (page === 'dashboard') {
    const rows = overall(), started=rows.some(r=>r.holes || r.bonus);
    const cards = `<div class="mobile-standings">${rows.map(row=>`<article class="card mobile-standing"><div class="standing-top"><span class="standing-rank">${started ? rows.findIndex(x=>x.points===row.points)+1 : '—'}</span>${avatar(row.p)}<div class="standing-name"><strong>${row.name}</strong><small>HCP ${data.handicaps[row.p]} · ${row.holes}/54 holes</small></div><div class="standing-points">${row.points}<small>PTS</small></div></div><div class="standing-stats"><span>Gross<strong>${row.holes ? row.gross : '—'}</strong></span><span>Net<strong>${row.holes ? row.net : '—'}</strong></span><span>Stableford<strong>${row.holes ? row.stable : '—'}</strong></span><span>Pin bonus<strong>+${row.bonus}</strong></span></div><div class="standing-rounds">${row.round.map((r,i)=>`<span>R${i+1} <b>${r.ranking}</b></span>`).join('')}<span>placing points</span></div><div class="mobile-earnings"><span>Earnings</span><div>${earningsMarkup(row)}</div></div></article>`).join('')}</div>`;
    app.querySelector('.leaderboard').insertAdjacentHTML('beforebegin',cards);
  }
  if (page === 'scorecard') {
    const panel=app.querySelector('.score-panel');
    panel.classList.toggle('show-full-card',mobileFullCard);
    app.querySelector('.score-help').insertAdjacentHTML('beforebegin',`<div class="mobile-score-mode"><button data-mobile-mode="hole" aria-pressed="${!mobileFullCard}">Hole by hole</button><button data-mobile-mode="full" aria-pressed="${mobileFullCard}">Full scorecard</button></div>${mobileHoleEditor()}`);
  }
}
function refreshMobileEditor(focusSelector) {
  const editor=app.querySelector('.mobile-hole-editor');
  if(editor) editor.outerHTML=mobileHoleEditor();
  if(focusSelector) app.querySelector(focusSelector)?.focus({preventScroll:true});
}
function commitMobileScore(p,value) {
  const hole=mobileHoles[selected];
  // Reuse the existing full-card change path to recalculate totals and persist.
  const input=app.querySelector(`.score-table [data-score="${p}"][data-hole="${hole}"]`);
  input.value=value ?? '';
  input.dataset.mobileCommit='true';
  try { input.dispatchEvent(new Event('change',{bubbles:true})); }
  finally { delete input.dataset.mobileCommit; }
  app.querySelector(`[data-mobile-result="${p}"]`).textContent=mobileScoreLabel(p,hole);
  app.querySelector('#mobile-hole-progress').textContent=mobileProgress(hole);
  app.querySelector('.hole-picker summary span').textContent=mobileProgress(hole);
  app.querySelector(`[data-mobile-hole="${hole}"]`).classList.toggle('complete',roundScores(selected).every(s=>Golf.played(s[hole])));
  app.querySelector('#mobile-live-match').innerHTML=compCard(selected);
}
document.addEventListener('click',e=> {
  const button=e.target.closest('button'); if(!button) return;
  if(button.hasAttribute('data-mobile-mode')) { mobileFullCard=button.dataset.mobileMode==='full'; render(); }
  if(button.hasAttribute('data-mobile-hole') || button.hasAttribute('data-mobile-prev') || button.hasAttribute('data-mobile-next')) {
    const next=button.hasAttribute('data-mobile-hole') ? Number(button.dataset.mobileHole) : mobileHoles[selected]+(button.hasAttribute('data-mobile-prev') ? -1 : 1);
    mobileHoles[selected]=Math.max(0,Math.min(17,next));
    refreshMobileEditor();
    app.querySelector('.mobile-hole-editor').scrollIntoView({block:'start'});
    app.querySelector('.hole-toolbar button:not(:disabled)')?.focus({preventScroll:true});
  }
  if(button.hasAttribute('data-mobile-step') || button.hasAttribute('data-mobile-clear')) {
    const clear=button.hasAttribute('data-mobile-clear'), p=Number(clear ? button.dataset.mobileClear : button.dataset.player);
    const hole=mobileHoles[selected];
    const value=clear ? null : steppedScore(roundScores(selected)[p][hole],Number(button.dataset.mobileStep),data.rounds[selected].pars[hole]);
    const input=app.querySelector(`[data-mobile-score="${p}"]`);
    input.value=value ?? '';
    input.setCustomValidity('');
    input.setAttribute('aria-invalid','false');
    commitMobileScore(p,value);
  }
});
document.addEventListener('input',e=> {
  if(e.target.dataset.mobileScore===undefined) return;
  const input=e.target, value=input.value==='' ? null : Number(input.value);
  const invalid=input.validity.badInput || value!==null && !Golf.played(value);
  input.setCustomValidity(invalid ? 'Enter a whole score from 1 to 30.' : '');
  input.setAttribute('aria-invalid',String(invalid));
  if(invalid) { app.querySelector(`[data-mobile-result="${input.dataset.mobileScore}"]`).textContent='Use a whole number, 1–30'; return; }
  commitMobileScore(Number(input.dataset.mobileScore),value);
});
