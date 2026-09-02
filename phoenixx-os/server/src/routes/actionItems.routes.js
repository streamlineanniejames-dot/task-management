import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, todayIso, parseJson, toCsv } from '../lib/util.js';
import {
  ok, created, validate, notFound, badRequest, forbidden, audit, paginate, pageMeta, sortClause,
} from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { scopeFilter } from '../middleware/auth.js';
import { upsertDeadline, resolveDeadline, resolveEscalations, raiseEscalation } from '../services/deadlines.js';
import { notifyMany } from '../services/notifications.js';
import { emitWebhook } from '../services/webhooks.js';

const router = Router();

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const itemSchema = z.object({
  title: z.string().min(2).max(240),
  description: z.string().max(8000).optional().nullable(),
  /** The one person accountable. Everything downstream - the reminder ladder,
   *  the escalation target, the overdue counters - reads this one column. */
  owner_id: z.string().optional().nullable(),
  /** Everyone else working the task. The owner is implicit and never needs
   *  listing here; sending an empty array clears the extras. */
  assignee_ids: z.array(z.string()).max(40).optional(),
  /** Staff the task from a project team in one go: every seated member becomes
   *  an assignee, and `owner_id` names which of them answers for it. */
  assign_from_project_id: z.string().optional().nullable(),
  client_id: z.string().optional().nullable(),
  project_id: z.string().optional().nullable(),
  category_id: z.string().optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES).optional(),
  due_date: z.string().optional().nullable(),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).optional().nullable(),
  recurrence_until: z.string().optional().nullable(),
  estimate_minutes: z.number().int().min(0).optional().nullable(),
  watchers: z.array(z.string()).optional(),
  source_type: z.string().optional().nullable(),
  source_id: z.string().optional().nullable(),
  sop_id: z.string().optional().nullable(),
  blocked_reason: z.string().optional().nullable(),
});

