"""HTTP checks: python -m unittest test_app.py."""

from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
import unittest
import json
import tempfile

from app import GolfHandler, ROOT, ROUTES
from course_store import CourseStore


class QuietHandler(GolfHandler):
    def log_message(self, *_args):
        pass


class WebsiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.server.course_store = CourseStore(cls.directory.name + "/courses.sqlite3")
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.directory.cleanup()

    def request(self, path, method="GET", body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
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

    def test_course_library_and_upload(self):
        courses = json.loads(self.request("/api/courses")[2])
        self.assertEqual(len(courses), 4)
        self.assertEqual([sum(t["distances"]) for t in courses[0]["tees"]], [5802, 5350, 4965, 4518])
        self.assertEqual(courses[0]["tees"][0]["pars"][16], 3)
        tee = dict(courses[0]["tees"][1], id="yellow", name="Yellow")
        version = courses[1]["version"]
        payload = json.dumps({"version": version, "tees": [tee]})
        status, _, body = self.request("/api/courses/1", "PUT", payload, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        course = json.loads(body)
        self.assertEqual(course["tees"][0]["name"], "Yellow")
        self.assertEqual(self.request("/api/courses/1", "PUT", payload)[0], 409)
        pdf = b"%PDF-1.4\nTest reference document\n%%EOF"
        headers = {"Content-Type": "application/pdf", "X-Course-Version": str(course["version"]), "X-File-Name": "test.pdf"}
        self.assertEqual(self.request("/api/courses/1/assets/map", "PUT", pdf, headers)[0], 200)
        status, headers, content = self.request("/api/courses/1/assets/map")
        self.assertEqual(status, 200)
        self.assertEqual(content, pdf)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        # Data and attachments survive reopening the database.
        reopened = CourseStore(self.directory.name + "/courses.sqlite3")
        self.assertEqual(reopened.list()[1]["tees"][0]["id"], "yellow")
        self.assertEqual(reopened.asset(1, "map")[1], pdf)

    def test_invalid_course_writes(self):
        course = json.loads(self.request("/api/courses")[2])[2]
        tee = dict(json.loads(self.request("/api/courses")[2])[0]["tees"][0])
        tee["indexes"] = [1] * 18
        payload = json.dumps({"version": course["version"], "tees": [tee]})
        self.assertEqual(self.request("/api/courses/2", "PUT", payload)[0], 400)
        headers = {"Content-Type": "image/png", "X-Course-Version": str(course["version"])}
        self.assertEqual(self.request("/api/courses/2/assets/map", "PUT", b"<script>bad</script>", headers)[0], 400)
        headers["Origin"] = "https://unrelated.example"
        self.assertEqual(self.request("/api/courses/2/assets/map", "PUT", b"bad", headers)[0], 403)
        self.assertEqual(self.request("/api/courses/9", "PUT", b"{}")[0], 404)


if __name__ == "__main__":
    unittest.main()
