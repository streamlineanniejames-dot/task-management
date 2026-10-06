import { get, all, run } from '../db/index.js';
import { uuid, nowIso, parseJson } from '../lib/util.js';
import { badRequest } from '../lib/http.js';
import { DEFAULT_TZ, todayInTz, timeInTz, localToUtc, formatDueTime } from '../lib/dueTime.js';
import { notify, channelsFor } from './notifications.js';

/**
 * Tomorrow's To-Do - the plan each person files for their next working day.
 *
 * This file owns the clock half of the module: the workspace schedule
 * (open -> reminder -> deadline -> escalation), the working-day calendar the
 * schedule runs on, and the notifications each rung sends. Every time is
 * workspace-local wall clock read through the tenant's timezone, never the
 * server's and never the browser's.
 *
 * The reporting person is `users.manager_id`, which only the owner edits.
 * Someone with no manager reports to the workspace owners.
 */

// ---------------------------------------------------------------- statuses
export const STATUSES = [
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'LATE', 'OVERDUE', 'MISSED',
];
/** A plan in any of these has reached the reporting person, so no more nudges. */
export const FILED = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'LATE'];

/** Notification event keys, one per rung and review outcome. */
export const EVENTS = {
  open: 'todo.submission_open',
  reminder: 'todo.reminder',
  overdue: 'todo.overdue',
  escalation: 'todo.escalation',
  submitted: 'todo.submitted',
  approved: 'todo.approved',
  changes: 'todo.changes_requested',
};

const PLAN_LINK = '/';

// ---------------------------------------------------------------- settings
export const CHANNEL_OPTIONS = ['in_app', 'email', 'whatsapp'];

export const DEFAULT_SETTINGS = {
  /** Off until an owner switches it on, so a new workspace is not nudged before anyone can file. */
  enabled: false,
  /** Workspace-local HH:MM; each must come after the one before. */
  open_time: '17:30',
  reminder_time: '17:50',
  deadline_time: '18:00',
  escalation_time: '18:15',
  /** Weekday numbers, 0 = Sunday. NULL follows the workspace week-off days. */
  working_days: null,
  allow_late: true,
  notify_employees: true,
  notify_managers: true,
  escalate_to_owner: false,
  /** In-app always goes; these are the extra channels, still subject to each person's preferences. */
  channels: ['in_app', 'email'],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function workspaceWorkingDays(tenantId) {
  const offs = parseJson(get('SELECT week_off_days FROM tenants WHERE id = ?', [tenantId])?.week_off_days, [0]);
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !(Array.isArray(offs) ? offs : [0]).includes(d));
}

export function settingsFor(tenantId) {
  const saved = parseJson(get('SELECT todo_settings FROM tenants WHERE id = ?', [tenantId])?.todo_settings, {}) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  return { ...s, working_days: s.working_days ?? workspaceWorkingDays(tenantId) };
}

export function saveSettings(tenantId, body) {
  const s = { ...settingsFor(tenantId), ...body };
  const times = ['open_time', 'reminder_time', 'deadline_time', 'escalation_time'];
  for (const k of times) {
    if (!HHMM.test(String(s[k]))) throw badRequest(`${k.replace(/_/g, ' ')} must be HH:MM`);
  }
  if (!(s.open_time < s.reminder_time && s.reminder_time < s.deadline_time && s.deadline_time < s.escalation_time)) {
    throw badRequest('The schedule must run in order: open < reminder < deadline < escalation');
  }
  const days = Array.isArray(s.working_days) ? [...new Set(s.working_days)] : null;
  if (!days?.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw badRequest('Pick at least one working day (0 = Sunday ... 6 = Saturday)');
  }
  const channels = Array.isArray(s.channels) ? [...new Set(['in_app', ...s.channels])] : null;
  if (!channels || channels.some((c) => !CHANNEL_OPTIONS.includes(c))) {
    throw badRequest(`channels must be drawn from ${CHANNEL_OPTIONS.join(', ')}`);
  }
  for (const k of ['enabled', 'allow_late', 'notify_employees', 'notify_managers', 'escalate_to_owner']) {
    if (typeof s[k] !== 'boolean') throw badRequest(`${k.replace(/_/g, ' ')} must be true or false`);
  }
  const clean = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));
  clean.working_days = days.sort();
  clean.channels = channels;
  run('UPDATE tenants SET todo_settings = ?, updated_at = ? WHERE id = ?', [JSON.stringify(clean), nowIso(), tenantId]);
  return clean;
}

