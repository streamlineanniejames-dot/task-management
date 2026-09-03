import { get, all, run, tx } from '../db/index.js';
import {
  uuid, nowIso, todayIso, monthIso, addDays, addMonths, startOfMonth, endOfMonth, pct, round1,
} from '../lib/util.js';
import { config } from '../config.js';
import { DEFAULT_TZ, dueAtIso } from '../lib/dueTime.js';
import { runDeadlineLadder, upsertDeadline, raiseEscalation } from './deadlines.js';
import { scoreAllClients } from './scoring.js';
import { detectImprovementFlags, snapshotMetrics } from './analytics.js';
import {
  generateDailyReport, generateWeeklyReport, generateMonthlyReport,
  generateClientMonthlyReport, sendDailyDigests, sendWeeklyEscalationReports, runCustomReport, dispatchReport,
} from './reports.js';
import { flushWebhooks } from './webhooks.js';
import { notifyRole, notifyMany } from './notifications.js';
import { createInvoiceFromTemplate } from './invoicing.js';

/**
 * In-process job runner.
 *
 * The production target (PRD 5.2) is Redis + BullMQ workers; this scheduler
 * exposes the same job keys and handler signatures, so moving to BullMQ means
 * registering these handlers with a queue rather than rewriting them.
 */

const activeTenants = () =>
  all("SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL").map((t) => t.id);

function record(jobKey, fn) {
  return async (...args) => {
    const id = uuid();
    run('INSERT INTO job_runs (id, job_key, status, started_at) VALUES (?,?,?,?)',
      [id, jobKey, 'running', nowIso()]);
    try {
      const processed = await fn(...args);
      run("UPDATE job_runs SET status = 'ok', finished_at = ?, processed = ? WHERE id = ?",
        [nowIso(), Number(processed) || 0, id]);
      return processed;
    } catch (err) {
      console.error(`[job:${jobKey}]`, err);
      run("UPDATE job_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
        [nowIso(), err.message, id]);
      throw err;
    }
  };
}

// ------------------------------------------------- A3: recurring action items
export const rollRecurringActionItems = record('action_items.recurring', () => {
  const today = todayIso();
  let created = 0;

  const templates = all(
    `SELECT a.*, COALESCE(t.timezone, ?) AS tz FROM action_items a
       LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.deleted_at IS NULL AND a.recurrence IS NOT NULL AND a.recurrence != 'none'
        AND a.status = 'done' AND (a.recurrence_until IS NULL OR a.recurrence_until >= ?)`,
    [DEFAULT_TZ, today],
  );

  for (const t of templates) {
    const step = { daily: 1, weekly: 7, monthly: 0 }[t.recurrence];
    const nextDue = t.recurrence === 'monthly'
      ? addMonths(t.due_date, 1).toISOString().slice(0, 10)
      : addDays(t.due_date, step).toISOString().slice(0, 10);
    if (nextDue > addDays(today, 30).toISOString().slice(0, 10)) continue;

    const parentId = t.recurrence_parent_id || t.id;
    const exists = get(
      'SELECT id FROM action_items WHERE tenant_id = ? AND recurrence_parent_id = ? AND due_date = ? AND deleted_at IS NULL',
      [t.tenant_id, parentId, nextDue],
    );
    if (exists) continue;

    // The time of day is part of what repeats: a standup due at 9:30 is due at
    // 9:30 again tomorrow, not merely "sometime tomorrow".
    const nextDueAt = dueAtIso(nextDue, t.due_time, t.tz);

    const id = uuid();
    run(
      `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
         project_id, category_id, priority, status, due_date, due_time, due_at, recurrence, recurrence_until,
         recurrence_parent_id, source_type, estimate_minutes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?,?,?,?, 'recurring', ?,?,?)`,
      [id, t.tenant_id, t.title, t.description, t.owner_id, t.created_by, t.client_id, t.project_id,
        t.category_id, t.priority, nextDue, t.due_time ?? null, nextDueAt,
        t.recurrence, t.recurrence_until, parentId,
        t.estimate_minutes, nowIso(), nowIso()],
    );

    const category = t.category_id ? get('SELECT escalation_days FROM action_categories WHERE id = ?', [t.category_id]) : null;
    const owner = t.owner_id ? get('SELECT manager_id FROM users WHERE id = ?', [t.owner_id]) : null;
    upsertDeadline({
      tenantId: t.tenant_id,
      sourceType: 'action_item',
      sourceId: id,
      title: t.title,
      dueAt: nextDueAt || nextDue,
      ownerId: t.owner_id,
      escalateToId: owner?.manager_id,
      escalationDays: category?.escalation_days ?? 3,
      meta: {
        priority: t.priority,
        timed: !!t.due_time,
        due_date: nextDue,
        due_time: t.due_time || null,
      },
    });
    created++;
  }
  return created;
});

