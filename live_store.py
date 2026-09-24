"""Shared scores and an atomic, append-only event history (standard library only)."""
import base64
import hashlib
import json
import math
import re
from datetime import datetime, timezone

from course_store import ConflictError, ROOT, max_tee_distance


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def empty_state():
    return {"handicaps": [0] * 4, "rounds": [
        {"scores": [[None] * 18 for _ in range(4)], "teamScores": [[None] * 18 for _ in range(2)],
         "pars": [4] * 18, "indexes": list(range(1, 19)), "verified": False, "ctp": None}
        for _ in range(4)]}


def validate_state(state):
    def array(value, length, check):
        return isinstance(value, list) and len(value) == length and all(check(x) for x in value)

    def integer(value, low, high):
        return type(value) is int and low <= value <= high

    def score(value):
        return value is None or integer(value, 1, 30)

    if not isinstance(state, dict) or set(state) != {"handicaps", "rounds"}:
        raise ValueError("Invalid score backup.")
    if not array(state["handicaps"], 4, lambda h: type(h) in (int, float) and math.isfinite(h) and -10 <= h <= 54):
        raise ValueError("Provide four playing handicaps between -10 and 54.")
    if not isinstance(state["rounds"], list) or len(state["rounds"]) != 4:
        raise ValueError("Provide four rounds.")
    for r in state["rounds"]:
        required = {"scores", "teamScores", "pars", "indexes", "verified", "ctp"}
        if not isinstance(r, dict) or not required <= set(r) or set(r) - required - {"tee"}:
            raise ValueError("Invalid round fields.")
        if not (array(r["scores"], 4, lambda s: array(s, 18, score))
                and array(r["teamScores"], 2, lambda s: array(s, 18, score))
                and array(r["pars"], 18, lambda p: integer(p, 3, 6))
                and array(r["indexes"], 18, lambda p: integer(p, 1, 18))
                and len(set(r["indexes"])) == 18 and type(r["verified"]) is bool
                and (r["ctp"] is None or integer(r["ctp"], 0, 3))):
            raise ValueError("Invalid scores, pars, stroke indexes or pin award.")
        tee = r.get("tee")
        if tee is not None and not (isinstance(tee, dict) and set(tee) == {"id", "name", "unit", "distances"}
                and isinstance(tee["id"], str) and 1 <= len(tee["id"]) <= 80
                and isinstance(tee["name"], str) and 1 <= len(tee["name"].strip()) <= 50
                and tee["unit"] in ("m", "yd")
                and array(tee["distances"], 18, lambda d: integer(d, 1, max_tee_distance(tee["unit"])))):
            raise ValueError("Invalid playing tee snapshot.")
    return state


def changes(before, after, path=None):
    """Ordered replacements with preconditions; array positions are zero based."""
    path = path or []
    if isinstance(before, dict) and isinstance(after, dict):
        result = []
        for key in sorted(before.keys() | after.keys()):
            if key not in before or key not in after:
                result.append({"path": path + [key], "before": before.get(key), "after": after.get(key),
                               "existed": key in before, "exists": key in after})
            else:
                result.extend(changes(before[key], after[key], path + [key]))
        return result
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        return [change for i, (a, b) in enumerate(zip(before, after)) for change in changes(a, b, path + [i])]
    if before == after:
        return []
    return [{"path": path, "before": before, "after": after, "existed": True, "exists": True}]


