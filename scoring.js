(function (root) {
  const played = value => Number.isInteger(value) && value >= 1 && value <= 30;
  function strokes(handicap, index) {
    const h = Math.round(handicap);
    return Math.floor(h / 18) + (index <= ((h % 18) + 18) % 18 ? 1 : 0);
  }
  function hole(gross, par, index, handicap) {
    if (!played(gross)) return null;
    const net = gross - strokes(handicap, index);
    return { gross, net, points: Math.max(0, 2 + par - net) };
  }
  function totals(round, player, handicap) {
    return round.scores[player].reduce((sum, gross, i) => {
      const h = hole(gross, round.pars[i], round.indexes[i], handicap);
      if (h) { sum.gross += h.gross; sum.net += h.net; sum.points += h.points; sum.holes++; }
      return sum;
    }, { gross: 0, net: 0, points: 0, holes: 0 });
  }
  function placingPoints(values) {
    return values.map(v => {
      const above = values.filter(x => x > v).length;
      const tied = values.filter(x => x === v).length;
      return 4 - above - (tied - 1) / 2;
    });
  }
  function competition(round, handicaps, teams, format) {
    if (format === 'solo') {
      const common = round.pars.map((_, i) => round.scores.every(s => played(s[i])));
      return { totals: handicaps.map((h, p) => totals(round, p, h).points), ranking: handicaps.map((h,p) => round.scores[p].reduce((sum,g,i) => sum + (common[i] ? hole(g,round.pars[i],round.indexes[i],h).points : 0),0)), holes: common.filter(Boolean).length };
    }
    let holes = 0;
    const values = [0, 0];
    for (let i = 0; i < 18; i++) {
      if (format === 'scramble') {
        if (round.teamScores.every(s => played(s[i]))) { holes++; values.forEach((_, t) => values[t] += round.teamScores[t][i]); }
      } else if (round.scores.every(s => played(s[i]))) {
        holes++;
        const points = teams.map(team => team.map(p => hole(round.scores[p][i], round.pars[i], round.indexes[i], handicaps[p]).points));
        const pair = points.map(p => format === 'match' ? p[0] + p[1] : Math.max(...p));
        if (format === 'match') { if (pair[0] > pair[1]) values[0]++; if (pair[1] > pair[0]) values[1]++; }
        else { values[0] += pair[0]; values[1] += pair[1]; }
      }
    }
    return { totals: values, holes };
  }
  function earnings(rounds, handicaps, teams, formats, standings) {
    const players = handicaps.map(() => ({ earned: 0, projected: 0, breakdown: [] }));
    let tiedPrizes = 0;
    const award = (p, amount, final, label) => {
      players[p][final ? 'earned' : 'projected'] += amount;
      players[p].breakdown.push({ label, amount, final });
    };
    let started = false;
    const results = rounds.map((r,i) => competition(r,handicaps,teams[i],formats[i]));
    results.forEach((result,i) => {
      if (!result.holes) return;
      started = true;
      const values = formats[i] === 'solo' ? result.ranking : result.totals;
      const best = formats[i] === 'scramble' ? Math.min(...values) : Math.max(...values);
      const winners = values.map((v,p) => v===best ? p : -1).filter(p=>p!==-1);
      if (winners.length !== 1) { tiedPrizes += formats[i] === 'solo' ? 20 : 40; return; }
      const recipients = formats[i] === 'solo' ? winners : teams[i][winners[0]];
      recipients.forEach(p => award(p,20,result.holes===18 && rounds[i].verified,`Round ${i+1}`));
    });
    if (started || rounds.some(r=>r.ctp!==null)) {
      const final = results.every(r=>r.holes===18) && rounds.every(r=>r.verified && r.ctp!==null);
      const prizes = [40,20,0,0];
      standings.forEach(row => {
        const above = standings.filter(other=>other.points>row.points).length;
        const tied = standings.filter(other=>other.points===row.points).length;
        if (tied === 1 && prizes[above]) award(row.p,prizes[above],final,'Overall');
      });
      // Count each tied prize group once. Prize ties remain unresolved, as in the rulebook.
      const seen = new Set();
      standings.forEach(row => {
        if (seen.has(row.points)) return;
        seen.add(row.points);
        const above = standings.filter(other=>other.points>row.points).length;
        const tied = standings.filter(other=>other.points===row.points).length;
        if (tied > 1) tiedPrizes += prizes.slice(above,above+tied).reduce((a,b)=>a+b,0);
      });
    }
    return { players, tiedPrizes };
  }
function standings(data, players, teams, formats) {
  const rows = players.map((name, p) => ({ name, p, gross: 0, net: 0, stable: 0, holes: 0, bonus: 0, points: 0, round: [] }));
  data.rounds.forEach((r, ri) => {
    if (r.ctp !== null) { rows[r.ctp].bonus++; rows[r.ctp].points++; }
    if (ri === 3) return;
    const playerTotals = players.map((_, p) => totals(r, p, data.handicaps[p]));
    // Rank live standings only on holes scored by all four players.
    const common = r.pars.map((_, i) => r.scores.every(s => played(s[i])));
    const comparable = players.map((_, p) => r.scores[p].reduce((sum, g, i) => sum + (common[i] ? hole(g, r.pars[i], r.indexes[i], data.handicaps[p]).points : 0), 0));
    const points = common.some(Boolean) ? placingPoints(comparable) : [0, 0, 0, 0];
    rows.forEach((row, p) => { const t = playerTotals[p]; row.gross += t.gross; row.net += t.net; row.stable += t.points; row.holes += t.holes; row.points += points[p]; row.round.push({ ...t, ranking: points[p] }); });
  });
  rows.sort((a, b) => b.points - a.points);
  const winnings = earnings(data.rounds,data.handicaps,teams,formats,rows);
  rows.forEach(row => row.earnings = winnings.players[row.p]);
  return rows;
}
  const api = { played, strokes, hole, totals, placingPoints, competition, earnings, standings };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Golf = api;
})(typeof window === 'undefined' ? globalThis : window);
