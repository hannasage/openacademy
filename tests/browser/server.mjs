import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
// Port zero asks the operating system to reserve a free port without a race.
const launcher = `
import sys
from pathlib import Path
from http.server import HTTPServer
from server import Handler
server = HTTPServer(('127.0.0.1', int(sys.argv[2])), Handler)
server.data_dir = Path(sys.argv[1])
print('READY http://127.0.0.1:' + str(server.server_port), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
`;

async function start(directory, port) {
  const child = spawn('python3', ['-u', '-c', launcher, directory, String(port)], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', value => { stderr = (stderr + value).slice(-4000); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('The isolated test server did not start within 10 seconds.')), 10000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        child.stdout.removeListener('data', onData);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        if (error) reject(error);
        else resolve(value);
      };
      const onData = value => {
        output += value;
        const ready = /^READY (http:\/\/127\.0\.0\.1:\d+)\r?$/m.exec(output);
        if (ready) finish(null, ready[1]);
      };
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`The isolated test server exited (${code}): ${stderr}`));
      child.stdout.setEncoding('utf8').on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    return {child, exited, url};
  } catch (error) {
    if (child.exitCode === null && child.pid) {
      child.kill('SIGTERM');
      await exited;
    }
    throw error;
  }
}

async function stop(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM');
  await process.exited;
}

export async function createIsolatedServer() {
  const directory = await mkdtemp(join(tmpdir(), 'touchline-browser-'));
  let process;
  try {
    process = await start(directory, 0);
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
  const url = process.url;
  let closed = false;
  return {
    directory,
    url,
    async restart() {
      if (closed) throw new Error('The isolated test server is closed.');
      await stop(process);
      process = await start(directory, Number(new URL(url).port));
    },
    async close() {
      if (closed) return;
      closed = true;
      await stop(process);
      // This is exclusively the directory created by this test harness.
      await rm(directory, {recursive: true, force: true});
    },
  };
}
