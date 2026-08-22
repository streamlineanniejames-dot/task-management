import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run, tx, hasColumn } from '../db/index.js';
import { uuid, nowIso, todayIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, ApiError } from '../lib/http.js';
import { config } from '../config.js';
import { syncDeadline } from './actionItems.routes.js';

const router = Router();

/**
 * AR5 - mobile sync.
 *
 * `GET /sync?updated_since=` returns a delta across the tables the mobile app
 * caches. `POST /sync/queue` replays actions taken while offline. Conflicts are
 * last-write-wins, and every resolved conflict is reported back to the client
 * so the user can be told what happened rather than silently losing an edit.
 */

const SYNCED_TABLES = {
  action_items: `SELECT a.*, u.name AS owner_name, c.name AS client_name FROM action_items a
                   LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN clients c ON c.id = a.client_id`,
  clients: 'SELECT c.* FROM clients c',
  contacts: 'SELECT c.* FROM contacts c',
  meetings: 'SELECT m.* FROM meetings m',
  notifications: 'SELECT n.* FROM notifications n',
  attendance: 'SELECT a.* FROM attendance a',
  leave_requests: 'SELECT l.* FROM leave_requests l',
  action_categories: 'SELECT a.* FROM action_categories a',
  service_lines: 'SELECT s.* FROM service_lines s',
  pipeline_stages: 'SELECT p.* FROM pipeline_stages p',
};

const alias = { action_items: 'a', clients: 'c', contacts: 'c', meetings: 'm', notifications: 'n', attendance: 'a', leave_requests: 'l', action_categories: 'a', service_lines: 's', pipeline_stages: 'p' };

router.get('/', (req, res) => {
  const { tenantId, userId, scope } = req.auth;
  const since = req.query.updated_since || '1970-01-01T00:00:00.000Z';
  const tables = req.query.tables ? String(req.query.tables).split(',') : Object.keys(SYNCED_TABLES);
  const limit = Math.min(500, Number(req.query.limit) || 300);

  const delta = {};
  for (const table of tables) {
    const base = SYNCED_TABLES[table];
    if (!base) continue;
    const a = alias[table];
    const filters = [`${a}.tenant_id = ?`];
    const params = [tenantId];

    // The timestamp column differs by table - reference data such as
    // action_categories is insert-only and has no updated_at at all, so the
    // column is chosen from the actual schema rather than assumed.
    const stamp = hasColumn(table, 'updated_at') ? 'updated_at' : 'created_at';
    filters.push(`${a}.${stamp} > ?`);
    params.push(since);

    // Employees sync only their own slice, which keeps the payload small.
    if (scope === 'own') {
      if (table === 'action_items') { filters.push(`(${a}.owner_id = ? OR ${a}.created_by = ?)`); params.push(userId, userId); }
      if (table === 'clients') { filters.push(`${a}.owner_id = ?`); params.push(userId); }
      if (['attendance', 'leave_requests', 'notifications'].includes(table)) { filters.push(`${a}.user_id = ?`); params.push(userId); }
    }

    const rows = all(`${base} WHERE ${filters.join(' AND ')} ORDER BY ${a}.${stamp} LIMIT ?`,
      [...params, limit]);
    delta[table] = rows;
  }

  return ok(res, delta, {
    synced_at: nowIso(),
    since,
    counts: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, v.length])),
    // A full page means there is more to fetch; the client re-syncs from here.
    has_more: Object.values(delta).some((v) => v.length >= limit),
  });
});

/**
 * Replays a queue of offline actions. Each entry carries a client-generated
 * `client_id` so a retried queue never double-applies.
 */
const queueSchema = z.object({
  operations: z.array(z.object({
    client_id: z.string().min(4).max(64),
    type: z.enum([
      'action_item.create', 'action_item.update', 'action_item.complete',
      'attendance.check_in', 'attendance.check_out',
      'activity.log', 'comment.create',
    ]),
    payload: z.record(z.string(), z.any()),
    created_at: z.string(),
  })).max(200),
});

router.post('/queue', (req, res) => {
  const { operations } = validate(queueSchema, req.body);
  const { tenantId, userId } = req.auth;
  const results = [];

  for (const op of operations) {
    const dedupeKey = `sync:${userId}:${op.client_id}`;
    const seen = get('SELECT response_json FROM idempotency_keys WHERE tenant_id = ? AND key = ? AND endpoint = ?',
      [tenantId, dedupeKey, 'sync.queue']);
    if (seen) {
      results.push({ client_id: op.client_id, status: 'duplicate', ...JSON.parse(seen.response_json) });
      continue;
    }

    try {
      const outcome = tx(() => applyOperation({ tenantId, userId, op, auth: req.auth }));
      run(
        `INSERT INTO idempotency_keys (tenant_id, key, endpoint, response_json, status_code, created_at)
         VALUES (?,?, 'sync.queue', ?, 200, ?)`,
        [tenantId, dedupeKey, JSON.stringify(outcome), nowIso()],
      );
      results.push({ client_id: op.client_id, status: 'applied', ...outcome });
    } catch (err) {
      results.push({ client_id: op.client_id, status: 'failed', error: err.message });
    }
  }

  return ok(res, results, {
    applied: results.filter((r) => r.status === 'applied').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    failed: results.filter((r) => r.status === 'failed').length,
    synced_at: nowIso(),
  });
});