// ------------------------------------------------------- F3: recurring invoices
export const runRecurringInvoices = record('invoices.recurring', () => {
  const today = todayIso();
  let created = 0;

  const due = all(
    'SELECT * FROM recurring_invoices WHERE active = 1 AND deleted_at IS NULL AND next_run_date <= ?',
    [today],
  );

  for (const r of due) {
    try {
      tx(() => {
        const invoice = createInvoiceFromTemplate(r.tenant_id, r);
        const next = addMonths(r.next_run_date, r.frequency === 'quarterly' ? 3 : r.frequency === 'yearly' ? 12 : 1);
        run(
          `UPDATE recurring_invoices SET next_run_date = ?, last_run_at = ?, runs_count = runs_count + 1, updated_at = ?
            WHERE id = ?`,
          [next.toISOString().slice(0, 10), nowIso(), nowIso(), r.id],
        );
        created++;
        return invoice;
      });
    } catch (err) {
      console.error('[job:invoices.recurring]', r.id, err.message);
    }
  }
  return created;
});

// ------------------------------------------ F2: overdue invoices feed module B
export const syncInvoiceDeadlines = record('invoices.deadlines', () => {
  const today = todayIso();
  let touched = 0;

  const open = all(
    `SELECT i.*, c.name AS client_name, u.manager_id AS owner_manager
       FROM invoices i JOIN clients c ON c.id = i.client_id
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.deleted_at IS NULL AND i.balance_minor > 0
        AND i.status NOT IN ('draft','paid','written_off')`,
  );

  for (const inv of open) {
    if (inv.due_date < today && inv.status !== 'overdue') {
      run("UPDATE invoices SET status = 'overdue', updated_at = ? WHERE id = ?", [nowIso(), inv.id]);
    }
    upsertDeadline({
      tenantId: inv.tenant_id,
      sourceType: 'invoice',
      sourceId: inv.id,
      title: `Invoice ${inv.number} - ${inv.client_name}`,
      dueAt: inv.due_date,
      ownerId: inv.created_by,
      escalateToId: inv.owner_manager,
      escalationDays: 5,
      severity: 'high',
      meta: {
        number: inv.number,
        client: inv.client_name,
        amount_minor: inv.total_minor,
        balance_minor: inv.balance_minor,
      },
    });
    touched++;
  }
  return touched;
});

// --------------------------------------------- E4: follow-up engine + flagging
export const syncFollowUps = record('crm.follow_ups', async () => {
  let flagged = 0;

  for (const tenantId of activeTenants()) {
    const withNext = all(
      `SELECT c.*, u.manager_id FROM clients c LEFT JOIN users u ON u.id = c.owner_id
        WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status IN ('lead','active')
          AND c.next_action IS NOT NULL AND c.next_action != '' AND c.next_action_date IS NOT NULL`,
      [tenantId],
    );
    for (const c of withNext) {
      upsertDeadline({
        tenantId,
        sourceType: 'follow_up',
        sourceId: c.id,
        title: `Follow up: ${c.name}`,
        dueAt: c.next_action_date,
        ownerId: c.next_action_owner_id || c.owner_id,
        escalateToId: c.manager_id,
        escalationDays: 3,
        meta: { client: c.name, next_action: c.next_action },
      });
    }

    // E4: a lead with no next action is a defect - flag it to its owner.
    const missing = all(
      `SELECT * FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('lead','active')
         AND (next_action IS NULL OR next_action = '' OR next_action_date IS NULL)`,
      [tenantId],
    );
    for (const c of missing) {
      if (c.owner_id) {
        await notifyMany({
          tenantId,
          userIds: [c.owner_id],
          eventKey: 'lead.no_next_action',
          vars: { client: c.name },
          link: `/crm/${c.id}`,
          dedupeKey: `no_next_action:${todayIso()}:${c.id}`,
        });
      }
      flagged++;
    }
  }
  return flagged;
});

