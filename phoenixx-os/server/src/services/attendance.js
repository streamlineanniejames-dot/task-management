import { get, all, run } from '../db/index.js';
import { uuid, nowIso, parseJson } from '../lib/util.js';
import {
  DEFAULT_TZ, DUE_TIME_RE, localToUtc, todayInTz, timeInTz, formatDueTime,
} from '../lib/dueTime.js';

/**
 * Module C - the working day.
 *
 * Attendance decides pay and performance scores, so the two things it must
 * never get wrong are *when* the day was and *who* said so. Both are settled
 * here rather than in the routes:
 *
 *  - **When.** A working day is a day on the workspace calendar, and a shift
 *    starts at a workspace-local wall clock. The server is not in the office
 *    and neither is UTC, so every comparison goes through the tenant timezone.
 *  - **Who.** The employee stamps nothing. Check-in and check-out times are
 *    taken from the server clock at the moment the button is pressed, and the
 *    only other way a time can move is an HR correction, which is logged.
 *
 * The schedule is resolved per employee with a workspace fallback, and it is
 * *snapshotted onto the attendance row* at check-in - HR changing someone's
 * hours in October must not rewrite whether they were late in September.
 */

const DEFAULTS = { start: '09:30', end: '18:30', grace: 10 };

/** Day kinds a working day can turn out not to be. */
export const HOLIDAY = 'holiday';
export const WEEK_OFF = 'weekoff';

/** Statuses the register and My Day both read. */
export const STATUSES = [
  'present', 'pending_approval', 'not_approved', 'absent',
  'half_day', 'wfh', 'leave', HOLIDAY, WEEK_OFF,
];

/** A late arrival nobody has ruled on yet. */
export const PENDING = 'pending_approval';

const tenantRow = (tenantId) => get(
  `SELECT timezone, work_start, work_end, late_grace_minutes, week_off_days
     FROM tenants WHERE id = ?`,
  [tenantId],
) || {};

export const tzFor = (tenantId) => tenantRow(tenantId).timezone || DEFAULT_TZ;

const validTime = (t) => (t && DUE_TIME_RE.test(String(t)) ? String(t) : null);

/**
 * The hours this person is expected to work: their own if HR has set them,
 * the workspace's otherwise. Returned with `source` so the HR screen can show
 * at a glance who is on the default and who has been given their own.
 */
export function scheduleFor(tenantId, userId) {
  const t = tenantRow(tenantId);
  const u = userId
    ? get('SELECT work_start, work_end, grace_minutes FROM users WHERE id = ? AND tenant_id = ?',
      [userId, tenantId])
    : null;

  const start = validTime(u?.work_start) || validTime(t.work_start) || DEFAULTS.start;
  const end = validTime(u?.work_end) || validTime(t.work_end) || DEFAULTS.end;
  const grace = u?.grace_minutes ?? t.late_grace_minutes ?? DEFAULTS.grace;

  return {
    start,
    end,
    grace_minutes: Number(grace) || 0,
    /** True when this person has hours of their own rather than the default. */
    custom: !!(validTime(u?.work_start) || validTime(u?.work_end) || u?.grace_minutes != null),
    timezone: t.timezone || DEFAULT_TZ,
  };
}

/** The workspace's own defaults, for the HR settings panel. */
export function workspaceSchedule(tenantId) {
  const t = tenantRow(tenantId);
  return {
    work_start: validTime(t.work_start) || DEFAULTS.start,
    work_end: validTime(t.work_end) || DEFAULTS.end,
    late_grace_minutes: Number(t.late_grace_minutes ?? DEFAULTS.grace),
    week_off_days: weekOffDays(tenantId),
    timezone: t.timezone || DEFAULT_TZ,
  };
}

/** The weekly off a workspace falls back to: Sunday, and nobody has to say so. */
export const DEFAULT_WEEK_OFF = [0];

/**
 * Weekday numbers that are a weekly off, 0 = Sunday.
 *
 * An empty list reads as Sunday rather than as "no weekly off at all". A
 * workspace with none would mark every employee absent every Sunday for ever,
 * which is never what somebody meant by unticking the last day - and the API
 * refuses to store an empty list precisely so this fallback stays theory.
 */
export function weekOffDays(tenantId) {
  const raw = parseJson(tenantRow(tenantId).week_off_days, null);
  const days = Array.isArray(raw) ? raw.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  const unique = [...new Set(days)].sort();
  return unique.length ? unique : [...DEFAULT_WEEK_OFF];
}

/** The weekday of a workspace-local date, read without timezone drift. */
export const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();

