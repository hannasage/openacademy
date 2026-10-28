"""Apply the private hub schema using credentials from .env.local."""
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
    process_env=dict(os.environ, PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGUSER=unquote(url.username), PGPASSWORD=unquote(url.password), PGDATABASE=url.path.lstrip('/'), PGSSLMODE='require', PGCONNECT_TIMEOUT='15')
    args=['psql','-X','-v','ON_ERROR_STOP=1','-q']
    for key,value in variables.items():args+=['-v',f'{key}={value}']
    return subprocess.run(args,input=sql,text=True,env=process_env,check=True,capture_output=True).stdout

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--owner-email',required=True)
    args=parser.parse_args()
    if '@' not in args.owner_email:raise SystemExit('Enter a valid owner email.')
    try:
        psql((ROOT/'backend/schema.sql').read_text())
        psql("insert into touchline_private.owner_settings(singleton,email) values(true,lower(:'email')) on conflict(singleton) do update set email=excluded.email;",email=args.owner_email)
        print('Private schema applied. Only the configured verified owner can access records.')
    except subprocess.CalledProcessError as error:
        print(error.stderr)
        raise SystemExit(1)
