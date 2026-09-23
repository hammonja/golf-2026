"""Run the Portugal 2026 website with: python app.py."""

import os
import json
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from course_store import CourseStore, ConflictError, MAX_UPLOAD


ROOT = Path(__file__).resolve().parent
ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/mobile.js": ("mobile.js", "text/javascript; charset=utf-8"),
    "/scoring.js": ("scoring.js", "text/javascript; charset=utf-8"),
    "/courses.js": ("courses.js", "text/javascript; charset=utf-8"),
    "/assets/ombria-course.svg": ("assets/ombria-course.svg", "image/svg+xml"),
    "/assets/ombria-scorecard.svg": ("assets/ombria-scorecard.svg", "image/svg+xml"),
}


class GolfHandler(BaseHTTPRequestHandler):
    """Serve only the site's public assets, never project or backup files."""

    def do_GET(self):
        self._serve(include_body=True)

    def do_HEAD(self):
        self._serve(include_body=False)

    def _json(self, status, value, include_body=True):
        self._respond(status, json.dumps(value).encode(), "application/json; charset=utf-8", include_body)

    def _respond(self, status, body, mime, include_body=True):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if mime in ("application/pdf", "image/svg+xml"):
            self.send_header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_PUT(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r"/api/courses/([0-3])(?:/assets/(map|scorecard))?", path)
        if not match:
            self.send_error(404)
            return
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self._json(403, {"error": "Use uploads from this website."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_UPLOAD:
                self._json(413, {"error": "Choose a file no larger than 10 MB."})
                return
            body = self.rfile.read(length)
            course_id, kind = int(match[1]), match[2]
            if kind:
                version = int(self.headers.get("X-Course-Version", "-1"))
                mime = self.headers.get("Content-Type", "").split(";")[0]
                name = unquote(self.headers.get("X-File-Name", kind))
                result = self.server.course_store.update(course_id, version, asset=(kind, name, mime, body))
            else:
                payload = json.loads(body)
                if not isinstance(payload, dict) or not isinstance(payload.get("tees"), list):
                    raise ValueError("Missing tee data.")
                result = self.server.course_store.update(course_id, payload.get("version"), tees=payload["tees"])
            self._json(200, result)
        except ConflictError as error:
            self._json(409, {"error": str(error)})
        except (ValueError, UnicodeError) as error:
            self._json(400, {"error": str(error)})
        except (OSError, sqlite3.Error):
            self._json(500, {"error": "Could not save the course file. Check server storage permissions."})

    def _serve(self, include_body):
        path = unquote(urlsplit(self.path).path)
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
        except OSError:
            self.send_error(500, "Website file unavailable")
            return
        self._respond(200, body, content_type, include_body)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "4050"))
    with ThreadingHTTPServer((host, port), GolfHandler) as server:
        server.course_store = CourseStore(os.environ.get("COURSE_DB", str(ROOT / "data" / "courses.sqlite3")))
        print(f"Portugal 2026: http://localhost:{port}", flush=True)
        print("Press Ctrl+C to stop. Scores are saved in each browser.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.", flush=True)


if __name__ == "__main__":
    main()
