import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { nowIso } from '../lib/util.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Durable storage for a host that has none.
 *
 * Render's free tier gives the container no persistent disk: the SQLite file is
 * destroyed on every restart, which happens after ~15 minutes of no traffic.
 * This module keeps a copy in Supabase Storage — downloaded on boot, uploaded
 * periodically and on shutdown — so the database outlives the container.
 *
 * It is a simulation of a disk, not a disk. Two consequences worth being clear
 * about, because they are the price of staying on a free tier:
 *
 *   1. If the host kills the process without a SIGTERM, everything written
 *      since the last upload is lost. `intervalMinutes` is that window.
 *   2. It assumes one instance. Two containers writing to the same bucket would
 *      each overwrite the other's snapshot, and the last one to exit wins.
 *      render.yaml pins this service to a single instance for other reasons
 *      too; do not scale it out while this is the storage layer.
 *
 * Snapshots alternate between two slots. A snapshot that is truncated — the
 * process is killed mid-upload, say — therefore lands on the slot that is NOT
 * the one being restored from, and the previous good copy is still there.
 */

const SLOTS = ['snapshot-a.db.gz', 'snapshot-b.db.gz'];
const MANIFEST = 'manifest.json';

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({ t: nowIso(), scope: 'snapshot', msg, ...extra }));

/** Configured and pointed at a real project. */
export const snapshotEnabled = () =>
  !!(config.snapshot.enabled && config.snapshot.url && config.snapshot.key);

/* ------------------------------------------------------------------ storage */

const objectUrl = (name) => {
  const base = config.snapshot.url.replace(/\/+$/, '');
  return `${base}/storage/v1/object/${config.snapshot.bucket}/${name}`;
};

const authHeaders = () => ({
  Authorization: `Bearer ${config.snapshot.key}`,
  apikey: config.snapshot.key,
});

