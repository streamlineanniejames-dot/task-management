import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { dueAtIso, DEFAULT_TZ } from '../lib/dueTime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.storageDir, { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

/** Apply schema.sql (idempotent - every statement is CREATE ... IF NOT EXISTS). */
export function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  addColumns();
  addIndexes();
  backfill();
}

/**
 * Indexes over columns that arrive through `ADDED_COLUMNS`. They cannot live in
 * schema.sql: that file is applied before the ALTERs, so on an existing
 * database the column would not be there yet and the CREATE INDEX would fail
 * the whole migration.
 */
const ADDED_INDEXES = [
  // Overdue is asked of the instant now, on every list, counter and My Day.
  ['action_items', 'due_at', 'CREATE INDEX IF NOT EXISTS ix_ai_due_at ON action_items(tenant_id, status, due_at)'],
  // HR's queue of late arrivals waiting on a ruling.
  ['attendance', 'scheduled_start', 'CREATE INDEX IF NOT EXISTS ix_att_status ON attendance(tenant_id, status, work_date)'],
];

function addIndexes() {
  for (const [table, column, sql] of ADDED_INDEXES) {
    if (tableExists(table) && hasColumn(table, column)) db.exec(sql);
  }
}

/**
 * One-off data repairs, run after the columns they touch are guaranteed to
 * exist. Every one of these has to be a no-op on the second boot.
 */
function backfill() {
  // Creator validation arrived after these tasks were already closed. They
  // were finished under the rules of the day, so they count as settled -
  // leaving them unset would park years of historic work in a sign-off queue
  // nobody asked for. `validated_by` stays empty on purpose: nobody actually
  // signed these off, and inventing a name for the record would be a lie.
  if (tableExists('action_items') && hasColumn('action_items', 'validation_status')) {
    db.exec(`UPDATE action_items
                SET validation_status = 'validated',
                    validated_at = COALESCE(completed_at, updated_at)
              WHERE status = 'done' AND validation_status IS NULL`);
  }

  // Every task that predates same-day scheduling has a date and no time, which
  // has always meant "by the end of that day" - so that is the instant it gets.
  // Resolved per tenant because the day ends at a different moment in each
  // workspace timezone. Idempotent: only rows with no instant are touched.
  if (tableExists('action_items') && hasColumn('action_items', 'due_at')) backfillDueAt();
}

function backfillDueAt() {
  const stale = db.prepare(
    `SELECT a.id, a.due_date, a.due_time, COALESCE(t.timezone, ?) AS tz
       FROM action_items a LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.due_date IS NOT NULL AND a.due_date != '' AND a.due_at IS NULL`,
  ).all(DEFAULT_TZ);
  if (!stale.length) return;

  const stmt = db.prepare('UPDATE action_items SET due_at = ? WHERE id = ?');
  for (const row of stale) {
    const at = dueAtIso(row.due_date, row.due_time, row.tz);
    if (at) stmt.run(at, row.id);
  }
}

/**
 * Additive migrations for columns introduced after a database already exists.
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that is already
 * there, so anything new has to arrive as an ALTER guarded by a column check.
 * Each entry must be nullable or carry a DEFAULT - SQLite cannot add a NOT NULL
 * column without one.
 */
const ADDED_COLUMNS = [
  // Manual card order inside a pipeline stage (Kanban board drag-and-drop).
  // REAL, not INTEGER: positions are assigned as the midpoint between the two
  // neighbours, so a reorder touches one row instead of renumbering the column.
  ['clients', 'board_sort', 'REAL NOT NULL DEFAULT 0'],
  // Links a pipeline lead to the client master record it belongs to. Nullable:
  // most leads are for companies not yet on file, and they stay that way until
  // someone attaches them. No REFERENCES clause here - SQLite cannot add a
  // foreign key with ALTER TABLE, so on an existing database this is a plain
  // TEXT column; new databases get the constraint from schema.sql.
  ['clients', 'client_account_id', 'TEXT'],
  // Delivery lead on a project, alongside the existing manager_id. Mirrors the
  // project_members row holding the 'lead' seat.
  ['projects', 'lead_id', 'TEXT'],
  // Security-question account recovery. The question is shown back to whoever
  // is trying to recover, so it is stored in the clear; the answer never is.
  ['users', 'security_question', 'TEXT'],
  ['users', 'security_answer_hash', 'TEXT'],
  ['users', 'security_updated_at', 'TEXT'],
  // Wrong-answer throttling lives on the row rather than in the in-memory rate
  // limiter: a lockout has to survive a restart and cannot be shed by moving IP.
  ['users', 'recovery_failed_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'recovery_locked_until', 'TEXT'],
  // Single-use, short-lived, stored as a SHA-256 digest like refresh tokens.
  ['users', 'recovery_token', 'TEXT'],
  ['users', 'recovery_token_expires_at', 'TEXT'],
  // Creator sign-off on completed work. `validation_status` is NULL while the
  // task is still being worked, 'pending' once the assignee marks it done,
  // then 'validated' or 'changes_requested' once the creator has ruled. Left
  // nullable rather than defaulted so existing rows read as "no validation
  // ever asked for", which is exactly what they are.
  ['action_items', 'validation_status', 'TEXT'],
  ['action_items', 'completed_by', 'TEXT'],
  ['action_items', 'validated_by', 'TEXT'],
  ['action_items', 'validated_at', 'TEXT'],
  ['action_items', 'validation_note', 'TEXT'],
  // How many times the work has come back for changes. Drives the "2nd
  // attempt" hint in the UI and is the number a manager actually wants.
  ['action_items', 'rework_count', 'INTEGER NOT NULL DEFAULT 0'],
  // Same-day scheduling. `due_time` is the workspace-local 'HH:MM' the task is
  // wanted by, NULL for a task that is simply due that day; `due_at` is the UTC
  // instant the date and time resolve to and is what every overdue test reads.
  // Both nullable: a task with no due date has neither.
  ['action_items', 'due_time', 'TEXT'],
  ['action_items', 'due_at', 'TEXT'],
  // The working day, as HR defines it. Workspace defaults first, then the
  // per-employee overrides that fall back to them when NULL.
  ['tenants', 'work_start', "TEXT NOT NULL DEFAULT '09:30'"],
  ['tenants', 'work_end', "TEXT NOT NULL DEFAULT '18:30'"],
  ['tenants', 'late_grace_minutes', 'INTEGER NOT NULL DEFAULT 10'],
  // JSON weekday numbers, 0 = Sunday. A workspace upgrading into this keeps
  // Saturday off, because that is what its register has always shown; a new
  // one starts on Sunday-only, which is what the product now specifies.
  ['tenants', 'week_off_days', "TEXT NOT NULL DEFAULT '[0,6]'"],
  ['users', 'work_start', 'TEXT'],
  ['users', 'work_end', 'TEXT'],
  ['users', 'grace_minutes', 'INTEGER'],
  // The schedule a day was actually judged against, and HR's ruling on it.
  ['attendance', 'scheduled_start', 'TEXT'],
  ['attendance', 'scheduled_end', 'TEXT'],
  ['attendance', 'approved_by', 'TEXT'],
  ['attendance', 'approved_at', 'TEXT'],
  ['attendance', 'approval_note', 'TEXT'],
];

function addColumns() {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    if (!tableExists(table) || hasColumn(table, column)) continue;
    db.exec(`ALTER TABLE ${assertIdent(table, 'table')} ADD COLUMN ${assertIdent(column, 'column')} ${decl}`);
    columnCache.delete(table);
  }
}

