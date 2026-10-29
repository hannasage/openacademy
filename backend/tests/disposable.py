"""A disposable Postgres cluster. No URL, environment file, or TCP listener."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile


class Database:
    def __init__(self):
        bindir = os.environ.get('PG_BIN') or os.environ.get('TOUCHLINE_POSTGRES_BIN')
        if not bindir:
            psql = shutil.which('psql')
            bindir = str(Path(psql).resolve().parent) if psql else ''
            candidates = [Path(bindir), Path('/opt/homebrew/opt/postgresql@17/bin'), Path('/usr/local/opt/postgresql@17/bin')]
            candidates += sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True)
            bindir = next((str(path) for path in candidates if all((path / name).is_file() for name in ('psql', 'pg_ctl', 'initdb'))), '')
        self.bin = Path(bindir)
        for name in ('initdb', 'pg_ctl', 'psql'):
            if not (self.bin / name).is_file():
                raise RuntimeError('Install PostgreSQL and set PG_BIN to its bin directory.')
        self.temp = tempfile.TemporaryDirectory(prefix='touchline-db-')
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.socket = self.root / 'socket'
        self.socket.mkdir()
        # Never inherit a caller's database endpoint, password, options, or service.
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
        self.empty_passwords = self.root / 'pgpass'
        self.empty_passwords.touch(mode=0o600)
        self.env.update(PGHOST=str(self.socket), PGPORT='5432', PGUSER='postgres', PGDATABASE='postgres',
                        PGPASSFILE=str(self.empty_passwords), PGSERVICEFILE=str(self.empty_passwords))
        self.started = False
        try:
            self.command('initdb', '-D', str(self.data), '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8')
            self.command('pg_ctl', '-D', str(self.data), '-l', str(self.root / 'postgres.log'),
                         '-o', f"-c listen_addresses='' -c unix_socket_directories='{self.socket}' -c fsync=on", '-w', 'start')
            self.started = True
        except Exception:
            self.close()
            raise

    def command(self, name, *args, **kwargs):
        return subprocess.run([str(self.bin / name), *args], env=self.env,
                              text=True, capture_output=True, check=True, **kwargs)

    def sql(self, sql, check=True):
        return subprocess.run([str(self.bin / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                              input=sql, env=self.env, text=True, capture_output=True, check=check)

    def close(self):
        if self.started:
            self.command('pg_ctl', '-D', str(self.data), '-m', 'immediate', '-w', 'stop')
            self.started = False
        self.temp.cleanup()
