"""Persistent course library and reference documents (SQLite, standard library only)."""
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULTS = json.loads((ROOT / "course_defaults.json").read_text(encoding="utf-8"))
MAX_UPLOAD = 10 * 1024 * 1024


class ConflictError(ValueError):
    pass


def valid_tee(tee):
    def numbers(key, low, high):
        values = tee.get(key)
        return isinstance(values, list) and len(values) == 18 and all(type(x) is int and low <= x <= high for x in values)
    return (isinstance(tee, dict)
            and isinstance(tee.get("id"), str) and 1 <= len(tee["id"]) <= 80
            and isinstance(tee.get("name"), str) and 1 <= len(tee["name"].strip()) <= 50
            and tee.get("unit") in ("m", "yd")
            and numbers("pars", 3, 6) and numbers("indexes", 1, 18)
            and len(set(tee["indexes"])) == 18 and numbers("distances", 1, 1000))


def valid_file(mime, body):
    return ((mime == "application/pdf" and body.startswith(b"%PDF-"))
            or (mime == "image/png" and body.startswith(b"\x89PNG\r\n\x1a\n"))
            or (mime == "image/jpeg" and body.startswith(b"\xff\xd8\xff"))
            or (mime == "image/webp" and body.startswith(b"RIFF") and body[8:12] == b"WEBP"))


class CourseStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY, content TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS assets (course INTEGER, kind TEXT, mime TEXT, body BLOB, PRIMARY KEY(course,kind))")
            for course in DEFAULTS:
                db.execute("INSERT OR IGNORE INTO courses VALUES (?,?)", (course["id"], json.dumps(course)))
                # Existing deployments also receive newly bundled references.
                # Never replace an uploaded document, a tee, or other user edits.
                saved = json.loads(db.execute("SELECT content FROM courses WHERE id=?", (course["id"],)).fetchone()[0])
                changed = False
                if course.get("teeNote") and not saved.get("teeNote"):
                    saved["teeNote"] = course["teeNote"]
                    changed = True
                for kind, asset in course["assets"].items():
                    if kind not in saved["assets"]:
                        saved["assets"][kind] = asset
                        changed = True
                if not saved.get("source") and course.get("source"):
                    saved["source"] = course["source"]
                    changed = True
                if not saved["tees"] and course["tees"]:
                    saved["tees"] = course["tees"]
                    changed = True
                if changed:
                    saved["version"] += 1
                    db.execute("UPDATE courses SET content=? WHERE id=?", (json.dumps(saved), course["id"]))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def list(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute("SELECT content FROM courses ORDER BY id")]

    def update(self, course_id, version, tees=None, asset=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            course = json.loads(db.execute("SELECT content FROM courses WHERE id=?", (course_id,)).fetchone()[0])
            if type(version) is not int or version != course["version"]:
                raise ConflictError("Course changed on another device. Reload its details and try again.")
            if tees is not None:
                if not isinstance(tees, list) or len(tees) > 12 or not all(valid_tee(t) for t in tees) or len({t['id'] for t in tees}) != len(tees):
                    raise ValueError("Provide up to 12 valid tees, with 18 pars, unique stroke indexes and distances.")
                course["tees"] = [{k: t[k] for k in ("id", "name", "unit", "pars", "indexes", "distances")} for t in tees]
            if asset:
                kind, name, mime, body = asset
                if not valid_file(mime, body):
                    raise ValueError("Upload a PNG, JPEG, WebP image or PDF with a matching file type.")
                db.execute("INSERT OR REPLACE INTO assets VALUES (?,?,?,?)", (course_id, kind, mime, body))
                course["assets"][kind] = {"url": f"/api/courses/{course_id}/assets/{kind}", "name": name[:150], "type": mime}
            course["version"] += 1
            db.execute("UPDATE courses SET content=? WHERE id=?", (json.dumps(course), course_id))
            return course

    def asset(self, course_id, kind):
        with self.connect() as db:
            return db.execute("SELECT mime,body FROM assets WHERE course=? AND kind=?", (course_id, kind)).fetchone()
