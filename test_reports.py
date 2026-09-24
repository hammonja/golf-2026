"""Round completeness, factual replay, invalidation, persistence and API boundaries."""
import copy
import json
import random
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from course_store import CourseStore
from live_store import LiveStore, empty_state
from round_facts import build_source, competition, complete, hole, signature
from round_reports import OpenAIReporter, RoundReports, settings, validate_report, word_count


def sample_report():
    sentence = "James and Owen shared the lead while Ben and Mark stayed close through the opening holes."
    return {"title": "A shared finish", "paragraphs": [" ".join([sentence] * 7)] * 3}


class FakeReporter:
    configured = True
    model = "test-model"
    config = {"daily_limit": 24}

    def __init__(self):
        self.sources = []
        self.callback = None

    def generate(self, source):
        self.sources.append(source)
        if self.callback:
            self.callback()
        return sample_report()


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "golf.sqlite3"
        self.live = LiveStore(CourseStore(self.path))
        self.reporter = FakeReporter()
        self.reports = RoundReports(self.live, self.reporter, debounce=0)
        self.live.summaries = self.reports
        self.state = self.live.snapshot()["state"]

    def tearDown(self):
        self.folder.cleanup()

    def save(self, action="scores.updated"):
        return self.live.save({"state": copy.deepcopy(self.state), "version": self.live.snapshot()["version"],
                               "requestId": uuid.uuid4().hex, "action": action}, "admin-test")

    def fill(self, ri):
        r = self.state["rounds"][ri]
        r["teamScores" if ri == 3 else "scores"] = [[4] * 18 for _ in range(2 if ri == 3 else 4)]
        r["verified"] = True

    def test_waits_for_every_hole_and_pushes_persisted_report(self):
        self.fill(0)
        self.state["rounds"][0]["scores"][3][17] = None
        self.assertIsNone(self.save()["summaries"][0])
        self.assertFalse(self.reports.run_once())
        self.state["rounds"][0]["scores"][3][17] = 4
        saved = self.save()
        self.assertEqual(saved["summaries"][0]["status"], "pending")
        self.assertTrue(self.reports.run_once())
        final = self.live.snapshot()
        self.assertEqual(final["summaries"][0]["status"], "ready")
        self.assertGreater(final["sequence"], saved["sequence"])
        self.assertEqual(final["version"], saved["version"], "Report generation does not create score conflicts")
        self.assertFalse(self.reports.run_once())
        restarted = LiveStore(CourseStore(self.path))
        restarted.summaries = RoundReports(restarted, self.reporter, debounce=0)
        self.assertEqual(restarted.snapshot()["summaries"], final["summaries"])
        self.assertFalse(restarted.summaries.run_once())
        self.assertTrue(any(e["type"] == "summary.generated" for e in self.live.history()["events"]))

    def test_invalidation_is_per_round_and_uses_only_relevant_inputs(self):
        self.fill(0)
        self.fill(3)
        self.save()
        self.reports.run_once()
        self.reports.run_once()
        self.state["rounds"][2]["scores"][0][0] = 3
        self.save()
        self.live.audit("auth.login")
        self.assertFalse(self.reports.run_once())
        self.state["handicaps"][0] = 18
        summaries = self.save()["summaries"]
        self.assertEqual(summaries[0]["status"], "pending")
        self.assertNotIn("report", summaries[0])
        self.assertEqual(summaries[3]["status"], "ready", "Handicaps do not affect the gross scramble")
        self.reports.run_once()
        for key, value in [("ctp", 2), ("verified", False)]:
            self.state["rounds"][0][key] = value
            self.assertEqual(self.save()["summaries"][0]["status"], "pending")
            self.reports.run_once()
        self.assertEqual(self.reporter.sources[-1]['nearestPin']['winner'], 'Mark Shaw')
        self.assertEqual(self.reporter.sources[-1]['nearestPin']['overallBonusPoints'], 1)
        self.assertFalse(self.reporter.sources[-1]['nearestPin']['affectsRoundWinner'])
        self.state["rounds"][0]["pars"][0] = 5
        self.assertEqual(self.save()["summaries"][0]["status"], "pending")
        self.reports.run_once()
        self.state["rounds"][0]["scores"][0][1] = None
        self.assertIsNone(self.save()["summaries"][0])

    def test_scramble_uses_pairs_not_individual_score_cells(self):
        self.state["rounds"][3]["scores"] = [[4] * 18 for _ in range(4)]
        self.assertIsNone(self.save()["summaries"][3])
        self.fill(3)
        self.save()
        self.reports.run_once()
        source = self.reporter.sources[0]
        self.assertIsNone(source["current"]["handicaps"])
        self.assertEqual(source["result"]["totals"], [72, 72])
        self.assertIsNone(source["holeOrder"][0]["scores"][0]["player"])

    def test_inflight_generation_cannot_publish_over_newer_scores_even_after_revert(self):
        self.fill(2)
        self.save()
        def change_and_revert():
            self.reporter.callback = None
            self.state["rounds"][2]["scores"][0][17] = 3
            self.save()
            self.state["rounds"][2]["scores"][0][17] = 4
            self.save()
        self.reporter.callback = change_and_revert
        self.reports.run_once()
        self.assertEqual(self.live.snapshot()["summaries"][2]["status"], "pending")
        self.assertTrue(any(e["type"] == "summary.discarded" for e in self.live.history()["events"]))
        self.reports.run_once()
        self.assertEqual(self.live.snapshot()["summaries"][2]["status"], "ready")

    def test_history_includes_corrections_and_imports_without_auth_or_files(self):
        self.live.audit("auth.login_failed", session="do-not-send")
        self.state["rounds"][2]["scores"][0][0] = 2
        self.save()
        self.fill(2)
        self.state["rounds"][2]["scores"][0][0] = 3
        self.save("backup.imported")
        self.reports.run_once()
        source = self.reporter.sources[0]
        events = source["history"]["events"]
        self.assertEqual([e["type"] for e in events], ["scores.updated", "backup.imported"])
        correction = next(c for c in events[-1]["changes"] if c["path"] == ["state", "rounds", 2, "scores", 0, 0])
        self.assertEqual((correction["before"], correction["after"]), (2, 3))
        self.assertEqual(source["holeOrder"][0]["scores"][0]["grossResult"], "birdie")
        for forbidden in ["base64", "do-not-send", "auth.login", '"session"', '"assets"']:
            self.assertNotIn(forbidden, json.dumps(source))

    def test_failures_retry_with_limit_and_manual_retry_keeps_daily_budget(self):
        self.fill(1)
        self.save()
        self.reporter.callback = lambda: (_ for _ in ()).throw(ValueError("secret provider error"))
        for _ in range(3):
            self.assertTrue(self.reports.run_once())
            with self.live.courses.connect() as db:
                db.execute("UPDATE golf_reports SET due=0")
        self.assertFalse(self.reports.run_once())
        self.assertEqual(self.live.snapshot()["summaries"][1], {"status": "failed"})
        self.assertNotIn("secret provider error", json.dumps(self.live.history()))
        self.reporter.config = {"daily_limit": 3}
        self.reports.retry(1)
        self.assertFalse(self.reports.run_once())
        self.assertEqual(len(self.reporter.sources), 3)

    def test_restart_recovers_interrupted_attempt_and_missing_configuration_is_safe(self):
        self.fill(0)
        self.save()
        with self.live.courses.connect() as db:
            db.execute("UPDATE golf_reports SET status='writing',attempts=1")
        recovered = RoundReports(self.live, self.reporter, debounce=0)
        self.assertTrue(recovered.run_once())
        self.state["rounds"][0]["ctp"] = 1
        self.save()
        self.reporter.configured = False
        self.assertFalse(self.reports.run_once())
        self.assertEqual(self.live.snapshot()["summaries"][0], {"status": "unavailable"})

    def test_debounce_and_invalid_model_output(self):
        self.reports.debounce = 30
        self.fill(0)
        self.save()
        self.assertFalse(self.reports.run_once())
        with self.live.courses.connect() as db:
            db.execute("UPDATE golf_reports SET due=0")
        self.reporter.generate = lambda source: {"title": "Too short", "paragraphs": ["Tiny"] * 3}
        self.reports.run_once()
        self.assertEqual(self.live.snapshot()["summaries"][0], {"status": "pending"})


