const assert = require('assert');
const {spawnSync} = require('child_process');
const {replay} = require('./replay-history');
const fixture = spawnSync('python', ['-c', `
import copy,json,tempfile,uuid
from course_store import CourseStore
from live_store import LiveStore
with tempfile.TemporaryDirectory() as folder:
    store=LiveStore(CourseStore(folder+'/scores.sqlite3'))
    store.audit('auth.login',session='test-admin')
    state=store.snapshot()['state']
    def save(action='scores.updated'):
        return store.save({'state':copy.deepcopy(state),'version':store.snapshot()['version'],'requestId':uuid.uuid4().hex,'action':action},'test-admin')
    state['rounds'][0]['verified']=True
    state['rounds'][0]['scores'][0][0]=3
    save()
    for p in (1,2,3):
        state['rounds'][0]['scores'][p][0]=4
        save()
    # James leads on a birdie, then a correction puts Ben ahead.
    state['rounds'][0]['scores'][1][0]=2
    save()
    state['rounds'][0]['scores'][0][0]=None
    save()
    state['handicaps'][3]=18
    save('backup.imported')
    course=store.snapshot()['courses'][0]
    tee=copy.deepcopy(course['tees'][0]);tee['name']='Custom tee'
    result=store.update_course(0,course['version'],'test-admin',tees=[tee])
    store.update_course(0,result['version'],'test-admin',asset=('map','map.pdf','application/pdf',b'%PDF-first'))
    course=store.snapshot()['courses'][0]
    store.update_course(0,course['version'],'test-admin',asset=('map','new.pdf','application/pdf',b'%PDF-second'))
    store.audit('auth.logout',session='test-admin')
    print(json.dumps({'history':store.history(),'current':store.snapshot()}))
`], {encoding:'utf8',maxBuffer:64*1024*1024});
if(fixture.status!==0) throw Error(fixture.stderr || fixture.error);
const {history,current}=JSON.parse(fixture.stdout), result=replay(history);
assert.deepStrictEqual(result.model.state,current.state);
assert.deepStrictEqual(result.model.courses,current.courses);
assert.equal(Buffer.from(result.model.assets['0/map'].base64,'base64').toString(),'%PDF-second');
const birdie=result.timeline.find(event=>event.scores.some(score=>score.grossResult==='birdie'));
assert.equal(birdie.scores[0].players[0],'James Hammond');
assert.equal(birdie.scores[0].hole,1);
const corrected=result.timeline.find(event=>event.scores.some(score=>score.action==='score corrected'));
assert.equal(corrected.before.overall[0].name,'James Hammond');
assert.equal(corrected.after.overall[0].name,'Ben Nowak');
assert.equal(corrected.scores[0].grossResult,'eagle');
assert(result.timeline.some(event=>event.scores.some(score=>score.action==='score cleared')));
assert(result.timeline.some(event=>event.type==='backup.imported'));
assert.deepStrictEqual(replay(history,1).model,history.events[0].details.checkpoint);
assert.equal(replay(history,corrected.sequence-1).calculated.overall[0].name,'James Hammond');
let corrupt=JSON.parse(JSON.stringify(history));corrupt.events[2].actor='altered';
assert.throws(()=>replay(corrupt));
corrupt=JSON.parse(JSON.stringify(history));corrupt.events.splice(3,1);
assert.throws(()=>replay(corrupt));
corrupt=JSON.parse(JSON.stringify(history));corrupt.events.pop();
assert.throws(()=>replay(corrupt));
console.log('History replay passed: exact state/courses/uploads, initial and intermediate checkpoints, lead changes, birdies, corrections, imports and damaged-file detection.');
