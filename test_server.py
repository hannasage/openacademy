import copy
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

if __name__=='__main__':
    unittest.main()