const SORTS = {
  due_date: 'a.due_date',
  created_at: 'a.created_at',
  updated_at: 'a.updated_at',
  priority: `CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
  title: 'a.title',
  status: 'a.status',
};

const SELECT = `
  SELECT a.*, u.name AS owner_name, u.avatar_url AS owner_avatar, u.designation AS owner_designation,
         cb.name AS created_by_name, cb.avatar_url AS created_by_avatar,
         c.name AS client_name, ac.name AS category_name, ac.color AS category_color,
         p.name AS project_name,
         (SELECT COUNT(*) FROM action_assignees aa WHERE aa.action_item_id = a.id) AS extra_assignee_count,
         (SELECT COUNT(*) FROM comments cm WHERE cm.entity = 'action_item' AND cm.entity_id = a.id AND cm.deleted_at IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM attachments at WHERE at.entity = 'action_item' AND at.entity_id = a.id AND at.deleted_at IS NULL) AS attachment_count
    FROM action_items a
    LEFT JOIN users u ON u.id = a.owner_id
    LEFT JOIN users cb ON cb.id = a.created_by
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN action_categories ac ON ac.id = a.category_id`;

/** SQL that is true when :user is on the task, as owner or as an extra. */
const IS_ASSIGNED = `(a.owner_id = ? OR EXISTS (
  SELECT 1 FROM action_assignees aa WHERE aa.action_item_id = a.id AND aa.user_id = ?))`;

/**
 * The whole team on a task: the accountable owner first, then everyone else,
 * so the UI never has to merge two lists or decide who leads.
 */
function assigneesOf(tenantId, item) {
  const rows = all(
    `SELECT aa.user_id, u.name, u.avatar_url, u.designation, u.email, ab.name AS assigned_by_name,
            aa.created_at AS assigned_at
       FROM action_assignees aa
       JOIN users u ON u.id = aa.user_id
       LEFT JOIN users ab ON ab.id = aa.assigned_by
      WHERE aa.tenant_id = ? AND aa.action_item_id = ?
      ORDER BY u.name`,
    [tenantId, item.id],
  ).filter((r) => r.user_id !== item.owner_id);

  const owner = item.owner_id
    ? get('SELECT id AS user_id, name, avatar_url, designation, email FROM users WHERE id = ?', [item.owner_id])
    : null;

  return [
    ...(owner ? [{ ...owner, accountable: true }] : []),
    ...rows.map((r) => ({ ...r, accountable: false })),
  ];
}

/** Everyone assigned, as plain ids - for notifications and update checks. */
const assigneeIds = (tenantId, itemId, ownerId) => [...new Set([
  ownerId,
  ...all('SELECT user_id FROM action_assignees WHERE tenant_id = ? AND action_item_id = ?',
    [tenantId, itemId]).map((r) => r.user_id),
].filter(Boolean))];

/**
 * Replaces the extra-assignee list. The owner is never stored here: they are
 * already accountable through `owner_id`, and holding them in both places is
 * how the two would eventually disagree.
 */
function setAssignees(req, itemId, userIds, ownerId) {
  const { tenantId, userId } = req.auth;
  const wanted = [...new Set(userIds.filter((id) => id && id !== ownerId))];

  if (wanted.length) {
    const real = all(
      `SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client'
         AND id IN (${wanted.map(() => '?').join(',')})`,
      [tenantId, ...wanted],
    ).map((u) => u.id);
    const missing = wanted.filter((id) => !real.includes(id));
    if (missing.length) throw badRequest('One of those people is not in this workspace');
  }

  run('DELETE FROM action_assignees WHERE action_item_id = ? AND tenant_id = ?', [itemId, tenantId]);
  for (const id of wanted) {
    run(
      `INSERT OR IGNORE INTO action_assignees (id, tenant_id, action_item_id, user_id, assigned_by, created_at)
       VALUES (?,?,?,?,?,?)`,
      [uuid(), tenantId, itemId, id, userId, nowIso()],
    );
  }
  return wanted;
}

/** Everyone seated on a project, for "assign this to the delivery team". */
const projectTeamIds = (tenantId, projectId) => all(
  `SELECT pm.user_id FROM project_members pm
     JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    WHERE pm.tenant_id = ? AND pm.project_id = ? AND pm.deleted_at IS NULL`,
  [tenantId, projectId],
).map((r) => r.user_id);

/** Tells people they have been put on a task. Never the person doing it. */
function notifyAssigned(req, item, userIds) {
  const targets = userIds.filter((id) => id && id !== req.auth.userId);
  if (!targets.length) return;
  notifyMany({
    tenantId: req.auth.tenantId,
    userIds: targets,
    eventKey: 'action_item.assigned',
    vars: {
      title: item.title,
      priority: item.priority,
      due_date: item.due_date || 'no date',
      assigned_by: req.auth.name,
    },
    link: `/action-items?open=${item.id}`,
  }).catch(() => {});
}

/** Registers the item's due date with the central deadline engine (B1). */
function syncDeadline(tenantId, item) {
  if (['done', 'cancelled'].includes(item.status) || !item.due_date) {
    resolveDeadline(tenantId, 'action_item', item.id, item.status === 'done' ? 'met' : 'cancelled');
    return;
  }
  const category = item.category_id
    ? get('SELECT escalation_days FROM action_categories WHERE id = ?', [item.category_id])
    : null;
  const owner = item.owner_id ? get('SELECT manager_id FROM users WHERE id = ?', [item.owner_id]) : null;
  const client = item.client_id ? get('SELECT name FROM clients WHERE id = ?', [item.client_id]) : null;

  upsertDeadline({
    tenantId,
    sourceType: 'action_item',
    sourceId: item.id,
    title: item.title,
    dueAt: item.due_date,
    ownerId: item.owner_id,
    escalateToId: owner?.manager_id,
    escalationDays: category?.escalation_days ?? 3,
    severity: item.priority === 'urgent' ? 'high' : 'normal',
    meta: { priority: item.priority, client: client?.name },
  });
}

// ------------------------------------------------------------------ list
router.get('/', requires('action_items', 'view'), (req, res) => {
  const { tenantId } = req.auth;
  const { page, limit, offset } = paginate(req);
  const filters = ['a.tenant_id = ?', 'a.deleted_at IS NULL'];
  const params = [tenantId];

  const scope = scopeFilter(req, 'a.owner_id');
  if (scope.where) {
    // Employees also see items they are assigned to alongside someone else,
    // plus anything they watch or raised themselves.
    filters.push(`(${scope.where}
      OR a.created_by = ?
      OR EXISTS (SELECT 1 FROM action_assignees aa WHERE aa.action_item_id = a.id AND aa.user_id = ?)
      OR a.id IN (SELECT action_item_id FROM action_watchers WHERE user_id = ?))`);
    params.push(...scope.params, req.auth.userId, req.auth.userId, req.auth.userId);
  }

  const q = req.query;
  if (q.status) { const s = String(q.status).split(','); filters.push(`a.status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (q.priority) { const s = String(q.priority).split(','); filters.push(`a.priority IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (q.owner_id) { filters.push('a.owner_id = ?'); params.push(q.owner_id); }
  // "On my plate" - accountable for it, or working it with someone else.
  if (q.assigned_to) { filters.push(IS_ASSIGNED); params.push(q.assigned_to, q.assigned_to); }
  if (q.assigned_to_me === 'true') { filters.push(IS_ASSIGNED); params.push(req.auth.userId, req.auth.userId); }
  if (q.needs_update === 'true') {
    filters.push(`a.status NOT IN ('done','cancelled') AND ${IS_ASSIGNED}
      AND NOT EXISTS (SELECT 1 FROM action_updates au WHERE au.action_item_id = a.id
                        AND au.user_id = ? AND au.update_date = ? AND au.deleted_at IS NULL)`);
    params.push(req.auth.userId, req.auth.userId, req.auth.userId, todayIso());
  }
  if (q.client_id) { filters.push('a.client_id = ?'); params.push(q.client_id); }
  if (q.project_id) { filters.push('a.project_id = ?'); params.push(q.project_id); }
  if (q.category_id) { filters.push('a.category_id = ?'); params.push(q.category_id); }
  if (q.due_before) { filters.push('a.due_date <= ?'); params.push(q.due_before); }
  if (q.due_after) { filters.push('a.due_date >= ?'); params.push(q.due_after); }
  if (q.overdue === 'true') { filters.push("a.due_date < ? AND a.status NOT IN ('done','cancelled')"); params.push(todayIso()); }
  if (q.escalated === 'true') filters.push('a.escalation_level > 0');
  if (q.search) { filters.push('(a.title LIKE ? OR a.description LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }

  const where = filters.join(' AND ');
  const order = sortClause(req, SORTS, "a.due_date IS NULL, a.due_date ASC, CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END");
  const total = Number(get(`SELECT COUNT(*) AS n FROM action_items a WHERE ${where}`, params)?.n || 0);
  const rows = all(`${SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);

  return ok(res, rows, {
    ...pageMeta(page, limit, total),
    summary: get(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN a.status = 'open' THEN 1 END) AS open,
              COUNT(CASE WHEN a.status = 'in_progress' THEN 1 END) AS in_progress,
              COUNT(CASE WHEN a.status = 'blocked' THEN 1 END) AS blocked,
              COUNT(CASE WHEN a.status = 'done' THEN 1 END) AS done,
              COUNT(CASE WHEN a.due_date < ? AND a.status NOT IN ('done','cancelled') THEN 1 END) AS overdue
         FROM action_items a WHERE ${where}`,
      [todayIso(), ...params],
    ),
  });
});

router.get('/export', requires('action_items', 'export'), (req, res) => {
  const rows = all(
    `${SELECT} WHERE a.tenant_id = ? AND a.deleted_at IS NULL ORDER BY a.due_date`,
    [req.auth.tenantId],
  ).map((r) => ({
    title: r.title, status: r.status, priority: r.priority, due_date: r.due_date,
    owner: r.owner_name, client: r.client_name, category: r.category_name,
    completed_at: r.completed_at, escalation_level: r.escalation_level,
  }));
  audit(req, { entity: 'action_item', action: 'export', after: { count: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="action-items.csv"');
  return res.send(toCsv(rows));
});

// ======================================================== A: DAILY UPDATES
/**
 * The daily update is the standup written down: what moved today, what is
 * moving, what has not started, what is in the way, and what happens next.
 *
 * One row per person per task per day, upserted - somebody who logs at noon and
 * again at six has one update for the day, not two. `update_date` is the day
 * being reported on, which is why it is a date and not derived from created_at:
 * writing up yesterday at 9am tomorrow should still land on yesterday.
 */
const UPDATE_SELECT = `
  SELECT au.*, u.name AS user_name, u.avatar_url, u.designation,
         a.title AS task_title, a.status AS task_status, a.priority, a.due_date,
         a.owner_id, c.name AS client_name
    FROM action_updates au
    JOIN users u ON u.id = au.user_id
    JOIN action_items a ON a.id = au.action_item_id
    LEFT JOIN clients c ON c.id = a.client_id`;

const updatesForItem = (tenantId, itemId) => all(
  `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.action_item_id = ? AND au.deleted_at IS NULL
    ORDER BY au.update_date DESC, au.created_at DESC LIMIT 60`,
  [tenantId, itemId],
);

const updateSchema = z.object({
  update_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  completed_today: z.string().max(4000).optional().nullable(),
  in_progress: z.string().max(4000).optional().nullable(),
  pending: z.string().max(4000).optional().nullable(),
  blockers: z.string().max(4000).optional().nullable(),
  next_action: z.string().max(4000).optional().nullable(),
  remarks: z.string().max(4000).optional().nullable(),
  progress_pct: z.number().int().min(0).max(100).optional().nullable(),
  hours_spent: z.number().min(0).max(24).optional().nullable(),
  /** Moving the task on as part of writing the update, so it is one action. */
  status: z.enum(STATUSES).optional(),
});

/** The task, if this caller is on it. Only assignees write updates. */
function assignedItemOr404(req, id) {
  const item = get(
    'SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [id, req.auth.tenantId],
  );
  if (!item) throw notFound('Action item');
  return item;
}

router.post('/:id/updates', requires('action_items', 'view'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const item = assignedItemOr404(req, req.params.id);
  const body = validate(updateSchema, req.body);

  if (!assigneeIds(tenantId, item.id, item.owner_id).includes(userId)) {
    throw forbidden('Only the people assigned to a task can post its daily update');
  }

  const day = body.update_date || todayIso();
  if (day > todayIso()) throw badRequest('You cannot log an update for a day that has not happened');

  const at = nowIso();
  const existing = get(
    `SELECT * FROM action_updates WHERE tenant_id = ? AND action_item_id = ? AND user_id = ?
       AND update_date = ? AND deleted_at IS NULL`,
    [tenantId, item.id, userId, day],
  );

  // Something has to be said. An empty update is worse than none: it reads as
  // progress on the manager's board while telling them nothing. Judged on what
  // the update will hold once merged, so topping up an existing one is fine.
  const PROSE = ['completed_today', 'in_progress', 'pending', 'blockers', 'next_action', 'remarks'];
  const said = PROSE.some((k) => String(body[k] !== undefined ? body[k] : existing?.[k] ?? '').trim());
  if (!said) throw badRequest('Fill in at least one part of the update');

  // A merge, not a replace. Somebody adding a blocker at four o'clock must not
  // wipe what they wrote at ten. Omit a field to keep it; send null to clear it.
  const keep = (k) => (body[k] !== undefined ? body[k] : (existing?.[k] ?? null));
  const fields = {
    completed_today: keep('completed_today'),
    in_progress: keep('in_progress'),
    pending: keep('pending'),
    blockers: keep('blockers'),
    next_action: keep('next_action'),
    remarks: keep('remarks'),
    progress_pct: keep('progress_pct'),
    hours_spent: keep('hours_spent'),
  };

  const id = existing?.id || uuid();
  tx(() => {
    if (existing) {
      run(
        `UPDATE action_updates SET completed_today = ?, in_progress = ?, pending = ?, blockers = ?,
           next_action = ?, remarks = ?, progress_pct = ?, hours_spent = ?, status_at_update = ?, updated_at = ?
         WHERE id = ?`,
        [...Object.values(fields), body.status || item.status, at, id],
      );
    } else {
      run(
        `INSERT INTO action_updates (id, tenant_id, action_item_id, user_id, update_date,
           completed_today, in_progress, pending, blockers, next_action, remarks,
           progress_pct, hours_spent, status_at_update, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, item.id, userId, day, ...Object.values(fields),
          body.status || item.status, at, at],
      );
    }

    // Writing "I finished it" and leaving the task open is the commonest way a
    // board goes stale, so the status moves with the update when asked.
    if (body.status && body.status !== item.status) {
      const patch = { status: body.status, updated_at: at };
      if (body.status === 'done') patch.completed_at = at;
      if (body.status === 'in_progress' && !item.started_at) patch.started_at = at;
      if (body.status !== 'blocked') patch.blocked_reason = null;
      if (body.status === 'blocked') patch.blocked_reason = body.blockers || item.blocked_reason;
      repo('action_items', tenantId).update(item.id, patch);
    }
  });

  const after = get('SELECT * FROM action_items WHERE id = ?', [item.id]);
  if (body.status && body.status !== item.status) {
    syncDeadline(tenantId, after);
    if (after.status === 'done') resolveEscalations(tenantId, 'action_item', after.id, 'Item completed');
  }

  // A blocker is the one part of an update somebody else has to act on, so the
  // accountable owner and the reporting manager hear about it the same day.
  if (body.blockers?.trim()) {
    const manager = get('SELECT manager_id FROM users WHERE id = ?', [userId])?.manager_id;
    notifyMany({
      tenantId,
      userIds: [item.owner_id, manager].filter((uid) => uid && uid !== userId),
      eventKey: 'action_item.blocked_reported',
      vars: { title: item.title, person: req.auth.name, blockers: body.blockers.trim().slice(0, 300) },
      link: `/action-items?open=${item.id}`,
      dedupeKey: `blocker:${item.id}:${userId}:${day}`,
    }).catch(() => {});
  }

  audit(req, {
    entity: 'action_update', entityId: id, action: existing ? 'update' : 'create',
    after: { action_item_id: item.id, update_date: day, status: body.status ?? null },
  });

  return (existing ? ok : created)(res, get(`${UPDATE_SELECT} WHERE au.id = ?`, [id]));
});

