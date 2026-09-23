const PLAYERS = ['James Hammond', 'Ben Nowak', 'Mark Shaw', 'Owen Shaw'];
const SHORT = ['James', 'Ben', 'Mark', 'Owen'];
const INITIALS = ['JH', 'BN', 'MS', 'OS'];
const COURSES = ['Ombria', "O’Connor", 'Faldo', 'Salgados'];
const FORMATS = ['match', 'best', 'solo', 'scramble'];
const TITLES = ['2v2 Matchplay', '2v2 Best Ball', 'Individual Stableford', '2v2 Scramble'];
const TEAMS = [[[0, 3], [2, 1]], [[1, 3], [2, 0]], [], [[3, 2], [0, 1]]];
const KEY = 'portugal2026-v1';
const empty = () => ({ handicaps: [0, 0, 0, 0], rounds: COURSES.map(() => ({ scores: PLAYERS.map(() => Array(18).fill(null)), teamScores: [Array(18).fill(null), Array(18).fill(null)], pars: Array(18).fill(4), indexes: Array.from({ length: 18 }, (_, i) => i + 1), verified: false, ctp: null })) });
function valid(s) {
  const array = (a, n, check) => Array.isArray(a) && a.length === n && a.every(check);
  const score = x => x === null || Golf.played(x);
  return s && array(s.handicaps, 4, h => typeof h === 'number' && Number.isFinite(h) && h >= -10 && h <= 54) && array(s.rounds, 4, r => r && array(r.scores, 4, a => array(a, 18, score)) && array(r.teamScores, 2, a => array(a, 18, score)) && array(r.pars, 18, p => Number.isInteger(p) && p >= 3 && p <= 6) && array(r.indexes, 18, p => Number.isInteger(p) && p >= 1 && p <= 18) && new Set(r.indexes).size === 18 && teeSnapshotValid(r.tee) && typeof r.verified === 'boolean' && (r.ctp === null || Number.isInteger(r.ctp) && r.ctp >= 0 && r.ctp < 4));
}
let data = empty(), loadError = false;
try { const saved = localStorage.getItem(KEY); if (saved) { const parsed = JSON.parse(saved); if (!valid(parsed)) throw Error(); data = parsed; } } catch { loadError = true; }
let page = 'dashboard', selected = 0, setup = false;
let previousRanks = null, rankMovement = [0, 0, 0, 0];
const app = document.getElementById('app');
const icon = (name) => ({ flag: '⚑', trophy: '♜', arrow: '↗', check: '✓' }[name] || name);
function toast(text) { const el = document.getElementById('toast'); el.textContent = text; el.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 4000); }
function save() { updateRankMovement(); try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { toast('Could not save in this browser. Export a backup to keep your scores.'); } }
function updateRankMovement() {
  const rows = overall();
  if (!rows.some(row => row.holes || row.bonus)) {
    previousRanks = null;
    rankMovement = [0, 0, 0, 0];
    return;
  }
  const ranks = PLAYERS.map((_,p) => {
    const player = rows.find(row => row.p === p);
    return 1 + rows.filter(row => row.points > player.points).length;
  });
  if (previousRanks && ranks.some((rank,p) => rank !== previousRanks[p])) {
    rankMovement = ranks.map((rank,p) => previousRanks[p] - rank);
  }
  previousRanks = ranks;
}
function movementMarkup(p) {
  const change = rankMovement[p];
  const description = change ? `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)} ${Math.abs(change) === 1 ? 'place' : 'places'} since the last position change` : 'No position change';
  return `<span class="rank-movement ${change > 0 ? 'rank-up' : change < 0 ? 'rank-down' : 'rank-steady'}" title="${description}" aria-label="${description}"><span aria-hidden="true">${change > 0 ? '▲' : change < 0 ? '▼' : '–'}${change ? ` ${Math.abs(change)}` : ''}</span></span>`;
}
function avatar(p) { return `<span class="avatar avatar-${p}">${INITIALS[p]}</span>`; }
function overall() {
  const rows = PLAYERS.map((name, p) => ({ name, p, gross: 0, net: 0, stable: 0, holes: 0, bonus: 0, points: 0, round: [] }));
  data.rounds.forEach((r, ri) => {
    if (r.ctp !== null) { rows[r.ctp].bonus++; rows[r.ctp].points++; }
    if (ri === 3) return;
    const totals = PLAYERS.map((_, p) => Golf.totals(r, p, data.handicaps[p]));
    // Rank live standings only on holes scored by all four players.
    const common = r.pars.map((_, i) => r.scores.every(s => Golf.played(s[i])));
    const comparable = PLAYERS.map((_, p) => r.scores[p].reduce((sum, g, i) => sum + (common[i] ? Golf.hole(g, r.pars[i], r.indexes[i], data.handicaps[p]).points : 0), 0));
    const points = common.some(Boolean) ? Golf.placingPoints(comparable) : [0, 0, 0, 0];
    rows.forEach((row, p) => { const t = totals[p]; row.gross += t.gross; row.net += t.net; row.stable += t.points; row.holes += t.holes; row.points += points[p]; row.round.push({ ...t, ranking: points[p] }); });
  });
  rows.sort((a, b) => b.points - a.points);
  const winnings = Golf.earnings(data.rounds,data.handicaps,TEAMS,FORMATS,rows);
  rows.forEach(row => row.earnings = winnings.players[row.p]);
  return rows;
}
function earningsMarkup(row) {
  const e = row.earnings;
  return `<strong>£${e.earned}</strong><small>${e.projected ? `+ £${e.projected} provisional` : 'confirmed'}</small>`;
}
function earningsNote() {
  const result = Golf.earnings(data.rounds,data.handicaps,TEAMS,FORMATS,overall());
  return `<p class="fine-print earnings-note">Earnings are prize money before the £50 entry. Provisional winnings follow the live leaders; confirmed winnings require complete scores and verified course details. Overall prizes also await all four nearest-the-pin awards.${result.tiedPrizes ? ` £${result.tiedPrizes} in tied prizes remains unallocated until ties are resolved.` : ''}</p>`;
}
function scene() { return `<svg class="landscape" viewBox="0 0 800 390" aria-hidden="true"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#77b9b1"/><stop offset="1" stop-color="#dce3bb"/></linearGradient><linearGradient id="land" x2="0" y2="1"><stop stop-color="#6c955e"/><stop offset="1" stop-color="#2b6c4a"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h800v390H0z"/><circle cx="601" cy="88" r="47" fill="#f5d366"/><path d="M0 181Q110 70 260 184Q415 60 570 176Q680 110 800 158V390H0" fill="#729587"/><path d="M0 227Q190 96 380 237Q570 110 800 193V390H0" fill="#43765f"/><path d="M0 284Q212 160 420 275Q635 191 800 218V390H0" fill="url(#land)"/><path d="M200 390Q500 255 584 240Q660 220 724 252Q514 264 441 390" fill="#a5b86c"/><ellipse cx="603" cy="265" rx="97" ry="28" fill="#c0cc82"/><path d="M634 261v-94" stroke="#f9f3dc" stroke-width="3"/><path d="M636 167l43 15-43 15" fill="#f34e35"/><ellipse cx="634" cy="263" rx="6" ry="2" fill="#355b3c"/><path d="M0 326Q103 261 206 339L225 390H0" fill="#205a43"/><g fill="#164c3e"><path d="M737 165l16-86 17 86zM718 198l22-105 23 105z"/><path d="M75 235l22-130 28 130z"/></g><g fill="#f3e8c7"><path d="M398 183v-31h67v36z"/><path d="M417 152v-23h25v23z"/></g><g fill="#ce754f"><path d="M391 152l40-21 40 21zM411 129l19-13 18 13z"/></g></svg>`; }
function shell(content) {
  app.innerHTML = `<header class="header"><a href="#dashboard" class="brand"><span class="brand-mark">p<span>26</span><i></i></span><span>PORTUGAL<span class="brand-sub">THE GOLF GETAWAY</span></span></a><nav aria-label="Main navigation">${[['dashboard','Leaderboard'],['scorecard','Scorecards'],['players','Players & handicaps'],['rules','The rulebook']].map(([key,label]) => `<button data-page="${key}" class="nav-link ${page === key ? 'active' : ''}">${label}</button>`).join('')}</nav><span class="trip-tag"><span class="flag-dot"></span> ALGARVE ’26</span></header><main>${content}</main><footer><span><strong>Four golfers. Four rounds. One winner.</strong><br>Made for the fairways. And the clubhouse.</span><div><span class="save-status">● Saved on this device</span><button class="text-button" data-action="export">Export scores ↗</button><button class="text-button" data-action="import">Import backup</button><input type="file" id="import" accept="application/json" hidden></div></footer>`;
  decorateCourses();
  decorateMobile();
}
function compCard(ri) {
  const r = data.rounds[ri], c = Golf.competition(r, data.handicaps, TEAMS[ri], FORMATS[ri]);
  const started = c.holes > 0, done = c.holes === 18;
  let body, status;
  if (ri === 2) {
    const order = [0, 1, 2, 3].sort((a, b) => c.ranking[b] - c.ranking[a]);
    body = order.map(p => `<div class="contest-row"><span>${avatar(p)}${SHORT[p]}</span><strong>${Golf.totals(r,p,data.handicaps[p]).holes ? c.totals[p] : '—'} <small>pts</small></strong></div>`).join('');
    const leaders = order.filter(p => c.ranking[p] === c.ranking[order[0]]);
    status = started ? `${leaders.map(p => SHORT[p]).join(' & ')} ${leaders.length > 1 ? 'tied' : done ? 'wins' : 'leads'}` : 'The individual showdown';
  } else {
    body = TEAMS[ri].map((team, t) => `<div class="contest-row"><span><span class="pair-avatars">${team.map(avatar).join('')}</span>${team.map(p => SHORT[p]).join(' & ')}</span><strong>${started ? c.totals[t] : '—'}<small> ${ri === 0 ? 'holes' : ri === 3 ? 'shots' : 'pts'}</small></strong></div>`).join('');
    const diff = c.totals[0] - c.totals[1], winning = ri === 3 ? (diff < 0 ? 0 : 1) : (diff > 0 ? 0 : 1);
    const clinched = ri === 0 && Math.abs(diff) > 18 - c.holes;
    status = !started ? 'Ready for the first tee' : !diff ? (done ? 'Finished · tied' : 'All square') : `${TEAMS[ri][winning].map(p => SHORT[p]).join(' & ')} ${done || clinched ? 'win' : 'lead'}${ri === 0 ? ` · ${Math.abs(diff)} ${done || clinched ? '& ' + (18-c.holes) : 'up'}` : ` by ${Math.abs(diff)}`}`;
  }
  return `<article class="competition card"><div class="card-eyebrow"><span>ROUND 0${ri+1} <span class="dot-divider">/</span> ${COURSES[ri].toUpperCase()}</span><span class="badge ${started ? 'live' : ''}">${done ? 'Complete' : started ? 'In play' : 'Upcoming'}</span></div><h3>${TITLES[ri]}</h3><div class="prize">${ri === 2 ? '£20 to the winner' : '£40 prize · £20 each'}</div><div class="contest">${body}</div><div class="match-status">${status}</div><div class="progress"><span style="width:${c.holes/18*100}%"></span></div><div class="card-bottom"><span>${c.holes} / 18 holes${!r.verified ? ' · setup needed' : ''}</span><button class="text-button" data-round="${ri}">Open scorecard <span>↗</span></button></div></article>`;
}
function dashboard() {
  const rows = overall(), holes = data.rounds.reduce((sum, r, ri) => sum + Golf.competition(r,data.handicaps,TEAMS[ri],FORMATS[ri]).holes, 0);
  const any = rows.some(r => r.holes || r.bonus), leaders = rows.filter(r => r.points === rows[0].points);
  const next = data.rounds.findIndex((r,i) => Golf.competition(r,data.handicaps,TEAMS[i],FORMATS[i]).holes < 18);
  shell(`<section class="hero"><div class="hero-copy"><div class="eyebrow"><span></span> THE ALGARVE COLLECTION · 2026</div><h1>A little sun.<br>A lot at stake<span>.</span></h1><p>Four friends. Four iconic courses.<br>Welcome to your Portugal golf getaway.</p><button class="button yellow" data-round="${next < 0 ? 3 : next}">${holes ? 'Continue the round' : 'Let’s play golf'} <span>↗</span></button><div class="hero-players"><span class="avatar-stack">${PLAYERS.map((_,p) => avatar(p)).join('')}</span><span>James, Ben, Mark & Owen<br><strong>The usual suspects.</strong></span></div></div><div class="hero-art">${scene()}<div class="art-stamp">37.1° N &nbsp; 8.2° W<br><strong>Life’s better<br>on the fairway.</strong><span>ALGARVE, PORTUGAL</span></div><span class="art-caption">SUNSHINE. STABLEFORD. SERIOUS BRAGGING RIGHTS.</span></div></section><section class="stat-grid"><div><span class="stat-icon">⚑</span><span class="stat-number">4 <small>courses to conquer</small></span></div><div><span class="stat-icon">◉</span><span class="stat-number">${holes}<span class="muted"> / 72</span><small>holes completed together</small></span></div><div><span class="stat-icon">£</span><span class="stat-number">200 <small>in the prize pot</small></span></div><div><span class="stat-icon">♜</span><span class="stat-number leader-name">${any ? leaders.length === 1 ? SHORT[leaders[0].p] : 'All to play for' : 'Up for grabs'}<small>${any ? 'live overall lead' : 'one overall champion'}</small></span></div></section><section class="section"><div class="section-heading"><div><div class="eyebrow green">THE RACE FOR THE CROWN</div><h2>Overall leaderboard<span class="yellow-dot">.</span></h2></div><span class="subtle-tag">${any ? '● Live standings' : '● Ready when you are'}</span></div><div class="leaderboard card table-scroll"><table><thead><tr><th>POS</th><th>PLAYER</th><th>HCP</th><th>GROSS</th><th>NET</th><th>STABLEFORD</th><th>R1</th><th>R2</th><th>R3</th><th>PIN +</th><th class="points-col">TOTAL PTS</th><th>PRIZE MONEY WON</th></tr></thead><tbody>${rows.map((row,i) => `<tr><td class="position">${any ? (i && row.points === rows[i-1].points ? rows.findIndex(x => x.points === row.points)+1 : i+1) : '—'}${movementMarkup(row.p)}</td><td><div class="player-cell">${avatar(row.p)}<span>${row.name}<small>${row.holes ? `${row.holes} / 54 individual holes` : 'Chasing the sunshine'}</small></span></div></td><td><span class="hcp-pill">${data.handicaps[row.p]}</span></td><td>${row.holes ? row.gross : '—'}</td><td>${row.holes ? row.net : '—'}</td><td>${row.holes ? row.stable : '—'}</td>${row.round.map(r => `<td>${r.holes ? r.ranking : '—'}</td>`).join('')}<td>${row.bonus ? '+'+row.bonus : '—'}</td><td class="points-col total-points">${row.points}</td><td class="earnings-cell">${earningsMarkup(row)}</td></tr>`).join('')}</tbody></table><div class="table-note"><span>Rounds 1–3: 4 · 3 · 2 · 1 placing points &nbsp; + &nbsp; closest-to-the-pin bonuses</span><span>Winner £40 <b>·</b> Runner-up £20</span></div></div><p class="fine-print">Sorted by overall points. Arrows show places moved at the last position change in this session. Live placing points use holes completed by all four players. Ties share placing points. Gross, net and Stableford show all entered individual scores.${data.rounds.some(r => !r.verified) ? ' Course details are unverified — confirm pars and stroke indexes in each scorecard.' : ''}</p>${earningsNote()}</section><section class="section"><div class="section-heading"><div><div class="eyebrow green">FOUR ROUNDS. FOUR BATTLES.</div><h2>The competitions<span class="yellow-dot">.</span></h2></div><button class="text-button" data-page="rules">View the rulebook ↗</button></div><div class="competition-grid">${COURSES.map((_,ri) => compCard(ri)).join('')}</div></section><aside class="clubhouse"><span class="beer-icon">♧</span><div><span class="eyebrow">THE MOST IMPORTANT RULE</span><h3>Last place buys the first round.</h3><p>Clubhouse. Straight after the round. No excuses.</p></div><span class="clubhouse-label">19TH HOLE<br><strong>TRADITIONS</strong></span></aside>`);
}
function scorecard() {
  const ri = selected, r = data.rounds[ri], scramble = ri === 3;
  const names = scramble ? TEAMS[ri].map(t => t.map(p => SHORT[p]).join(' & ')) : SHORT;
  const scores = scramble ? r.teamScores : r.scores;
  const total = scores.map((s,p) => scramble ? { gross: s.filter(Golf.played).reduce((a,b) => a+b,0), holes:s.filter(Golf.played).length } : Golf.totals(r,p,data.handicaps[p]));
  shell(`<div class="page-heading"><div class="eyebrow green">EVERY SHOT COUNTS</div><h1>The scorecards<span>.</span></h1><p>Enter gross strokes. We’ll take care of the numbers.</p></div><div class="round-tabs">${COURSES.map((c,i) => `<button class="${i===ri ? 'selected' : ''}" data-round="${i}"><small>ROUND 0${i+1}</small>${c}</button>`).join('')}</div><div class="score-layout"><section class="card score-panel"><div class="score-heading"><div><div class="eyebrow green">${COURSES[ri]} · ROUND 0${ri+1}</div><h2>${TITLES[ri]}</h2></div><button class="button outline" data-action="setup">${setup ? 'Close course setup' : 'Course setup'} ⚙</button></div>${!r.verified ? '<div class="notice">Course setup needed: select a saved tee, or upload a scorecard and add its tees under Course setup before relying on results.</div>' : ''}${setup ? courseSetup(r) : ''}<p class="score-help">${scramble ? 'Enter one shared gross score per pair. Lowest gross total wins; handicaps do not apply to this round.' : 'All four players play their own ball. Each cell shows net strokes and Stableford points after entry.'} Blank means not played.</p><div class="table-scroll"><table class="score-table"><thead><tr><th>HOLE</th><th>PAR</th><th>SI</th>${names.map((n,p) => `<th>${n}${!scramble ? `<small>HCP ${data.handicaps[p]}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${Array.from({length:18},(_,i) => `<tr><td class="hole-number">${i+1}</td><td>${r.pars[i]}</td><td class="muted">${r.indexes[i]}</td>${scores.map((s,p) => { const h = scramble ? null : Golf.hole(s[i],r.pars[i],r.indexes[i],data.handicaps[p]); return `<td><input class="score-input" type="number" inputmode="numeric" min="1" max="30" step="1" value="${s[i] ?? ''}" data-score="${p}" data-hole="${i}" aria-label="${names[p]}, hole ${i+1} gross strokes"><small class="hole-result">${h ? `${h.net} net · ${h.points} pts` : '—'}</small></td>`; }).join('')}</tr>${i === 8 ? `<tr class="subtotal"><td>OUT</td><td>${r.pars.slice(0,9).reduce((a,b)=>a+b,0)}</td><td></td>${scores.map(s => `<td>${s.slice(0,9).some(Golf.played) ? s.slice(0,9).filter(Golf.played).reduce((a,b)=>a+b,0) : '—'}</td>`).join('')}</tr>` : ''}`).join('')}<tr class="subtotal"><td>IN</td><td>${r.pars.slice(9).reduce((a,b)=>a+b,0)}</td><td></td>${scores.map(s => `<td>${s.slice(9).some(Golf.played) ? s.slice(9).filter(Golf.played).reduce((a,b)=>a+b,0) : '—'}</td>`).join('')}</tr><tr class="score-total"><td>TOTAL</td><td>${r.pars.reduce((a,b)=>a+b,0)}</td><td></td>${total.map(t => `<td>${t.holes ? t.gross : '—'}${!scramble ? `<small>${t.net} net · ${t.points} pts</small>` : ''}</td>`).join('')}</tr></tbody></table></div></section><aside class="score-sidebar">${compCard(ri)}<section class="card pin-card"><span class="pin-icon">⚑</span><div class="eyebrow green">A LITTLE CLOSER. A POINT BETTER.</div><h3>Closest to the pin</h3><p>Last par 3 of the round${r.verified && r.pars.includes(3) ? ` · hole ${r.pars.lastIndexOf(3)+1}` : ''}. One bonus point on the overall leaderboard.</p><label for="ctp">Who stuck it closest?</label><select id="ctp"><option value="">Not awarded yet</option>${PLAYERS.map((p,i) => `<option value="${i}" ${r.ctp === i ? 'selected' : ''}>${p}</option>`).join('')}</select></section><div class="sidebar-note">Scores save automatically on this device. Export a backup from the footer to move them to another device.</div></aside></div>`);
}
function courseSetup(r) { return courseLibrarySetup(selected); }

function players() {
  shell(`<div class="page-heading"><div class="eyebrow green">THE USUAL SUSPECTS</div><h1>Meet the fourball<span>.</span></h1><p>New handicap? Every net score, Stableford point and placing updates instantly.</p></div><div class="notice">Enter the playing handicap to use across this trip. These are not automatically converted from a Handicap Index using course ratings or slope. Values start at 0 until you set them.</div><div class="player-grid">${PLAYERS.map((name,p) => `<section class="card player-card">${avatar(p)}<span class="eyebrow green">PLAYER 0${p+1}</span><h2>${name}</h2><label for="hcp-${p}">Playing handicap</label><div class="handicap-control"><input type="number" id="hcp-${p}" data-hcp="${p}" min="-10" max="54" step="1" value="${data.handicaps[p]}"><span>HCP</span></div><p>Strokes are allocated by each hole’s stroke index. Use a negative number for a plus handicap.</p></section>`).join('')}</div><section class="card explanation"><h3>How your handicap works</h3><p>A playing handicap of 20 gets one stroke on every hole, plus another on stroke indexes 1 and 2. Net par earns 2 Stableford points, net birdie 3, net bogey 1, and net double bogey or worse 0. Changes apply to all saved rounds immediately.</p><p>The scramble is gross stroke play, so handicap edits affect rounds 1–3 only.</p></section>`);
}
function rules() {
  const descriptions = ['Each hole goes to the pair with the higher combined Stableford score. Equal scores halve the hole. The pair that wins the most holes wins the round.', 'On every hole, each pair counts its better individual Stableford score. The pair with the highest total at the end wins.', 'Everyone plays their own ball. Highest individual Stableford total wins the round.', 'Both players in a pair play from the better shot each time. Record a single gross score for each pair on every hole. Lowest total wins.'];
  shell(`<div class="page-heading"><div class="eyebrow green">THE GOLF HOLIDAY RULEBOOK</div><h1>Four rounds. One winner<span>.</span></h1><p>A £200 pot. A few friendly rivalries. And plenty to play for.</p></div><div class="rules-grid">${TITLES.map((title,i) => `<article class="card rule-card"><span class="rule-number">0${i+1}</span><div><div class="eyebrow green">${COURSES[i]}</div><h2>${title}</h2><p>${descriptions[i]}</p><strong>${i===2 ? 'Every golfer for himself' : TEAMS[i].map(t=>t.map(p=>SHORT[p]).join(' & ')).join(' vs ')}</strong><div class="prize">${i===2 ? '£20 to the winner' : '£40 to the winning pair · £20 each'}</div></div></article>`).join('')}</div><section class="card explanation"><h2>The overall crown</h2><p>After each of rounds 1, 2 and 3, rank all four golfers by individual Stableford score: 1st earns 4 points, 2nd 3, 3rd 2 and 4th 1. Round 4’s scramble does not earn placing points.</p><p>Closest to the pin on the last par 3 of each of the four rounds earns that player one extra overall point. Overall winner: £40. Runner-up: £20. Everyone puts in £50.</p><h3>Ties & live scoring</h3><p>Tied players share the points for the places they occupy (a joint first earns 3.5 each). Live placing points and pair competitions compare only holes entered for every player or pair, so partial entry cannot give someone an unfair lead. Individual totals show all their entered holes. Final tied competitions are shown as tied; agree any prize split or playoff together.</p><h3>The clubhouse rule</h3><p>Last place each day buys the first round of beers, straight after the round.</p></section>`);
}
function render() { ({ dashboard, scorecard, players, rules }[page] || dashboard)(); }
function navigate(target) { page = target; location.hash = target; render(); window.scrollTo(0,0); }
app.addEventListener('click', e => {
  const el = e.target.closest('button'); if (!el) return;
  if (el.dataset.page) navigate(el.dataset.page);
  if (el.dataset.round !== undefined) { selected = Number(el.dataset.round); setup = false; newTee = false; navigate('scorecard'); }
  if (el.dataset.action === 'setup') { setup = !setup; render(); }
  if (el.dataset.action === 'export') { const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='portugal-2026-scores.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('Score backup exported.'); }
  if (el.dataset.action === 'import') document.getElementById('import').click();
});
app.addEventListener('change', async e => {
  const el=e.target;
  if (el.dataset.score !== undefined) {
    const n=el.value === '' ? null : Number(el.value); if (n!==null && !Golf.played(n)) { toast('Enter a whole score from 1 to 30, or leave blank.'); render(); return; }
    const r=data.rounds[selected], p=Number(el.dataset.score), i=Number(el.dataset.hole);
    (selected===3 ? r.teamScores : r.scores)[p][i]=n; save();
    // Keep the score field DOM intact so tabbing and tapping the next input remain reliable.
    const h=selected===3 ? null : Golf.hole(n,r.pars[i],r.indexes[i],data.handicaps[p]);
    el.nextElementSibling.textContent=h ? `${h.net} net · ${h.points} pts` : '—';
    const oldScroll=window.scrollY;
    const sidebar=app.querySelector('.score-sidebar .competition'); if(sidebar) sidebar.outerHTML=compCard(selected);
    const scores=selected===3 ? r.teamScores : r.scores;
    app.querySelectorAll('.subtotal').forEach((row,half)=>scores.forEach((s,p)=> { const a=s.slice(half*9,half*9+9).filter(Golf.played); row.children[p+3].textContent=a.length ? a.reduce((a,b)=>a+b,0) : '—'; }));
    scores.forEach((s,p)=> { const t=selected===3 ? {gross:s.filter(Golf.played).reduce((a,b)=>a+b,0),holes:s.filter(Golf.played).length} : Golf.totals(r,p,data.handicaps[p]); app.querySelector('.score-total').children[p+3].innerHTML=`${t.holes ? t.gross : '—'}${selected!==3 ? `<small>${t.net} net · ${t.points} pts</small>` : ''}`; });
    window.scrollTo(0,oldScroll);
    if (!el.dataset.mobileCommit) refreshMobileEditor();
  }
  if (el.dataset.hcp !== undefined) { const n=Number(el.value); if(el.value==='' || !Number.isInteger(n) || n < -10 || n > 54) { toast('Enter a whole playing handicap between -10 and 54.'); render(); return; } data.handicaps[Number(el.dataset.hcp)]=n; save(); toast('Handicap saved. All standings recalculated.'); }
  if(el.id==='ctp') { data.rounds[selected].ctp=el.value==='' ? null : Number(el.value); save(); toast('Closest-to-the-pin bonus updated.'); }
  if(el.id==='import' && el.files[0]) { try { const parsed=JSON.parse(await el.files[0].text()); if(!valid(parsed)) throw Error(); if(!confirm('Replace the scores and handicaps on this device with this backup?')) return; data=parsed; save(); render(); toast('Backup imported.'); } catch { toast('That file is not a valid Portugal 2026 backup. Your scores are unchanged.'); } }
});
window.addEventListener('hashchange',()=> { const target=location.hash.slice(1); if(['dashboard','scorecard','players','rules'].includes(target)) {page=target;render();} });
if(['dashboard','scorecard','players','rules'].includes(location.hash.slice(1))) page=location.hash.slice(1);
updateRankMovement();
render();
if(loadError) toast('Saved data could not be loaded. Import a valid backup to restore your scores.');

if (typeof fetch === 'function') loadCourseLibrary();