// ------------------------------------------------ E6: nightly score recompute
export const recomputeScores = record('crm.scores', () => {
  let n = 0;
  for (const tenantId of activeTenants()) n += scoreAllClients(tenantId, { snapshot: true });
  return n;
});

// ------------------------------------------------ H3: improvement flags + H4
export const refreshDashboardIntel = record('dashboard.intel', () => {
  let n = 0;
  for (const tenantId of activeTenants()) {
    n += detectImprovementFlags(tenantId);
    snapshotMetrics(tenantId);
  }
  return n;
});

// -------------------------------------------------------- B4: daily digest
export const dailyDigest = record('notifications.daily_digest', async () => {
  let n = 0;
  for (const tenantId of activeTenants()) n += await sendDailyDigests(tenantId);
  return n;
});

export const weeklyEscalationReport = record('reports.weekly_escalation', async () => {
  let n = 0;
  for (const tenantId of activeTenants()) n += await sendWeeklyEscalationReports(tenantId);
  return n;
});

// ------------------------------------------- A: daily update reminder
/**
 * End of day: anyone holding open tasks who has written nothing about them
 * today gets one message listing them.
 *
 * One notification per person, not per task - five separate nudges about five
 * tasks is how a reminder becomes noise people filter out. The dedupe key is
 * the date, so a restart or a forced re-run cannot send it twice.
 */
export const dailyUpdateReminder = record('action_items.update_reminder', async () => {
  const today = todayIso();
  let sent = 0;

  for (const tenantId of activeTenants()) {
    // Everyone with at least one open task and no update logged today. The
    // task list comes back with it so the message can name what is missing.
    const pending = all(
      `SELECT p.user_id, u.name, COUNT(*) AS n,
              GROUP_CONCAT(p.title, ' · ') AS titles
         FROM (
           SELECT DISTINCT COALESCE(aa.user_id, a.owner_id) AS user_id, a.id, a.title
             FROM action_items a
             LEFT JOIN action_assignees aa ON aa.action_item_id = a.id
            WHERE a.tenant_id = ? AND a.deleted_at IS NULL
              AND a.status NOT IN ('done','cancelled')
              AND COALESCE(aa.user_id, a.owner_id) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM action_updates au
                 WHERE au.action_item_id = a.id
                   AND au.user_id = COALESCE(aa.user_id, a.owner_id)
                   AND au.update_date = ? AND au.deleted_at IS NULL)
         ) p
         JOIN users u ON u.id = p.user_id
        WHERE u.deleted_at IS NULL AND u.status = 'active'
        GROUP BY p.user_id`,
      [tenantId, today],
    );

    for (const row of pending) {
      const titles = String(row.titles || '').split(' · ').slice(0, 3).join(', ');
      const more = Number(row.n) > 3 ? ` and ${Number(row.n) - 3} more` : '';
      await notifyMany({
        tenantId,
        userIds: [row.user_id],
        eventKey: 'action_item.update_due',
        vars: { count: Number(row.n), titles: `${titles}${more}` },
        link: '/action-items?tab=updates',
        dedupeKey: `update_due:${today}`,
      });
      sent += 1;
    }
  }
  return sent;
});

// -------------------------------------------------------- G1: scheduled reports
export const scheduledReports = record('reports.scheduled', async () => {
  let n = 0;
  const now = new Date();
  const day = now.getUTCDay();      // 0 = Sunday
  const dom = now.getUTCDate();

  for (const tenantId of activeTenants()) {
    generateDailyReport(tenantId);
    n++;
    if (day === 1) { generateWeeklyReport(tenantId); n++; }        // Monday
    if (dom === 1) { generateMonthlyReport(tenantId); n++; }        // 1st of month

    // Saved definitions (G3) whose next_run_at has arrived.
    const defs = all(
      'SELECT * FROM report_definitions WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL AND (next_run_at IS NULL OR next_run_at <= ?)',
      [tenantId, nowIso()],
    );
    for (const def of defs) {
      if (!def.schedule) continue;
      const report = def.kind === 'client_monthly'
        ? null
        : runCustomReport(tenantId, def);
      if (report) {
        await dispatchReport(tenantId, report.id, {
          recipients: JSON.parse(def.recipients || '[]'),
          channels: JSON.parse(def.channels || '["in_app"]'),
        });
      }
      run('UPDATE report_definitions SET last_run_at = ?, next_run_at = ? WHERE id = ?',
        [nowIso(), nextRunFor(def.schedule), def.id]);
      n++;
    }
  }
  return n;
});

