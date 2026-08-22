import { get, all, run } from '../db/index.js';
import { uuid, nowIso, daysBetween, parseJson, formatMoney } from '../lib/util.js';
import { notify, notifyMany } from './notifications.js';
import { emitWebhook } from './webhooks.js';

/**
 * Module B - the central deadline engine.
 *
 * Every module that owns a date registers it here (B1) instead of writing its
 * own reminder logic. One ladder implementation (B3), one escalation path (A4),
 * one place to audit what was sent.
 */

export const LADDER = [
  { rung: 't-3d', offsetDays: -3, label: 'in 3 days' },
  { rung: 't-1d', offsetDays: -1, label: 'tomorrow' },
  { rung: 'due', offsetDays: 0, label: 'today' },
];

/** Register (or refresh) a deadline for any source record. Idempotent. */
export function upsertDeadline({
  tenantId, sourceType, sourceId, title, dueAt, ownerId,
  escalateToId = null, escalationDays = 3, severity = 'normal', meta = {},
}) {
  if (!dueAt) return cancelDeadline(tenantId, sourceType, sourceId);
  const existing = get(
    'SELECT * FROM deadlines WHERE tenant_id = ? AND source_type = ? AND source_id = ?',
    [tenantId, sourceType, sourceId],
  );
  const due = dueAt.length === 10 ? `${dueAt}T18:00:00.000Z` : dueAt;

  if (existing) {
    // A moved due date resets the ladder so the new schedule is honoured.
    const resetLadder = existing.due_at !== due;
    run(
      `UPDATE deadlines SET title = ?, due_at = ?, owner_id = ?, escalate_to_id = ?, escalation_days = ?,
         severity = ?, meta = ?, status = CASE WHEN status IN ('met','cancelled') THEN 'pending' ELSE status END,
         ladder_sent = ?, updated_at = ? WHERE id = ?`,
      [title, due, ownerId, escalateToId, escalationDays, severity, JSON.stringify(meta),
        resetLadder ? '[]' : existing.ladder_sent, nowIso(), existing.id],
    );
    return existing.id;
  }

  const id = uuid();
  run(
    `INSERT INTO deadlines (id, tenant_id, source_type, source_id, title, due_at, owner_id,
       escalate_to_id, status, severity, ladder_sent, escalation_days, meta, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,'pending',?,'[]',?,?,?,?)`,
    [id, tenantId, sourceType, sourceId, title, due, ownerId, escalateToId, severity,
      escalationDays, JSON.stringify(meta), nowIso(), nowIso()],
  );
  return id;
}

export function resolveDeadline(tenantId, sourceType, sourceId, status = 'met') {
  run(
    `UPDATE deadlines SET status = ?, resolved_at = ?, updated_at = ?
      WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND status = 'pending'`,
    [status, nowIso(), nowIso(), tenantId, sourceType, sourceId],
  );
}

export const cancelDeadline = (tenantId, sourceType, sourceId) =>
  resolveDeadline(tenantId, sourceType, sourceId, 'cancelled');

// ---------------------------------------------------------------- ladder tick
const userById = (id) => (id ? get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [id]) : null);

const linkFor = (d) => ({
  action_item: `/action-items/${d.source_id}`,
  invoice: `/invoices/${d.source_id}`,
  proposal: `/proposals/${d.source_id}`,
  follow_up: `/crm/${d.source_id}`,
  leave: '/hr/leave',
}[d.source_type] || '/');

const eventKeyFor = (sourceType, phase) => {
  if (sourceType === 'invoice') return phase === 'overdue' ? 'invoice.overdue' : 'invoice.due_soon';
  if (sourceType === 'follow_up') return 'follow_up.due';
  return phase === 'overdue' ? 'action_item.overdue' : 'action_item.due_soon';
};

/**
 * Runs the reminder ladder for every pending deadline and raises escalations
 * for anything overdue past its configured window. Safe to run repeatedly -
 * each rung is deduped by (deadline, rung).
 */