function applyOperation({ tenantId, userId, op, auth }) {
  const ts = nowIso();

  switch (op.type) {
    case 'action_item.create': {
      const id = op.payload.id || uuid();
      run(
        `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
           category_id, priority, status, due_date, source_type, estimate_minutes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'open', ?, 'mobile_offline', ?, ?, ?)`,
        [id, tenantId, op.payload.title, op.payload.description ?? null,
          op.payload.owner_id || userId, userId, op.payload.client_id ?? null,
          op.payload.category_id ?? null, op.payload.priority || 'medium',
          op.payload.due_date ?? null, op.payload.estimate_minutes ?? null,
          op.created_at || ts, ts],
      );
      const item = get('SELECT * FROM action_items WHERE id = ?', [id]);
      syncDeadline(tenantId, item);
      return { entity: 'action_item', id, server_updated_at: ts };
    }

    case 'action_item.update':
    case 'action_item.complete': {
      const item = get('SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
        [op.payload.id, tenantId]);
      if (!item) throw new Error('Action item no longer exists');

      // Last-write-wins, but a server edit newer than the queued one is reported.
      const conflict = item.updated_at > op.created_at;
      const patch = op.type === 'action_item.complete'
        ? { status: 'done', completed_at: op.created_at || ts, updated_at: ts }
        : { ...op.payload, id: undefined, updated_at: ts };
      delete patch.id;

      const cols = Object.keys(patch).filter((c) => patch[c] !== undefined);
      run(`UPDATE action_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...cols.map((c) => patch[c]), item.id, tenantId]);

      const after = get('SELECT * FROM action_items WHERE id = ?', [item.id]);
      syncDeadline(tenantId, after);
      return {
        entity: 'action_item',
        id: item.id,
        server_updated_at: ts,
        ...(conflict && {
          conflict: 'last_write_wins',
          overwrote_server_version_at: item.updated_at,
          message: 'This item had also been changed on the server; your offline edit was applied.',
        }),
      };
    }

    case 'attendance.check_in': {
      const workDate = op.payload.work_date || (op.created_at || ts).slice(0, 10);
      const existing = get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
        [tenantId, userId, workDate]);
      if (existing?.check_in_at) return { entity: 'attendance', id: existing.id, skipped: 'already checked in' };

      const id = existing?.id || uuid();
      run(
        `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, in_lat, in_lng,
           source, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'mobile', 'present', ?, ?)
         ON CONFLICT (tenant_id, user_id, work_date) DO UPDATE SET
           check_in_at = excluded.check_in_at, in_lat = excluded.in_lat, in_lng = excluded.in_lng,
           source = 'mobile', updated_at = excluded.updated_at`,
        [id, tenantId, userId, workDate, op.created_at || ts,
          op.payload.lat ?? null, op.payload.lng ?? null, ts, ts],
      );
      return { entity: 'attendance', id, server_updated_at: ts };
    }

    case 'attendance.check_out': {
      const workDate = op.payload.work_date || (op.created_at || ts).slice(0, 10);
      const row = get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
        [tenantId, userId, workDate]);
      if (!row?.check_in_at) throw new Error('No check-in recorded for that day');

      const minutes = Math.max(0, Math.round((new Date(op.created_at || ts) - new Date(row.check_in_at)) / 60_000));
      run(
        `UPDATE attendance SET check_out_at = ?, out_lat = ?, out_lng = ?, work_minutes = ?, updated_at = ? WHERE id = ?`,
        [op.created_at || ts, op.payload.lat ?? null, op.payload.lng ?? null, minutes, ts, row.id],
      );
      return { entity: 'attendance', id: row.id, work_minutes: minutes, server_updated_at: ts };
    }

    case 'activity.log': {
      const id = uuid();
      run(
        `INSERT INTO activities (id, tenant_id, client_id, contact_id, type, direction, subject, body,
           outcome, occurred_at, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, op.payload.client_id, op.payload.contact_id ?? null, op.payload.type || 'call',
          op.payload.direction || 'outbound', op.payload.subject ?? null, op.payload.body ?? null,
          op.payload.outcome ?? null, op.created_at || ts, userId, ts],
      );
      const patch = { last_activity_at: op.created_at || ts, updated_at: ts };
      if (op.payload.next_action) {
        patch.next_action = op.payload.next_action;
        patch.next_action_date = op.payload.next_action_date ?? null;
      }
      const cols = Object.keys(patch);
      run(`UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...cols.map((c) => patch[c]), op.payload.client_id, tenantId]);
      return { entity: 'activity', id, server_updated_at: ts };
    }

    case 'comment.create': {
      const id = uuid();
      run(
        `INSERT INTO comments (id, tenant_id, entity, entity_id, author_id, body, mentions, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, op.payload.entity, op.payload.entity_id, userId, op.payload.body,
          JSON.stringify(op.payload.mentions || []), op.created_at || ts, ts],
      );
      return { entity: 'comment', id, server_updated_at: ts };
    }

    default:
      throw new Error(`Unsupported operation "${op.type}"`);
  }
}

