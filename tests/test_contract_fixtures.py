"""The same fixtures constrain schema readers and the local Python runtime."""
import json
from pathlib import Path
import tempfile
import unittest

from local_store import LocalStore, StoreError
from server import initial, validate, validate_curriculum

FIXTURES = Path(__file__).parent / 'fixtures' / 'contracts'


def read(relative):
    return json.loads((FIXTURES / relative).read_text())


class ContractFixtureTests(unittest.TestCase):
    def test_local_runtime_matches_shared_fixtures(self):
        supported = {'local-record.v2.schema.json', 'curriculum.v1.schema.json',
                     'progress.v1.schema.json', 'legacy-backup.v1.schema.json'}
        checked = 0
        for case in read('cases.json'):
            if case['schema'] not in supported:
                continue
            with self.subTest(case=case['name']), tempfile.TemporaryDirectory() as directory:
                checked += 1
                course = read('valid/curriculum.json')
                store = LocalStore(directory, dict(course, id='built-in-fixture'), validate_curriculum, validate, initial)
                value = read(case['file'])
                def apply():
                    if case['schema'] == 'local-record.v2.schema.json':
                        return store._validate(value)
                    if case['schema'] == 'curriculum.v1.schema.json':
                        return store._course(value)
                    if case['schema'] == 'progress.v1.schema.json':
                        return store._state(value, course)
                    return store.import_record(value, {'kind': 'local'}, 'active')
                if case['valid'] and case.get('semanticValid', True):
                    apply()
                else:
                    with self.assertRaises(StoreError):
                        apply()
        self.assertGreater(checked, 20)
