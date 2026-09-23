"""HTTP checks: python -m unittest test_app.py."""

from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
import unittest

from app import GolfHandler, ROOT, ROUTES


class QuietHandler(GolfHandler):
    def log_message(self, *_args):
        pass


class WebsiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method="GET"):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_public_assets(self):
        for path, (filename, content_type) in ROUTES.items():
            with self.subTest(path=path):
                status, headers, body = self.request(path + "?version=1")
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], content_type)
                self.assertEqual(body, (ROOT / filename).read_bytes())

    def test_head(self):
        status, headers, body = self.request("/", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(int(headers["Content-Length"]), (ROOT / "index.html").stat().st_size)
        self.assertEqual(body, b"")

    def test_private_and_unknown_paths(self):
        for path in ("/app.py", "/.git/config", "/readme.md", "/scores.json", "/../app.py", "/%2e%2e/app.py", "/missing"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)


if __name__ == "__main__":
    unittest.main()