/** Parses "daily@08:00" / "weekly@mon-09:00" / "monthly@1-09:00". */
export function nextRunFor(schedule, from = new Date()) {
  if (!schedule) return null;
  const [kind, spec = '09:00'] = String(schedule).split('@');
  const d = new Date(from);

  if (kind === 'daily') {
    const [h, m] = spec.split(':').map(Number);
    d.setUTCHours(h, m, 0, 0);
    if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  if (kind === 'weekly') {
    const [dow, time = '09:00'] = spec.split('-');
    const target = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(dow.toLowerCase());
    const [h, m] = time.split(':').map(Number);
    d.setUTCHours(h, m, 0, 0);
    const diff = (target - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString();
  }
  if (kind === 'monthly') {
    const [dom, time = '09:00'] = spec.split('-');
    const [h, m] = time.split(':').map(Number);
    d.setUTCDate(Number(dom) || 1);
    d.setUTCHours(h, m, 0, 0);
    if (d <= from) d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString();
  }
  return null;
}

// ---------------------------------------------- PRD 7.5: monthly close
/**
 * On the 1st: build KPI/KRA reviews, client profitability and the client-facing
 * reports, then queue them for approval before dispatch.
 */
export const monthlyClose = record('close.monthly', async () => {
  const month = monthIso(addMonths(new Date(), -1));
  let n = 0;

  for (const tenantId of activeTenants()) {
    // 1. Performance reviews from real completion + attendance data (C3).
    const staff = all(
      "SELECT * FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'",
      [tenantId],
    );
    const from = startOfMonth(month).slice(0, 10);
    const to = endOfMonth(month).slice(0, 10);

    for (const u of staff) {
      if (get('SELECT id FROM performance_reviews WHERE tenant_id = ? AND user_id = ? AND period_month = ?',
        [tenantId, u.id, month])) continue;

      const items = get(
        `SELECT COUNT(*) AS assigned, COUNT(CASE WHEN status='done' THEN 1 END) AS done,
                COUNT(CASE WHEN status='done' AND completed_at <= due_date || 'T23:59:59Z' THEN 1 END) AS on_time
           FROM action_items WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL
             AND due_date BETWEEN ? AND ?`,
        [tenantId, u.id, from, to],
      ) || {};
      const att = get(
        `SELECT COUNT(*) AS n, COUNT(CASE WHEN status IN ('present','wfh') THEN 1 END) AS p
           FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date BETWEEN ? AND ?`,
        [tenantId, u.id, from, to],
      ) || {};

      const completion = pct(Number(items.done || 0), Number(items.assigned || 0));
      const attendance = pct(Number(att.p || 0), Number(att.n || 0));
      const reviewId = uuid();

      run(
        `INSERT INTO performance_reviews (id, tenant_id, user_id, period_month, items_assigned,
           items_completed, items_on_time, completion_pct, attendance_pct, kpi_score, status,
           reviewer_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,
        [reviewId, tenantId, u.id, month, Number(items.assigned || 0), Number(items.done || 0),
          Number(items.on_time || 0), completion, attendance, round1(completion * 0.7 + attendance * 0.3),
          u.manager_id, nowIso(), nowIso()],
      );

      // Attach each KPI defined for the role (D3).
      const kpis = all(
        `SELECT * FROM kpis WHERE tenant_id = ? AND deleted_at IS NULL AND active = 1
           AND (applies_role IS NULL OR applies_role = ?)`,
        [tenantId, u.role],
      );
      for (const k of kpis) {
        const actual = k.source === 'action_items.completion' ? completion
          : k.source === 'attendance.pct' ? attendance : null;
        run(
          `INSERT INTO performance_kpi_scores (id, tenant_id, review_id, kpi_id, kpi_name, target_value,
             actual_value, achievement_pct, weight, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [uuid(), tenantId, reviewId, k.id, k.name, k.target_value, actual,
            actual != null && k.target_value ? round1((actual / k.target_value) * 100) : null,
            k.weight, nowIso()],
        );
      }
      n++;
    }

    // 2. Monthly internal review.
    generateMonthlyReport(tenantId, { month });

    // 3. Client-facing reports, queued for approval before dispatch (G2).
    const clients = all(
      "SELECT id FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'",
      [tenantId],
    );
    for (const c of clients) {
      generateClientMonthlyReport(tenantId, c.id, { month });
      n++;
    }

    await notifyRole({
      tenantId,
      roles: ['owner', 'manager'],
      eventKey: 'report.ready',
      vars: { title: `Monthly close for ${month}`, period: month },
      link: '/reports',
      dedupeKey: `close:${month}:${tenantId}`,
    });
  }
  return n;
});

// ------------------------------------------------------------------ scheduler
const JOBS = [
  { key: 'deadlines.ladder', everyMin: 15, fn: () => runDeadlineLadder() },
  { key: 'invoices.deadlines', everyMin: 60, fn: syncInvoiceDeadlines },
  { key: 'crm.follow_ups', everyMin: 60, fn: syncFollowUps },
  { key: 'webhooks.flush', everyMin: 1, fn: () => flushWebhooks() },
  { key: 'action_items.recurring', atHourUtc: 0, fn: rollRecurringActionItems },
  { key: 'invoices.recurring', atHourUtc: 1, fn: runRecurringInvoices },
  { key: 'crm.scores', atHourUtc: 2, fn: recomputeScores },
  { key: 'dashboard.intel', atHourUtc: 2, fn: refreshDashboardIntel },
  { key: 'action_items.update_reminder', atHourUtc: 12, fn: dailyUpdateReminder }, // 17:30 IST
  { key: 'notifications.daily_digest', atHourUtc: 3, fn: dailyDigest },   // 08:30 IST
  { key: 'reports.scheduled', atHourUtc: 3, fn: scheduledReports },
  { key: 'reports.weekly_escalation', atHourUtc: 4, onDayOfWeek: 1, fn: weeklyEscalationReport },
  { key: 'close.monthly', atHourUtc: 4, onDayOfMonth: 1, fn: monthlyClose },
];

const lastRun = new Map();

async function tick() {
  const now = new Date();
  for (const job of JOBS) {
    const last = lastRun.get(job.key) || 0;
    let due = false;

    if (job.everyMin) {
      due = Date.now() - last >= job.everyMin * 60_000;
    } else {
      const hourMatches = now.getUTCHours() === job.atHourUtc;
      const dayMatches = job.onDayOfWeek == null || now.getUTCDay() === job.onDayOfWeek;
      const domMatches = job.onDayOfMonth == null || now.getUTCDate() === job.onDayOfMonth;
      const ranToday = new Date(last).toDateString() === now.toDateString();
      due = hourMatches && dayMatches && domMatches && !ranToday;
    }

    if (!due) continue;
    lastRun.set(job.key, Date.now());
    try {
      await job.fn();
    } catch (err) {
      console.error(`[jobs] ${job.key} failed:`, err.message);
    }
  }
}

let timer = null;
export function startJobRunner() {
  if (!config.jobs.enabled || timer) return;
  console.log(JSON.stringify({ t: nowIso(), msg: 'job runner started', tick_ms: config.jobs.tickMs }));
  timer = setInterval(() => { tick().catch((e) => console.error('[jobs]', e)); }, config.jobs.tickMs);
  timer.unref?.();
  setTimeout(() => { tick().catch(() => {}); }, 3_000).unref?.();
}
export function stopJobRunner() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed so the Super Admin console can force a job (S9). */
export const JOB_REGISTRY = {
  'deadlines.ladder': () => runDeadlineLadder(),
  'invoices.deadlines': syncInvoiceDeadlines,
  'invoices.recurring': runRecurringInvoices,
  'crm.follow_ups': syncFollowUps,
  'crm.scores': recomputeScores,
  'dashboard.intel': refreshDashboardIntel,
  'action_items.recurring': rollRecurringActionItems,
  'action_items.update_reminder': dailyUpdateReminder,
  'notifications.daily_digest': dailyDigest,
  'reports.scheduled': scheduledReports,
  'reports.weekly_escalation': weeklyEscalationReport,
  'close.monthly': monthlyClose,
  'webhooks.flush': () => flushWebhooks(),
};
