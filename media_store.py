"""Original hole photos/videos with resumable, anonymous uploads and audit metadata."""
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from live_store import encoded, now
from round_facts import COURSES

CHUNK_SIZE = 2 * 1024 * 1024
PHOTO_LIMIT = 25 * 1024 * 1024
VIDEO_LIMIT = 200 * 1024 * 1024
TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
         "image/heif": "heif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}
ID = r"[a-f0-9]{32}"


class MediaError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def key_hash(key):
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise MediaError("This upload is missing its private recovery key.", 403)
    return hashlib.sha256(key.encode()).hexdigest()


def metadata(value):
    if not isinstance(value, dict):
        raise MediaError("Missing capture details.")
    result = {key: value.get(key) for key in ("id", "round", "hole", "mime", "size", "capturedAt",
              "timezoneOffsetMinutes", "historySequenceAtCapture", "stateVersionAtCapture", "originalName")}
    if not isinstance(result["id"], str) or not re.fullmatch(ID, result["id"]):
        raise MediaError("Invalid capture identifier.")
    for key, low, high in (("round", 0, 3), ("hole", 1, 18), ("timezoneOffsetMinutes", -840, 840)):
        if type(result[key]) is not int or not low <= result[key] <= high:
            raise MediaError("Invalid course, hole or timezone.")
    if not isinstance(result["mime"], str) or result["mime"] not in TYPES:
        raise MediaError("Use a JPEG, PNG, WebP, HEIC photo, or MP4, MOV or WebM video.")
    limit = PHOTO_LIMIT if result["mime"].startswith("image/") else VIDEO_LIMIT
    if type(result["size"]) is not int or not 1 <= result["size"] <= limit:
        raise MediaError("Photos can be up to 25 MB and videos up to 200 MB.", 413)
    try:
        date = datetime.fromisoformat(result["capturedAt"].replace("Z", "+00:00"))
        if date.tzinfo is None or not 2020 <= date.year <= 2100:
            raise ValueError()
    except (AttributeError, ValueError, TypeError):
        raise MediaError("Invalid capture time.") from None
    for key in ("historySequenceAtCapture", "stateVersionAtCapture"):
        if result[key] is not None and (type(result[key]) is not int or not 0 <= result[key] <= 2**53 - 1):
            raise MediaError("Invalid history reference.")
    name = result["originalName"]
    if not isinstance(name, str) or not 1 <= len(name) <= 180 or any(ord(c) < 32 for c in name):
        raise MediaError("Invalid original filename.")
    result["originalName"] = name.replace("\\", "/").rsplit("/", 1)[-1]
    result["course"] = COURSES[result["round"]]
    result["kind"] = "photo" if result["mime"].startswith("image/") else "video"
    result["roundNumber"] = result["round"] + 1
    return result


