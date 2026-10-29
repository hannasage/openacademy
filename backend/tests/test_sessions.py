import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from disposable import Database
from test_database import OWNER, OTHER, PENDING, ROOT, literal

SESSION = '10000000-0000-4000-8000-000000000001'
SECOND = '20000000-0000-4000-8000-000000000001'


class SessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = Database()
        cls.addClassCleanup(cls.db.close)
        cls.db.sql((ROOT / 'backend/tests/fixtures/auth.sql').read_text())
        for file in sorted((ROOT / 'backend/migrations').glob('*.sql')):
            cls.db.sql(file.read_text())
        cls.db.sql("select touchline_private.configure_owner('owner@example.invalid');")
        cls.db.sql(f"insert into auth.sessions values('{SECOND}','{OWNER}',now(),now())")
        cls.backup = json.loads((ROOT / 'tests/fixtures/contracts/valid/legacy-backup.json').read_text())

    def request(self, sql, session=SESSION, account=OWNER, prefix='', commit=False):
        end = 'commit' if commit else 'rollback'
        return self.db.sql(f"begin; {prefix} set local role authenticated; select set_config('request.jwt.claim.sub','{account}',true); select set_config('request.jwt.claim.session_id','{session}',true); {sql}; {end};", check=False)

    def publish(self):
        c, p = self.backup['curriculum'], self.backup['state']
        return f"select public.save_learning_course('{c['id']}',{literal(c)},{literal(p)},-1)"

    def test_register_and_truthful_inventory(self):
        result = self.request("select register_touchline_session('My browser'); select list_touchline_sessions()")
        self.assertEqual(result.returncode, 0, result.stderr)
        registered, listed = map(json.loads, result.stdout.strip().splitlines()[-2:])
        self.assertEqual(registered, {'sessionId':SESSION, 'accountId':OWNER})
        self.assertEqual(len(listed), 2)
        current = next(x for x in listed if x['isCurrent'])
        self.assertEqual(current['label'], 'My browser')
        self.assertIsNotNone(current['lastSeenAt'])
        other = next(x for x in listed if not x['isCurrent'])
        self.assertEqual(other['label'], 'Unknown device')
        self.assertIsNone(other['lastSeenAt'])
        self.assertEqual(set(current), {'sessionId','label','createdAt','lastSeenAt','isCurrent'})

    def test_missing_malformed_foreign_and_deleted_sessions_are_denied(self):
        for session in ['', 'bad', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001']:
            with self.subTest(session=session):
                self.assertNotEqual(self.request(self.publish(), session=session).returncode, 0)
                self.assertNotEqual(self.request("select register_touchline_session('Browser')", session=session).returncode, 0)
        result = self.request(self.publish(), prefix=f"delete from auth.sessions where id='{SESSION}';")
        self.assertNotEqual(result.returncode, 0)

    def test_unknown_and_unconfirmed_accounts_cannot_manage_sessions(self):
        for user in [OTHER,PENDING]:
            for sql in ["select register_touchline_session('Browser')", "select list_touchline_sessions()", f"select revoke_touchline_session('{SECOND}')"]:
                self.assertNotEqual(self.request(sql, account=user, session='1'+user[1:]).returncode, 0)

    def test_revoke_blocks_next_request_and_does_not_delete_records(self):
        # Commit only inside this isolated test database to prove the next request fails.
        self.assertEqual(self.request(self.publish(), commit=True).returncode, 0)
        try:
            result = self.request(f"select revoke_touchline_session('{SECOND}'); select revoke_touchline_session('{SECOND}')", commit=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for sql in ["select register_touchline_session('Again')", "select list_touchline_sessions()", self.publish()]:
                self.assertNotEqual(self.request(sql, session=SECOND).returncode, 0)
            for table in ['learning_courses','learning_snapshots','learning_libraries','learning_library_snapshots']:
                result = self.request(f'select count(*) from public.{table}', session=SECOND)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip().splitlines()[-1], '0')
            self.assertEqual(self.db.sql('select count(*) from learning_courses').stdout.strip(), '1')
            self.assertEqual(self.request("select register_touchline_session('Still active')").returncode, 0)
        finally:
            self.db.sql("delete from touchline_private.session_registry; delete from learning_courses;")

    def test_cannot_revoke_foreign_or_missing_session(self):
        for target in ['10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001']:
            self.assertNotEqual(self.request(f"select revoke_touchline_session('{target}')").returncode, 0)

    def test_labels_and_registry_are_restricted(self):
        for label in ['', ' ', 'x'*81]:
            self.assertNotEqual(self.request(f"select register_touchline_session('{label}')").returncode, 0)
        for sql in ["select * from touchline_private.session_registry", "delete from touchline_private.session_registry", "select touchline_private.current_session_id()", "select touchline_private.session_is_allowed()"]:
            self.assertNotEqual(self.request(sql).returncode, 0)

    def test_replayed_guard_does_not_fall_back_when_session_helper_is_missing(self):
        self.assertEqual(self.request(self.publish(), commit=True).returncode, 0)
        self.db.sql((ROOT / 'backend/migrations/001_private_writes.sql').read_text())
        try:
            for sql in [self.publish(), 'select count(*) from learning_courses']:
                result = self.request(sql, prefix='alter function touchline_private.session_is_allowed() rename to unavailable_session_helper;')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('session_is_allowed', result.stderr)
        finally:
            self.db.sql((ROOT / 'backend/migrations/004_session_access.sql').read_text())
            self.db.sql('delete from learning_courses;')

    def test_self_revocation_cannot_be_undone_by_registration(self):
        sql = f"select revoke_touchline_session('{SESSION}'); select register_touchline_session('Again')"
        self.assertNotEqual(self.request(sql).returncode, 0)

    def test_waiting_publication_rechecks_revocation_after_lock(self):
        import time
        from concurrent.futures import ThreadPoolExecutor
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                revoke = pool.submit(self.request, f"select revoke_touchline_session('{SECOND}'); select pg_sleep(0.6)",
                                     prefix="set local application_name='touchline-revocation-test';", commit=True)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    sleeping = self.db.sql("select count(*) from pg_stat_activity where application_name='touchline-revocation-test' and wait_event='PgSleep'").stdout.strip()
                    if sleeping == '1':
                        break
                    time.sleep(0.01)
                else:
                    self.fail('Revocation did not reach the controlled transaction hold.')
                result = self.request(self.publish(), session=SECOND, commit=True)
                self.assertEqual(revoke.result().returncode, 0)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.db.sql('select count(*) from learning_courses').stdout.strip(), '0')
        finally:
            self.db.sql('delete from touchline_private.session_registry; delete from learning_courses;')

    def test_migration_replay_never_restores_revoked_or_missing_session_access(self):
        self.assertEqual(self.request(self.publish(), commit=True).returncode, 0)
        self.assertEqual(self.request(f"select revoke_touchline_session('{SECOND}')", commit=True).returncode, 0)
        library = "select save_learning_library('{\"version\":1,\"revision\":0,\"focusCurriculumId\":null}',-1)"
        c, p = self.backup['curriculum'], self.backup['state']
        writes = [self.publish(), f"select publish_learning_course('{c['id']}',{literal(c)},{literal(p)},'active',0)", library]
        def assert_denied():
            for session in [SECOND, '']:
                for table in ['learning_courses','learning_snapshots','learning_libraries','learning_library_snapshots']:
                    result = self.request(f'select count(*) from {table}', session=session)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip().splitlines()[-1], '0')
                for sql in writes:
                    result = self.request(sql, session=session)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('session has ended', result.stderr)
            self.assertEqual(self.request("select register_touchline_session('Still active')").returncode, 0)
        try:
            # Stop after every file, including a later failed transaction, so an
            # eventual 004 repair cannot conceal a temporary authorization gap.
            for file in sorted((ROOT / 'backend/migrations').glob('*.sql')):
                self.db.sql(file.read_text())
                failed = self.db.sql('begin; select 1/0; commit;', check=False)
                self.assertNotEqual(failed.returncode, 0)
                assert_denied()
            self.db.sql('\\i ' + "'" + str(ROOT / 'backend/schema.sql').replace("'", "''") + "'")
            assert_denied()
        finally:
            self.db.sql('delete from touchline_private.session_registry; delete from learning_courses;')
