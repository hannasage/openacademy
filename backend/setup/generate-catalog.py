"""Generate compatibility evidence using disposable PostgreSQL only."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('setup_disposable', ROOT/'backend/tests/disposable.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def generate():
    database = module.Database()
    try:
        if int(database.sql("select current_setting('server_version_num')::integer/10000").stdout) != 17:
            raise RuntimeError('Generate the reference catalog with PostgreSQL 17; provider.mjs adapts its expected MAINTAIN grants for 15/16.')
        database.sql((ROOT/'backend/tests/fixtures/auth.sql').read_text())
        database.sql('delete from auth.sessions; delete from auth.users; set search_path=public,pg_catalog;')
        database.sql((ROOT/'backend/setup/tests/platform-baseline.sql').read_text())
        query = (ROOT/'backend/setup/catalog.sql').read_text()
        stages = [{'migrations': [], 'catalog': json.loads(database.sql(query).stdout)}]
        migrations = []
        for file in sorted((ROOT/'backend/migrations').glob('*.sql')):
            database.sql(file.read_text())
            migrations.append({'id': file.name, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
            catalog = json.loads(database.sql(query).stdout)
            stages.append({'migrations': list(migrations), 'catalog': catalog})
        return stages
    finally:
        database.close()


if __name__ == '__main__':
    target = ROOT/'backend/setup/catalog-evidence.json'
    target.write_text(json.dumps(generate(), indent=2) + '\n')
