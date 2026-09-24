"""HTTP checks: python -m unittest test_app.py."""

from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
import unittest
import json
import tempfile

from app import GolfHandler, ROOT, ROUTES, versioned_index, configure_server
from course_store import CourseStore


class QuietHandler(GolfHandler):
    def log_message(self, *_args):
        pass


class WebsiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        configure_server(cls.server, cls.directory.name + "/courses.sqlite3")
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
            if method == "PUT":
                login = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
                login.request("POST", "/api/login", json.dumps({"username":"admin","password":"hammonja"}), {"Content-Type":"application/json"})
                response = login.getresponse()
                cookie = response.getheader("Set-Cookie").split(";", 1)[0]
                csrf = json.loads(response.read())["csrf"]
                login.close()
                headers = {**(headers or {}), "Cookie":cookie, "X-CSRF-Token":csrf}
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
                expected = (ROOT / filename).read_bytes()
                if filename == "index.html":
                    expected = versioned_index(expected)
                self.assertEqual(body, expected)

    def test_head(self):
        status, headers, body = self.request("/", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(int(headers["Content-Length"]), len(versioned_index((ROOT / "index.html").read_bytes())))
        self.assertEqual(body, b"")

    def test_html_versions_every_script_and_stylesheet(self):
        import re
        from unittest.mock import patch
        original = (ROOT / "index.html").read_bytes()
        html = versioned_index(original).decode()
        urls = re.findall(r'(?:src|href)="([^\"]+\.(?:js|css)\?[^\"]+)"', html)
        self.assertEqual(len(urls), 9)
        for url in urls:
            self.assertRegex(url, r'\?v=[a-f0-9]{16}$')
            self.assertEqual(self.request(url)[0], 200)
        # The same URL is stable until the underlying contents change.
        self.assertEqual(versioned_index(original).decode(), html)
        with patch("pathlib.Path.read_bytes", return_value=b"changed deployment"):
            self.assertNotEqual(versioned_index(original).decode(), html)

    def test_install_manifest_and_icons(self):
        import struct
        status, headers, body = self.request("/manifest.webmanifest")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/manifest+json")
        manifest = json.loads(body)
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual(manifest["scope"], "/")
        self.assertEqual(self.request(manifest["start_url"])[0], 200)
        icons = manifest["icons"] + [{"src": "/assets/apple-touch-icon.png", "sizes": "180x180"}]
        for icon in icons:
            status, headers, body = self.request(icon["src"])
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "image/png")
            self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", body[16:24]), tuple(map(int, icon["sizes"].split("x"))))

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

    def test_salgados_references_backfill_without_overwriting(self):
        from course_store import DEFAULTS
        with tempfile.TemporaryDirectory() as directory:
            store = CourseStore(directory + "/courses.sqlite3")
            course = store.list()[3]
            self.assertEqual(course["assets"]["scorecard"]["type"], "application/pdf")
            self.assertIn("Older layout", course["assets"]["map"]["note"])
            self.assertEqual([sum(t["distances"]) for t in course["tees"]], [6033,5615,5119,4684,3837,2864])
            course.update(tees=[])
            with store.connect() as db:
                db.execute("UPDATE courses SET content=? WHERE id=3", (json.dumps(course),))
            self.assertEqual(len(CourseStore(directory + "/courses.sqlite3").list()[3]["tees"]), 6)
            # Simulate a deployment created before Salgados was bundled, with a custom map/tee.
            custom_map = {"url":"/api/courses/3/assets/map","name":"My map","type":"image/png"}
            course.update(assets={"map":custom_map},source="",tees=[DEFAULTS[0]["tees"][0]],version=7)
            with store.connect() as db:
                db.execute("UPDATE courses SET content=? WHERE id=3", (json.dumps(course),))
            upgraded = CourseStore(directory + "/courses.sqlite3").list()[3]
            self.assertEqual(upgraded["assets"]["map"], custom_map)
            self.assertEqual(upgraded["tees"], course["tees"])
            self.assertIn("scorecard", upgraded["assets"])
            self.assertEqual(upgraded["version"], 8)
            self.assertEqual(CourseStore(directory + "/courses.sqlite3").list()[3]["version"], 8)

    def test_amendoeira_tees_and_existing_database_upgrade(self):
        from course_store import DEFAULTS, valid_tee
        expected = {1: ([6708, 6273, 5939, 5640, 5242, 3984, 3083], 17),
                    2: ([6598, 6296, 5858, 5334, 4703], 16)}
        for course_id, (totals, last_par3) in expected.items():
            tees = DEFAULTS[course_id]["tees"]
            self.assertEqual([sum(t["distances"]) for t in tees], totals)
            for tee in tees:
                self.assertTrue(valid_tee(tee))
                self.assertEqual(sum(tee["pars"]), 72)
                self.assertEqual(max(i+1 for i,p in enumerate(tee["pars"]) if p == 3), last_par3)
        with tempfile.TemporaryDirectory() as directory:
            path = directory + "/courses.sqlite3"
            store = CourseStore(path)
            old = dict(store.list()[1], tees=[], assets={}, source="", version=3)
            with store.connect() as db:
                db.execute("UPDATE courses SET content=? WHERE id=1", (json.dumps(old),))
            upgraded = CourseStore(path).list()[1]
            self.assertEqual(len(upgraded["tees"]), 7)
            self.assertEqual(upgraded["version"], 4)
            custom = dict(upgraded["tees"][2], name="Our Yellow", distances=[300]*18)
            updated = store.update(1, 4, tees=[custom])
            self.assertEqual(CourseStore(path).list()[1]["tees"], [custom])
            self.assertEqual(CourseStore(path).list()[1]["version"], updated["version"])


if __name__ == "__main__":
    unittest.main()