// ---------------------------------------------------------------- calendar
const tzOf = (tenantId) => get('SELECT timezone FROM tenants WHERE id = ?', [tenantId])?.timezone || DEFAULT_TZ;
const addDay = (d, n = 1) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

/** Restricted holidays are optional for the person, so they do not stop the plan. */
const isHoliday = (tenantId, day) => !!get(
  "SELECT id FROM holidays WHERE tenant_id = ? AND holiday_date = ? AND kind = 'company_holiday' AND deleted_at IS NULL",
  [tenantId, day],
);

export function isWorkingDay(tenantId, day, settings = settingsFor(tenantId)) {
  return settings.working_days.includes(weekday(day)) && !isHoliday(tenantId, day);
}

/** The day a plan filed on `day` is for: Friday's plan is Monday's when the weekend is off. */
export function nextWorkingDay(tenantId, day, settings = settingsFor(tenantId)) {
  let d = addDay(day);
  for (let i = 0; i < 60; i++, d = addDay(d)) if (isWorkingDay(tenantId, d, settings)) return d;
  return null;
}

/** Where today sits in the schedule, on the workspace clock. */
export function windowFor(tenantId, now = new Date()) {
  const settings = settingsFor(tenantId);
  const tz = tzOf(tenantId);
  const today = todayInTz(tz, now);
  const time = timeInTz(tz, now);
  const working = settings.enabled && isWorkingDay(tenantId, today, settings);
  const target = working ? nextWorkingDay(tenantId, today, settings) : null;
  let phase = 'closed';
  if (working) {
    if (time >= settings.deadline_time) phase = 'past_deadline';
    else if (time >= settings.open_time) phase = 'open';
    else phase = 'not_open';
  }
  return {
    tz,
    today,
    time,
    working,
    todo_date: target,
    phase,
    deadline_at: working ? localToUtc(today, settings.deadline_time, tz).toISOString() : null,
    settings,
  };
}

// ---------------------------------------------------------------- people
/** Everyone expected to file a plan: active staff other than the owners themselves. */
export const plannersOf = (tenantId) => all(
  `SELECT * FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
      AND role NOT IN ('owner','client','super_admin')`,
  [tenantId],
);

const ownerIds = (tenantId) => all(
  "SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' AND deleted_at IS NULL AND status = 'active'",
  [tenantId],
).map((u) => u.id);

/** Read at the moment of use, so an owner's reassignment applies from the next plan on. */
export function reportingPersonIds(tenantId, user) {
  if (user.manager_id) {
    const m = get(
      "SELECT id FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND status = 'active'",
      [user.manager_id, tenantId],
    );
    if (m) return [m.id];
  }
  return ownerIds(tenantId);
}

/** Planners who have not filed for `todoDate` yet. */
function pendingFor(tenantId, todoDate) {
  const filed = new Set(all(
    `SELECT user_id FROM todo_submissions WHERE tenant_id = ? AND todo_date = ?
        AND status IN (${FILED.map(() => '?').join(',')})`,
    [tenantId, todoDate, ...FILED],
  ).map((r) => r.user_id));
  return plannersOf(tenantId).filter((u) => !filed.has(u.id));
}

// ---------------------------------------------------------------- sending
/**
 * In-app always; email/WhatsApp only when the workspace has switched them on
 * for To-Do AND the person has not muted them. Returns whether anything new
 * went out, so a re-run of a rung that already fired reports nothing.
 */
async function tell(tenantId, user, eventKey, vars, dedupeKey, settings, link = PLAN_LINK) {
  const channels = channelsFor(user, eventKey).filter((c) => settings.channels.includes(c));
  if (!channels.includes('in_app')) channels.unshift('in_app');
  const out = await notify({ tenantId, user, eventKey, vars, link, channels, dedupeKey });
  return out.length > 0;
}

function systemAudit(tenantId, entity, entityId, action, after) {
  run(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_name, entity, entity_id, action, before_json, after_json, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, null, 'System', entity, entityId, action, null, JSON.stringify(after), null, nowIso()],
  );
}

