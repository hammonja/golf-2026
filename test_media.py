"""Public media endpoints, durable resume, permissions, originals and metadata."""
import copy
import base64
import hashlib
import json
import tempfile
import threading
import unittest
import uuid
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from app import GolfHandler, configure_server
from media_store import MediaStore, PHOTO_LIMIT, matches_type


class QuietHandler(GolfHandler):
    def log_message(self, *_args):
        pass


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = configure_server(ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler), Path(self.directory.name) / 'golf.sqlite3')
        self.server.media.reserve_bytes = 0
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.key = 'a' * 64
        self.body = b'\xff\xd8\xff' + b'captured-photo-data' * 30
        self.info = {'id': uuid.uuid4().hex, 'round': 2, 'hole': 16, 'mime': 'image/jpeg', 'size': len(self.body),
                     'capturedAt': '2026-09-24T10:31:20.000Z', 'timezoneOffsetMinutes': -60,
                     'historySequenceAtCapture': 1, 'stateVersionAtCapture': 0, 'originalName': 'IMG_0001.jpg'}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, method='GET', body=None, headers=None, key=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        request_headers = {'X-Media-Key': self.key if key is None else key, **(headers or {})}
        if isinstance(body, dict):
            body = json.dumps(body)
            request_headers['Content-Type'] = 'application/json'
        connection.request(method, path, body, request_headers)
        response = connection.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        connection.close()
        return result

    def begin(self, info=None):
        return self.request('/api/media/uploads', 'POST', self.info if info is None else info)

    def upload(self, offset=0, body=None):
        return self.request('/api/media/uploads/' + self.info['id'], 'PUT', self.body if body is None else body,
                            {'Content-Type': 'application/octet-stream', 'X-Upload-Offset': str(offset)})

    def finish(self):
        return self.request('/api/media/uploads/' + self.info['id'] + '/complete', 'POST')

    def test_anonymous_upload_audited_without_changing_scores(self):
        before = self.server.live_store.snapshot()
        self.assertEqual(self.begin()[0], 200)
        self.assertEqual(self.upload()[0], 200)
        code, _, body = self.finish()
        self.assertEqual(code, 200)
        item = json.loads(body)['item']
        self.assertEqual(item['course'], 'Faldo')
        self.assertEqual(item['hole'], 16)
        self.assertEqual(item['sha256'], hashlib.sha256(self.body).hexdigest())
        self.assertNotIn('player', item)
        after = self.server.live_store.snapshot()
        self.assertEqual(before['version'], after['version'])
        self.assertEqual(before['state'], after['state'])
        event = self.server.live_store.history()['events'][-1]
        self.assertEqual(event['type'], 'media.uploaded')
        self.assertEqual(event['actor'], 'visitor')
        self.assertEqual(event['details']['historySequenceAtUpload'], event['seq'])
        self.assertNotIn(self.key, json.dumps(event))
        self.assertEqual(self.request(item['url'])[2], self.body)
        self.assertEqual(len(json.loads(self.request('/api/media')[2])['items']), 1)
        manifest = json.loads(self.request('/api/media/manifest.json')[2])
        self.assertEqual(manifest['items'][0]['capturedAt'], self.info['capturedAt'])

    def test_resume_after_restart_and_lost_responses_is_idempotent(self):
        self.begin()
        self.assertEqual(self.upload(body=self.body[:100])[0], 200)
        self.server.media = MediaStore(self.server.live_store, self.server.media.root, reserve_bytes=0)
        progress = json.loads(self.begin()[2])
        self.assertEqual(progress['offset'], 100)
        self.assertEqual(self.upload(body=self.body[:100])[0], 409)
        self.assertEqual(self.upload(100, self.body[100:])[0], 200)
        self.assertEqual(self.finish()[0], 200)
        self.assertEqual(self.finish()[0], 200)
        self.assertEqual(json.loads(self.begin()[2])['status'], 'ready')
        self.assertEqual(len(self.server.media.listing()), 1)
        events = [e for e in self.server.live_store.history()['events'] if e['type'] == 'media.uploaded']
        self.assertEqual(len(events), 1)

    def test_keys_origin_and_admin_boundaries(self):
        self.begin()
        for method, path, body in [('GET', '/api/media/uploads/' + self.info['id'], None),
                                   ('POST', '/api/media/uploads', self.info),
                                   ('POST', '/api/media/uploads/' + self.info['id'] + '/complete', None)]:
            self.assertEqual(self.request(path, method, body, key='b' * 64)[0], 403)
        self.assertEqual(self.request('/api/media/uploads', 'POST', self.info, {'Origin': 'https://another.example'})[0], 403)
        self.assertEqual(self.request('/api/state', 'PUT', {}, key='')[0], 401)
        self.assertEqual(self.request('/api/media/uploads', 'POST', self.info, key='')[0], 403)
        self.assertEqual(self.request('/media_store.py')[0], 404)
        self.assertEqual(self.request('/data/media/incoming/' + self.info['id'] + '.part')[0], 404)

    def test_validation_and_incomplete_files_stay_private(self):
        for key, value in [('round', 4), ('hole', 0), ('size', PHOTO_LIMIT + 1), ('capturedAt', 'yesterday'),
                           ('mime', 'image/svg+xml'), ('mime', []), ('id', '../unsafe'), ('round', True)]:
            bad = {**self.info, key: value}
            self.assertIn(self.begin(bad)[0], (400, 413))
        self.begin()
        self.assertEqual(self.upload(body=b'<script>bad</script>')[0], 415)
        self.assertEqual(self.finish()[0], 409)
        self.assertEqual(self.request('/api/media/' + self.info['id'] + '/file')[0], 404)
        self.assertEqual(json.loads(self.request('/api/media')[2])['items'], [])
        self.assertEqual(self.begin({**self.info, 'hole': 17})[0], 409)

    def test_range_streaming_and_head_for_video_players(self):
        self.body = b'\x00\x00\x00\x18ftypisom' + b'\x00' * 4 + b'isommp42' + b'video-test-payload' * 40
        self.info.update(mime='video/mp4', size=len(self.body), originalName='capture.mp4')
        self.begin(); self.upload(); self.finish()
        url = '/api/media/' + self.info['id'] + '/file'
        status, headers, body = self.request(url, headers={'Range': 'bytes=5-19'})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.body[5:20])
        self.assertEqual(headers['Content-Range'], f'bytes 5-19/{len(self.body)}')
        self.assertEqual(headers['Content-Type'], 'video/mp4')
        self.assertEqual(self.request(url, headers={'Range': 'bytes=-7'})[2], self.body[-7:])
        self.assertEqual(self.request(url, headers={'Range': 'bytes=999999-'})[0], 416)
        status, headers, body = self.request(url, 'HEAD')
        self.assertEqual((status, body), (200, b''))
        self.assertEqual(int(headers['Content-Length']), len(self.body))
        self.assertIn('attachment', self.request(url+'?download=1')[1]['Content-Disposition'])

    def test_storage_limit_reserves_pending_files(self):
        self.server.media.total_limit = len(self.body)
        self.assertEqual(self.begin()[0], 200)
        self.assertEqual(self.begin({**self.info, 'id': uuid.uuid4().hex})[0], 507)
        self.assertEqual(self.begin()[0], 200)

    def test_crash_recovery_discards_uncommitted_tail_and_finishes_rename(self):
        self.begin(); self.upload(body=self.body[:100])
        path = self.server.media.root / 'incoming' / (self.info['id']+'.part')
        with path.open('ab') as file:
            file.write(b'uncommitted')
        self.assertEqual(self.upload(100, self.body[100:])[0], 200)
        final = self.server.media.root / 'originals' / (self.info['id']+'.jpg')
        path.replace(final)
        self.assertEqual(self.finish()[0], 200)
        self.assertEqual(final.read_bytes(), self.body)

    def test_supported_camera_containers(self):
        for mime, brand in [('video/mp4', b'isom'), ('video/quicktime', b'qt  '), ('image/heic', b'heic')]:
            head = b'\x00\x00\x00\x18ftyp' + brand + b'\x00' * 4 + brand + b'\x00' * 4
            self.assertTrue(matches_type(mime, head))
        self.assertFalse(matches_type('video/mp4', b'<html>not a video</html>'))
        self.assertTrue(matches_type('video/webm', b'\x1a\x45\xdf\xa3webm'))

    def admin_headers(self):
        status, headers, body = self.request('/api/login', 'POST', {'username': 'admin', 'password': 'hammonja'})
        self.assertEqual(status, 200)
        return {'Cookie': headers['Set-Cookie'].split(';', 1)[0], 'X-CSRF-Token': json.loads(body)['csrf']}

    def test_delete_requires_admin_csrf_and_same_origin(self):
        self.begin(); self.upload(); self.finish()
        url = '/api/media/' + self.info['id']
        self.assertEqual(self.request(url, 'DELETE')[0], 401)
        headers = self.admin_headers()
        self.assertEqual(self.request(url, 'DELETE', headers={'Cookie': headers['Cookie']})[0], 403)
        self.assertEqual(self.request(url, 'DELETE', headers={**headers, 'X-CSRF-Token': 'wrong'})[0], 403)
        self.assertEqual(self.request(url, 'DELETE', headers={**headers, 'Origin': 'https://elsewhere.example'})[0], 403)
        for session in self.server.auth.sessions.values():
            session['expires'] = 0
        self.assertEqual(self.request(url, 'DELETE', headers=headers)[0], 401)
        self.assertEqual(len(self.server.media.listing()), 1)
        self.assertFalse(any(e['type'] == 'media.deleted' for e in self.server.live_store.history()['events']))

    def test_admin_deletion_purges_files_audits_once_and_blocks_reupload(self):
        self.info['thumbnail'] = base64.b64encode(self.body).decode()
        self.begin(); self.upload(); self.finish()
        url = '/api/media/' + self.info['id']
        self.assertEqual(self.request(url+'/thumbnail')[1]['Cache-Control'], 'no-store')
        self.assertEqual(self.request(url+'/file')[1]['Cache-Control'], 'no-store')
        headers = self.admin_headers()
        before = self.server.live_store.snapshot()
        self.server.media.total_limit = len(self.body)
        for _ in range(2):
            status, _, body = self.request(url, 'DELETE', headers=headers)
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)['deleted'])
        after = self.server.live_store.snapshot()
        self.assertEqual(after['state'], before['state'])
        self.assertEqual(after['version'], before['version'])
        self.assertEqual(after['sequence'], before['sequence'] + 1)
        self.assertEqual(self.server.media.listing(), [])
        self.assertEqual(self.server.media.manifest()['items'], [])
        self.assertEqual(list((self.server.media.root / 'originals').iterdir()), [])
        self.assertEqual(self.request(url+'/file')[0], 410)
        self.assertEqual(self.request(url+'/thumbnail')[0], 410)
        events = [e for e in self.server.live_store.history()['events'] if e['type'] == 'media.deleted']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['actor'], 'admin')
        self.assertTrue(events[0]['session'])
        self.assertEqual(events[0]['details']['id'], self.info['id'])
        self.assertEqual(events[0]['details']['sha256'], hashlib.sha256(self.body).hexdigest())
        self.assertEqual(events[0]['changes'], [])
        self.assertEqual(self.begin()[0], 410)
        self.assertEqual(self.upload()[0], 410)
        self.assertEqual(self.finish()[0], 410)
        self.assertEqual(self.begin({**self.info, 'id': uuid.uuid4().hex})[0], 200, 'Deletion releases file capacity')

    def test_delete_rollback_and_interrupted_cleanup(self):
        self.begin(); self.upload(); self.finish()
        headers = self.admin_headers()
        url = '/api/media/' + self.info['id']
        with patch.object(self.server.live_store, 'append', side_effect=OSError('audit unavailable')):
            self.assertEqual(self.request(url, 'DELETE', headers=headers)[0], 503)
        self.assertEqual(self.request(url+'/file')[2], self.body, 'Failed audit must preserve the original')
        with patch.object(self.server.media, '_purge_deleted', side_effect=OSError('interrupted cleanup')):
            self.assertEqual(self.request(url, 'DELETE', headers=headers)[0], 503)
        self.assertEqual(self.server.media.listing(), [])
        self.assertEqual(self.request(url+'/file')[0], 410)
        self.server.media = MediaStore(self.server.live_store, self.server.media.root, reserve_bytes=0)
        self.assertEqual(list((self.server.media.root / 'originals').iterdir()), [])
        self.assertEqual(self.request(url, 'DELETE', headers=headers)[0], 200)
        events = [e for e in self.server.live_store.history()['events'] if e['type'] == 'media.deleted']
        self.assertEqual(len(events), 1)


if __name__ == '__main__':
    unittest.main()
