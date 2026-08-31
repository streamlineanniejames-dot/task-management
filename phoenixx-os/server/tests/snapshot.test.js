import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { useTempDatabase, seedPlan } from './helpers.js';

const dir = useTempDatabase();

// config.js reads the environment once, at import — so these have to be set
// before snapshot.js pulls it in below.
process.env.SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-role-key-for-tests';
process.env.SNAPSHOT_BUCKET = 'phoenixx-db';

/**
 * Supabase Storage, in memory. Enough of the REST surface for the module under
 * test: create bucket, upsert object, get object.
 */
const store = new Map();
let failNextUpload = false;

globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  const method = options.method || 'GET';
  const ok = (status = 200, body = '') => new Response(body, { status });

  if (path.endsWith('/storage/v1/bucket')) return ok(200, '{}');

  const key = path.replace('/storage/v1/object/phoenixx-db/', '');

  if (method === 'POST') {
    if (failNextUpload) { failNextUpload = false; return ok(500, 'simulated failure'); }
    const body = options.body;
    store.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
    return ok(200, '{}');
  }
  if (!store.has(key)) return ok(404, 'not found');
  return new Response(store.get(key), { status: 200 });
};

const db = await import('../src/db/index.js');
db.migrate();
await seedPlan(db);

const { takeSnapshot, restoreSnapshot, snapshotEnabled } = await import('../src/services/snapshot.js');
const { config } = await import('../src/config.js');

const manifest = () => JSON.parse(store.get('manifest.json').toString('utf8'));

/** Reads the restored file with a fresh handle, rather than the module's own. */
function readRestored() {
  const handle = new DatabaseSync(config.dbFile);
  try {
    return handle.prepare('SELECT code FROM plans').all().map((r) => ({ ...r }.code));
  } finally {
    handle.close();
  }
}

describe('snapshot to Supabase Storage', () => {
  test('is on when the project URL and key are configured', () => {
    assert.equal(snapshotEnabled(), true);
  });

  test('uploads a gzipped SQLite file and a manifest naming the slot', async () => {
    assert.equal(await takeSnapshot({ force: true, reason: 'test' }), true);

    const m = manifest();
    assert.equal(m.slot, 'snapshot-a.db.gz');
    assert.ok(m.taken_at);

    const raw = zlib.gunzipSync(store.get('snapshot-a.db.gz'));
    assert.equal(raw.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  });

  test('alternates slots, so a bad write cannot clobber the good copy', async () => {
    await takeSnapshot({ force: true, reason: 'test' });
    assert.equal(manifest().slot, 'snapshot-b.db.gz');
    assert.ok(store.has('snapshot-a.db.gz'), 'the previous slot is still there');

    await takeSnapshot({ force: true, reason: 'test' });
    assert.equal(manifest().slot, 'snapshot-a.db.gz');
  });

  test('skips the upload when nothing has changed since the last one', async () => {
    await takeSnapshot({ force: true, reason: 'test' });
    const before = manifest().taken_at;
    assert.equal(await takeSnapshot({ reason: 'interval' }), false);
    assert.equal(manifest().taken_at, before);
  });

  test('a failed upload leaves the previous manifest intact', async () => {
    const before = manifest();
    failNextUpload = true;
    assert.equal(await takeSnapshot({ force: true, reason: 'test' }), false);
    assert.deepEqual(manifest(), before, 'the manifest still points at the last good snapshot');
  });

  test('restores the database onto an empty disk', async () => {
    await takeSnapshot({ force: true, reason: 'test' });

    // Close the module's handle before the file is replaced under it.
    db.db.close();
    fs.rmSync(config.dbFile);
    for (const suffix of ['-wal', '-shm']) {
      const f = `${config.dbFile}${suffix}`;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    assert.equal(fs.existsSync(config.dbFile), false);

    assert.equal(await restoreSnapshot(), true);
    assert.ok(readRestored().includes('growth'), 'the seeded plan came back');
  });

  test('falls back to the other slot when the newest one is corrupt', async () => {
    const good = store.get(manifest().slot === 'snapshot-a.db.gz' ? 'snapshot-b.db.gz' : 'snapshot-a.db.gz');
    assert.ok(good, 'the older slot exists to fall back to');

    store.set(manifest().slot, zlib.gzipSync(Buffer.from('this is not a database')));
    fs.rmSync(config.dbFile);

    assert.equal(await restoreSnapshot(), true);
    assert.ok(readRestored().includes('growth'), 'restored from the older slot');
  });

  test('reports nothing to restore when the bucket is empty', async () => {
    store.clear();
    assert.equal(await restoreSnapshot(), false);
  });

  test('cleans up the temporary VACUUM file', () => {
    assert.equal(fs.existsSync(`${config.dbFile}.snapshot`), false);
    assert.ok(dir);
  });
});
