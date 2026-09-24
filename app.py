"""Run the Portugal 2026 website with: python app.py."""

import os
import json
import re
import sqlite3
import hashlib
import hmac
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from course_store import CourseStore, ConflictError, MAX_UPLOAD
from live_store import LiveStore
from auth import Auth


ROOT = Path(__file__).resolve().parent
ROUTES = {
    "/assets/hero-course.png": ("assets/hero-course.png", "image/png"),
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/live.js": ("live.js", "text/javascript; charset=utf-8"),
    "/pwa.js": ("pwa.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/assets/apple-touch-icon.png": ("assets/apple-touch-icon.png", "image/png"),
    "/assets/app-icon-192.png": ("assets/app-icon-192.png", "image/png"),
    "/assets/app-icon-512.png": ("assets/app-icon-512.png", "image/png"),
    "/assets/app-icon-maskable-512.png": ("assets/app-icon-maskable-512.png", "image/png"),
    "/mobile.js": ("mobile.js", "text/javascript; charset=utf-8"),
    "/scoring.js": ("scoring.js", "text/javascript; charset=utf-8"),
    "/courses.js": ("courses.js", "text/javascript; charset=utf-8"),
    "/assets/ombria-course.svg": ("assets/ombria-course.svg", "image/svg+xml"),
    "/assets/ombria-scorecard.svg": ("assets/ombria-scorecard.svg", "image/svg+xml"),
    "/assets/salgados-course.gif": ("assets/salgados-course.gif", "image/gif"),
    "/assets/salgados-scorecard.pdf": ("assets/salgados-scorecard.pdf", "application/pdf"),
    "/assets/faldo-course.png": ("assets/faldo-course.png", "image/png"),
    "/assets/faldo-scorecard.pdf": ("assets/faldo-scorecard.pdf", "application/pdf"),
    "/assets/oconnor-course.png": ("assets/oconnor-course.png", "image/png"),
    "/assets/oconnor-scorecard.pdf": ("assets/oconnor-scorecard.pdf", "application/pdf"),
    "/assets/james-hammond.png": ("assets/james-hammond.png", "image/png"),
    "/assets/player-photo-2.png": ("assets/player-photo-2.png", "image/png"),
    "/assets/player-photo-3.png": ("assets/player-photo-3.png", "image/png"),
    "/assets/player-photo-4.png": ("assets/player-photo-4.png", "image/png"),
}


def versioned_index(body):
    """Keep cached JS/CSS in sync with each deployed HTML response."""
    html = body.decode("utf-8")
    def version(match):
        attribute, url = match.groups()
        filename = ROUTES[url][0]
        digest = hashlib.sha256((ROOT / filename).read_bytes()).hexdigest()[:16]
        return f'{attribute}="{url}?v={digest}"'
    html = re.sub(r'(src|href)="(/(?:app|live|pwa|courses|mobile|scoring)\.js|/style\.css)"', version, html)
    return html.encode("utf-8")


class GolfHandler(BaseHTTPRequestHandler):
    """Serve only the site's public assets, never project or backup files."""

    def do_GET(self):
        self._serve(include_body=True)

    def do_HEAD(self):
        self._serve(include_body=False)

    def _json(self, status, value, include_body=True, headers=None):
        self._respond(status, json.dumps(value).encode(), "application/json; charset=utf-8", include_body, headers)

    def _respond(self, status, body, mime, include_body=True, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if mime in ("application/pdf", "image/svg+xml"):
            self.send_header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        self.end_headers()
        if include_body:
            self.wfile.write(body)
        self.wfile.flush()
        # Drain rejected request bodies before closing (Windows otherwise may reset
        # the socket and hide a useful 401/403 response from the browser).
        if self.command in ("PUT", "POST") and not getattr(self, "body_read", False):
            try:
                remaining = int(self.headers.get("Content-Length", "0"))
                if 0 < remaining <= MAX_UPLOAD:
                    self.connection.settimeout(5)
                    while remaining:
                        chunk = self.rfile.read(min(remaining, 65536))
                        if not chunk:
                            break
                        remaining -= len(chunk)
            except (ValueError, OSError):
                pass

    def _same_origin(self):
        origin = self.headers.get("Origin")
        if ((origin and (urlsplit(origin).netloc != self.headers.get("Host") or urlsplit(origin).scheme not in ("http", "https")))
                or self.headers.get("Sec-Fetch-Site") == "cross-site"):
            self._json(403, {"error": "Use this website to make changes."})
            return False
        return True

    def _admin(self, write=False):
        session = self.server.auth.session(self.headers)
        if not session:
            self._json(401, {"error": "Log in as admin to edit."})
            return None
        if write and not hmac.compare_digest(self.headers.get("X-CSRF-Token", "").encode(), session["csrf"].encode()):
            self._json(403, {"error": "Your login needs refreshing. Reload and try again."})
            return None
        return session

    def _body(self, limit=MAX_UPLOAD):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid request length.") from None
        if not 0 < length <= limit or self.headers.get("Transfer-Encoding"):
            raise ValueError(f"Request must contain between 1 and {limit} bytes.")
        self.connection.settimeout(30)
        body = self.rfile.read(length)
        self.body_read = True
        if len(body) != length:
            raise ValueError("Incomplete request.")
        return body

    def _publish(self):
        with self.server.updates:
            self.server.updates.notify_all()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path not in ("/api/login", "/api/logout"):
            self._json(404, {"error": "Not found."})
            return
        if not self._same_origin():
            return
        try:
            if path == "/api/login":
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise ValueError("Send login as JSON.")
                payload = json.loads(self._body(4096))
                if not isinstance(payload, dict) or not all(isinstance(payload.get(k), str) for k in ("username", "password")):
                    raise ValueError("Enter a username and password.")
                token, session = self.server.auth.login(payload["username"], payload["password"], self.client_address[0])
                if not session:
                    if token != "limited":
                        self.server.live_store.audit("auth.login_failed", "anonymous")
                    self._json(429 if token == "limited" else 401, {"error": "Too many attempts. Try again in five minutes." if token == "limited" else "Incorrect username or password."})
                    return
                self.server.live_store.audit("auth.login", session=session["id"])
                self._json(200, {"admin": True, "csrf": session["csrf"]}, headers={"Set-Cookie": self.server.auth.cookie(token)})
            else:
                session = self._admin(write=True)
                if not session:
                    return
                self.server.live_store.audit("auth.logout", session=session["id"])
                self.server.auth.logout(self.headers)
                self._json(200, {"admin": False}, headers={"Set-Cookie": self.server.auth.cookie("", clear=True)})
        except (ValueError, UnicodeError) as error:
            self._json(400, {"error": str(error)})
        except (OSError, sqlite3.Error):
            self._json(500, {"error": "Could not complete login. Check server storage."})

    def do_PUT(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r"/api/courses/([0-3])(?:/assets/(map|scorecard))?", path)
        if not match and path != "/api/state":
            self._json(404, {"error": "Not found."})
            return
        if not self._same_origin():
            return
        session = self._admin(write=True)
        if not session:
            return
        try:
            body = self._body(128 * 1024 if path == "/api/state" else MAX_UPLOAD)
            if path == "/api/state":
                result = self.server.live_store.save(json.loads(body), session["id"])
                self._publish()
                self._json(200, result)
                return
            course_id, kind = int(match[1]), match[2]
            if kind:
                version = int(self.headers.get("X-Course-Version", "-1"))
                mime = self.headers.get("Content-Type", "").split(";")[0]
                name = unquote(self.headers.get("X-File-Name", kind))
                result = self.server.live_store.update_course(course_id, version, session["id"], asset=(kind, name, mime, body))
            else:
                payload = json.loads(body)
                if not isinstance(payload, dict) or not isinstance(payload.get("tees"), list):
                    raise ValueError("Missing tee data.")
                result = self.server.live_store.update_course(course_id, payload.get("version"), session["id"], tees=payload["tees"])
            self._publish()
            self._json(200, result)
        except ConflictError as error:
            self._json(409, {"error": str(error), "snapshot": self.server.live_store.snapshot()})
        except (ValueError, UnicodeError) as error:
            self._json(400, {"error": str(error)})
        except (OSError, sqlite3.Error):
            self._json(500, {"error": "Could not save. Check server storage permissions."})

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.connection.settimeout(30)
        self.close_connection = True
        last = None
        try:
            # Always send a complete snapshot on reconnect, including missed changes.
            while True:
                with self.server.updates:
                    snapshot = self.server.live_store.snapshot()
                    if snapshot["sequence"] == last:
                        self.server.updates.wait(timeout=15)
                        snapshot = self.server.live_store.snapshot()
                if snapshot["sequence"] != last:
                    last = snapshot["sequence"]
                    message = f"id: {last}\nevent: snapshot\ndata: {json.dumps(snapshot, separators=(',', ':'))}\n\n"
                else:
                    message = ": heartbeat\n\n"
                self.wfile.write(message.encode())
                self.wfile.flush()
        except (ConnectionError, OSError):
            pass

    def _serve(self, include_body):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/session":
            session = self.server.auth.session(self.headers)
            self._json(200, {"admin": bool(session), "csrf": session["csrf"] if session else None}, include_body)
            return
        if path == "/api/state":
            self._json(200, self.server.live_store.snapshot(), include_body)
            return
        if path == "/api/events":
            if include_body:
                self._events()
            else:
                self._respond(200, b"", "text/event-stream", False)
            return
        if path == "/api/history":
            if self._admin():
                self._json(200, self.server.live_store.history(), include_body,
                           {"Content-Disposition": 'attachment; filename="portugal-2026-history.json"'})
            return
        if path == "/api/courses":
            self._json(200, self.server.course_store.list(), include_body)
            return
        asset_match = re.fullmatch(r"/api/courses/([0-3])/assets/(map|scorecard)", path)
        if asset_match:
            asset = self.server.course_store.asset(int(asset_match[1]), asset_match[2])
            if asset:
                self._respond(200, asset[1], asset[0], include_body)
            else:
                self.send_error(404)
            return
        route = ROUTES.get(path)
        if route is None:
            self.send_error(404, "Not found")
            return
        filename, content_type = route
        try:
            body = (ROOT / filename).read_bytes()
            if filename == "index.html":
                body = versioned_index(body)
        except OSError:
            self.send_error(500, "Website file unavailable")
            return
        self._respond(200, body, content_type, include_body)


def configure_server(server, database):
    server.course_store = CourseStore(database)
    server.live_store = LiveStore(server.course_store)
    server.auth = Auth()
    server.updates = threading.Condition()
    return server


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "4050"))
    with ThreadingHTTPServer((host, port), GolfHandler) as server:
        configure_server(server, os.environ.get("COURSE_DB", str(ROOT / "data" / "courses.sqlite3")))
        print(f"Portugal 2026: http://localhost:{port}", flush=True)
        print("Shared scores and history are saved on the server. Viewers are read-only; admin login enables editing.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.", flush=True)


if __name__ == "__main__":
    main()
