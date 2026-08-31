import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { PokeClient } from './poke.js';
import { SessionManager } from './sessions.js';
import { buildServer } from './server.js';

const config = loadConfig();
const storage = new Storage(config);
const poke = new PokeClient(config);
const sessions = new SessionManager(storage, config);
const app = await buildServer({ config, storage, poke, sessions });

sessions.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  sessions.stop();
  await app.close();
  storage.close();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info({ host: config.HOST, port: config.PORT, publicBaseUrl: config.PUBLIC_BASE_URL }, 'poke-device-bridge started');
