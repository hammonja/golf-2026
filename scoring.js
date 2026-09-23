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
  const api = { played, strokes, hole, totals, placingPoints, competition };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Golf = api;
})(typeof window === 'undefined' ? globalThis : window);
