#!/usr/bin/env node
/* node replay-history.js history.json [--at SEQUENCE] [--timeline] */
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const Golf = require('./scoring');
const clone = value => JSON.parse(JSON.stringify(value));

function view(model, history) {
  const state = model.state;
  return {
    overall: Golf.standings(state, history.players, history.teams, history.formats),
    rounds: state.rounds.map((round, i) => {
      const result = Golf.competition(round, state.handicaps, history.teams[i], history.formats[i]);
      const values = result.ranking || result.totals;
      const best = history.formats[i] === 'scramble' ? Math.min(...values) : Math.max(...values);
      return {course: history.courses[i], verified: round.verified, ...result,
        leaders: result.holes ? values.flatMap((value, p) => value === best ? [i === 2 ? [history.players[p]] : history.teams[i][p].map(player => history.players[player])] : []) : []};
    })
  };
}

function scoreFacts(event, model, history) {
  return event.changes.filter(change => change.path[0] === 'state' && change.path[1] === 'rounds' && ['scores', 'teamScores'].includes(change.path[3]) && change.path.length === 6).map(change => {
    const [, , ri, kind, player, hole] = change.path, round = model.state.rounds[ri], gross = change.after;
    const versusPar = gross === null ? null : gross - round.pars[hole];
    return {course: history.courses[ri], round: ri + 1, hole: hole + 1,
      players: kind === 'scores' ? [history.players[player]] : history.teams[ri][player].map(p => history.players[p]),
      before: change.before, gross, par: round.pars[hole], versusPar, verifiedCourse: round.verified,
      action: gross === null ? 'score cleared' : change.before === null ? 'score entered' : 'score corrected',
      grossResult: gross === null ? null : ({'-3':'albatross','-2':'eagle','-1':'birdie','0':'par','1':'bogey','2':'double bogey'}[versusPar] || `${versusPar > 0 ? '+' : ''}${versusPar} to par`),
      ...(kind === 'scores' ? {scoring: Golf.hole(gross, round.pars[hole], round.indexes[hole], model.state.handicaps[player])} : {})};
  });
}

function replay(history, through = Infinity) {
  if (history.schema !== 'portugal2026.history' || history.schemaVersion !== 1 || history.scoringVersion !== 1 || !Array.isArray(history.events) || !history.events.length) throw Error('Unsupported or empty history.');
  let chain = '', model = null, sequence = 0;
  const timeline = [];
  for (const event of history.events) {
    if (event.seq !== sequence + 1) throw Error('Missing or out-of-order event.');
    sequence = event.seq;
    const {integrity, ...plain} = event;
    assert.deepStrictEqual(JSON.parse(integrity.canonical), plain, 'Event does not match its integrity record.');
    chain = crypto.createHash('sha256').update(chain + '\n' + integrity.canonical).digest('hex');
    if (chain !== integrity.sha256) throw Error('History integrity check failed.');
    if (event.seq > through) continue;
    if (event.seq === 1) {
      if (event.type !== 'history.started') throw Error('Missing initial checkpoint.');
      model = clone(event.details.checkpoint);
      continue;
    }
    const before = view(model, history);
    for (const change of event.changes) {
      const path = change.path;
      if (!Array.isArray(path) || path.length < 2 || !['state','courses','assets'].includes(path[0]) || path.some(key => ['__proto__','constructor','prototype'].includes(key))) throw Error('Invalid change path.');
      let target = model;
      for (const key of path.slice(0, -1)) {
        if (!Object.hasOwn(target, key)) throw Error('Missing path in history.');
        target = target[key];
      }
      const key = path[path.length - 1];
      assert.equal(Object.hasOwn(target, key), change.existed, 'Change presence does not match.');
      if (change.existed) assert.deepStrictEqual(target[key], change.before, 'Before value does not match.');
      if (change.exists) target[key] = clone(change.after); else delete target[key];
    }
    const after = view(model, history);
    timeline.push({sequence: event.seq, timestamp: event.timestamp, actor: event.actor, session: event.session,
      type: event.type, details: event.details, changes: event.changes.map(change => change.path[0] === 'assets' ? {path: change.path, attachmentChanged: true} : change),
      scores: scoreFacts(event, model, history), before, after});
  }
  if (sequence !== history.throughSequence || chain !== history.sha256) throw Error('History is truncated or incomplete.');
  if (!model) throw Error('Requested sequence is before the initial checkpoint.');
  return {schema: 'portugal2026.replay', throughSequence: Math.min(through, sequence),
    note: 'Timestamps are entry times, not necessarily playing times. Imports and corrections are explicitly identified; unverified course results are provisional.',
    model, calculated: view(model, history), timeline};
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), filename = args[0], atIndex = args.indexOf('--at');
    if (!filename) throw Error('Usage: node replay-history.js history.json [--at SEQUENCE] [--timeline]');
    const through = atIndex < 0 ? Infinity : Number(args[atIndex + 1]);
    if (atIndex >= 0 && (!Number.isInteger(through) || through < 1)) throw Error('--at needs a positive event sequence.');
    const result = replay(JSON.parse(fs.readFileSync(filename, 'utf8')), through);
    const output = args.includes('--timeline') ? {note: result.note, throughSequence: result.throughSequence, timeline: result.timeline} : {...result, timeline: undefined};
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {replay};
