"""Setup persistence uses a disposable socket-only PostgreSQL cluster."""
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup_disposable', ROOT/'backend/tests/disposable.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SetupStoreTests(unittest.TestCase):
    def test_disposable_postgres_store(self):
        database = module.Database()
        try:
            env = {key: value for key, value in os.environ.items() if not key.startswith('PG') and key != 'DATABASE_URL'}
            env['TOUCHLINE_TEST_PG_SOCKET'] = str(database.socket)
            result = subprocess.run(['node', '--test', 'backend/setup/tests/postgres.integration.mjs'], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        finally:
            database.close()
