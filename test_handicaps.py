"""Per-round handicaps, legacy migration and replay across the schema change."""
import copy
import json
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from course_store import CourseStore
from live_store import LiveStore, changes, empty_state, encoded, validate_state
from round_facts import build_source, competition, signature
from round_reports import RoundReports
from test_reports import FakeReporter


def save(store, state, action="scores.updated"):
    return store.save({"state": copy.deepcopy(state), "version": store.snapshot()["version"],
                       "requestId": uuid.uuid4().hex, "action": action}, "test-admin")


class HandicapTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "golf.sqlite3"
        self.store = LiveStore(CourseStore(self.path))

    def tearDown(self):
        self.folder.cleanup()

    def test_validation_and_explicit_legacy_import(self):
        state = empty_state()
        for bad in [[], [0] * 4, [[0] * 4] * 3, [0, [0] * 4, [0] * 4, [0] * 4],
                    [[0] * 3] * 4, [[55] * 4] * 4, [[-11] * 4] * 4, [[True] * 4] * 4,
                    [[float("nan")] * 4] * 4, [["18"] * 4] * 4]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_state({**state, "handicaps": bad})
        state["handicaps"] = [-2, 18, 36, 54]
        with self.assertRaisesRegex(ValueError, "Refresh"):
            save(self.store, state)
        imported = save(self.store, state, "backup.imported")["state"]
        self.assertEqual(imported["handicaps"], [state["handicaps"]] * 4)
        self.assertEqual(imported["rounds"], state["rounds"])
        imported["handicaps"][1][0] = 9
        self.assertEqual(imported["handicaps"][0][0], -2)
        save(self.store, imported)
        self.assertEqual(LiveStore(CourseStore(self.path)).snapshot()["state"], imported)
        edited = self.store.history()["events"][-1]
        self.assertEqual(edited["changes"][0]["path"], ["state", "handicaps", 1, 0])

    def test_only_changed_round_report_regenerates(self):
        reporter = FakeReporter()
        reports = RoundReports(self.store, reporter, debounce=0)
        self.store.summaries = reports
        state = empty_state()
        for r in state["rounds"]:
            r["scores"] = [[4] * 18 for _ in range(4)]
            r["teamScores"] = [[4] * 18 for _ in range(2)]
            r["verified"] = True
        save(self.store, state)
        for _ in range(4):
            self.assertTrue(reports.run_once())
        before = [competition(state, ri) for ri in range(4)]
        state["handicaps"][1][0] = 18
        summaries = save(self.store, state)["summaries"]
        self.assertEqual([s["status"] for s in summaries], ["ready", "pending", "ready", "ready"])
        for ri in (0, 2, 3):
            self.assertEqual(competition(state, ri), before[ri])
        self.assertEqual(competition(state, 1)["totals"], [36, 54])
        self.assertTrue(reports.run_once())
        source = reporter.sources[-1]
        self.assertEqual(source["round"], 2)
        self.assertEqual(source["current"]["handicaps"], [18, 0, 0, 0])
        self.assertEqual(source["holeOrder"][0]["scores"][0]["scoring"]["net"], 3)
        state["handicaps"][3][0] = 54
        self.assertEqual([s["status"] for s in save(self.store, state)["summaries"]], ["ready"] * 4)
        self.assertFalse(reports.run_once())
        self.assertEqual(len(reporter.sources), 5)

    def test_legacy_migration_and_history_replay_preserve_results(self):
        # Reproduce an old on-disk checkpoint plus an old scalar handicap edit.
        initial = empty_state()
        initial["handicaps"] = [-2, 8, 18, 36]
        legacy = copy.deepcopy(initial)
        legacy["handicaps"][0] = 9
        for ri, r in enumerate(legacy["rounds"]):
            if ri == 3:
                r["teamScores"] = [[3] * 18, [4] * 18]
            else:
                r["scores"] = [[p + 3] * 18 for p in range(4)]
            r["verified"] = True
        with self.store.courses.connect() as db:
            event = json.loads(db.execute("SELECT content FROM golf_events WHERE seq=1").fetchone()[0])
            event["details"]["checkpoint"]["state"] = initial
            db.execute("UPDATE golf_events SET content=? WHERE seq=1", (encoded(event),))
            self.store.append(db, "scores.updated", "admin", "old-session", changes(initial, legacy, ["state"]))
            db.execute("UPDATE golf_state SET version=1,content=? WHERE id=1", (encoded(legacy),))
        old_history = self.store.history()
        old_history["scoringVersion"] = 1
        original_events = old_history["events"]
        self.store = LiveStore(CourseStore(self.path))
        migrated = self.store.snapshot()
        self.assertEqual(migrated["version"], 2)
        self.assertEqual(migrated["state"]["rounds"], legacy["rounds"])
        self.assertEqual(migrated["state"]["handicaps"], [legacy["handicaps"]] * 4)
        self.assertEqual(self.store.history()["events"][:2], original_events)
        self.assertEqual(self.store.history()["events"][2]["type"], "handicaps.rounds_enabled")
        for ri in range(4):
            self.assertEqual(signature(legacy, ri), signature(migrated["state"], ri))
            self.assertEqual(competition(legacy, ri), competition(migrated["state"], ri))
        self.assertEqual(LiveStore(CourseStore(self.path)).snapshot(), migrated, "Migration must run once")
        state = migrated["state"]
        state["handicaps"][1][0] = 27
        save(self.store, state)
        # This unrelated change must be excluded from other rounds' AI input.
        state["handicaps"][2][2] = 4
        saved = save(self.store, state)
        history = self.store.history()
        for ri in range(4):
            source = build_source(history["events"], state, ri, saved["sequence"])
            self.assertEqual(source["result"], competition(state, ri))
            if ri != 3:
                self.assertEqual(source["current"]["handicaps"], state["handicaps"][ri])
                edits = [c for e in source["history"]["events"] for c in e["changes"]
                         if c["path"][:2] == ["state", "handicaps"] and len(c["path"]) == 4]
                self.assertTrue(all(c["path"][2] == ri for c in edits))
        script = """
const assert=require('assert'),{replay}=require('./replay-history');
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
const d=JSON.parse(input);
const old=replay(d.old), full=replay(d.history), migrated=replay(d.history,3);
assert.deepStrictEqual(old.model.state,d.legacy);
assert.deepStrictEqual(old.calculated,migrated.calculated);
assert.deepStrictEqual(full.model.state,d.current);
assert.deepStrictEqual(replay(d.history,2).calculated,old.calculated);
assert.deepStrictEqual(full.timeline.find(e=>e.type==='handicaps.rounds_enabled').before,
                       full.timeline.find(e=>e.type==='handicaps.rounds_enabled').after);
});
"""
        result = subprocess.run(["node", "-e", script], input=json.dumps({"old": old_history, "history": history,
                                "legacy": legacy, "current": state}), text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