class ProviderAndFactsTests(unittest.TestCase):
    def test_config_precedence_and_shared_key_allowlist(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "golf"
            root.mkdir()
            tools = Path(folder) / "tools"
            tools.mkdir()
            (tools / ".env").write_text('OPENAI_API_KEY="shared-test"\nOPENAI_MODEL=gpt-5-mini\nUNRELATED_SECRET=excluded\n')
            (root / ".env").write_text("OPENAI_MODEL=local-model\nGOLF_AI_ENABLED=0\n")
            config = settings(root, {"OPENAI_MODEL": "environment-model"})
            self.assertEqual(config["OPENAI_API_KEY"], "shared-test")
            self.assertEqual(config["OPENAI_MODEL"], "environment-model")
            self.assertFalse(config["enabled"])
            self.assertNotIn("UNRELATED_SECRET", config)
            (root / '.env').write_text('')
            self.assertEqual(settings(root, {})['OPENAI_MODEL'], 'gpt-6-sol', 'Do not inherit Tools model')
            self.assertEqual(settings(root, {'GOLF_AI_MODEL':'gpt-6-astra'})['OPENAI_MODEL'], 'gpt-6-astra')

    def test_api_payload_validation_and_no_provider_storage(self):
        reporter = OpenAIReporter({"OPENAI_API_KEY": "test-key", "OPENAI_MODEL": "test-model"})
        response = {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(sample_report())}]}]}
        with patch("round_reports.urlopen") as send:
            send.return_value.__enter__.return_value.read.return_value = json.dumps(response).encode()
            report = reporter.generate({"history": {"events": []}})
            self.assertTrue(300 <= word_count(report["paragraphs"]) <= 500)
            request = send.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
            payload = json.loads(request.data)
            self.assertFalse(payload["store"])
            self.assertTrue(payload["text"]["format"]["strict"])
            self.assertNotIn("test-key", json.dumps(payload))
        for paragraphs in [["word"] * 3, ["word " * 200] * 3]:
            with self.assertRaises(ValueError):
                validate_report({"title": "Report", "paragraphs": paragraphs})
        invented = sample_report()
        invented['paragraphs'][0] += ' Ben sank a long putt.'
        with self.assertRaises(ValueError):
            validate_report(invented)

    def test_comeback_last_hole_tie_and_early_match_clinch(self):
        state = empty_state()
        r = state["rounds"][2]
        r["scores"] = [[4] * 18 for _ in range(4)]
        r["scores"][0][0] = 3
        r["scores"][1][16] = 3
        r["scores"][1][17] = 3
        events = [{"details": {"checkpoint": {"state": state}}}]
        source = build_source(events, state, 2, 1)
        self.assertEqual(source["holeOrder"][8]["standingsThroughHole"]["leaders"], ["James Hammond"])
        self.assertEqual(source["holeOrder"][16]["standingsThroughHole"]["leaders"], ["James Hammond", "Ben Nowak"])
        self.assertEqual(source["result"]["leaders"], ["Ben Nowak"])
        state["rounds"][0]["scores"] = [[3] * 18, [5] * 18, [5] * 18, [3] * 18]
        source = build_source(events, state, 0, 1)
        self.assertEqual(source["matchClinchedAfterHole"], 10)

    @unittest.skipUnless(shutil.which("node"), "Node is needed for cross-language scoring parity")
    def test_calculations_match_browser_scoring_engine(self):
        rng = random.Random(2026)
        states = []
        for _ in range(30):
            state = empty_state()
            state["handicaps"] = [rng.choice([-9.5, -1.5, 0, 8.5, 18, 36, 54]) for _ in range(4)]
            for r in state["rounds"]:
                r["pars"] = [rng.choice([3, 4, 5]) for _ in range(18)]
                rng.shuffle(r["indexes"])
                r["scores"] = [[rng.choice([None, 2, 3, 4, 5, 6, 9]) for _ in range(18)] for _ in range(4)]
                r["teamScores"] = [[rng.choice([None, 2, 3, 4, 5]) for _ in range(18)] for _ in range(2)]
            states.append(state)
        script = "const G=require('./scoring');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(d=>d.rounds.map((r,i)=>G.competition(r,d.handicaps,[[[0,3],[2,1]],[[1,3],[2,0]],[],[[3,2],[0,1]]][i],['match','best','solo','scramble'][i]))))));"
        result = subprocess.run(["node", "-e", script], input=json.dumps(states), text=True, capture_output=True, check=True, timeout=15)
        expected = json.loads(result.stdout)
        for state, rounds in zip(states, expected):
            for ri, js in enumerate(rounds):
                py = competition(state, ri)
                for key in js:
                    self.assertEqual(py[key], js[key], f"Round {ri}: {key}")


if __name__ == "__main__":
    unittest.main()
