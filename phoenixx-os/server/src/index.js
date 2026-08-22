import { createApp } from './app.js';
import { config } from './config.js';
import { startJobRunner, stopJobRunner } from './services/jobs.js';
import { nowIso } from './lib/util.js';

const app = createApp();

/**
 * Free hosting tiers have no persistent disk: the container's filesystem — and
 * with it the SQLite file — is thrown away whenever the instance restarts. With
 * SEED_ON_BOOT set, an empty database is refilled with the demo workspace, so a
 * cold start comes back up as a working app instead of an empty login screen.
 * Anything a tester typed is gone; that is the trade a free tier makes. On a
 * paid instance with a disk attached, leave this off.
 */
if (config.seedOnBoot) {
  const { get, migrate } = await import('./db/index.js');
  migrate();
  const empty = !get('SELECT id FROM tenants LIMIT 1');
  if (empty) {
    console.log(JSON.stringify({ t: nowIso(), msg: 'empty database, seeding the demo workspace' }));
    await import('./seed.js');
  }
}

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({
    t: nowIso(),
    msg: 'Phoenixx OS API listening',
    port: config.port,
    env: config.env,
    docs: `${config.apiBaseUrl}/api/v1/openapi.json`,
  }));
  startJobRunner();
});

const shutdown = (signal) => {
  console.log(JSON.stringify({ t: nowIso(), msg: `received ${signal}, shutting down` }));
  stopJobRunner();
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck keep-alive connection.
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
