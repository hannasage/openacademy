"""Apply reviewed numbered migrations to an explicitly configured deployment."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit, unquote

ROOT=Path(__file__).resolve().parent.parent

def environment():
    values={}
    for line in (ROOT/'.env.local').read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            key,value=line.split('=',1)
            try:value=json.loads(value)
            except json.JSONDecodeError:value=value.strip("'\"")
            values[key]=value
    return values

def psql(sql, **variables):
    env=environment()
    url=urlsplit(env['POSTGRES_URL'])
    process_env=dict({key:value for key,value in os.environ.items() if not key.startswith('PG')}, PGPASSFILE=os.devnull, PGSERVICEFILE=os.devnull, PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGUSER=unquote(url.username), PGPASSWORD=unquote(url.password), PGDATABASE=url.path.lstrip('/'), PGSSLMODE='require', PGCONNECT_TIMEOUT='15')
    args=['psql','-X','-v','ON_ERROR_STOP=1','-q']
    for key,value in variables.items():args+=['-v',f'{key}={value}']
    return subprocess.run(args,input=sql,text=True,env=process_env,check=True,capture_output=True).stdout

def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('--owner-email',required=True)
    parser.add_argument('--owner-id', help='Explicit confirmed owner UUID for administrative recovery.')
    args=parser.parse_args(argv)
    if '@' not in args.owner_email:raise SystemExit('Enter a valid owner email.')
    try:
        def configure_owner():
            psql("select touchline_private.configure_owner(lower(:'email'),nullif(:'owner_id','')::uuid);",
                 email=args.owner_email, owner_id=args.owner_id or '')

        for migration in sorted((ROOT/'backend/migrations').glob('*.sql')):
            psql(migration.read_text())
            if args.owner_id and migration.name == '001_private_writes.sql':
                # The schema must exist, but automatic legacy binding must not
                # run before an explicit, database-validated recovery choice.
                configure_owner()
        if not args.owner_id:
            configure_owner()
        print('Migrations and owner configuration applied. Access requires the pinned, confirmed owner account.')
    except subprocess.CalledProcessError as error:
        print(error.stderr)
        raise SystemExit(1)


if __name__=='__main__':
    main()