def matches_type(mime, head):
    if mime == "image/jpeg":
        return head.startswith(b"\xff\xd8\xff")
    if mime == "image/png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if mime == "video/webm":
        return head.startswith(b"\x1a\x45\xdf\xa3") and b"webm" in head[:4096]
    if len(head) < 16 or head[4:8] != b"ftyp":
        return False
    brands = head[8:12] + head[16:min(int.from_bytes(head[:4], "big"), 256)]
    image_brand = any(brand in brands for brand in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"))
    if mime in ("image/heic", "image/heif"):
        return image_brand
    return not image_brand and (mime == "video/quicktime" and b"qt  " in brands or
            mime == "video/mp4" and any(b in brands for b in (b"isom", b"iso2", b"mp41", b"mp42", b"avc1", b"M4V ")))


class MediaStore:
    def __init__(self, live, root, total_limit=None, reserve_bytes=256 * 1024 * 1024):
        self.live = live
        self.root = Path(root).resolve()
        self.total_limit = total_limit if total_limit is not None else int(os.environ.get("GOLF_MEDIA_MAX_BYTES", 20 * 1024**3))
        self.reserve_bytes = reserve_bytes
        (self.root / "incoming").mkdir(parents=True, exist_ok=True)
        (self.root / "originals").mkdir(exist_ok=True)
        with live.courses.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS golf_media (
                id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, metadata TEXT NOT NULL,
                created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'uploading',
                offset INTEGER NOT NULL DEFAULT 0, digest TEXT, uploaded_at TEXT,
                history_sequence INTEGER, thumbnail BLOB)""")
            interrupted = [r[0] for r in db.execute("SELECT id FROM golf_media WHERE status='deleting'")]
        for capture_id in interrupted:
            try:
                self._purge_deleted(capture_id)
            except (OSError, sqlite3.Error):
                # Keep inaccessible files reserved until cleanup can be retried.
                pass

    def _row(self, db, capture_id, key=None, include_deleted=False):
        row = db.execute("SELECT id,key_hash,metadata,created_at,status,offset,digest,uploaded_at,history_sequence,thumbnail FROM golf_media WHERE id=?", (capture_id,)).fetchone()
        if not row:
            raise MediaError("Capture not found.", 404)
        if key is not None and not hmac.compare_digest(row[1], key_hash(key)):
            raise MediaError("This capture belongs to another upload.", 403)
        if not include_deleted and row[4] in ("deleting", "deleted"):
            raise MediaError("This capture has been deleted by an admin.", 410)
        return row

    def _path(self, row, final=False):
        info = json.loads(row[2])
        return self.root / ("originals" if final else "incoming") / (row[0] + ("." + TYPES[info["mime"]] if final else ".part"))

    def _public(self, row):
        info = json.loads(row[2])
        return {**info, "uploadStartedAt": row[3], "uploadedAt": row[7], "sha256": row[6],
                "historySequenceAtUpload": row[8], "url": f"/api/media/{row[0]}/file",
                "thumbnailUrl": f"/api/media/{row[0]}/thumbnail" if row[9] else None,
                "relativePath": f"originals/{row[0]}.{TYPES[info['mime']]}"}

    def _progress(self, row):
        return {"id": row[0], "status": row[4], "offset": row[5], "size": json.loads(row[2])["size"],
                "chunkSize": CHUNK_SIZE, "item": self._public(row) if row[4] == "ready" else None}

    def begin(self, payload, key):
        info = metadata(payload)
        hashed = key_hash(key)
        thumbnail = None
        if payload.get("thumbnail"):
            try:
                thumbnail = base64.b64decode(payload["thumbnail"], validate=True)
            except (ValueError, TypeError):
                raise MediaError("Invalid preview image.") from None
            if len(thumbnail) > 100 * 1024 or not matches_type("image/jpeg", thumbnail):
                raise MediaError("Preview must be a JPEG under 100 KB.")
        with self.live.courses.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM golf_media WHERE id=?", (info["id"],)).fetchone():
                row = self._row(db, info["id"], key)
                if json.loads(row[2]) != info:
                    raise MediaError("Capture details changed. Keep the original upload details.", 409)
                return self._progress(row)
            count, reserved = db.execute("SELECT COUNT(*),COALESCE(SUM(json_extract(metadata,'$.size')),0) FROM golf_media WHERE status!='deleted'").fetchone()
            pending = db.execute("SELECT COALESCE(SUM(json_extract(metadata,'$.size')-offset),0) FROM golf_media WHERE status='uploading'").fetchone()[0]
            if count >= 10000 or reserved + info["size"] > self.total_limit or shutil.disk_usage(self.root).free < pending + info["size"] + self.reserve_bytes:
                raise MediaError("The server needs more storage. Your capture will stay on this phone.", 507)
            db.execute("INSERT INTO golf_media(id,key_hash,metadata,created_at,thumbnail) VALUES (?,?,?,?,?)",
                       (info["id"], hashed, encoded(info), now(), thumbnail))
            return self._progress(self._row(db, info["id"]))

    def progress(self, capture_id, key):
        with self.live.courses.connect() as db:
            return self._progress(self._row(db, capture_id, key))

    def chunk(self, capture_id, key, offset, body):
        if not 1 <= len(body) <= CHUNK_SIZE or type(offset) is not int or offset < 0:
            raise MediaError("Invalid upload chunk.")
        with self.live.courses.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, capture_id, key)
            info = json.loads(row[2])
            if row[4] == "ready":
                return self._progress(row)
            if offset != row[5]:
                raise MediaError("Upload position changed. Resume from the saved position.", 409)
            if offset + len(body) > info["size"]:
                raise MediaError("Upload exceeds the recorded file size.", 413)
            if offset == 0 and not matches_type(info["mime"], body[:4096]):
                raise MediaError("The file contents do not match a supported photo or video.", 415)
            if shutil.disk_usage(self.root).free < len(body) + self.reserve_bytes:
                raise MediaError("Server storage is full. Keep this capture on your phone.", 507)
            path = self._path(row)
            if offset and (not path.exists() or path.stat().st_size < offset):
                raise MediaError("The server upload is incomplete. Contact the admin before removing your local copy.", 500)
            with path.open("r+b" if path.exists() else "w+b") as file:
                file.truncate(offset)  # Recover an interrupted write before the database commit.
                file.seek(offset)
                file.write(body)
                file.flush()
                os.fsync(file.fileno())
            db.execute("UPDATE golf_media SET offset=? WHERE id=?", (offset + len(body), capture_id))
            return self._progress(self._row(db, capture_id))

    def finish(self, capture_id, key):
        with self.live.courses.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, capture_id, key)
            info = json.loads(row[2])
            if row[4] == "ready":
                return self._progress(row)
            if row[5] != info["size"]:
                raise MediaError("The capture has not finished uploading.", 409)
            incoming, final = self._path(row), self._path(row, True)
            source = incoming if incoming.exists() else final  # Recover rename-before-commit after a restart.
            if not source.exists() or source.stat().st_size != info["size"]:
                raise MediaError("Stored file is incomplete.", 409)
            digest = hashlib.sha256()
            with source.open("rb") as file:
                while chunk := file.read(1024 * 1024):
                    digest.update(chunk)
            if source != final:
                os.replace(source, final)
                if os.name != "nt":
                    directory = os.open(final.parent, os.O_RDONLY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
            uploaded = now()
            db.execute("UPDATE golf_media SET status='ready',digest=?,uploaded_at=? WHERE id=?", (digest.hexdigest(), uploaded, capture_id))
            event = self.live.append(db, "media.uploaded", "visitor", None, [], self._public(self._row(db, capture_id)))
            db.execute("UPDATE golf_media SET history_sequence=? WHERE id=?", (event["seq"], capture_id))
            event["details"]["historySequenceAtUpload"] = event["seq"]
            db.execute("UPDATE golf_events SET content=? WHERE seq=?", (encoded(event), event["seq"]))
            return self._progress(self._row(db, capture_id))

    def delete(self, capture_id, session):
        with self.live.courses.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, capture_id, include_deleted=True)
            if row[4] == "uploading":
                raise MediaError("This capture has not finished uploading.", 409)
            if row[4] == "ready":
                self.live.append(db, "media.deleted", "admin", session, [],
                                 {**self._public(row), "deletedAt": now()})
                db.execute("UPDATE golf_media SET status='deleting',thumbnail=NULL WHERE id=?", (capture_id,))
        # Commit the audit record and hide the capture before removing its files.
        # The tombstone prevents delayed upload retries from recreating it.
        self._purge_deleted(capture_id)
        return {"id": capture_id, "deleted": True}

    def _purge_deleted(self, capture_id):
        with self.live.courses.connect() as db:
            row = self._row(db, capture_id, include_deleted=True)
        if row[4] != "deleting":
            return
        for path in (self._path(row, True), self._path(row)):
            path.unlink(missing_ok=True)
        with self.live.courses.connect() as db:
            db.execute("UPDATE golf_media SET status='deleted' WHERE id=? AND status='deleting'", (capture_id,))

    def listing(self):
        with self.live.courses.connect() as db:
            return [self._public(row) for row in db.execute("SELECT id,key_hash,metadata,created_at,status,offset,digest,uploaded_at,history_sequence,thumbnail IS NOT NULL FROM golf_media WHERE status='ready' ORDER BY created_at,id")]

    def asset(self, capture_id, thumbnail=False):
        with self.live.courses.connect() as db:
            row = self._row(db, capture_id)
        if row[4] != "ready":
            raise MediaError("Capture is still uploading.", 404)
        if thumbnail:
            if not row[9]:
                raise MediaError("No preview available.", 404)
            return row[9], "image/jpeg"
        path = self._path(row, True)
        if not path.is_file():
            raise MediaError("Original file is unavailable.", 404)
        return path, json.loads(row[2])["mime"]

    def manifest(self):
        return {"schema": "portugal2026.media", "schemaVersion": 1, "exportedAt": now(), "items": self.listing(),
                "notes": ["capturedAt is the phone's clock when its camera was opened; it is not a server-verified shot time.",
                          "round is zero-based; roundNumber and hole are one-based.",
                          "historySequenceAtCapture is the last history event seen by that phone (null if unavailable).",
                          "historySequenceAtUpload links to media.uploaded in history.json. Originals are stored separately; sha256 verifies each file."]}
