"""Authentication, shared state, push, concurrency, persistence and audit tests."""
import copy
import json
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from app import GolfHandler, configure_server
from course_store import CourseStore
from live_store import LiveStore


class QuietHandler(GolfHandler):
    def log_message(self, *_args):
        pass


class SharedGolfTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = self.directory.name + '/golf.sqlite3'
        self.server = configure_server(ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler), self.path)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.credentials = self.login()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, method='GET', payload=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            body = json.dumps(payload) if payload is not None and not isinstance(payload, bytes) else payload
            connection.request(method, path, body, {'Content-Type': 'application/json', **(headers or {})})
            response = connection.getresponse()
            status, response_headers, body = response.status, dict(response.getheaders()), response.read()
            return status, response_headers, json.loads(body) if 'application/json' in response_headers.get('Content-Type', '') else body
        finally:
            connection.close()

    def login(self):
        status, headers, result = self.request('/api/login', 'POST', {'username':'admin','password':'hammonja'})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        return {'Cookie': headers['Set-Cookie'].split(';', 1)[0], 'X-CSRF-Token':result['csrf']}

    def payload(self, snapshot=None):
        snapshot = snapshot or self.request('/api/state')[2]
        return {'state':copy.deepcopy(snapshot['state']), 'version':snapshot['version'], 'requestId':uuid.uuid4().hex}

    def test_viewers_cannot_mutate_any_api_or_read_history(self):
        for path, body in [('/api/state', self.payload()), ('/api/courses/0', {'version':1,'tees':[]}), ('/api/courses/0/assets/map', b'%PDF-test')]:
            self.assertEqual(self.request(path, 'PUT', body)[0], 401)
            self.assertEqual(self.request(path, 'PUT', body, {'Cookie':self.credentials['Cookie']})[0], 403)
            self.assertEqual(self.request(path, 'PUT', body, {**self.credentials, 'Origin':'https://elsewhere.example'})[0], 403)
        self.assertEqual(self.request('/api/history')[0], 401)
        status, headers, state = self.request('/api/state')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertNotIn('csrf', state)
        self.assertFalse(self.request('/api/session')[2]['admin'])

    def test_login_failure_logout_expiry_and_rate_limit(self):
        self.assertEqual(self.request('/api/login', 'POST', {'username':'admin','password':'wrong'})[0], 401)
        self.assertEqual(self.request('/api/login', 'POST', {'username':'admin','password':'hammonja'}, {'Origin':'https://elsewhere.example'})[0], 403)
        self.assertTrue(self.request('/api/session', headers=self.credentials)[2]['admin'])
        self.assertEqual(self.request('/api/logout', 'POST', headers=self.credentials)[0], 200)
        self.assertEqual(self.request('/api/state', 'PUT', self.payload(), self.credentials)[0], 401)
        self.credentials = self.login()
        for session in self.server.auth.sessions.values():
            session['expires'] = 0
        self.assertFalse(self.request('/api/session', headers=self.credentials)[2]['admin'])
        for _ in range(10):
            self.assertEqual(self.request('/api/login', 'POST', {'username':'admin','password':'wrong'})[0], 401)
        self.assertEqual(self.request('/api/login', 'POST', {'username':'admin','password':'wrong'})[0], 429)

    def test_state_conflicts_idempotency_and_restart(self):
        payload = self.payload()
        payload['state']['handicaps'][0] = 18
        payload['state']['rounds'][0]['scores'][0][0] = 3
        status, _, saved = self.request('/api/state', 'PUT', payload, self.credentials)
        self.assertEqual(status, 200)
        self.assertEqual(saved['version'], 1)
        self.assertEqual(self.request('/api/state')[2]['state'], payload['state'])
        self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[2]['version'], 1)
        stale = copy.deepcopy(payload)
        stale['requestId'] = uuid.uuid4().hex
        stale['state']['handicaps'][1] = 9
        self.assertEqual(self.request('/api/state', 'PUT', stale, self.credentials)[0], 409)
        stale['requestId'] = payload['requestId']
        self.assertEqual(self.request('/api/state', 'PUT', stale, self.credentials)[0], 400)
        self.assertEqual(LiveStore(CourseStore(self.path)).snapshot()['state'], saved['state'])
        history = self.request('/api/history', headers=self.credentials)[2]
        edits = [e for e in history['events'] if e['type'] == 'scores.updated']
        self.assertEqual(len(edits), 1)
        self.assertEqual(edits[0]['actor'], 'admin')
        self.assertEqual(len(edits[0]['changes']), 2)
        self.assertNotIn('hammonja', json.dumps(history))
        self.assertNotIn(self.credentials['Cookie'].split('=')[1], json.dumps(history))
        # A lost response retried after someone else's edit must not rebase queued drafts.
        newer = self.payload()
        newer['state']['handicaps'][2] = 12
        self.assertEqual(self.request('/api/state', 'PUT', newer, self.credentials)[0], 200)
        self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[0], 409)

    def test_concurrent_writes_only_one_wins(self):
        payloads = [self.payload(), self.payload()]
        for i, payload in enumerate(payloads):
            payload['state']['handicaps'][i] = 10 + i
        with ThreadPoolExecutor(2) as pool:
            statuses = list(pool.map(lambda p: self.request('/api/state', 'PUT', p, self.credentials)[0], payloads))
        self.assertEqual(sorted(statuses), [200, 409])

    def test_validation_and_atomic_audit(self):
        for bad in (True, 0, 31, 3.5, '4'):
            payload = self.payload()
            payload['state']['rounds'][0]['scores'][0][0] = bad
            self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[0], 400)
        for bad in (None, [], {}, {'state':{'handicaps':[0]*4, 'rounds':[None]*4}}):
            self.assertEqual(self.request('/api/state', 'PUT', bad or [], self.credentials)[0], 400)
        payload = self.payload()
        payload['state']['handicaps'][0] = 20
        import sqlite3
        with patch.object(self.server.live_store, 'append', side_effect=sqlite3.OperationalError('disk full')):
            self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[0], 500)
        self.assertEqual(self.request('/api/state')[2]['version'], 0)
        self.assertEqual(self.request('/api/state')[2]['state']['handicaps'][0], 0)

    def test_course_upload_and_import_are_replayable(self):
        before = self.request('/api/state')[2]
        course = before['courses'][0]
        tees = copy.deepcopy(course['tees'])
        tees[0]['name'] = 'Test tee'
        self.assertEqual(self.request('/api/courses/0', 'PUT', {'version':course['version'],'tees':tees}, self.credentials)[0], 200)
        pdf = b'%PDF-1.4\nRound reference\n%%EOF'
        headers = {**self.credentials, 'Content-Type':'application/pdf','X-Course-Version':str(course['version'] + 1),'X-File-Name':'round.pdf'}
        self.assertEqual(self.request('/api/courses/0/assets/map', 'PUT', pdf, headers)[0], 200)
        payload = self.payload()
        payload['action'] = 'browser.imported'
        payload['state']['rounds'][0]['scores'][0][0] = 3
        self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[0], 200)
        history = self.request('/api/history', headers=self.credentials)[2]
        model = copy.deepcopy(history['events'][0]['details']['checkpoint'])
        for event in history['events'][1:]:
            for change in event['changes']:
                target = model
                for key in change['path'][:-1]:
                    target = target[key]
                key = change['path'][-1]
                if change['existed']:
                    self.assertEqual(target[key], change['before'])
                if change['exists']:
                    target[key] = change['after']
                else:
                    del target[key]
        latest = self.request('/api/state')[2]
        self.assertEqual(model['state'], latest['state'])
        self.assertEqual(model['courses'], latest['courses'])
        import base64
        self.assertEqual(base64.b64decode(model['assets']['0/map']['base64']), pdf)
        self.assertTrue(model['bundledFiles'])
        self.assertEqual(history['events'][-1]['type'], 'browser.imported')

    def test_converted_yard_distances_save_and_survive_restart(self):
        course = self.request('/api/state')[2]['courses'][0]
        tee = copy.deepcopy(course['tees'][0])
        tee.update(unit='yd', distances=[457, 1094] + [100] * 16)
        status, _, saved_course = self.request('/api/courses/0', 'PUT', {'version':course['version'],'tees':[tee]}, self.credentials)
        self.assertEqual(status, 200)
        payload = self.payload()
        payload['state']['rounds'][0]['tee'] = {key:tee[key] for key in ('id','name','unit','distances')}
        self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[0], 200)
        reopened = LiveStore(CourseStore(self.path)).snapshot()
        self.assertEqual(reopened['courses'][0]['tees'][0], tee)
        self.assertEqual(reopened['state']['rounds'][0]['tee']['distances'][:2], [457,1094])
        for unit, distance in [('yd',1095),('m',1001)]:
            invalid = copy.deepcopy(tee)
            invalid.update(unit=unit, distances=[distance]*18)
            self.assertEqual(self.request('/api/courses/0', 'PUT', {'version':saved_course['version'],'tees':[invalid]}, self.credentials)[0], 400)
            payload = self.payload()
            payload['state']['rounds'][0]['tee'] = {key:invalid[key] for key in ('id','name','unit','distances')}
            self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[0], 400)

    def test_push_to_multiple_viewers_and_reconnect(self):
        viewers = []
        def next_snapshot(response):
            while True:
                line = response.readline()
                self.assertTrue(line, 'Stream closed unexpectedly')
                if line.startswith(b'data: '):
                    return json.loads(line[6:])
        try:
            for _ in range(2):
                connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
                connection.request('GET', '/api/events')
                response = connection.getresponse()
                self.assertEqual(response.getheader('Content-Type'), 'text/event-stream')
                viewers.append((connection, response))
                self.assertEqual(next_snapshot(response)['version'], 0)
            payload = self.payload()
            payload['state']['rounds'][2]['scores'][0][1] = 3
            self.assertEqual(self.request('/api/state', 'PUT', payload, self.credentials)[0], 200)
            for _, response in viewers:
                self.assertEqual(next_snapshot(response)['state'], payload['state'])
            reconnect = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
            reconnect.request('GET', '/api/events', headers={'Last-Event-ID':'1'})
            response = reconnect.getresponse()
            viewers.append((reconnect, response))
            self.assertEqual(next_snapshot(response)['state'], payload['state'])
        finally:
            for connection, response in viewers:
                response.close()
                connection.close()


if __name__ == '__main__':
    unittest.main()