/** Every update written on a task, newest first. */
router.get('/:id/updates', requires('action_items', 'view'), (req, res) => {
  assignedItemOr404(req, req.params.id);
  return ok(res, updatesForItem(req.auth.tenantId, req.params.id));
});

/** Withdraw an update you wrote. Only your own, only the day it belongs to. */
router.delete('/updates/:updateId', requires('action_items', 'view'), (req, res) => {
  const row = get(
    'SELECT * FROM action_updates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.updateId, req.auth.tenantId],
  );
  if (!row) throw notFound('Daily update');
  if (row.user_id !== req.auth.userId) throw forbidden('You can only remove your own update');
  run('UPDATE action_updates SET deleted_at = ? WHERE id = ?', [nowIso(), row.id]);
  audit(req, { entity: 'action_update', entityId: row.id, action: 'delete' });
  return ok(res, { ok: true });
});

/**
 * The employee view: what is on my plate, what still owes an update today, and
 * what I have already written.
 */
router.get('/updates/mine', requires('action_items', 'view'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIso();

  const mine = all(
    `${SELECT} WHERE a.tenant_id = ? AND a.deleted_at IS NULL
       AND a.status NOT IN ('done','cancelled') AND ${IS_ASSIGNED}
     ORDER BY a.due_date IS NULL, a.due_date,
       CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
    [tenantId, userId, userId],
  );

  const logged = all(
    `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.user_id = ? AND au.update_date = ?
       AND au.deleted_at IS NULL ORDER BY au.updated_at DESC`,
    [tenantId, userId, day],
  );
  const loggedFor = new Set(logged.map((u) => u.action_item_id));
  const today = todayIso();

  return ok(res, {
    date: day,
    tasks: mine.map((t) => ({ ...t, has_update_today: loggedFor.has(t.id) })),
    needs_update: mine.filter((t) => !loggedFor.has(t.id)),
    submitted: logged,
    /** Due today or already past it - the "today's pending work" bucket. */
    due_today: mine.filter((t) => t.due_date && t.due_date <= today),
    recent: all(
      `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.user_id = ? AND au.update_date < ?
         AND au.deleted_at IS NULL ORDER BY au.update_date DESC, au.updated_at DESC LIMIT 30`,
      [tenantId, userId, day],
    ),
  });
});

/**
 * The manager view: for one day, everyone I am responsible for, the tasks on
 * them, and what each person said. People who wrote nothing are listed too -
 * silence is the thing a manager most needs to see.
 */
router.get('/updates/team', requires('action_items', 'view'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIso();
  const wide = req.auth.scope === 'all';

  if (req.auth.scope === 'own') throw forbidden('Only managers and admins can review team updates');

  // Whose updates this caller may read: everybody for an admin, direct reports
  // (and themselves) for a manager.
  const people = wide
    ? all(
      `SELECT id, name, avatar_url, designation, email FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'
        ORDER BY name`,
      [tenantId],
    )
    : all(
      `SELECT id, name, avatar_url, designation, email FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
          AND (manager_id = ? OR id = ?) ORDER BY name`,
      [tenantId, userId, userId],
    );

  if (req.query.user_id && people.some((u) => u.id === req.query.user_id)) {
    people.splice(0, people.length, ...people.filter((u) => u.id === req.query.user_id));
  }
  const ids = people.map((u) => u.id);
  if (!ids.length) return ok(res, { date: day, people: [], summary: { updated: 0, silent: 0, blocked: 0 } });

  const placeholders = ids.map(() => '?').join(',');

  const updates = all(
    `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.update_date = ? AND au.deleted_at IS NULL
       AND au.user_id IN (${placeholders}) ORDER BY au.updated_at DESC`,
    [tenantId, day, ...ids],
  );

  // Open work per person, so "no update" can be told apart from "nothing to
  // update on" - a quiet day with no tasks is not a missed update.
  const openTasks = all(
    `SELECT a.id, a.title, a.status, a.priority, a.due_date, a.owner_id,
            COALESCE(aa.user_id, a.owner_id) AS assignee_id, c.name AS client_name
       FROM action_items a
       LEFT JOIN action_assignees aa ON aa.action_item_id = a.id
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.status NOT IN ('done','cancelled')
        AND (a.owner_id IN (${placeholders}) OR aa.user_id IN (${placeholders}))`,
    [tenantId, ...ids, ...ids],
  );

  const byPerson = Object.fromEntries(ids.map((id) => [id, { updates: [], tasks: new Map() }]));
  for (const u of updates) byPerson[u.user_id]?.updates.push(u);
  for (const t of openTasks) {
    for (const uid of [t.owner_id, t.assignee_id]) {
      if (uid && byPerson[uid]) byPerson[uid].tasks.set(t.id, t);
    }
  }

  const rows = people.map((u) => {
    const bucket = byPerson[u.id];
    const tasks = [...bucket.tasks.values()];
    const updatedIds = new Set(bucket.updates.map((x) => x.action_item_id));
    const blockers = bucket.updates.filter((x) => x.blockers?.trim());
    const progress = bucket.updates.filter((x) => x.progress_pct != null).map((x) => x.progress_pct);

    return {
      user: u,
      open_tasks: tasks.length,
      overdue_tasks: tasks.filter((t) => t.due_date && t.due_date < todayIso()).length,
      updates: bucket.updates,
      /** What they are on but said nothing about today. */
      missing: tasks.filter((t) => !updatedIds.has(t.id)),
      blockers,
      avg_progress_pct: progress.length
        ? Math.round(progress.reduce((a, b) => a + b, 0) / progress.length) : null,
      hours_logged: bucket.updates.reduce((a, x) => a + Number(x.hours_spent || 0), 0),
      status: bucket.updates.length ? 'updated' : tasks.length ? 'silent' : 'no_open_tasks',
    };
  });

  return ok(res, {
    date: day,
    scope: wide ? 'all' : 'team',
    people: rows,
    summary: {
      people: rows.length,
      updated: rows.filter((r) => r.status === 'updated').length,
      silent: rows.filter((r) => r.status === 'silent').length,
      blocked: rows.filter((r) => r.blockers.length).length,
      updates: updates.length,
      hours_logged: Math.round(rows.reduce((a, r) => a + r.hours_logged, 0) * 10) / 10,
    },
  });
});

/** The team board as a CSV, for a weekly review that happens in a spreadsheet. */
router.get('/updates/export', requires('action_items', 'export'), (req, res) => {
  const { tenantId } = req.auth;
  const from = req.query.from || todayIso();
  const to = req.query.to || todayIso();
  const scoped = req.auth.scope === 'all'
    ? { where: '', params: [] }
    : {
      where: `AND au.user_id IN (SELECT id FROM users WHERE tenant_id = ? AND (manager_id = ? OR id = ?))`,
      params: [tenantId, req.auth.userId, req.auth.userId],
    };

  const rows = all(
    `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.deleted_at IS NULL
       AND au.update_date >= ? AND au.update_date <= ? ${scoped.where}
     ORDER BY au.update_date DESC, u.name`,
    [tenantId, from, to, ...scoped.params],
  ).map((u) => ({
    date: u.update_date,
    employee: u.user_name,
    task: u.task_title,
    client: u.client_name || '',
    task_status: u.task_status,
    due_date: u.due_date || '',
    completed_today: u.completed_today || '',
    in_progress: u.in_progress || '',
    pending: u.pending || '',
    blockers: u.blockers || '',
    next_action: u.next_action || '',
    remarks: u.remarks || '',
    progress_pct: u.progress_pct ?? '',
    hours_spent: u.hours_spent ?? '',
  }));

  audit(req, { entity: 'action_update', action: 'export', after: { rows: rows.length, from, to } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="daily-updates.csv"');
  return res.send(toCsv(rows));
});

// --------------------------------------------------------------- single
router.get('/:id', requires('action_items', 'view'), (req, res) => {
  const item = get(`${SELECT} WHERE a.id = ? AND a.tenant_id = ? AND a.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!item) throw notFound('Action item');

  return ok(res, {
    ...item,
    assignees: assigneesOf(req.auth.tenantId, item),
    watchers: all(
      `SELECT w.user_id, u.name, u.avatar_url FROM action_watchers w
         JOIN users u ON u.id = w.user_id WHERE w.action_item_id = ?`,
      [item.id],
    ),
    comments: all(
      `SELECT c.*, u.name AS author_name, u.avatar_url FROM comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.entity = 'action_item' AND c.entity_id = ? AND c.deleted_at IS NULL
        ORDER BY c.created_at`,
      [item.id],
    ).map((c) => ({ ...c, mentions: parseJson(c.mentions, []) })),
    attachments: all(
      `SELECT * FROM attachments WHERE entity = 'action_item' AND entity_id = ? AND deleted_at IS NULL ORDER BY created_at`,
      [item.id],
    ),
    escalations: all(
      `SELECT e.*, u.name AS to_name FROM escalations e LEFT JOIN users u ON u.id = e.to_user_id
        WHERE e.tenant_id = ? AND e.source_type = 'action_item' AND e.source_id = ? ORDER BY e.level`,
      [req.auth.tenantId, item.id],
    ),
    deadline: get(
      "SELECT * FROM deadlines WHERE tenant_id = ? AND source_type = 'action_item' AND source_id = ?",
      [req.auth.tenantId, item.id],
    ),
    updates: updatesForItem(req.auth.tenantId, item.id),
    /** Whether this caller still owes an update on it today. */
    my_update_today: get(
      `SELECT * FROM action_updates WHERE tenant_id = ? AND action_item_id = ? AND user_id = ?
         AND update_date = ? AND deleted_at IS NULL`,
      [req.auth.tenantId, item.id, req.auth.userId, todayIso()],
    ) || null,
  });
});

