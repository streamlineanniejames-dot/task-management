import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso, parseJson } from '../lib/util.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { DEFAULT_TZ, todayInTz, timeInTz, localToUtc, formatDueTime } from '../lib/dueTime.js';
import { notify, channelsFor } from './notifications.js';
import { can } from '../middleware/rbac.js';
import { visibleProjectIds } from './projectOversight.js';

/**
 * Tomorrow's To-Do - the plan each person files for their next working day.
 *
 * This file owns both halves of the module. The clock: the workspace schedule
 * (open -> reminder -> deadline -> escalation), the working-day calendar the
 * schedule runs on, and the notifications each rung sends. Every time is
 * workspace-local wall clock read through the tenant's timezone, never the
 * server's and never the browser's. The plan: saving, submitting and the
 * reporting person's review, with every permission checked here rather than
 * trusted from the client.
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
  comment: 'todo.comment',
};

const PLAN_LINK = '/';
const planLink = (id) => `/?plan=${id}`;

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
/** '2026-10-07' -> 'Wed, 7 Oct', for notification copy. */
export const dayLabel = (d) => (d
  ? new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))
  : '');

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
    const base = { todo_date: target, todo_day: dayLabel(target), deadline, late_note: s.allow_late ? ' Late plans are still accepted but marked late.' : ' Late plans are not accepted.' };

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

// ================================================================ the plan
export const PRIORITIES = ['high', 'medium', 'low'];
/** The reporting person is working on it or has decided: the employee's copy is frozen. */
const LOCKED = ['UNDER_REVIEW', 'APPROVED', 'MISSED'];
const AWAITING_REVIEW = ['SUBMITTED', 'LATE', 'UNDER_REVIEW'];

/** Owner/admin: whoever may edit workspace settings sees and reviews every plan. */
export const isAdmin = (auth) => can(auth, 'settings', 'edit');

const userName = (id) => (id ? get('SELECT name FROM users WHERE id = ?', [id])?.name : null) || null;
const userRow = (id) => get('SELECT * FROM users WHERE id = ?', [id]);

export function canView(auth, sub) {
  if (!sub) return false;
  if (sub.user_id === auth.userId || sub.reporting_person_id === auth.userId || isAdmin(auth)) return true;
  // The employee's current reporting person may read their history too.
  return userRow(sub.user_id)?.manager_id === auth.userId;
}

export const canReview = (auth, sub) => !!sub && sub.user_id !== auth.userId
  && (sub.reporting_person_id === auth.userId || isAdmin(auth));

function loadSubmission(auth, id) {
  const sub = get('SELECT * FROM todo_submissions WHERE id = ? AND tenant_id = ?', [id, auth.tenantId]);
  // Not-found rather than forbidden, so an id cannot be probed for existence.
  if (!sub || !canView(auth, sub)) throw notFound('To-Do');
  return sub;
}

/** What the person may pick from: projects they can see, and clients if they can see the CRM. */
export function optionsFor(auth) {
  const pids = visibleProjectIds(auth);
  const projects = pids.length
    ? all(
      `SELECT id, name FROM projects WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
          AND id IN (${pids.map(() => '?').join(',')}) ORDER BY name`,
      [auth.tenantId, ...pids],
    )
    : [];
  const clients = can(auth, 'crm', 'view')
    ? all("SELECT id, name FROM client_accounts WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY name",
      [auth.tenantId])
    : [];
  return { projects, clients };
}

/** Whether the employee may still change this plan, and if not, why. */
function editState(auth, sub, win) {
  if (sub.user_id !== auth.userId) return { can_edit: false, reason: null };
  if (sub.status === 'MISSED') return { can_edit: false, reason: 'The planned day has arrived.' };
  if (LOCKED.includes(sub.status)) return { can_edit: false, reason: 'Your reporting person has this plan now.' };
  if (sub.todo_date < win.today || (sub.todo_date === win.today && sub.status !== 'CHANGES_REQUESTED')) {
    return { can_edit: false, reason: 'The planned day has arrived.' };
  }
  if (sub.status === 'CHANGES_REQUESTED') return { can_edit: true, reason: null };
  const past = sub.deadline_at && Date.now() > Date.parse(sub.deadline_at);
  if (past && ['SUBMITTED', 'LATE'].includes(sub.status)) return { can_edit: false, reason: 'Submitted plans can be edited until the deadline.' };
  if (past && !win.settings.allow_late) return { can_edit: false, reason: 'The deadline has passed and late plans are not accepted.' };
  return { can_edit: true, reason: null };
}

