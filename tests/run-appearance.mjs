import {join} from 'node:path';
import {verifyAppearanceState} from './browser/appearance-state.mjs';
import {createIsolatedServer} from './browser/server.mjs';

const server = await createIsolatedServer();
try {
  process.env.TOUCHLINE_URL = server.url;
  process.env.TOUCHLINE_ARTIFACT_DIR = join(server.directory, 'artifacts');
  await import('./appearance.mjs');
  await verifyAppearanceState(server);
} finally {
  await server.close();
}
