import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, todayIso, parseJson, toCsv } from '../lib/util.js';
import {
  ok, created, validate, notFound, badRequest, audit, paginate, pageMeta, sortClause,
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
  owner_id: z.string().optional().nullable(),
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
  SELECT a.*, u.name AS owner_name, u.avatar_url AS owner_avatar,
         c.name AS client_name, ac.name AS category_name, ac.color AS category_color,
         p.name AS project_name,
         (SELECT COUNT(*) FROM comments cm WHERE cm.entity = 'action_item' AND cm.entity_id = a.id AND cm.deleted_at IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM attachments at WHERE at.entity = 'action_item' AND at.entity_id = a.id AND at.deleted_at IS NULL) AS attachment_count
    FROM action_items a
    LEFT JOIN users u ON u.id = a.owner_id
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN action_categories ac ON ac.id = a.category_id`;

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
    // Employees also see items they watch or created.
    filters.push(`(${scope.where} OR a.created_by = ? OR a.id IN (SELECT action_item_id FROM action_watchers WHERE user_id = ?))`);
    params.push(...scope.params, req.auth.userId, req.auth.userId);
  }

  const q = req.query;
  if (q.status) { const s = String(q.status).split(','); filters.push(`a.status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (q.priority) { const s = String(q.priority).split(','); filters.push(`a.priority IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (q.owner_id) { filters.push('a.owner_id = ?'); params.push(q.owner_id); }
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

// --------------------------------------------------------------- single
router.get('/:id', requires('action_items', 'view'), (req, res) => {
  const item = get(`${SELECT} WHERE a.id = ? AND a.tenant_id = ? AND a.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!item) throw notFound('Action item');

  return ok(res, {
    ...item,
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
  });
});

// --------------------------------------------------------------- create
router.post('/', requires('action_items', 'create'), (req, res) => {
  const body = validate(itemSchema, req.body);
  const { tenantId, userId } = req.auth;
  const ts = nowIso();
  const id = uuid();

  const item = tx(() => {
    run(
      `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
         project_id, category_id, priority, status, due_date, recurrence, recurrence_until,
         source_type, source_id, sop_id, estimate_minutes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, body.title, body.description ?? null, body.owner_id || userId, userId,
        body.client_id ?? null, body.project_id ?? null, body.category_id ?? null,
        body.priority || 'medium', body.status || 'open', body.due_date ?? null,
        body.recurrence ?? null, body.recurrence_until ?? null, body.source_type ?? 'manual',
        body.source_id ?? null, body.sop_id ?? null, body.estimate_minutes ?? null, ts, ts],
    );
    for (const w of body.watchers || []) {
      run('INSERT OR IGNORE INTO action_watchers (id, tenant_id, action_item_id, user_id, created_at) VALUES (?,?,?,?,?)',
        [uuid(), tenantId, id, w, ts]);
    }
    return get('SELECT * FROM action_items WHERE id = ?', [id]);
  });

  syncDeadline(tenantId, item);
  audit(req, { entity: 'action_item', entityId: id, action: 'create', after: item });

  if (item.owner_id && item.owner_id !== userId) {
    notifyMany({
      tenantId,
      userIds: [item.owner_id],
      eventKey: 'action_item.assigned',
      vars: { title: item.title, priority: item.priority, due_date: item.due_date || 'no date' },
      link: `/action-items/${id}`,
    }).catch(() => {});
  }

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

  if (body.status && body.status !== before.status) {
    if (body.status === 'done') patch.completed_at = nowIso();
    if (body.status === 'in_progress' && !before.started_at) patch.started_at = nowIso();
    if (body.status !== 'blocked') patch.blocked_reason = null;
    if (body.status === 'blocked' && !body.blocked_reason && !before.blocked_reason) {
      throw badRequest('A blocked item needs a reason so the manager knows what to unblock');
    }
  }

  const after = tx(() => {
    const updated = r.update(req.params.id, patch);
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

  if (body.owner_id && body.owner_id !== before.owner_id && body.owner_id !== userId) {
    notifyMany({
      tenantId,
      userIds: [body.owner_id],
      eventKey: 'action_item.assigned',
      vars: { title: after.title, priority: after.priority, due_date: after.due_date || 'no date' },
      link: `/action-items/${after.id}`,
    }).catch(() => {});
  }

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