/** Today, on the workspace calendar. Never the server's day, never UTC's. */
export const workDayFor = (tenantId, at = new Date()) => todayInTz(tzFor(tenantId), at);

export const holidayOn = (tenantId, dateStr) => get(
  'SELECT * FROM holidays WHERE tenant_id = ? AND holiday_date = ? AND deleted_at IS NULL',
  [tenantId, dateStr],
) || null;

export const holidaysBetween = (tenantId, from, to) => all(
  `SELECT * FROM holidays WHERE tenant_id = ? AND holiday_date >= ? AND holiday_date <= ?
     AND deleted_at IS NULL ORDER BY holiday_date`,
  [tenantId, from, to],
);

/**
 * What kind of day this is before anybody has done anything about it. A
 * holiday outranks a weekly off so the calendar names the reason people are
 * away, not merely that they are.
 */
export function dayKind(tenantId, dateStr, holidays = null) {
  const holiday = holidays
    ? holidays.find((h) => h.holiday_date === dateStr) || null
    : holidayOn(tenantId, dateStr);
  if (holiday) return { kind: HOLIDAY, holiday };
  if (weekOffDays(tenantId).includes(weekdayOf(dateStr))) return { kind: WEEK_OFF, holiday: null };
  return { kind: 'working', holiday: null };
}

/** Nobody is expected to check in on a holiday or a weekly off. */
export const isWorkingDay = (tenantId, dateStr) => dayKind(tenantId, dateStr).kind === 'working';

/**
 * How late an arrival was, and therefore whether HR has to look at it.
 *
 * Grace is deliberately part of "on time" rather than a separate forgiven
 * state: a workspace that allows ten minutes has decided 09:39 is on time, and
 * saying so plainly beats filing a rubber-stamp approval every morning.
 */
export function assessCheckIn({ tenantId, workDate, at, schedule }) {
  const tz = schedule.timezone || tzFor(tenantId);
  const shiftStart = localToUtc(workDate, schedule.start, tz);
  const lateMinutes = Math.max(0, Math.round((new Date(at) - shiftStart) / 60_000));
  const late = lateMinutes > schedule.grace_minutes;
  return {
    late,
    late_minutes: lateMinutes,
    status: late ? PENDING : 'present',
    scheduled_start: schedule.start,
    scheduled_end: schedule.end,
  };
}

/** Minutes between the two stamps, floored at zero. */
export const workMinutes = (inAt, outAt) => (inAt && outAt
  ? Math.max(0, Math.round((new Date(outAt) - new Date(inAt)) / 60_000))
  : 0);

/**
 * A checkout that never came. Only ever true for a day that is already over -
 * somebody still at their desk at four in the afternoon has not forgotten
 * anything, and telling HR they have would make the flag worthless.
 */
export const checkoutMissing = (tenantId, row, now = new Date()) => !!row?.check_in_at
  && !row.check_out_at
  && row.work_date < workDayFor(tenantId, now);

/** Appends to a day's history. Append-only: nothing here is ever updated. */
export function logAttendance({
  tenantId, attendanceId, userId, workDate, event, actorId = null,
  fromStatus = null, toStatus = null, note = null, at = null,
}) {
  const ts = nowIso();
  run(
    `INSERT INTO attendance_events (id, tenant_id, attendance_id, user_id, work_date, event,
       actor_id, from_status, to_status, note, at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, attendanceId, userId, workDate, event, actorId,
      fromStatus, toStatus, note, at || ts, ts],
  );
}

export const historyFor = (tenantId, attendanceId) => all(
  `SELECT e.*, u.name AS actor_name, u.avatar_url AS actor_avatar
     FROM attendance_events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.tenant_id = ? AND e.attendance_id = ?
    ORDER BY e.created_at, e.rowid`,
  [tenantId, attendanceId],
);

/** "8h 52m" - the one way working hours are said, on every screen. */
export function hoursLabel(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Everything a screen needs to talk about one attendance row, worked out once
 * here so My Day, the register and the CSV cannot drift apart.
 */
export function decorate(tenantId, row, { now = new Date() } = {}) {
  if (!row) return row;
  const tz = tzFor(tenantId);
  return {
    ...row,
    checkout_missing: checkoutMissing(tenantId, row, now),
    work_hours_label: row.work_minutes ? hoursLabel(row.work_minutes) : null,
    check_in_label: row.check_in_at ? formatDueTime(timeInTz(tz, new Date(row.check_in_at))) : null,
    check_out_label: row.check_out_at ? formatDueTime(timeInTz(tz, new Date(row.check_out_at))) : null,
    scheduled_start_label: formatDueTime(row.scheduled_start),
    scheduled_end_label: formatDueTime(row.scheduled_end),
  };
}