export function detail(auth, sub, win = windowFor(auth.tenantId)) {
  const tasks = all(
    `SELECT t.id, t.task, t.project_id, p.name AS project_name, t.client_id, c.name AS client_name,
            t.priority, t.expected_time, t.notes
       FROM todo_tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN client_accounts c ON c.id = t.client_id
      WHERE t.submission_id = ? ORDER BY t.sort`,
    [sub.id],
  );
  const comments = all(
    `SELECT tc.id, tc.kind, tc.body, tc.created_at, tc.user_id, u.name AS user_name
       FROM todo_comments tc LEFT JOIN users u ON u.id = tc.user_id
      WHERE tc.submission_id = ? ORDER BY tc.created_at`,
    [sub.id],
  );
  return {
    ...sub,
    employee_name: userName(sub.user_id),
    reporting_person_name: userName(sub.reporting_person_id),
    reviewed_by_name: userName(sub.reviewed_by),
    tasks,
    comments,
    ...editState(auth, sub, win),
    can_review: canReview(auth, sub),
  };
}

export function mine(auth) {
  const win = windowFor(auth.tenantId);
  const me = userRow(auth.userId);
  // A plan sent back for changes stays the one in front of the person until it is fixed.
  const sub = get(
    `SELECT * FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date >= ?
        AND (todo_date = ? OR status = 'CHANGES_REQUESTED')
      ORDER BY CASE status WHEN 'CHANGES_REQUESTED' THEN 0 ELSE 1 END, todo_date LIMIT 1`,
    [auth.tenantId, auth.userId, win.today, win.todo_date ?? ''],
  );
  const reporting = reportingPersonIds(auth.tenantId, me)[0] ?? null;
  const { settings, ...window } = win;
  return {
    window,
    settings: {
      enabled: settings.enabled, open_time: settings.open_time, deadline_time: settings.deadline_time,
      allow_late: settings.allow_late,
    },
    expected: !['owner', 'client', 'super_admin'].includes(me.role),
    plan: sub ? detail(auth, sub, win) : null,
    reporting_person: reporting ? { id: reporting, name: userName(reporting) } : null,
    options: optionsFor(auth),
    history: all(
      `SELECT s.id, s.todo_date, s.status, s.submitted_at, s.minutes_late,
              (SELECT COUNT(*) FROM todo_tasks t WHERE t.submission_id = s.id) AS task_count
         FROM todo_submissions s WHERE s.tenant_id = ? AND s.user_id = ?
        ORDER BY s.todo_date DESC LIMIT 14`,
      [auth.tenantId, auth.userId],
    ).map((h) => ({ ...h, task_count: Number(h.task_count) })),
  };
}

const HHMM_OPT = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanTasks(auth, tasks, submitting) {
  if (!Array.isArray(tasks)) throw badRequest('tasks must be a list');
  if (tasks.length > 30) throw badRequest('A plan can hold at most 30 tasks');
  const opts = optionsFor(auth);
  const projectIds = new Set(opts.projects.map((p) => p.id));
  const clientIds = new Set(opts.clients.map((c) => c.id));
  const out = tasks
    .map((t) => ({
      task: String(t?.task ?? '').trim(),
      project_id: t?.project_id || null,
      client_id: t?.client_id || null,
      priority: t?.priority || 'medium',
      expected_time: t?.expected_time || null,
      notes: String(t?.notes ?? '').trim() || null,
    }))
    // A row the person added and never touched is not a task.
    .filter((t) => t.task || t.notes || t.project_id || t.client_id);
  out.forEach((t, i) => {
    const n = `Task ${i + 1}`;
    if (!t.task) throw badRequest(`${n}: describe the task`);
    if (t.task.length > 300) throw badRequest(`${n}: keep the task under 300 characters`);
    if (t.notes && t.notes.length > 1000) throw badRequest(`${n}: keep notes under 1000 characters`);
    if (!PRIORITIES.includes(t.priority)) throw badRequest(`${n}: priority must be high, medium or low`);
    if (t.expected_time && !HHMM_OPT.test(t.expected_time)) throw badRequest(`${n}: expected time must be HH:MM`);
    if (t.project_id && !projectIds.has(t.project_id)) throw badRequest(`${n}: that project is not available to you`);
    if (t.client_id && !clientIds.has(t.client_id)) throw badRequest(`${n}: that client is not available to you`);
  });
  if (submitting && !out.length) throw badRequest('Add at least one task before submitting');
  return out;
}

