import copy
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import HTTPServer
from server import Handler, initial, validate_curriculum

class HubTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.course = validate_curriculum(json.loads(Path('curriculum.json').read_text()))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.server.data_dir = Path(self.temp.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port)
        h = {'Content-Type':'application/json'}
        h.update(headers or {})
        connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data

    def test_curriculum_has_26_weeks_and_286_hours(self):
        self.assertEqual(len(self.course['modules']), 13)
        self.assertEqual(sum(m['hours'] for m in self.course['modules']), 286)
        self.assertEqual(self.course['modules'][-1]['weekEnd'], 26)

    def test_save_reload_and_backup(self):
        state = initial(self.course)
        state['modules']['m01'] = dict(status='active', tasks=[True,False,False,False], notes='A useful observation', evidence='', hours=1.5)
        status, saved = self.request('PUT','/api/state',state)
        self.assertEqual(status,200)
        self.assertEqual(saved['revision'],1)
        saved['modules']['m01']['notes']='A second observation'
        self.assertEqual(self.request('PUT','/api/state',saved)[0],200)
        current=self.request('GET','/api/state')[1]
        self.assertEqual(current['modules']['m01']['notes'],'A second observation')
        record_id = self.request('GET', '/api/record?plan=soccer-ml')[1]['recordId']
        backup=json.loads((self.server.data_dir/'records'/record_id/'record.backup.json').read_text())['state']
        self.assertEqual(backup['modules']['m01']['notes'],'A useful observation')

    def test_reject_stale_tab(self):
        state=initial(self.course)
        self.assertEqual(self.request('PUT','/api/state',state)[0],200)
        self.assertEqual(self.request('PUT','/api/state',state)[0],409)

    def test_completion_requires_evidence(self):
        state=initial(self.course)
        state['modules']['m01']=dict(status='complete', tasks=[True]*4, notes='', evidence='',hours=1)
        self.assertEqual(self.request('PUT','/api/state',state)[0],400)
        state['modules']['m01']['evidence']='Local notebook and independent explanation'
        self.assertEqual(self.request('PUT','/api/state',state)[0],200)

    def test_import_and_separate_progress(self):
        second=copy.deepcopy(self.course);second['id']='second-course';second['title']='Another topic'
        self.assertEqual(self.request('PUT','/api/curricula',second)[0],201)
        state=initial(second);state['weeklyHours']=5
        self.assertEqual(self.request('PUT','/api/state?plan=second-course',state)[0],200)
        self.assertEqual(self.request('GET','/api/state')[1]['weeklyHours'],11)
        self.assertEqual(self.request('GET','/api/state?plan=second-course')[1]['weeklyHours'],5)
        self.assertEqual(len(self.request('GET','/api/curricula')[1]),2)
        self.assertEqual(self.request('PUT','/api/curricula',second)[0],409)

    def test_invalid_backup_is_not_saved(self):
        state=initial(self.course);state['curriculumId']='wrong-course'
        self.assertEqual(self.request('PUT','/api/state',state)[0],400)
        self.assertFalse((self.server.data_dir/'soccer-ml/state.json').exists())

    def test_damaged_file_is_preserved(self):
        path=self.server.data_dir/'soccer-ml/state.json';path.parent.mkdir();path.write_text('{damaged')
        self.assertEqual(self.request('GET','/api/state')[0],500)
        self.assertEqual(self.request('PUT','/api/state',initial(self.course))[0],500)
        self.assertEqual(path.read_text(),'{damaged')

    def test_reject_foreign_origin_and_path_traversal(self):
        self.assertEqual(self.request('PUT','/api/state',initial(self.course),{'Origin':'https://unrelated.example'})[0],403)
        c=copy.deepcopy(self.course);c['id']='../unsafe'
        self.assertEqual(self.request('PUT','/api/curricula',c)[0],400)
        self.assertEqual(self.request('GET','/server.py')[0],404)

    def test_reject_unsafe_resource_url(self):
        c=copy.deepcopy(self.course);c['id']='unsafe';c['resources']['data']['url']='javascript:alert(1)'
        self.assertEqual(self.request('PUT','/api/curricula',c)[0],400)

    def test_reject_invalid_numbers(self):
        state=initial(self.course);state['weeklyHours']=float('nan')
        self.assertEqual(self.request('PUT','/api/state',state)[0],400)


FIXTURES = Path('tests/fixtures/contracts/valid')


def lesson_text(name):
    return (FIXTURES / name).read_text()


def tree_of(directory):
    directory = Path(directory)
    return {str(p.relative_to(directory)): (hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'dir')
            for p in sorted(directory.rglob('*'))}


class LessonRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.server.data_dir = Path(self.temp.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, method, path, body=None, headers=None, raw=None, port=None):
        connection = HTTPConnection('127.0.0.1', port or self.server.server_port)
        h = {'Content-Type': 'application/json'}
        h.update(headers or {})
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        connection.request(method, path, body=data, headers=h)
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        return response.status, payload

    def post(self, path, body, **kw):
        return self.call('POST', path, body, **kw)

    def declared(self, path, length):
        """A POST that declares a body length and sends no body, as the server decides before it reads."""
        connection = HTTPConnection('127.0.0.1', self.server.server_port)
        connection.putrequest('POST', path)
        connection.putheader('Content-Type', 'application/json')
        connection.putheader('Content-Length', str(length))
        connection.endheaders()
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        return response.status, payload

    def importing(self, name, **kw):
        return self.post('/api/lessons/import', {'source': lesson_text(name), 'filename': name}, **kw)

    def newer(self):
        document = json.loads(lesson_text('lesson-module-minimal.json'))
        document['version'] = '1.1.0'
        return document

    def test_a_server_with_no_lessons_folder_behaves_as_before(self):
        self.assertEqual(self.call('GET', '/api/lessons'), (200, {'revision': 0, 'modules': []}))
        self.assertEqual(self.call('GET', '/api/state')[0], 200)
        self.assertEqual(self.call('POST', '/api/lessons/import/preview', {'source': lesson_text('lesson-module-minimal.json')})[0], 200)
        self.assertEqual(self.call('GET', '/api/lessons/export')[0], 200)
        self.assertFalse((self.server.data_dir / '_lessons').exists())

    def test_the_older_routes_and_their_cap_are_unchanged(self):
        self.assertEqual(self.call('GET', '/api/lessons/unknown')[0], 404)
        self.assertEqual(self.call('PUT', '/api/lessons', {})[0], 404)
        self.assertEqual(self.call('POST', '/api/lessons', {})[0], 404)
        status, body = self.declared('/api/import/preview', 2_000_001)
        self.assertEqual((status, body['code'], body['error']), (413, 'payload_too_large', 'Backup must be smaller than 2 MB.'))

    def test_preview_writes_nothing(self):
        self.call('GET', '/api/state')
        before = tree_of(self.server.data_dir)
        status, preview = self.post('/api/lessons/import/preview', {'source': lesson_text('lesson-module-minimal.json'), 'filename': 'a.json'})
        self.assertEqual(status, 200)
        self.assertTrue(preview['importable'])
        self.assertEqual(preview['kind'], 'module')
        self.assertEqual([(m['id'], m['version'], m['state']) for m in preview['modules']], [('hello-module', '1.0.0', 'new')])
        self.assertEqual(preview['modules'][0]['taskCount'], 1)
        self.assertEqual(tree_of(self.server.data_dir), before)
        self.assertFalse((self.server.data_dir / '_lessons').exists())

    def test_import_list_and_exact_text(self):
        text = lesson_text('lesson-module-minimal.json')
        status, result = self.importing('lesson-module-minimal.json')
        self.assertEqual(status, 200)
        self.assertEqual(result['imported'][0]['id'], 'hello-module')
        stored = self.server.data_dir / '_lessons' / 'modules' / 'hello-module' / '1.0.0' / 'module.json'
        self.assertEqual(stored.read_text(), text)
        status, listing = self.call('GET', '/api/lessons')
        self.assertEqual(listing['modules'][0]['pinnedVersion'], '1.0.0')
        self.assertIsNone(listing['modules'][0]['newerVersionAvailable'])
        before = tree_of(self.server.data_dir)
        self.assertEqual(self.importing('lesson-module-minimal.json')[0], 200)
        self.assertEqual(tree_of(self.server.data_dir), before)

    def test_a_parsed_object_is_accepted_too(self):
        status, _ = self.post('/api/lessons/import', {'source': json.loads(lesson_text('lesson-module-minimal.json')), 'filename': 'a.json'})
        self.assertEqual(status, 200)
        self.assertEqual(self.call('GET', '/api/lessons')[1]['modules'][0]['id'], 'hello-module')

    def test_a_packet_and_its_module_import_together(self):
        status, result = self.post('/api/lessons/import', {'source': [lesson_text('packet-one-module.json'), lesson_text('lesson-module-minimal.json')], 'filename': 'bundle.json'})
        self.assertEqual(status, 200, result)
        self.assertEqual(sorted(i['kind'] for i in result['imported']), ['module', 'packet'])
        status, preview = self.post('/api/lessons/import/preview', {'source': lesson_text('packet-one-module.json')})
        self.assertEqual(status, 200)
        self.assertTrue(preview['importable'])
        self.assertEqual(preview['kind'], 'packet')

    def test_a_missing_packet_module_is_invalid_and_changes_nothing(self):
        status, body = self.post('/api/lessons/import', {'source': lesson_text('packet-one-module.json')})
        self.assertEqual((status, body['code']), (422, 'missing_module'))
        self.assertFalse((self.server.data_dir / '_lessons').exists())

    def test_error_statuses(self):
        invalid = json.loads(lesson_text('lesson-module-minimal.json'))
        invalid['extra'] = 1
        status, body = self.post('/api/lessons/import', {'source': invalid})
        self.assertEqual((status, body['code']), (422, 'invalid_lesson'))
        invalid = json.loads(lesson_text('lesson-module-minimal.json'))
        invalid['schemaVersion'] = '2.0'
        self.assertEqual(self.post('/api/lessons/import', {'source': invalid})[0], 409)
        self.assertEqual(self.post('/api/lessons/import', {'source': 5})[0], 400)
        self.assertEqual(self.post('/api/lessons/import', {'source': '{"a":', 'extra': 1})[0], 400)
        self.assertEqual(self.post('/api/lessons/import', {'source': '{"a":'})[0], 422)
        self.assertEqual(self.post('/api/lessons/import', {'source': [], 'filename': 3})[0], 400)
        self.assertFalse((self.server.data_dir / '_lessons').exists())

    def test_same_version_with_other_content_is_a_conflict(self):
        self.importing('lesson-module-minimal.json')
        before = tree_of(self.server.data_dir)
        changed = json.loads(lesson_text('lesson-module-minimal.json'))
        changed['title'] = 'Changed'
        status, body = self.post('/api/lessons/import', {'source': changed})
        self.assertEqual((status, body['code']), (409, 'version_conflict'))
        status, preview = self.post('/api/lessons/import/preview', {'source': changed})
        self.assertEqual(status, 200)
        self.assertFalse(preview['importable'])
        self.assertEqual(preview['conflicts'], [{'id': 'hello-module', 'version': '1.0.0'}])
        self.assertEqual(tree_of(self.server.data_dir), before)

    def test_lesson_routes_take_5_mb_and_no_more(self):
        padded = lesson_text('lesson-module-minimal.json') + ' ' * 2_500_000
        status, preview = self.post('/api/lessons/import/preview', {'source': padded})
        self.assertEqual(status, 200, preview)
        status, body = self.declared('/api/lessons/import/preview', 5_300_000)
        self.assertEqual((status, body['code']), (413, 'payload_too_large'))
        status, body = self.declared('/api/lessons/import', 5 * 1024 * 1024 + 1)
        self.assertEqual(status, 413)
        status, body = self.declared('/api/lessons/pins', 5 * 1024 * 1024 + 1)
        self.assertEqual(status, 413)
        self.assertEqual(self.declared('/api/import/preview', 2_500_000)[0], 413)

    def test_a_newer_version_is_offered_and_never_switched(self):
        self.importing('lesson-module-minimal.json')
        self.post('/api/lessons/import', {'source': self.newer(), 'filename': 'b.json'})
        entry = self.call('GET', '/api/lessons')[1]['modules'][0]
        self.assertEqual((entry['pinnedVersion'], entry['newerVersionAvailable'], entry['versions']), ('1.0.0', '1.1.0', ['1.0.0', '1.1.0']))
        status, preview = self.post('/api/lessons/import/preview', {'source': self.newer()})
        self.assertEqual(preview['modules'][0]['state'], 'present')

    def test_a_pin_moves_only_with_an_explicit_confirm(self):
        self.importing('lesson-module-minimal.json')
        self.post('/api/lessons/import', {'source': self.newer()})
        revision = self.call('GET', '/api/lessons')[1]['revision']
        before = tree_of(self.server.data_dir)
        for confirm in (False, None, 'true', 1, 'yes'):
            status, body = self.post('/api/lessons/pins', {'moduleId': 'hello-module', 'version': '1.1.0', 'confirm': confirm, 'expectedRevision': revision})
            self.assertEqual((status, body['code']), (400, 'confirmation_required'), confirm)
        status, body = self.post('/api/lessons/pins', {'moduleId': 'hello-module', 'version': '1.1.0'})
        self.assertEqual(status, 400)
        self.assertEqual(self.post('/api/lessons/pins', {'moduleId': 'hello-module', 'version': '1.1.0', 'confirm': True, 'extra': 1})[0], 400)
        self.assertEqual(tree_of(self.server.data_dir), before)
        stale = self.post('/api/lessons/pins', {'moduleId': 'hello-module', 'version': '1.1.0', 'confirm': True, 'expectedRevision': revision + 5})
        self.assertEqual((stale[0], stale[1]['code']), (409, 'revision_conflict'))
        self.assertEqual(self.post('/api/lessons/pins', {'moduleId': 'hello-module', 'version': '9.9.9', 'confirm': True})[0], 404)
        status, listing = self.post('/api/lessons/pins', {'moduleId': 'hello-module', 'version': '1.1.0', 'confirm': True, 'expectedRevision': revision})
        self.assertEqual(status, 200)
        self.assertEqual(listing['modules'][0]['pinnedVersion'], '1.1.0')
        self.assertIsNone(listing['modules'][0]['newerVersionAvailable'])

    def test_export_then_restore_into_another_folder_rebuilds_it(self):
        self.post('/api/lessons/import', {'source': [lesson_text('packet-one-module.json'), lesson_text('lesson-module-minimal.json')]})
        self.post('/api/lessons/import', {'source': self.newer()})
        status, backup = self.call('GET', '/api/lessons/export')
        self.assertEqual((status, backup['format']), (200, 'schola-lesson-backup'))
        other = tempfile.TemporaryDirectory()
        second = HTTPServer(('127.0.0.1', 0), Handler)
        second.data_dir = Path(other.name)
        thread = threading.Thread(target=second.serve_forever, daemon=True)
        thread.start()
        try:
            status, preview = self.post('/api/lessons/import/preview', {'source': backup, 'filename': 'b.json'}, port=second.server_port)
            self.assertEqual((status, preview['kind'], preview['importable']), (200, 'backup', True))
            self.assertEqual(tree_of(other.name), {})
            status, result = self.post('/api/lessons/import', {'source': backup, 'filename': 'b.json'}, port=second.server_port)
            self.assertEqual(status, 200, result)
            lessons = lambda root: {k: v for k, v in tree_of(root).items() if k.startswith('_lessons')}  # noqa: E731
            self.assertEqual(lessons(other.name), lessons(self.server.data_dir))
            self.assertEqual(self.call('GET', '/api/lessons', port=second.server_port)[1], self.call('GET', '/api/lessons')[1])
            before = tree_of(other.name)
            damaged = dict(backup, modules=[dict(backup['modules'][0], sha256='0' * 64)] + backup['modules'][1:])
            status, body = self.post('/api/lessons/import', {'source': damaged}, port=second.server_port)
            self.assertEqual(status, 422)
            self.assertEqual(tree_of(other.name), before)
        finally:
            second.shutdown()
            second.server_close()
            thread.join()
            other.cleanup()

    def test_host_and_origin_rules_cover_every_lesson_route(self):
        self.importing('lesson-module-minimal.json')
        before = tree_of(self.server.data_dir)
        port = self.server.server_port
        routes = [('GET', '/api/lessons', None), ('GET', '/api/lessons/export', None),
                  ('POST', '/api/lessons/import/preview', {'source': lesson_text('lesson-module-full.json')}),
                  ('POST', '/api/lessons/import', {'source': lesson_text('lesson-module-full.json')}),
                  ('POST', '/api/lessons/pins', {'moduleId': 'hello-module', 'version': '1.0.0', 'confirm': True}),
                  ('POST', '/api/lessons/migrate', {})]
        for method, path, body in routes:
            for headers in ({'Origin': 'https://unrelated.example'}, {'Origin': 'null'}, {'Origin': f'http://127.0.0.1:{port + 1}'},
                            {'Host': 'unrelated.example'}, {'Host': f'127.0.0.1:{port + 1}'}):
                with self.subTest(route=path, headers=headers):
                    self.assertEqual(self.call(method, path, body, headers)[0], 403)
        self.assertEqual(tree_of(self.server.data_dir), before)
        ok = self.call('GET', '/api/lessons', headers={'Origin': f'http://127.0.0.1:{port}'})
        self.assertEqual(ok[0], 200)

    def test_posts_need_json(self):
        status, body = self.call('POST', '/api/lessons/import', raw=b'x', headers={'Content-Type': 'text/plain'})
        self.assertEqual(status, 415)
        status, body = self.call('POST', '/api/lessons/import', raw=b'{"source": NaN}')
        self.assertEqual((status, body['code']), (400, 'invalid_json'))

    def test_migrate_route_is_explicit_and_repeatable(self):
        before_state = self.call('GET', '/api/state')[1]
        self.assertEqual(self.post('/api/lessons/migrate', {'a': 1})[0], 400)
        self.assertEqual(self.post('/api/lessons/migrate', {})[1]['status'], 'migrated')
        self.assertEqual(self.post('/api/lessons/migrate', {})[1], {'status': 'already-migrated'})
        self.assertEqual(self.call('GET', '/api/state')[1], before_state)


if __name__=='__main__':
    unittest.main()
