import {join} from 'node:path';
import {createIsolatedServer} from './browser/server.mjs';

const server = await createIsolatedServer();
try {
  process.env.TOUCHLINE_URL = server.url;
  process.env.TOUCHLINE_ARTIFACT_DIR = join(server.directory, 'artifacts');
  await import('./appearance.mjs');
} finally {
  await server.close();
}