function addThread(tenantId, submissionId, userId, kind, body) {
  run('INSERT INTO todo_comments (id, tenant_id, submission_id, user_id, kind, body, created_at) VALUES (?,?,?,?,?,?,?)',
    [uuid(), tenantId, submissionId, userId, kind, body || null, nowIso()]);
}

function auditAs(auth, entityId, action, before, after) {
  run(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_name, entity, entity_id, action, before_json, after_json, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), auth.tenantId, auth.userId, auth.name ?? userName(auth.userId), 'todo_submission', entityId, action,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, null, nowIso()],
  );
}

/**
 * Save (and optionally submit) the caller's own plan for `todoDate`. The
 * reporting person is never taken from the request: it is read from the
 * employee's record at the moment of submission.
 */
export async function savePlan(auth, todoDate, { tasks = [], submit = false } = {}) {
  const win = windowFor(auth.tenantId);
  const s = win.settings;
  let sub = get('SELECT * FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
    [auth.tenantId, auth.userId, todoDate]);

  if (!sub) {
    if (!win.todo_date || todoDate !== win.todo_date) {
      throw badRequest(win.todo_date ? `Plans can only be filed for ${win.todo_date} today` : 'There is no To-Do to file today');
    }
    if (Date.now() > Date.parse(win.deadline_at) && !s.allow_late) {
      throw forbidden('The deadline has passed and late plans are not accepted');
    }
  } else {
    const state = editState(auth, sub, win);
    if (!state.can_edit) throw forbidden(state.reason || 'This plan can no longer be edited');
  }

  const clean = cleanTasks(auth, tasks, submit);
  const me = userRow(auth.userId);
  const now = nowIso();
  const before = sub
    ? { status: sub.status, tasks: all('SELECT task, priority FROM todo_tasks WHERE submission_id = ? ORDER BY sort', [sub.id]) }
    : null;
  const resubmission = sub?.status === 'CHANGES_REQUESTED';

  const id = tx(() => {
    if (!sub) {
      const newId = uuid();
      run(
        `INSERT INTO todo_submissions (id, tenant_id, user_id, reporting_person_id, todo_date, plan_date, status,
           deadline_at, created_at, updated_at) VALUES (?,?,?,?,?,?, 'DRAFT', ?,?,?)`,
        [newId, auth.tenantId, auth.userId, reportingPersonIds(auth.tenantId, me)[0] ?? null, todoDate, win.today,
          win.deadline_at, now, now],
      );
      sub = get('SELECT * FROM todo_submissions WHERE id = ?', [newId]);
    }
    run('DELETE FROM todo_tasks WHERE submission_id = ?', [sub.id]);
    clean.forEach((t, i) => run(
      `INSERT INTO todo_tasks (id, tenant_id, submission_id, task, project_id, client_id, priority, expected_time, notes,
         sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), auth.tenantId, sub.id, t.task, t.project_id, t.client_id, t.priority, t.expected_time, t.notes, i, now, now],
    ));

    if (submit) {
      // A resubmission answers the reviewer; it is not late against the original deadline.
      const late = !resubmission && sub.deadline_at && Date.now() > Date.parse(sub.deadline_at);
      const minutesLate = late ? Math.ceil((Date.now() - Date.parse(sub.deadline_at)) / 60_000) : sub.minutes_late;
      run(
        `UPDATE todo_submissions SET status = ?, submitted_at = ?, minutes_late = ?, reporting_person_id = ?, updated_at = ?
          WHERE id = ?`,
        [late ? 'LATE' : 'SUBMITTED', now, minutesLate ?? null, reportingPersonIds(auth.tenantId, me)[0] ?? null, now, sub.id],
      );
      addThread(auth.tenantId, sub.id, auth.userId, 'submitted', resubmission ? 'Resubmitted with changes' : null);
    } else {
      // A plain save never changes the status: a draft stays a draft, an overdue plan stays overdue.
      run('UPDATE todo_submissions SET updated_at = ? WHERE id = ?', [now, sub.id]);
    }
    return sub.id;
  });

  const saved = get('SELECT * FROM todo_submissions WHERE id = ?', [id]);
  const action = submit
    ? (resubmission ? 'resubmit' : saved.status === 'LATE' ? 'submit_late' : 'submit')
    : (before ? 'edit' : 'create');
  auditAs(auth, id, action, before, { status: saved.status, tasks: clean.map((t) => ({ task: t.task, priority: t.priority })) });

  if (submit) {
    const late = saved.status === 'LATE' ? ` (${saved.minutes_late} min late)` : '';
    for (const rid of reportingPersonIds(auth.tenantId, me)) {
      const recipient = userRow(rid);
      if (recipient) {
        await tell(auth.tenantId, recipient, EVENTS.submitted,
          { person: `${me.name}${late}`, todo_date: saved.todo_date, todo_day: dayLabel(saved.todo_date), count: clean.length }, null, s, planLink(id));
      }
    }
  }
  return detail(auth, saved, win);
}

/** The reporting person opening a plan moves it to UNDER_REVIEW, so it cannot change underneath them. */
export function startReview(auth, id) {
  const sub = loadSubmission(auth, id);
  if (canReview(auth, sub) && ['SUBMITTED', 'LATE'].includes(sub.status)) {
    run("UPDATE todo_submissions SET status = 'UNDER_REVIEW', updated_at = ? WHERE id = ?", [nowIso(), sub.id]);
    auditAs(auth, sub.id, 'review_start', { status: sub.status }, { status: 'UNDER_REVIEW' });
  }
  return detail(auth, get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]));
}

export async function decide(auth, id, { approve, note }) {
  const sub = loadSubmission(auth, id);
  if (!canReview(auth, sub)) throw forbidden('Only the reporting person or an owner can review this plan');
  if (!AWAITING_REVIEW.includes(sub.status)) {
    throw badRequest(`This plan is ${sub.status.toLowerCase().replace(/_/g, ' ')}, not awaiting review`);
  }
  const text = String(note ?? '').trim();
  if (!approve && !text) throw badRequest('Say what needs to change');
  if (text.length > 2000) throw badRequest('Keep the note under 2000 characters');

  const now = nowIso();
  const status = approve ? 'APPROVED' : 'CHANGES_REQUESTED';
  tx(() => {
    run(
      'UPDATE todo_submissions SET status = ?, reviewed_by = ?, reviewed_at = ?, approved_at = ?, updated_at = ? WHERE id = ?',
      [status, auth.userId, now, approve ? now : null, now, sub.id],
    );
    addThread(auth.tenantId, sub.id, auth.userId, approve ? 'approved' : 'changes_requested', text || null);
  });
  auditAs(auth, sub.id, approve ? 'approve' : 'request_changes', { status: sub.status }, { status, note: text || null });

  await tell(auth.tenantId, userRow(sub.user_id), approve ? EVENTS.approved : EVENTS.changes,
    { reviewer: userName(auth.userId), todo_date: sub.todo_date, todo_day: dayLabel(sub.todo_date), note: text }, null, settingsFor(auth.tenantId), planLink(sub.id));
  return detail(auth, get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]));
}

export async function addComment(auth, id, body) {
  const sub = loadSubmission(auth, id);
  const text = String(body ?? '').trim();
  if (!text) throw badRequest('Write a comment');
  if (text.length > 2000) throw badRequest('Keep the comment under 2000 characters');
  addThread(auth.tenantId, sub.id, auth.userId, 'comment', text);
  auditAs(auth, sub.id, 'comment', null, { body: text });

  // The other side of the conversation hears about it.
  const to = sub.user_id === auth.userId ? [sub.reporting_person_id].filter(Boolean) : [sub.user_id];
  for (const rid of to.filter((x) => x !== auth.userId)) {
    const recipient = userRow(rid);
    if (recipient) {
      await tell(auth.tenantId, recipient, EVENTS.comment,
        { person: userName(auth.userId), todo_date: sub.todo_date, todo_day: dayLabel(sub.todo_date), note: text.slice(0, 300) }, null, settingsFor(auth.tenantId), planLink(sub.id));
    }
  }
  return detail(auth, get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]));
}

export const getPlan = (auth, id) => detail(auth, loadSubmission(auth, id));

/**
 * The reviewer's view of one planned day: each of their people and where their
 * plan stands, plus every plan still waiting on them. An owner sees everyone.
 * Someone with nobody reporting to them gets `is_reviewer: false`.
 */
export function team(auth, day) {
  const win = windowFor(auth.tenantId);
  const s = win.settings;
  const target = day || win.todo_date || nextWorkingDay(auth.tenantId, win.today, s);
  const admin = isAdmin(auth);

  const people = plannersOf(auth.tenantId)
    .filter((u) => u.id !== auth.userId && (admin || u.manager_id === auth.userId));

  const plans = all(
    `SELECT s.*, (SELECT COUNT(*) FROM todo_tasks t WHERE t.submission_id = s.id) AS task_count
       FROM todo_submissions s WHERE s.tenant_id = ? AND s.todo_date = ?`,
    [auth.tenantId, target],
  );
  const byUser = new Map(plans.map((p) => [p.user_id, p]));
  // Someone reassigned away since filing still shows to the person their plan went to.
  const extra = plans
    .filter((p) => p.reporting_person_id === auth.userId && !people.some((u) => u.id === p.user_id))
    .map((p) => userRow(p.user_id)).filter(Boolean);

  const rows = [...people, ...extra].map((u) => {
    const p = byUser.get(u.id);
    return {
      user: { id: u.id, name: u.name, designation: u.designation },
      reporting_person_name: userName(reportingPersonIds(auth.tenantId, u)[0]),
      plan: p ? {
        id: p.id, status: p.status, submitted_at: p.submitted_at, minutes_late: p.minutes_late,
        task_count: Number(p.task_count),
      } : null,
    };
  }).sort((a, b) => a.user.name.localeCompare(b.user.name));

  const counts = { total: rows.length, not_submitted: 0 };
  for (const st of STATUSES) counts[st] = 0;
  for (const r of rows) {
    if (!r.plan || ['DRAFT', 'OVERDUE', 'MISSED'].includes(r.plan.status)) counts.not_submitted += 1;
    if (r.plan) counts[r.plan.status] += 1;
  }

  const pending = all(
    `SELECT s.id, s.user_id, u.name AS employee_name, s.todo_date, s.status, s.submitted_at, s.minutes_late,
            (SELECT COUNT(*) FROM todo_tasks t WHERE t.submission_id = s.id) AS task_count
       FROM todo_submissions s JOIN users u ON u.id = s.user_id
      WHERE s.tenant_id = ? AND s.status IN ('SUBMITTED','LATE','UNDER_REVIEW') AND s.todo_date >= ?
        AND s.user_id != ? ${admin ? '' : 'AND s.reporting_person_id = ?'}
      ORDER BY s.submitted_at`,
    admin ? [auth.tenantId, win.today, auth.userId] : [auth.tenantId, win.today, auth.userId, auth.userId],
  ).map((p) => ({ ...p, task_count: Number(p.task_count) }));

  return {
    todo_date: target,
    deadline_time: s.deadline_time,
    is_reviewer: admin || rows.length > 0 || pending.length > 0,
    is_admin: admin,
    counts,
    rows,
    pending,
  };
}