/** Bootstrap payload for a fresh mobile install. */
router.get('/bootstrap', (req, res) => {
  const { tenantId, userId } = req.auth;
  return ok(res, {
    server_time: nowIso(),
    tenant: get('SELECT id, name, timezone, currency, number_format, brand_primary, brand_accent, logo_url FROM tenants WHERE id = ?', [tenantId]),
    directory: all(
      "SELECT id, name, email, role, designation, avatar_url FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'",
      [tenantId],
    ),
    action_categories: all('SELECT * FROM action_categories WHERE tenant_id = ? AND active = 1', [tenantId]),
    service_lines: all('SELECT * FROM service_lines WHERE tenant_id = ? AND deleted_at IS NULL AND active = 1', [tenantId]),
    pipeline_stages: all('SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort', [tenantId]),
    leave_types: all('SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1', [tenantId]),
    my_attendance_today: get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
      [tenantId, userId, todayIso()]) || null,
  });
});

// ================================================================== FILES
/** A5/A6 - attachments, including mobile voice notes. */
const fileRouter = Router();

fileRouter.post('/', (req, res) => {
  const body = validate(z.object({
    entity: z.string().min(2).max(40),
    entity_id: z.string(),
    filename: z.string().min(1).max(200),
    mime: z.string().optional(),
    kind: z.enum(['file', 'voice_note']).optional(),
    // Base64 keeps the dev harness dependency-free; production swaps this for
    // a pre-signed S3 upload and stores only the returned key.
    content_base64: z.string().max(20_000_000),
  }), req.body);

  const buffer = Buffer.from(body.content_base64, 'base64');
  if (buffer.length > 15 * 1024 * 1024) throw badRequest('Files are limited to 15 MB');

  const safeName = body.filename.replace(/[^\w.\- ]/g, '_');
  const rel = path.posix.join('attachments', req.auth.tenantId, `${uuid()}-${safeName}`);
  const abs = path.join(config.storageDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);

  const id = uuid();
  run(
    `INSERT INTO attachments (id, tenant_id, entity, entity_id, filename, mime, size_bytes,
       storage_path, kind, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.entity, body.entity_id, body.filename, body.mime ?? null,
      buffer.length, rel, body.kind || 'file', req.auth.userId, nowIso()],
  );

  return created(res, { ...get('SELECT * FROM attachments WHERE id = ?', [id]), url: `/api/v1/files/${rel}` });
});

fileRouter.get('/list', (req, res) => ok(res, all(
  `SELECT a.*, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.tenant_id = ? AND a.entity = ? AND a.entity_id = ? AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC`,
  [req.auth.tenantId, req.query.entity, req.query.entity_id],
).map((a) => ({ ...a, url: `/api/v1/files/${a.storage_path}` }))));

fileRouter.delete('/:id', (req, res) => {
  const att = get('SELECT * FROM attachments WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!att) throw notFound('Attachment');
  run('UPDATE attachments SET deleted_at = ? WHERE id = ?', [nowIso(), att.id]);
  return ok(res, { ok: true });
});

/** Serves a stored file. The tenant prefix in the path is checked against the caller. */
fileRouter.get('/*splat', (req, res, next) => {
  try {
    const rel = (req.params.splat || []).join('/') || req.path.replace(/^\//, '');
    const safe = path.posix.normalize(rel).replace(/^(\.\.(\/|$))+/, '');
    const abs = path.join(config.storageDir, safe);

    if (!abs.startsWith(path.resolve(config.storageDir))) throw new ApiError(400, 'bad_path', 'Invalid file path');
    if (!fs.existsSync(abs)) throw notFound('File');

    // Attachments live under attachments/<tenant_id>/ - enforce ownership.
    if (safe.startsWith('attachments/')) {
      const owner = safe.split('/')[1];
      if (owner !== req.auth.tenantId) throw notFound('File');
    } else {
      // Generated documents are looked up by their recorded path.
      const known = get(
        `SELECT 1 AS ok FROM invoices WHERE tenant_id = ? AND pdf_path = ?
         UNION SELECT 1 FROM proposals WHERE tenant_id = ? AND pdf_path = ?
         UNION SELECT 1 FROM report_runs WHERE tenant_id = ? AND pdf_path = ?`,
        [req.auth.tenantId, safe, req.auth.tenantId, safe, req.auth.tenantId, safe],
      );
      if (!known) throw notFound('File');
    }

    res.sendFile(abs);
  } catch (err) { next(err); }
});

export { router as syncRouter, fileRouter };
