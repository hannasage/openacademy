import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from disposable import Database
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend import apply

ROOT = Path(__file__).resolve().parents[2]
OWNER = '00000000-0000-4000-8000-000000000001'
OTHER = '00000000-0000-4000-8000-000000000002'
PENDING = '00000000-0000-4000-8000-000000000003'


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


class DatabaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = Database()
        cls.addClassCleanup(cls.db.close)
        cls.db.sql((ROOT / 'backend/tests/fixtures/auth.sql').read_text())
        cls.migrations = sorted((ROOT / 'backend/migrations').glob('*.sql'))
        if not cls.migrations:
            raise AssertionError('Numbered migrations are required.')
        for file in cls.migrations:
            cls.db.sql(file.read_text())
        cls.db.sql("select touchline_private.configure_owner('owner@example.invalid');")
        cls.backup = json.loads((ROOT / 'tests/fixtures/contracts/valid/legacy-backup.json').read_text())

    def as_user(self, sql, user=OWNER, role='authenticated', prefix=''):
        session = '1' + user[1:] if user else ''
        return self.db.sql(f"begin; {prefix} set local role {role}; select set_config('request.jwt.claim.sub','{user}',true); select set_config('request.jwt.claim.session_id','{session}',true); {sql}; rollback;", check=False)

    def save(self, backup=None, revision=-1):
        backup = backup or self.backup
        return f"select public.save_learning_course('{backup['curriculum']['id']}',{literal(backup['curriculum'])},{literal(backup['state'])},{revision})"

    def test_disposable_cluster_uses_only_its_private_socket(self):
        self.assertEqual(self.db.sql('show listen_addresses').stdout.strip(), '')
        self.assertEqual(self.db.env['PGHOST'], str(self.db.socket))
        self.assertEqual(self.db.env['PGPASSFILE'], str(self.db.empty_passwords))
        self.assertEqual(self.db.env['PGSERVICEFILE'], str(self.db.empty_passwords))
        for key in ['PGHOSTADDR', 'PGSERVICE', 'PGOPTIONS']:
            self.assertNotIn(key, self.db.env)

    def test_owner_cannot_bypass_revision_check_with_direct_insert(self):
        result = self.as_user(f"insert into public.learning_courses(user_id,id,curriculum,progress) values('{OWNER}','x','{{}}','{{}}')")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('permission denied', result.stderr)

    def test_owner_can_publish_but_other_accounts_cannot(self):
        self.assertEqual(self.as_user(self.save()).returncode, 0)
        for user, role in [(OTHER, 'authenticated'), (PENDING, 'authenticated'), ('', 'anon')]:
            self.assertNotEqual(self.as_user(self.save(), user, role).returncode, 0)

    def test_direct_mutations_and_private_helpers_are_denied(self):
        for sql in ["update public.learning_courses set revision=99", "delete from public.learning_courses",
                    "insert into public.learning_libraries(user_id) values(auth.uid())",
                    "update public.learning_libraries set revision=99", "delete from public.learning_libraries",
                    "select * from touchline_private.owner_settings", "select * from touchline_private.write_requests",
                    "select touchline_private.configure_owner('other@example.invalid')",
                    "select touchline_private.require_owner()"]:
            with self.subTest(sql=sql):
                result = self.as_user(sql)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('permission denied', result.stderr)

    def test_owner_reads_and_foreign_claims_are_filtered(self):
        for user, expected in [(OWNER, '1'), (OTHER, '0'), (PENDING, '0'), ('', '0')]:
            sql = self.save() + f"; select set_config('request.jwt.claim.sub','{user}',true); select count(*) from public.learning_snapshots"
            result = self.as_user(sql)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip().splitlines()[-1], expected)
        for table in ['learning_courses', 'learning_libraries', 'learning_snapshots', 'learning_library_snapshots']:
            self.assertNotEqual(self.as_user('select * from public.' + table, '', 'anon').returncode, 0)

    def test_owner_uuid_survives_provider_linking_and_email_changes(self):
        prefix = f"update auth.users set email='relay@privaterelay.example.invalid',raw_app_meta_data='{{\"providers\":[\"email\",\"google\",\"apple\"]}}' where id='{OWNER}'; insert into auth.identities values('apple-linked','{OWNER}','apple');"
        self.assertEqual(self.as_user(self.save(), prefix=prefix).returncode, 0)
        forged = f"update auth.users set email='owner@example.invalid',raw_user_meta_data='{{\"is_owner\":true}}',raw_app_meta_data='{{\"provider\":\"google\"}}' where id='{OTHER}';"
        result = self.as_user(self.save(), OTHER, prefix=forged)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('deployment is private', result.stderr)

    def test_owner_must_remain_confirmed_active_and_nonanonymous(self):
        for change in ["email_confirmed_at=null", "is_anonymous=true", "banned_until=now()+interval '1 day'", "deleted_at=now()"]:
            with self.subTest(change=change):
                result = self.as_user(self.save(), prefix=f"update auth.users set {change} where id='{OWNER}';")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('deployment is private', result.stderr)

    def test_signup_pins_one_account_and_denies_separate_provider_accounts(self):
        for email in ['other@example.invalid', 'relay@privaterelay.example.invalid', 'owner@example.invalid']:
            result = self.db.sql(f"begin; insert into auth.users(id,email,email_confirmed_at) values('00000000-0000-4000-8000-000000000004','{email}',now()); rollback;",check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Account creation is restricted', result.stderr)
        result = self.db.sql("begin; update touchline_private.owner_settings set owner_user_id=null,email='first@example.invalid'; insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000004','first@example.invalid'); select owner_user_id from touchline_private.owner_settings; rollback;")
        self.assertEqual(result.stdout.strip(), '00000000-0000-4000-8000-000000000004')

    def test_admin_recovery_pins_existing_relay_account_explicitly(self):
        result = self.as_user(self.save(), OTHER, prefix=f"select touchline_private.configure_owner('owner@example.invalid','{OTHER}');")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.as_user(self.save(), OWNER, prefix=f"select touchline_private.configure_owner('owner@example.invalid','{OTHER}');")
        self.assertNotEqual(result.returncode, 0)
        result = self.db.sql(f"begin; select touchline_private.configure_owner('owner@example.invalid','{PENDING}'); rollback;",check=False)
        self.assertNotEqual(result.returncode, 0)

    def test_creation_and_update_conflicts_do_not_change_rows(self):
        for expected in [-1, 3, None, -2, 2147483647]:
            sql = self.save() + '; ' + self.save(revision='null' if expected is None else expected)
            result = self.as_user(sql)
            self.assertNotEqual(result.returncode, 0)
        result = self.as_user(self.save() + '; ' + self.save(revision=0) + '; select revision from public.learning_courses')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines()[-1], '1')

    def test_invalid_publications_reject_private_fields_types_and_references(self):
        import copy
        mutations = [
            lambda b: b['curriculum'].update(version=2),
            lambda b: b['state'].update(version=2),
            lambda b: b['state'].update(revision=True),
            lambda b: b['state'].update(revision=9007199254740992),
            lambda b: b['state'].update(curriculumId='wrong'),
            lambda b: b['curriculum'].update(draft='private'),
            lambda b: b['state'].update(draft='private'),
            lambda b: b['curriculum']['modules'][0].update(private='secret'),
            lambda b: b['state']['modules']['baseline'].update(secret='private'),
            lambda b: b['curriculum']['resources']['guide'].update(secret='private'),
            lambda b: b['curriculum']['resources']['guide'].update(url='javascript:alert(1)'),
            lambda b: b['curriculum']['modules'][0].update(resources=['missing']),
            lambda b: b['curriculum']['modules'][0].update(prerequisites=['missing']),
            lambda b: b['curriculum']['modules'][0].update(weekEnd=999),
            lambda b: b['curriculum']['modules'].append(b['curriculum']['modules'][0]),
            lambda b: b['state'].update(startDate='2026-02-30'),
            lambda b: b['state']['modules']['baseline'].update(tasks=['yes', False]),
            lambda b: b['state']['modules']['baseline'].update(status='complete'),
            lambda b: b['state']['modules']['baseline'].update(notes='x'*50001),
            lambda b: b['state'].update(experiments=[{'id':'a','date':'','module':'baseline','title':'','hypothesis':'','result':''}]),
            lambda b: b['curriculum'].update(description='x'*2000000),
        ]
        for number, mutate in enumerate(mutations):
            with self.subTest(case=number):
                backup = copy.deepcopy(self.backup); mutate(backup)
                result = self.as_user(self.save(backup))
                self.assertNotEqual(result.returncode, 0, result.stdout)

    def publish(self, status='active', expected=-1, request=None, backup=None):
        b = backup or self.backup
        request = "null" if request is None else "'"+request+"'"
        return f"select public.publish_learning_course('{b['curriculum']['id']}',{literal(b['curriculum'])},{literal(b['state'])},'{status}',{expected},{request})"

    def library(self, focus=None, expected=-1, request=None):
        request = 'null' if request is None else "'"+request+"'"
        payload={'version':1,'revision':max(expected,0),'focusCurriculumId':focus}
        return f"select public.save_learning_library({literal(payload)},{expected},{request})"

    def test_retry_id_returns_original_result_and_rejects_reuse(self):
        request='10000000-0000-4000-8000-000000000001'
        sql=self.publish(request=request)+';'+self.publish(request=request)+'; select revision from public.learning_courses'
        result=self.as_user(sql)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip().splitlines()[-1],'0')
        self.assertNotEqual(self.as_user(self.publish(request=request)+';'+self.publish(status='paused',request=request)).returncode,0)
        self.assertNotEqual(self.as_user(self.publish(request=request)+';'+self.library(request=request)).returncode,0)
        result=self.as_user(self.library(request=request)+';'+self.library(request=request)+'; select revision from public.learning_libraries')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip().splitlines()[-1],'0')

    def test_library_focus_requires_active_course_and_clears_atomically(self):
        course=self.backup['curriculum']['id']
        self.assertNotEqual(self.as_user(self.library(course)).returncode,0)
        self.assertNotEqual(self.as_user(self.publish(status='paused')+';'+self.library(course)).returncode,0)
        result=self.as_user(self.save()+';'+self.library(course)+';'+self.publish(status='paused',expected=0)+'; select snapshot from public.learning_library_snapshots')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1]),{'version':1,'revision':1,'focusCurriculumId':None})
        self.assertNotEqual(self.as_user(self.library()+';'+self.library()).returncode,0)

    def test_snapshot_has_only_public_contract_fields(self):
        result=self.as_user(self.save()+'; select snapshot from public.learning_snapshots')
        self.assertEqual(result.returncode,0,result.stderr)
        snapshot=json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(set(snapshot),{'format','version','curriculum','progress','status','revision','publishedAt'})
        self.assertEqual(snapshot['format'],'touchline-snapshot')
        self.assertRegex(snapshot['publishedAt'],r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')

    def test_simultaneous_updates_have_exactly_one_winner(self):
        import copy
        from concurrent.futures import ThreadPoolExecutor
        backup=copy.deepcopy(self.backup); backup['curriculum']['id']='race'; backup['state']['curriculumId']='race'
        self.db.sql(f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{OWNER}',true); select set_config('request.jwt.claim.session_id','1{OWNER[1:]}',true); {self.save(backup)}; commit;")
        sql=f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{OWNER}',true); select set_config('request.jwt.claim.session_id','1{OWNER[1:]}',true); {self.save(backup,0)}; commit;"
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes=list(pool.map(lambda _:self.db.sql(sql,check=False),range(4)))
        self.assertEqual(sum(result.returncode==0 for result in outcomes),1)
        for result in outcomes:
            if result.returncode: self.assertIn('Newer cloud progress exists',result.stderr)
        self.assertEqual(self.db.sql("select revision from public.learning_courses where id='race'").stdout.strip(),'1')

    def test_migrations_are_repeatable_without_rebinding_the_owner(self):
        for file in self.migrations:
            result=self.db.sql(file.read_text())
            self.assertEqual(result.returncode,0)
        self.assertEqual(self.db.sql('select owner_user_id from touchline_private.owner_settings').stdout.strip(),OWNER)


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.db=Database(); self.addCleanup(self.db.close)
        self.db.sql((ROOT/'backend/tests/fixtures/auth.sql').read_text())
        self.db.sql((ROOT/'backend/tests/fixtures/legacy-schema.sql').read_text())
        self.db.sql("insert into touchline_private.owner_settings(singleton,email) values(true,'owner@example.invalid')")
        self.backup=json.loads((ROOT/'tests/fixtures/contracts/valid/legacy-backup.json').read_text())

    def migrate(self):
        for file in sorted((ROOT/'backend/migrations').glob('*.sql')):
            self.db.sql(file.read_text())

    def test_upgrade_keeps_original_rows_and_pins_existing_verified_owner(self):
        b=self.backup
        self.db.sql(f"insert into public.learning_courses(user_id,id,curriculum,progress,revision) values('{OWNER}','{b['curriculum']['id']}',{literal(b['curriculum'])},{literal(b['state'])},4)")
        before=self.db.sql('select curriculum,progress,revision,updated_at from public.learning_courses').stdout
        self.migrate()
        self.assertEqual(self.db.sql('select curriculum,progress,revision,updated_at from public.learning_courses').stdout,before)
        self.assertEqual(self.db.sql('select format_version from public.learning_courses').stdout.strip(),'1')
        self.assertEqual(self.db.sql('select owner_user_id from touchline_private.owner_settings').stdout.strip(),OWNER)
        result=self.db.sql(f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{OWNER}',true); update public.learning_courses set revision=5; rollback;",check=False)
        self.assertNotEqual(result.returncode,0)

    def test_incompatible_legacy_rows_stay_intact_and_out_of_versioned_view(self):
        self.db.sql(f"insert into public.learning_courses(user_id,id,curriculum,progress) values('{OWNER}','legacy','{{\"id\":\"legacy\",\"private\":\"kept\"}}','{{\"curriculumId\":\"legacy\"}}')")
        before=self.db.sql('select curriculum,progress from public.learning_courses').stdout
        self.migrate()
        self.assertEqual(self.db.sql('select curriculum,progress from public.learning_courses').stdout,before)
        self.assertEqual(self.db.sql('select count(*) from public.learning_snapshots').stdout.strip(),'0')
        self.assertEqual(self.db.sql('select format_version from public.learning_courses').stdout.strip(),'0')

    def test_ambiguous_owner_upgrade_fails_closed_and_has_admin_recovery(self):
        self.db.sql(f"update auth.users set email='owner@example.invalid' where id='{OTHER}'")
        migrations=sorted((ROOT/'backend/migrations').glob('*.sql'))
        self.db.sql(migrations[0].read_text())
        result=self.db.sql(migrations[1].read_text(),check=False)
        self.assertNotEqual(result.returncode,0)
        result=self.db.sql(f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{OWNER}',true); select touchline_private.is_owner(); rollback;")
        self.assertEqual(result.stdout.strip().splitlines()[-1],'f')
        self.db.sql(f"select touchline_private.configure_owner('owner@example.invalid','{OWNER}')")
        self.migrate()
        self.assertEqual(self.db.sql('select owner_user_id from touchline_private.owner_settings').stdout.strip(),OWNER)

    def test_cli_recovers_ambiguous_owner_without_bypassing_target_validation(self):
        self.db.sql(f"update auth.users set email='owner@example.invalid' where id='{OTHER}'")

        def local_psql(sql, **variables):
            # Run the real CLI sequence with only the test cluster's socket/env.
            args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
            for key, value in variables.items():
                args += ['-v', f'{key}={value}']
            return self.db.command('psql', *args, input=sql).stdout

        with patch.object(apply, 'psql', side_effect=local_psql), patch('builtins.print'):
            with self.assertRaises(SystemExit) as failed:
                apply.main(['--owner-email', 'owner@example.invalid'])
            self.assertEqual(failed.exception.code, 1)
            with self.assertRaises(SystemExit) as invalid:
                apply.main(['--owner-email', 'owner@example.invalid', '--owner-id', PENDING])
            self.assertEqual(invalid.exception.code, 1)
            self.assertEqual(self.db.sql('select owner_user_id is null from touchline_private.owner_settings').stdout.strip(), 't')
            apply.main(['--owner-email', 'owner@example.invalid', '--owner-id', OWNER])
            apply.main(['--owner-email', 'owner@example.invalid'])
        self.assertEqual(self.db.sql('select owner_user_id from touchline_private.owner_settings').stdout.strip(), OWNER)

    def test_failed_owner_configuration_keeps_schema_and_prior_owner_for_retry(self):
        self.migrate()
        result=self.db.sql(f"select touchline_private.configure_owner('owner@example.invalid','{PENDING}')",check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.db.sql('select owner_user_id from touchline_private.owner_settings').stdout.strip(),OWNER)
        self.migrate()
        self.db.sql(f"select touchline_private.configure_owner('owner@example.invalid','{OWNER}')")


    def test_upgrade_removes_column_grants_and_contains_old_permissive_policies(self):
        b=self.backup
        self.db.sql(f"insert into public.learning_courses(user_id,id,curriculum,progress) values('{OWNER}','{b['curriculum']['id']}',{literal(b['curriculum'])},{literal(b['state'])})")
        self.db.sql("grant update(revision),select(curriculum) on public.learning_courses to authenticated,anon; create policy old_broad_policy on public.learning_courses for all to authenticated using(true) with check(true)")
        self.migrate()
        result=self.db.sql(f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{OWNER}',true); update public.learning_courses set revision=9; rollback;",check=False)
        self.assertNotEqual(result.returncode,0)
        result=self.db.sql(f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{OTHER}',true); select count(*) from public.learning_courses; rollback;")
        self.assertEqual(result.stdout.strip().splitlines()[-1],'0')
        self.assertNotEqual(self.db.sql('begin; set local role anon; select curriculum from public.learning_courses; rollback;',check=False).returncode,0)
