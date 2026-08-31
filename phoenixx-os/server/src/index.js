import { createApp } from './app.js';
import { config } from './config.js';
import { startJobRunner, stopJobRunner } from './services/jobs.js';
import { restoreSnapshot, startSnapshots, snapshotOnShutdown } from './services/snapshot.js';
import { nowIso } from './lib/util.js';

/**
 * Restore before anything else. This has to happen before the first import of
 * db/index.js, which opens the SQLite file as a side effect of being imported —
 * so the file has to be on disk by now. That is also why createApp() is called
 * below this line rather than at the top of the module.
 */
const restored = await restoreSnapshot();

const app = createApp();

/**
 * Free hosting tiers have no persistent disk: the container's filesystem — and
 * with it the SQLite file — is thrown away whenever the instance restarts.
 *
 * Two ways to survive that. If Supabase snapshots are configured, the database
 * was just downloaded above and comes back with real data in it. Otherwise
 * SEED_ON_BOOT refills an empty database with the demo workspace, so a cold
 * start is a working app rather than an empty login screen — but anything a
 * tester typed is gone.
 *
 * Seeding is skipped when a snapshot was restored: that database is not empty,
 * and the demo workspace has no business being poured into real data.
 */
if (config.seedOnBoot) {
  const { get, migrate } = await import('./db/index.js');
  migrate();
  const empty = !get('SELECT id FROM tenants LIMIT 1');
  if (empty && !restored) {
    console.log(JSON.stringify({ t: nowIso(), msg: 'empty database, seeding the demo workspace' }));
    await import('./seed.js');
  }
} else if (restored) {
  // Snapshots on, seeding off: still apply any schema added since the snapshot
  // was taken, or the code would be newer than the database it just restored.
  const { migrate } = await import('./db/index.js');
  migrate();
}

// Clients added to the register before delivery records existed would be
// missing from every project, proposal and invoice picker, with nothing on
// screen to explain why. Idempotent, and a no-op once consistent.
{
  const { backfillDeliveryRecords } = await import('./services/clientAccounts.js');
  const repaired = backfillDeliveryRecords();
  if (repaired) {
    console.log(JSON.stringify({
      t: nowIso(), msg: 'linked client accounts to delivery records', count: repaired,
    }));
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
  startSnapshots();
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ t: nowIso(), msg: `received ${signal}, shutting down` }));
  stopJobRunner();
  // Stop taking new requests first, so the snapshot captures a database nothing
  // is still writing to.
  server.close();

  // The last write wins: on a host that wipes the disk, this upload is the only
  // thing standing between the last few minutes of work and losing it.
  try { await snapshotOnShutdown(); } catch { /* logged inside */ }
  process.exit(0);
};

// Render allows ~30s between SIGTERM and SIGKILL; the upload gets 15 of them.
const HARD_EXIT_MS = 15_000;

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // Don't hang forever on a stuck upload or keep-alive connection.
    setTimeout(() => process.exit(1), HARD_EXIT_MS).unref();
    shutdown(signal);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