export async function runDeadlineLadder({ now = new Date() } = {}) {
  const pending = all(
    `SELECT d.*, t.currency, t.number_format FROM deadlines d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE d.status = 'pending' AND t.status = 'active' AND t.deleted_at IS NULL`,
  );
  let sent = 0;

  for (const d of pending) {
    const daysToDue = daysBetween(now, d.due_at);
    const ladderSent = parseJson(d.ladder_sent, []) || [];
    const owner = userById(d.owner_id);
    const meta = parseJson(d.meta, {}) || {};

    const vars = {
      title: d.title,
      due_date: d.due_at.slice(0, 10),
      client: meta.client || '-',
      number: meta.number || '',
      amount: meta.amount_minor != null ? formatMoney(meta.amount_minor, d.currency, d.number_format) : '',
      balance: meta.balance_minor != null ? formatMoney(meta.balance_minor, d.currency, d.number_format) : '',
      priority: meta.priority || 'medium',
      next_action: meta.next_action || d.title,
    };

    // --- pre-due rungs -------------------------------------------------
    for (const rung of LADDER) {
      if (ladderSent.includes(rung.rung)) continue;
      if (daysToDue !== -rung.offsetDays) continue;
      if (owner) {
        await notify({
          tenantId: d.tenant_id,
          user: owner,
          eventKey: eventKeyFor(d.source_type, 'due'),
          vars: { ...vars, when: rung.label },
          link: linkFor(d),
          dedupeKey: `deadline:${d.id}:${rung.rung}`,
        });
        sent++;
      }
      ladderSent.push(rung.rung);
    }

    // --- overdue -------------------------------------------------------
    if (daysToDue < 0) {
      const daysOverdue = -daysToDue;
      const rung = `overdue-${daysOverdue}`;
      if (!ladderSent.includes(rung) && owner) {
        await notify({
          tenantId: d.tenant_id,
          user: owner,
          eventKey: eventKeyFor(d.source_type, 'overdue'),
          vars: { ...vars, days_overdue: daysOverdue },
          link: linkFor(d),
          dedupeKey: `deadline:${d.id}:${rung}`,
        });
        ladderSent.push(rung);
        sent++;
      }
      if (d.status === 'pending') {
        run("UPDATE deadlines SET status = 'breached', updated_at = ? WHERE id = ?", [nowIso(), d.id]);
      }
      // B3/A4: overdue past the configured window escalates to the manager.
      if (daysOverdue >= d.escalation_days) {
        await raiseEscalation({
          tenantId: d.tenant_id,
          sourceType: d.source_type,
          sourceId: d.source_id,
          title: d.title,
          fromUserId: d.owner_id,
          toUserId: d.escalate_to_id || owner?.manager_id,
          reason: `${daysOverdue} day(s) overdue`,
          link: linkFor(d),
        });
      }
    }

    run('UPDATE deadlines SET ladder_sent = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(ladderSent), nowIso(), d.id]);
  }
  return { checked: pending.length, sent };
}

// ---------------------------------------------------------------- escalations
/** A4 / workflow 2: log the escalation, alert the manager, fire the webhook. */
export async function raiseEscalation({
  tenantId, sourceType, sourceId, title, fromUserId, toUserId, reason, link = '/', slaHours = 24,
}) {
  if (!toUserId) return null;

  const openAtLevel = get(
    `SELECT * FROM escalations WHERE tenant_id = ? AND source_type = ? AND source_id = ?
      ORDER BY level DESC LIMIT 1`,
    [tenantId, sourceType, sourceId],
  );
  // Only escalate further once the previous level has aged past its SLA.
  if (openAtLevel && !openAtLevel.resolved_at) {
    const ageHours = (Date.now() - new Date(openAtLevel.created_at).getTime()) / 3.6e6;
    if (ageHours < (openAtLevel.sla_hours || slaHours)) return openAtLevel.id;
  }

  const level = (openAtLevel?.level || 0) + 1;
  const id = uuid();
  run(
    `INSERT INTO escalations (id, tenant_id, source_type, source_id, level, from_user_id, to_user_id,
       reason, sla_hours, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, sourceType, sourceId, level, fromUserId, toUserId, reason, slaHours, nowIso()],
  );

  if (sourceType === 'action_item') {
    run(`UPDATE action_items SET escalation_level = ?, escalated_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`, [level, nowIso(), nowIso(), sourceId, tenantId]);
  }

  const from = userById(fromUserId);
  await notifyMany({
    tenantId,
    userIds: [toUserId],
    eventKey: 'escalation.raised',
    vars: { title, level, reason, from: from?.name || 'system' },
    link,
    dedupeKey: `escalation:${id}`,
  });

  emitWebhook(tenantId, 'escalation.raised', {
    id, source_type: sourceType, source_id: sourceId, level, reason, to_user_id: toUserId,
  });

  return id;
}

export function resolveEscalations(tenantId, sourceType, sourceId, note = null) {
  run(
    `UPDATE escalations SET resolved_at = ?, resolution_note = ?
      WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND resolved_at IS NULL`,
    [nowIso(), note, tenantId, sourceType, sourceId],
  );
}