// -------------------------------------------------------------- query helpers
// node:sqlite returns null-prototype objects; normalise so JSON.stringify and
// spread behave predictably across the codebase.
const plain = (row) => (row ? { ...row } : row);

export const all = (sql, params = []) => db.prepare(sql).all(...params).map(plain);
export const get = (sql, params = []) => plain(db.prepare(sql).get(...params));
export const run = (sql, params = []) => db.prepare(sql).run(...params);
export const pluck = (sql, params = []) => {
  const row = get(sql, params);
  return row ? Object.values(row)[0] : undefined;
};

/** Synchronous transaction wrapper (node:sqlite is sync by design). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

// ------------------------------------------------------ tenant-scoped repository
// Defence in depth (AR1): callers never hand-write `tenant_id = ?`; the repo
// injects it. In the PostgreSQL target this layer is backed by RLS policies too.
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const assertIdent = (s, what) => {
  if (!IDENT.test(s)) throw new Error(`unsafe ${what}: ${s}`);
  return s;
};

export function repo(table, tenantId) {
  assertIdent(table, 'table');
  if (!tenantId) throw new Error(`repo(${table}) requires a tenantId`);

  const softDeletable = hasColumn(table, 'deleted_at');
  const alive = softDeletable ? ' AND deleted_at IS NULL' : '';

  return {
    table,
    tenantId,
    findById(id, { withDeleted = false } = {}) {
      return get(
        `SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?${withDeleted ? '' : alive}`,
        [id, tenantId],
      );
    },
    findAll({ where = '', params = [], order = '', limit, offset, withDeleted = false } = {}) {
      let sql = `SELECT * FROM ${table} WHERE tenant_id = ?${withDeleted ? '' : alive}`;
      if (where) sql += ` AND (${where})`;
      if (order) sql += ` ORDER BY ${order}`;
      if (limit != null) sql += ` LIMIT ${Number(limit)}`;
      if (offset) sql += ` OFFSET ${Number(offset)}`;
      return all(sql, [tenantId, ...params]);
    },
    count({ where = '', params = [], withDeleted = false } = {}) {
      let sql = `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?${withDeleted ? '' : alive}`;
      if (where) sql += ` AND (${where})`;
      return Number(pluck(sql, [tenantId, ...params]) || 0);
    },
    insert(data) {
      const row = { ...data, tenant_id: tenantId };
      const cols = Object.keys(row).map((c) => assertIdent(c, 'column'));
      run(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map((c) => row[c]),
      );
      return this.findById(row.id, { withDeleted: true });
    },
    update(id, data) {
      const cols = Object.keys(data).map((c) => assertIdent(c, 'column'));
      if (!cols.length) return this.findById(id);
      run(
        `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...cols.map((c) => data[c]), id, tenantId],
      );
      return this.findById(id, { withDeleted: true });
    },
    softDelete(id, at) {
      if (!softDeletable) return this.hardDelete(id);
      run(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND tenant_id = ?`, [at, id, tenantId]);
      return true;
    },
    hardDelete(id) {
      run(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
      return true;
    },
  };
}

const columnCache = new Map();
export function hasColumn(table, column) {
  assertIdent(table, 'table');
  if (!columnCache.has(table)) {
    const cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
    columnCache.set(table, new Set(cols));
  }
  return columnCache.get(table).has(column);
}

export function tableExists(table) {
  return !!get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', table]);
}
