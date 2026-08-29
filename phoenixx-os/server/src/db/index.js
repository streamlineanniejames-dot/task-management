import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

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