/** One row per planner per target day; created by the clock when it has to record OVERDUE. */
function markOverdue(tenantId, user, win) {
  const row = get('SELECT id, status FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
    [tenantId, user.id, win.todo_date]);
  if (row) {
    if (row.status === 'DRAFT') {
      run("UPDATE todo_submissions SET status = 'OVERDUE', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    }
    return;
  }
  run(
    `INSERT INTO todo_submissions (id, tenant_id, user_id, reporting_person_id, todo_date, plan_date, status,
       deadline_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'OVERDUE', ?,?,?)`,
    [uuid(), tenantId, user.id, reportingPersonIds(tenantId, user)[0] ?? null, win.todo_date, win.today,
      win.deadline_at, nowIso(), nowIso()],
  );
}

// ---------------------------------------------------------------- the clock
/**
 * Runs every minute. Each rung fires once per target day - the dedupe key on
 * the notification row guarantees that across restarts - and only to people
 * who have not filed yet. A server that comes up after the deadline skips the
 * open and reminder messages rather than sending stale ones.
 */
export async function todoTick(tenantIds, now = new Date()) {
  let n = 0;
  for (const tenantId of tenantIds) {
    const win = windowFor(tenantId, now);
    const s = win.settings;

    // The day a plan was for has arrived: anything still unfiled is missed.
    const missed = run(
      `UPDATE todo_submissions SET status = 'MISSED', updated_at = ?
        WHERE tenant_id = ? AND status IN ('DRAFT','OVERDUE') AND todo_date <= ?`,
      [nowIso(), tenantId, win.today],
    );
    n += Number(missed.changes || 0);

    if (!win.working || !win.todo_date) continue;
    const t = win.time;
    if (t < s.open_time) continue;

    const target = win.todo_date;
    const pending = pendingFor(tenantId, target);
    const deadline = formatDueTime(s.deadline_time);
    const base = { todo_date: target, deadline, late_note: s.allow_late ? ' Late plans are still accepted but marked late.' : ' Late plans are not accepted.' };

    const rung = async (stage, eventKey, users, varsFor = () => base, dedupe = () => `todo_${stage}:${target}`) => {
      const reached = [];
      for (const u of users) {
        if (await tell(tenantId, u.recipient || u, eventKey, varsFor(u), dedupe(u), s)) reached.push(u.id);
      }
      if (reached.length) systemAudit(tenantId, 'todo_schedule', `${tenantId}:${target}`, `${stage}_sent`, { todo_date: target, users: reached });
      n += reached.length;
    };

    if (t < s.deadline_time) {
      if (!get("SELECT id FROM audit_logs WHERE tenant_id = ? AND entity = 'todo_schedule' AND entity_id = ? AND action = 'opened'",
        [tenantId, `${tenantId}:${target}`])) {
        systemAudit(tenantId, 'todo_schedule', `${tenantId}:${target}`, 'opened', { todo_date: target, plan_date: win.today });
      }
      if (s.notify_employees) {
        if (t < s.reminder_time) await rung('open', EVENTS.open, pending);
        else await rung('reminder', EVENTS.reminder, pending);
      }
      continue;
    }

    // Past the deadline.
    for (const u of pending) markOverdue(tenantId, u, win);
    if (s.notify_employees) await rung('overdue', EVENTS.overdue, pending);

    if (t >= s.escalation_time) {
      const sends = [];
      for (const u of pending) {
        const to = new Set();
        if (s.notify_managers) reportingPersonIds(tenantId, u).forEach((id) => to.add(id));
        if (s.escalate_to_owner) ownerIds(tenantId).forEach((id) => to.add(id));
        for (const id of to) {
          const recipient = get('SELECT * FROM users WHERE id = ?', [id]);
          if (recipient) sends.push({ id: `${u.id}>${id}`, recipient, employee: u });
        }
      }
      await rung(
        'escalation',
        EVENTS.escalation,
        sends,
        (x) => ({ ...base, person: x.employee.name, status: 'Overdue' }),
        (x) => `todo_escalation:${target}:${x.employee.id}`,
      );
    }
  }
  return n;
}