async function putObject(name, body, contentType) {
  const res = await fetch(objectUrl(name), {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': contentType,
      // Supabase rejects a POST to an existing key unless upsert is asked for.
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) throw new Error(`upload ${name} failed: ${res.status} ${await res.text()}`);
}

async function getObject(name) {
  const res = await fetch(objectUrl(name), { headers: authHeaders() });
  if (res.status === 400 || res.status === 404) return null;   // not uploaded yet
  if (!res.ok) throw new Error(`download ${name} failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Creates the bucket if it is missing, so a fresh Supabase project needs no
 * clicking around in the dashboard. Private: these files are whole databases.
 */
async function ensureBucket() {
  const base = config.snapshot.url.replace(/\/+$/, '');
  const res = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: config.snapshot.bucket, id: config.snapshot.bucket, public: false }),
  });
  // 409 means it already exists, which is the normal case after the first boot.
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    if (!/already exists/i.test(body)) throw new Error(`create bucket failed: ${res.status} ${body}`);
  }
}

/* ------------------------------------------------------------------ restore */

/**
 * Pulls the newest usable snapshot onto local disk. Returns true if the
 * database was restored, false if there is nothing stored yet — in which case
 * the caller seeds a fresh one and the first upload becomes the baseline.
 *
 * Must run BEFORE anything imports db/index.js, which opens the file on import.
 */
export async function restoreSnapshot() {
  if (!snapshotEnabled()) return false;

  try {
    await ensureBucket();
    const manifestRaw = await getObject(MANIFEST);
    if (!manifestRaw) {
      log('no snapshot in the bucket yet, starting fresh');
      return false;
    }

    const manifest = JSON.parse(manifestRaw.toString('utf8'));
    // Newest first, then the other slot as a fallback if that one is unreadable.
    const order = [manifest.slot, SLOTS.find((s) => s !== manifest.slot)].filter(Boolean);

    for (const slot of order) {
      try {
        const gz = await getObject(slot);
        if (!gz) continue;
        const raw = await gunzip(gz);
        // A SQLite file starts with this exact string. Catches a truncated or
        // half-written upload before it replaces a working database.
        if (raw.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
          log('slot is not a SQLite file, trying the other one', { slot });
          continue;
        }

        fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
        // Stale -wal/-shm next to a restored file would corrupt it: they
        // describe a different database.
        for (const suffix of ['-wal', '-shm']) {
          const f = `${config.dbFile}${suffix}`;
          if (fs.existsSync(f)) fs.rmSync(f);
        }
        fs.writeFileSync(config.dbFile, raw);

        log('restored database from Supabase', {
          slot, bytes: raw.length, taken_at: manifest.taken_at,
        });
        return true;
      } catch (err) {
        log('could not restore from slot', { slot, error: err.message });
      }
    }

    log('every slot failed to restore, starting fresh');
    return false;
  } catch (err) {
    // Never let backup storage stop the app from booting.
    log('restore failed, continuing with local disk', { error: err.message });
    return false;
  }
}

/* ------------------------------------------------------------------- upload */

let nextSlot = 0;
let lastSignature = '';
let timer = null;
let inFlight = false;

/** Cheap "has anything changed" check, so an idle instance uploads nothing. */
function signature() {
  const parts = [];
  for (const suffix of ['', '-wal']) {
    try {
      const s = fs.statSync(`${config.dbFile}${suffix}`);
      parts.push(`${s.size}:${s.mtimeMs}`);
    } catch { parts.push('-'); }
  }
  return parts.join('|');
}

/**
 * Uploads a consistent copy of the database.
 *
 * `VACUUM INTO` is what makes this safe to run against a live database: SQLite
 * writes a complete, self-consistent copy, so there is no torn read and no need
 * to stop serving requests. Copying the file by hand while WAL mode is on would
 * not be safe.
 */
export async function takeSnapshot({ force = false, reason = 'interval' } = {}) {
  if (!snapshotEnabled()) return false;
  if (inFlight) return false;

  const sig = signature();
  if (!force && sig === lastSignature) return false;

  inFlight = true;
  const temp = `${config.dbFile}.snapshot`;
  try {
    const { db } = await import('../db/index.js');
    if (fs.existsSync(temp)) fs.rmSync(temp);
    // Parameters are not allowed in VACUUM INTO, and this path is ours, not
    // user input — but quote it properly regardless.
    db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);

    const gz = await gzip(fs.readFileSync(temp));
    const slot = SLOTS[nextSlot];

    await putObject(slot, gz, 'application/gzip');
    // The manifest is written only after the body is safely up, so it never
    // points at a half-written slot.
    await putObject(
      MANIFEST,
      JSON.stringify({ slot, taken_at: nowIso(), bytes: gz.length, reason }),
      'application/json',
    );

    nextSlot = (nextSlot + 1) % SLOTS.length;
    lastSignature = sig;
    log('uploaded snapshot', { slot, bytes: gz.length, reason });
    return true;
  } catch (err) {
    log('snapshot failed', { error: err.message, reason });
    return false;
  } finally {
    try { if (fs.existsSync(temp)) fs.rmSync(temp); } catch { /* best effort */ }
    inFlight = false;
  }
}

export function startSnapshots() {
  if (!snapshotEnabled()) {
    log('disabled — set SUPABASE_URL and SUPABASE_SERVICE_KEY to turn it on');
    return;
  }
  const ms = Math.max(1, config.snapshot.intervalMinutes) * 60_000;
  timer = setInterval(() => { takeSnapshot({ reason: 'interval' }); }, ms);
  timer.unref();
  log('snapshots on', { every_minutes: config.snapshot.intervalMinutes, bucket: config.snapshot.bucket });

  // The baseline, so a freshly seeded database is stored even if the instance
  // is killed before the first interval elapses.
  takeSnapshot({ force: true, reason: 'boot' });
}

export function stopSnapshots() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Final push on the way down. Awaited by the shutdown handler. */
export async function snapshotOnShutdown() {
  stopSnapshots();
  if (!snapshotEnabled()) return;
  await takeSnapshot({ force: true, reason: 'shutdown' });
}
