"""Run the Portugal 2026 website with: python app.py."""

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/mobile.js": ("mobile.js", "text/javascript; charset=utf-8"),
    "/scoring.js": ("scoring.js", "text/javascript; charset=utf-8"),
}


class GolfHandler(BaseHTTPRequestHandler):
    """Serve only the site's public assets, never project or backup files."""

    def do_GET(self):
        self._serve(include_body=True)

    def do_HEAD(self):
        self._serve(include_body=False)

    def _serve(self, include_body):
        route = ROUTES.get(unquote(urlsplit(self.path).path))
        if route is None:
            self.send_error(404, "Not found")
            return
        filename, content_type = route
        try:
            body = (ROOT / filename).read_bytes()
        except OSError:
            self.send_error(500, "Website file unavailable")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if include_body:
            self.wfile.write(body)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "3000"))
    with ThreadingHTTPServer((host, port), GolfHandler) as server:
        print(f"Portugal 2026: http://localhost:{port}", flush=True)
        print("Press Ctrl+C to stop. Scores are saved in each browser.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.", flush=True)


if __name__ == "__main__":
    main()