class LiveStore:
    def __init__(self, courses):
        self.courses = courses
        with courses.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TABLE IF NOT EXISTS golf_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, content TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS golf_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS golf_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, version INTEGER NOT NULL)")
            if not db.execute("SELECT 1 FROM golf_state").fetchone():
                state = empty_state()
                db.execute("INSERT INTO golf_state VALUES (1,0,?)", (encoded(state),))
                courses_data = [json.loads(r[0]) for r in db.execute("SELECT content FROM courses ORDER BY id")]
                assets = {f"{c}/{k}": {"mime": m, "base64": base64.b64encode(b).decode()}
                          for c, k, m, b in db.execute("SELECT course,kind,mime,body FROM assets")}
                # Include original reference files too, making the export self-contained.
                bundled = {}
                for course in courses_data:
                    for asset in course["assets"].values():
                        url = asset["url"]
                        if url.startswith("/assets/"):
                            filename = ROOT / "assets" / url.rsplit("/", 1)[-1]
                            if filename.is_file():
                                bundled[url] = {"mime": asset["type"], "base64": base64.b64encode(filename.read_bytes()).decode()}
                self.append(db, "history.started", "system", None, [], {
                    "checkpoint": {"state": state, "courses": courses_data, "assets": assets, "bundledFiles": bundled},
                    "note": "Earlier browser edits cannot be recovered; imported scores enter history at import time."})

    def append(self, db, kind, actor, session, edits, details=None):
        event = {"timestamp": now(), "type": kind, "actor": actor, "session": session,
                 "changes": edits, "details": details or {}}
        cursor = db.execute("INSERT INTO golf_events(content) VALUES ('{}')")
        event["seq"] = cursor.lastrowid
        db.execute("UPDATE golf_events SET content=? WHERE seq=?", (encoded(event), event["seq"]))
        return event

    def audit(self, kind, actor="admin", session=None, details=None):
        with self.courses.connect() as db:
            self.append(db, kind, actor, session, [], details)

    def snapshot(self, db=None):
        if db is None:
            with self.courses.connect() as connection:
                connection.execute("BEGIN")
                return self.snapshot(connection)
        version, content = db.execute("SELECT version,content FROM golf_state WHERE id=1").fetchone()
        return {"version": version, "state": json.loads(content),
                "courses": [json.loads(r[0]) for r in db.execute("SELECT content FROM courses ORDER BY id")],
                "sequence": db.execute("SELECT MAX(seq) FROM golf_events").fetchone()[0]}

    def save(self, payload, session):
        if not isinstance(payload, dict):
            raise ValueError("Invalid score request.")
        state = validate_state(payload.get("state"))
        request_id = payload.get("requestId", "")
        if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{16,100}", request_id):
            raise ValueError("Missing save request identifier.")
        kind = payload.get("action", "scores.updated")
        if kind not in ("scores.updated", "backup.imported", "browser.imported"):
            raise ValueError("Unknown action.")
        fingerprint = hashlib.sha256(encoded(payload).encode()).hexdigest()
        with self.courses.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT fingerprint,version FROM golf_requests WHERE id=?", (request_id,)).fetchone()
            if existing:
                if existing[0] != fingerprint:
                    raise ValueError("Save identifier already used for different data.")
                current = self.snapshot(db)
                if existing[1] != current["version"]:
                    raise ConflictError("Your previous save succeeded, then another admin changed the scores. Latest scores loaded; check your unsaved draft before continuing.")
                return current
            current = self.snapshot(db)
            if type(payload.get("version")) is not int or payload["version"] != current["version"]:
                raise ConflictError("Another admin changed the scores. Latest scores loaded; your unsaved draft is available to download.")
            edits = changes(current["state"], state, ["state"])
            if edits or kind != "scores.updated":
                version = current["version"] + 1
                db.execute("UPDATE golf_state SET version=?,content=? WHERE id=1", (version, encoded(state)))
                self.append(db, kind, "admin", session, edits, {"version": version, "requestId": request_id})
            saved_version = db.execute("SELECT version FROM golf_state WHERE id=1").fetchone()[0]
            db.execute("INSERT INTO golf_requests VALUES (?,?,?)", (request_id, fingerprint, saved_version))
            return self.snapshot(db)

    def update_course(self, course_id, version, session, tees=None, asset=None):
        with self.courses.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            before = json.loads(db.execute("SELECT content FROM courses WHERE id=?", (course_id,)).fetchone()[0])
            old_asset = None
            if asset:
                row = db.execute("SELECT mime,body FROM assets WHERE course=? AND kind=?", (course_id, asset[0])).fetchone()
                if row:
                    old_asset = {"mime": row[0], "base64": base64.b64encode(row[1]).decode()}
            course = self.courses.update_in_transaction(db, course_id, version, tees, asset)
            edits = changes(before, course, ["courses", course_id])
            if asset:
                edits.append({"path": ["assets", f"{course_id}/{asset[0]}"], "before": old_asset,
                              "after": {"mime": asset[2], "base64": base64.b64encode(asset[3]).decode()},
                              "existed": old_asset is not None, "exists": True})
            self.append(db, "course.asset_uploaded" if asset else "course.tees_updated", "admin", session, edits,
                        {"course": course_id, "kind": asset[0] if asset else "tees"})
            return course

    def history(self):
        with self.courses.connect() as db:
            db.execute("BEGIN")
            events = [json.loads(row[0]) for row in db.execute("SELECT content FROM golf_events ORDER BY seq")]
            # Canonical serialisation is included verbatim for portable integrity checking.
            chain = ""
            for event in events:
                canonical = encoded(event)
                chain = hashlib.sha256((chain + "\n" + canonical).encode()).hexdigest()
                event["integrity"] = {"canonical": canonical, "sha256": chain}
            return {"schema": "portugal2026.history", "schemaVersion": 1, "exportedAt": now(),
                    "scoringVersion": 1, "players": ["James Hammond", "Ben Nowak", "Mark Shaw", "Owen Shaw"],
                    "courses": ["Ombria", "O’Connor", "Faldo", "Salgados"],
                    "formats": ["match", "best", "solo", "scramble"],
                    "teams": [[[0, 3], [2, 1]], [[1, 3], [2, 0]], [], [[3, 2], [0, 1]]],
                    "throughSequence": events[-1]["seq"], "sha256": chain, "events": events}
