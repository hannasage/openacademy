import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend import apply


class ApplyTests(unittest.TestCase):
    def test_explicit_owner_is_configured_between_schema_and_binding(self):
        with patch.object(apply, 'psql') as psql, patch('builtins.print'):
            apply.main(['--owner-email', 'owner@example.invalid', '--owner-id',
                        '00000000-0000-4000-8000-000000000001'])
        calls = psql.call_args_list
        self.assertEqual(len(calls), 5)
        self.assertIn('create schema', calls[0].args[0])
        self.assertIn('configure_owner', calls[1].args[0])
        self.assertEqual(calls[1].kwargs['owner_id'], '00000000-0000-4000-8000-000000000001')
        self.assertIn('Bind a prior verified owner', calls[2].args[0])
        self.assertIn('format_version', calls[3].args[0])

    def test_ordinary_setup_configures_owner_after_migrations(self):
        with patch.object(apply, 'psql') as psql, patch('builtins.print'):
            apply.main(['--owner-email', 'owner@example.invalid'])
        calls = psql.call_args_list
        self.assertEqual(len(calls), 5)
        self.assertIn('Bind a prior verified owner', calls[1].args[0])
        self.assertIn('configure_owner', calls[-1].args[0])
        self.assertEqual(calls[-1].kwargs['owner_id'], '')

    def test_only_explicit_endpoint_reaches_psql_and_credentials_are_not_arguments(self):
        with patch.object(apply, 'environment', return_value={'POSTGRES_URL':'postgres://operator:fixture-password@db.example.invalid:6543/learning'}), patch.dict(os.environ, {
            'PGHOST':'foreign.example.invalid','PGHOSTADDR':'192.0.2.1','PGSERVICE':'foreign',
            'PGDATABASE':'other','PGUSER':'other','PGPASSWORD':'old','PGOPTIONS':'-c role=foreign',
            'PGSERVICEFILE':'/foreign/service','PGPASSFILE':'/foreign/passwords',
        }), patch.object(apply.subprocess,'run') as run:
            run.return_value.stdout='ok'
            self.assertEqual(apply.psql('select 1;'), 'ok')
        args,kwargs=run.call_args
        env=kwargs['env']
        self.assertEqual(env['PGHOST'],'db.example.invalid')
        self.assertEqual(env['PGPORT'],'6543')
        self.assertEqual(env['PGDATABASE'],'learning')
        self.assertEqual(env['PGUSER'],'operator')
        self.assertEqual(env['PGPASSWORD'],'fixture-password')
        self.assertNotIn('PGHOSTADDR',env)
        self.assertNotIn('PGSERVICE',env)
        self.assertNotIn('PGOPTIONS',env)
        self.assertEqual(env['PGSERVICEFILE'],os.devnull)
        self.assertEqual(env['PGPASSFILE'],os.devnull)
        self.assertNotIn('fixture-password',repr(args))
        self.assertTrue(kwargs['capture_output'])