// --------------------------------------------------------------- create
router.post('/', requires('action_items', 'create'), (req, res) => {
  const body = validate(itemSchema, req.body);
  const { tenantId, userId } = req.auth;
  const ts = nowIso();
  const id = uuid();

  // Staffing from a project team means "everyone seated on it", with whoever
  // was named owner answering for the due date. Falling back to the creator
  // keeps the old behaviour for a task raised with nobody named.
  const fromTeam = body.assign_from_project_id
    ? projectTeamIds(tenantId, body.assign_from_project_id) : [];
  if (body.assign_from_project_id && !fromTeam.length) {
    throw badRequest('That project has nobody on its team yet - staff the project first');
  }
  const ownerId = body.owner_id || fromTeam[0] || userId;
  const extras = [...(body.assignee_ids || []), ...fromTeam];

  const item = tx(() => {
    run(
      `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
         project_id, category_id, priority, status, due_date, recurrence, recurrence_until,
         source_type, source_id, sop_id, estimate_minutes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, body.title, body.description ?? null, ownerId, userId,
        body.client_id ?? null, body.project_id ?? body.assign_from_project_id ?? null,
        body.category_id ?? null,
        body.priority || 'medium', body.status || 'open', body.due_date ?? null,
        body.recurrence ?? null, body.recurrence_until ?? null, body.source_type ?? 'manual',
        body.source_id ?? null, body.sop_id ?? null, body.estimate_minutes ?? null, ts, ts],
    );
    if (extras.length) setAssignees(req, id, extras, ownerId);
    for (const w of body.watchers || []) {
      run('INSERT OR IGNORE INTO action_watchers (id, tenant_id, action_item_id, user_id, created_at) VALUES (?,?,?,?,?)',
        [uuid(), tenantId, id, w, ts]);
    }
    return get('SELECT * FROM action_items WHERE id = ?', [id]);
  });

  syncDeadline(tenantId, item);
  audit(req, { entity: 'action_item', entityId: id, action: 'create', after: item });
  notifyAssigned(req, item, assigneeIds(tenantId, id, item.owner_id));

  return created(res, get(`${SELECT} WHERE a.id = ?`, [id]));
});

// --------------------------------------------------------------- update
router.patch('/:id', requires('action_items', 'edit'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const r = repo('action_items', tenantId);
  const before = r.findById(req.params.id);
  if (!before) throw notFound('Action item');

  const body = validate(itemSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  delete patch.watchers;
  delete patch.assignee_ids;
  delete patch.assign_from_project_id;

  if (body.status && body.status !== before.status) {
    if (body.status === 'done') patch.completed_at = nowIso();
    if (body.status === 'in_progress' && !before.started_at) patch.started_at = nowIso();
    if (body.status !== 'blocked') patch.blocked_reason = null;
    if (body.status === 'blocked' && !body.blocked_reason && !before.blocked_reason) {
      throw badRequest('A blocked item needs a reason so the manager knows what to unblock');
    }
  }

  const wasAssigned = assigneeIds(tenantId, before.id, before.owner_id);
  const nextOwner = body.owner_id !== undefined ? body.owner_id : before.owner_id;
  const fromTeam = body.assign_from_project_id
    ? projectTeamIds(tenantId, body.assign_from_project_id) : [];

  const after = tx(() => {
    const updated = r.update(req.params.id, patch);
    // Re-staffing is explicit: send `assignee_ids` (or a project to pull from)
    // and the list is replaced; omit both and the team is left alone.
    if (body.assignee_ids || body.assign_from_project_id) {
      setAssignees(req, req.params.id, [...(body.assignee_ids || []), ...fromTeam], nextOwner);
    } else if (body.owner_id && body.owner_id !== before.owner_id) {
      // A new owner must not also linger in the extras list.
      run('DELETE FROM action_assignees WHERE action_item_id = ? AND user_id = ?',
        [req.params.id, body.owner_id]);
    }
    if (body.watchers) {
      run('DELETE FROM action_watchers WHERE action_item_id = ?', [req.params.id]);
      for (const w of body.watchers) {
        run('INSERT OR IGNORE INTO action_watchers (id, tenant_id, action_item_id, user_id, created_at) VALUES (?,?,?,?,?)',
          [uuid(), tenantId, req.params.id, w, nowIso()]);
      }
    }
    return updated;
  });

  syncDeadline(tenantId, after);
  if (after.status === 'done') {
    resolveEscalations(tenantId, 'action_item', after.id, 'Item completed');
    emitWebhook(tenantId, 'action_item.completed', { id: after.id, title: after.title, owner_id: after.owner_id });
  }
  audit(req, { entity: 'action_item', entityId: after.id, action: 'update', before, after });

  // Tell whoever is newly on the task - not the whole team every time it is
  // edited, or the notification stops meaning anything.
  const nowAssigned = assigneeIds(tenantId, after.id, after.owner_id);
  const added = nowAssigned.filter((uid) => uid !== before.owner_id && !wasAssigned.includes(uid));
  notifyAssigned(req, after, added);

  return ok(res, get(`${SELECT} WHERE a.id = ?`, [after.id]));
});

router.delete('/:id', requires('action_items', 'delete'), (req, res) => {
  const r = repo('action_items', req.auth.tenantId);
  const before = r.findById(req.params.id);
  if (!before) throw notFound('Action item');

  r.softDelete(req.params.id, nowIso());
  resolveDeadline(req.auth.tenantId, 'action_item', req.params.id, 'cancelled');
  audit(req, { entity: 'action_item', entityId: req.params.id, action: 'delete', before });
  return ok(res, { ok: true });
});

// ------------------------------------------------------ manual escalation
router.post('/:id/escalate', requires('action_items', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const item = get('SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!item) throw notFound('Action item');

  const { reason, to_user_id: toUserId } = validate(
    z.object({ reason: z.string().min(3), to_user_id: z.string().optional() }), req.body,
  );
  const owner = item.owner_id ? get('SELECT manager_id FROM users WHERE id = ?', [item.owner_id]) : null;
  const target = toUserId || owner?.manager_id;
  if (!target) throw badRequest('No reporting manager is set for this owner - pick someone to escalate to');

  const id = await raiseEscalation({
    tenantId,
    sourceType: 'action_item',
    sourceId: item.id,
    title: item.title,
    fromUserId: req.auth.userId,
    toUserId: target,
    reason,
    link: `/action-items/${item.id}`,
  });
  audit(req, { entity: 'action_item', entityId: item.id, action: 'update', after: { escalated_to: target, reason } });
  return ok(res, { escalation_id: id });
});

// ------------------------------------------------------------- comments
router.post('/:id/comments', requires('action_items', 'view'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const item = get('SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!item) throw notFound('Action item');

  const { body, mentions = [] } = validate(
    z.object({ body: z.string().min(1).max(4000), mentions: z.array(z.string()).optional() }), req.body,
  );
  const id = uuid();
  run(
    `INSERT INTO comments (id, tenant_id, entity, entity_id, author_id, body, mentions, created_at, updated_at)
     VALUES (?,?, 'action_item', ?,?,?,?,?,?)`,
    [id, tenantId, item.id, userId, body, JSON.stringify(mentions), nowIso(), nowIso()],
  );

  // A5: @mentions notify the mentioned user.
  if (mentions.length) {
    notifyMany({
      tenantId,
      userIds: mentions.filter((m) => m !== userId),
      eventKey: 'mention.comment',
      vars: { from: req.auth.name, entity: item.title, excerpt: body.slice(0, 120) },
      link: `/action-items/${item.id}`,
    }).catch(() => {});
  }

  return created(res, get(
    'SELECT c.*, u.name AS author_name, u.avatar_url FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?',
    [id],
  ));
});

// ------------------------------------------------------- bulk operations
router.post('/bulk', requires('action_items', 'edit'), (req, res) => {
  const { ids, patch } = validate(
    z.object({ ids: z.array(z.string()).min(1).max(200), patch: itemSchema.partial() }), req.body,
  );
  const r = repo('action_items', req.auth.tenantId);
  const updated = [];

  tx(() => {
    for (const id of ids) {
      const before = r.findById(id);
      if (!before) continue;
      const fields = { ...patch, updated_at: nowIso() };
      delete fields.watchers;
      if (patch.status === 'done') fields.completed_at = nowIso();
      updated.push(r.update(id, fields));
    }
  });
  for (const item of updated) syncDeadline(req.auth.tenantId, item);
  audit(req, { entity: 'action_item', action: 'update', after: { bulk: ids.length, patch } });

  return ok(res, { updated: updated.length });
});

// ------------------------------------------------------- my work (mobile)
router.get('/me/today', requires('action_items', 'view'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const today = todayIso();
  return ok(res, {
    overdue: all(`${SELECT} WHERE a.tenant_id = ? AND a.owner_id = ? AND a.deleted_at IS NULL
       AND a.status NOT IN ('done','cancelled') AND a.due_date < ? ORDER BY a.due_date`,
    [tenantId, userId, today]),
    today: all(`${SELECT} WHERE a.tenant_id = ? AND a.owner_id = ? AND a.deleted_at IS NULL
       AND a.status NOT IN ('done','cancelled') AND a.due_date = ?`, [tenantId, userId, today]),
    upcoming: all(`${SELECT} WHERE a.tenant_id = ? AND a.owner_id = ? AND a.deleted_at IS NULL
       AND a.status NOT IN ('done','cancelled') AND a.due_date > ? ORDER BY a.due_date LIMIT 10`,
    [tenantId, userId, today]),
  });
});

export { router as actionItemsRouter, SELECT as ACTION_ITEM_SELECT, syncDeadline };
