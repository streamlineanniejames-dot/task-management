import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import {
  uuid, nowIso, todayIso, monthIso, daysBetween, startOfMonth, endOfMonth, pct, round1, toCsv,
} from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, forbidden, audit, paginate, pageMeta } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import { notifyMany } from '../services/notifications.js';
import { upsertDeadline, resolveDeadline } from '../services/deadlines.js';

const router = Router();

// ============================================================ C1 ATTENDANCE
const geoSchema = z.object({
  lat: z.number().optional(),
  lng: z.number().optional(),
  accuracy: z.number().optional(),
});

router.post('/attendance/check-in', requires('hr_attendance', 'create'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({
    geo: geoSchema.optional(),
    source: z.enum(['web', 'mobile']).optional(),
    work_date: z.string().optional(),      // AR5: offline queue replays with its own date
    at: z.string().optional(),
    notes: z.string().optional().nullable(),
  }), req.body || {});

  const workDate = body.work_date || todayIso();
  const at = body.at || nowIso();
  const existing = get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
    [tenantId, userId, workDate]);
  if (existing?.check_in_at) {
    return ok(res, { ...existing, already_checked_in: true });
  }

  // Standard day starts 09:30 IST (04:00 UTC); anything later is logged as late.
  const shiftStart = new Date(`${workDate}T04:00:00.000Z`);
  const lateMinutes = Math.max(0, Math.round((new Date(at) - shiftStart) / 60_000));

  const id = existing?.id || uuid();
  if (existing) {
    run(
      `UPDATE attendance SET check_in_at = ?, in_lat = ?, in_lng = ?, in_accuracy = ?, source = ?,
         status = 'present', late_minutes = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`,
      [at, body.geo?.lat ?? null, body.geo?.lng ?? null, body.geo?.accuracy ?? null,
        body.source || 'web', lateMinutes, body.notes ?? null, nowIso(), id],
    );
  } else {
    run(
      `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, in_lat, in_lng,
         in_accuracy, source, status, late_minutes, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'present', ?,?,?,?)`,
      [id, tenantId, userId, workDate, at, body.geo?.lat ?? null, body.geo?.lng ?? null,
        body.geo?.accuracy ?? null, body.source || 'web', lateMinutes, body.notes ?? null,
        nowIso(), nowIso()],
    );
  }
  return created(res, get('SELECT * FROM attendance WHERE id = ?', [id]));
});

router.post('/attendance/check-out', requires('hr_attendance', 'create'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({
    geo: geoSchema.optional(), work_date: z.string().optional(), at: z.string().optional(),
  }), req.body || {});

  const workDate = body.work_date || todayIso();
  const at = body.at || nowIso();
  const row = get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
    [tenantId, userId, workDate]);
  if (!row?.check_in_at) throw badRequest('You have not checked in for this day yet');

  const minutes = Math.max(0, Math.round((new Date(at) - new Date(row.check_in_at)) / 60_000));
  run(
    `UPDATE attendance SET check_out_at = ?, out_lat = ?, out_lng = ?, work_minutes = ?,
       status = CASE WHEN ? < 240 THEN 'half_day' ELSE 'present' END, updated_at = ? WHERE id = ?`,
    [at, body.geo?.lat ?? null, body.geo?.lng ?? null, minutes, minutes, nowIso(), row.id],
  );
  return ok(res, get('SELECT * FROM attendance WHERE id = ?', [row.id]));
});

router.get('/attendance/today', requires('hr_attendance', 'view'), (req, res) => {
  const { tenantId, userId } = req.auth;
  const today = todayIso();
  return ok(res, {
    me: get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
      [tenantId, userId, today]) || null,
    team: can(req.auth, 'hr_attendance', 'approve')
      ? all(
        `SELECT a.*, u.name, u.avatar_url, u.designation FROM attendance a
           JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id = ? AND a.work_date = ? ORDER BY a.check_in_at`,
        [tenantId, today],
      )
      : [],
    absent: can(req.auth, 'hr_attendance', 'approve')
      ? all(
        `SELECT u.id, u.name, u.avatar_url, u.designation FROM users u
          WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status = 'active' AND u.role != 'client'
            AND u.id NOT IN (SELECT user_id FROM attendance WHERE tenant_id = ? AND work_date = ?)`,
        [tenantId, tenantId, today],
      )
      : [],
  });
});

/** C1 - the monthly attendance register. */
router.get('/attendance/register', requires('hr_attendance', 'view'), (req, res) => {
  const { tenantId } = req.auth;
  const month = req.query.month || monthIso();
  const from = startOfMonth(month).slice(0, 10);
  const to = endOfMonth(month).slice(0, 10);

  const scopeToSelf = !can(req.auth, 'hr_attendance', 'approve');
  const users = all(
    `SELECT id, name, avatar_url, designation, role FROM users
      WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client'
        ${scopeToSelf ? 'AND id = ?' : ''} ORDER BY name`,
    scopeToSelf ? [tenantId, req.auth.userId] : [tenantId],
  );

  const records = all(
    'SELECT * FROM attendance WHERE tenant_id = ? AND work_date >= ? AND work_date <= ?',
    [tenantId, from, to],
  );
  const leaves = all(
    `SELECT * FROM leave_requests WHERE tenant_id = ? AND status = 'approved'
       AND from_date <= ? AND to_date >= ?`,
    [tenantId, to, from],
  );

  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days.push({ date: iso, weekend: [0, 6].includes(d.getUTCDay()) });
  }

  return ok(res, {
    month,
    days,
    rows: users.map((u) => {
      const mine = records.filter((r) => r.user_id === u.id);
      const myLeaves = leaves.filter((l) => l.user_id === u.id);
      const cells = days.map((day) => {
        const rec = mine.find((r) => r.work_date === day.date);
        if (rec) return { date: day.date, status: rec.status, work_minutes: rec.work_minutes, late_minutes: rec.late_minutes, check_in_at: rec.check_in_at, check_out_at: rec.check_out_at };
        if (myLeaves.some((l) => l.from_date <= day.date && l.to_date >= day.date)) {
          return { date: day.date, status: 'leave' };
        }
        if (day.weekend) return { date: day.date, status: 'weekoff' };
        return { date: day.date, status: day.date <= todayIso() ? 'absent' : null };
      });
      const workingDays = cells.filter((c) => !['weekoff', null].includes(c.status)).length;
      const present = cells.filter((c) => ['present', 'wfh'].includes(c.status)).length;
      return {
        user: u,
        cells,
        summary: {
          present,
          half_day: cells.filter((c) => c.status === 'half_day').length,
          leave: cells.filter((c) => c.status === 'leave').length,
          absent: cells.filter((c) => c.status === 'absent').length,
          working_days: workingDays,
          attendance_pct: pct(present, workingDays),
          avg_hours: round1(
            mine.filter((r) => r.work_minutes).reduce((a, r) => a + r.work_minutes, 0)
            / (mine.filter((r) => r.work_minutes).length || 1) / 60,
          ),
        },
      };
    }),
  });
});

router.get('/attendance/export', requires('hr_attendance', 'export'), (req, res) => {
  const month = req.query.month || monthIso();
  const rows = all(
    `SELECT u.name AS employee, a.work_date, a.status, a.check_in_at, a.check_out_at,
            a.work_minutes, a.late_minutes, a.source
       FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ? AND a.work_date >= ? AND a.work_date <= ?
      ORDER BY u.name, a.work_date`,
    [req.auth.tenantId, startOfMonth(month).slice(0, 10), endOfMonth(month).slice(0, 10)],
  );
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${month}.csv"`);
  return res.send(toCsv(rows));
});

// ---------------------------------------------------------- regularization
router.post('/attendance/regularize', requires('hr_attendance', 'create'), (req, res) => {
  const body = validate(z.object({
    work_date: z.string(),
    requested_in: z.string().optional().nullable(),
    requested_out: z.string().optional().nullable(),
    requested_status: z.enum(['present', 'half_day', 'wfh']).optional(),
    reason: z.string().min(5).max(1000),
  }), req.body);
  const { tenantId, userId } = req.auth;

  const id = uuid();
  run(
    `INSERT INTO attendance_regularizations (id, tenant_id, user_id, work_date, requested_in,
       requested_out, requested_status, reason, approver_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, userId, body.work_date, body.requested_in ?? null, body.requested_out ?? null,
      body.requested_status || 'present', body.reason, req.auth.managerId ?? null, nowIso(), nowIso()],
  );

  if (req.auth.managerId) {
    notifyMany({
      tenantId, userIds: [req.auth.managerId], eventKey: 'leave.requested',
      vars: { days: 1, leave_type: 'attendance regularization', from_date: body.work_date, to_date: body.work_date, reason: body.reason },
      link: '/hr/attendance',
    }).catch(() => {});
  }
  return created(res, get('SELECT * FROM attendance_regularizations WHERE id = ?', [id]));
});

router.get('/attendance/regularizations', requires('hr_attendance', 'view'), (req, res) => {
  const canApprove = can(req.auth, 'hr_attendance', 'approve');
  return ok(res, all(
    `SELECT r.*, u.name AS user_name, u.avatar_url FROM attendance_regularizations r
       JOIN users u ON u.id = r.user_id
      WHERE r.tenant_id = ? ${canApprove ? '' : 'AND r.user_id = ?'}
        ${req.query.status ? 'AND r.status = ?' : ''}
      ORDER BY r.created_at DESC LIMIT 200`,
    [req.auth.tenantId, ...(canApprove ? [] : [req.auth.userId]), ...(req.query.status ? [req.query.status] : [])],
  ));
});

router.post('/attendance/regularizations/:id/decide', requires('hr_attendance', 'approve'), (req, res) => {
  const { decision, note } = validate(
    z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().optional() }), req.body,
  );
  const { tenantId, userId } = req.auth;
  const reg = get('SELECT * FROM attendance_regularizations WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
  if (!reg) throw notFound('Regularization request');
  if (reg.status !== 'pending') throw badRequest('This request has already been decided');

  tx(() => {
    run(
      'UPDATE attendance_regularizations SET status = ?, approver_id = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?',
      [decision, userId, nowIso(), note ?? null, nowIso(), reg.id],
    );
    if (decision === 'approved') {
      const minutes = reg.requested_in && reg.requested_out
        ? Math.max(0, Math.round((new Date(reg.requested_out) - new Date(reg.requested_in)) / 60_000))
        : 480;
      run(
        `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, check_out_at,
           source, status, work_minutes, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'regularized', ?,?,?,?,?)
         ON CONFLICT (tenant_id, user_id, work_date) DO UPDATE SET
           check_in_at = excluded.check_in_at, check_out_at = excluded.check_out_at,
           source = 'regularized', status = excluded.status, work_minutes = excluded.work_minutes,
           updated_at = excluded.updated_at`,
        [uuid(), tenantId, reg.user_id, reg.work_date, reg.requested_in, reg.requested_out,
          reg.requested_status || 'present', minutes, `Regularized: ${reg.reason}`, nowIso(), nowIso()],
      );
    }
  });

  audit(req, { entity: 'attendance_regularization', entityId: reg.id, action: decision === 'approved' ? 'approve' : 'reject' });
  return ok(res, get('SELECT * FROM attendance_regularizations WHERE id = ?', [reg.id]));
});

// ================================================================= C2 LEAVE
router.get('/leave/types', requires('hr_leave', 'view'), (req, res) => ok(res, all(
  'SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1 ORDER BY name', [req.auth.tenantId],
)));

router.get('/leave/balances', requires('hr_leave', 'view'), (req, res) => {
  const { tenantId } = req.auth;
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  const userId = req.query.user_id && can(req.auth, 'hr_leave', 'approve') ? req.query.user_id : req.auth.userId;

  const types = all('SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1', [tenantId]);
  return ok(res, types.map((t) => {
    const bal = get(
      'SELECT * FROM leave_balances WHERE tenant_id = ? AND user_id = ? AND leave_type_id = ? AND year = ?',
      [tenantId, userId, t.id, year],
    );
    const used = Number(get(
      `SELECT COALESCE(SUM(days),0) AS d FROM leave_requests WHERE tenant_id = ? AND user_id = ?
         AND leave_type_id = ? AND status = 'approved' AND from_date LIKE ?`,
      [tenantId, userId, t.id, `${year}%`],
    )?.d || 0);
    const entitled = bal?.entitled ?? t.annual_quota;
    return {
      leave_type_id: t.id, name: t.name, code: t.code, color: t.color,
      entitled, used, carried: bal?.carried || 0,
      available: round1(entitled + (bal?.carried || 0) - used),
    };
  }));
});

const leaveSchema = z.object({
  leave_type_id: z.string(),
  kind: z.enum(['leave', 'permission']).optional(),
  from_date: z.string(),
  to_date: z.string(),
  from_time: z.string().optional().nullable(),
  to_time: z.string().optional().nullable(),
  reason: z.string().min(3).max(1000),
});

router.get('/leave/requests', requires('hr_leave', 'view'), (req, res) => {
  const { page, limit, offset } = paginate(req);
  const canApprove = can(req.auth, 'hr_leave', 'approve');
  const filters = ['l.tenant_id = ?'];
  const params = [req.auth.tenantId];

  if (!canApprove) { filters.push('l.user_id = ?'); params.push(req.auth.userId); }
  else if (req.auth.role === 'manager') {
    filters.push('(l.user_id = ? OR l.user_id IN (SELECT id FROM users WHERE manager_id = ?))');
    params.push(req.auth.userId, req.auth.userId);
  }
  if (req.query.status) { filters.push('l.status = ?'); params.push(req.query.status); }
  if (req.query.user_id && canApprove) { filters.push('l.user_id = ?'); params.push(req.query.user_id); }
  if (req.query.from) { filters.push('l.to_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('l.from_date <= ?'); params.push(req.query.to); }

  const where = filters.join(' AND ');
  const total = Number(get(`SELECT COUNT(*) AS n FROM leave_requests l WHERE ${where}`, params)?.n || 0);
  const rows = all(
    `SELECT l.*, u.name AS user_name, u.avatar_url, lt.name AS leave_type_name, lt.code AS leave_type_code,
            lt.color, a.name AS approver_name
       FROM leave_requests l
       JOIN users u ON u.id = l.user_id
       JOIN leave_types lt ON lt.id = l.leave_type_id
       LEFT JOIN users a ON a.id = l.approver_id
      WHERE ${where} ORDER BY l.from_date DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return ok(res, rows, pageMeta(page, limit, total));
});

router.post('/leave/requests', requires('hr_leave', 'create'), (req, res) => {
  const body = validate(leaveSchema, req.body);
  const { tenantId, userId } = req.auth;

  if (body.to_date < body.from_date) throw badRequest('The end date cannot be before the start date');
  const type = get('SELECT * FROM leave_types WHERE id = ? AND tenant_id = ? AND active = 1',
    [body.leave_type_id, tenantId]);
  if (!type) throw notFound('Leave type');

  const days = body.kind === 'permission' ? 0.25 : daysBetween(body.from_date, body.to_date) + 1;

  const overlap = get(
    `SELECT id FROM leave_requests WHERE tenant_id = ? AND user_id = ? AND status IN ('pending','approved')
       AND from_date <= ? AND to_date >= ?`,
    [tenantId, userId, body.to_date, body.from_date],
  );
  if (overlap) throw badRequest('You already have a leave request covering those dates');

  const id = uuid();
  run(
    `INSERT INTO leave_requests (id, tenant_id, user_id, leave_type_id, kind, from_date, to_date,
       from_time, to_time, days, reason, approver_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, userId, body.leave_type_id, body.kind || 'leave', body.from_date, body.to_date,
      body.from_time ?? null, body.to_time ?? null, days, body.reason, req.auth.managerId ?? null,
      nowIso(), nowIso()],
  );

  // B1: an approval that has not happened is a deadline the manager owns.
  if (req.auth.managerId) {
    upsertDeadline({
      tenantId, sourceType: 'leave', sourceId: id,
      title: `Approve leave: ${req.auth.name} (${body.from_date})`,
      dueAt: body.from_date, ownerId: req.auth.managerId, escalationDays: 1,
    });
    notifyMany({
      tenantId, userIds: [req.auth.managerId], eventKey: 'leave.requested',
      vars: { days, leave_type: type.name, from_date: body.from_date, to_date: body.to_date, reason: body.reason },
      link: '/hr/leave',
    }).catch(() => {});
  }

  return created(res, get('SELECT * FROM leave_requests WHERE id = ?', [id]));
});

router.post('/leave/requests/:id/decide', requires('hr_leave', 'approve'), (req, res) => {
  const { decision, note } = validate(
    z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().optional() }), req.body,
  );
  const { tenantId, userId } = req.auth;
  const lr = get('SELECT * FROM leave_requests WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
  if (!lr) throw notFound('Leave request');
  if (lr.status !== 'pending') throw badRequest('This request has already been decided');
  if (lr.user_id === userId && req.auth.role !== 'owner') throw forbidden('You cannot approve your own leave');

  run('UPDATE leave_requests SET status = ?, approver_id = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?',
    [decision, userId, nowIso(), note ?? null, nowIso(), lr.id]);
  resolveDeadline(tenantId, 'leave', lr.id, decision === 'approved' ? 'met' : 'cancelled');

  notifyMany({
    tenantId, userIds: [lr.user_id], eventKey: 'leave.decided',
    vars: { status: decision, from_date: lr.from_date, to_date: lr.to_date, note: note ? `: ${note}` : '' },
    link: '/hr/leave',
  }).catch(() => {});

  audit(req, { entity: 'leave_request', entityId: lr.id, action: decision === 'approved' ? 'approve' : 'reject' });
  return ok(res, get('SELECT * FROM leave_requests WHERE id = ?', [lr.id]));
});

router.delete('/leave/requests/:id', requires('hr_leave', 'create'), (req, res) => {
  const lr = get('SELECT * FROM leave_requests WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!lr) throw notFound('Leave request');
  if (lr.user_id !== req.auth.userId && !can(req.auth, 'hr_leave', 'delete')) throw forbidden();
  if (lr.status === 'approved' && lr.from_date <= todayIso()) throw badRequest('Leave that has already started cannot be withdrawn');

  run("UPDATE leave_requests SET status = 'withdrawn', updated_at = ? WHERE id = ?", [nowIso(), lr.id]);
  resolveDeadline(req.auth.tenantId, 'leave', lr.id, 'cancelled');
  return ok(res, { ok: true });
});

/** C2 - team availability calendar. */
router.get('/leave/calendar', requires('hr_leave', 'view'), (req, res) => {
  const month = req.query.month || monthIso();
  return ok(res, all(
    `SELECT l.id, l.from_date, l.to_date, l.days, l.kind, l.status, u.id AS user_id, u.name, u.avatar_url,
            lt.name AS leave_type_name, lt.color
       FROM leave_requests l
       JOIN users u ON u.id = l.user_id
       JOIN leave_types lt ON lt.id = l.leave_type_id
      WHERE l.tenant_id = ? AND l.status IN ('approved','pending')
        AND l.from_date <= ? AND l.to_date >= ?
      ORDER BY l.from_date`,
    [req.auth.tenantId, endOfMonth(month).slice(0, 10), startOfMonth(month).slice(0, 10)],
  ));
});

// =========================================================== C3 PERFORMANCE
router.get('/performance', requires('hr_performance', 'view'), (req, res) => {
  const { tenantId } = req.auth;
  const canSeeAll = can(req.auth, 'hr_performance', 'approve');
  const month = req.query.month || monthIso();
  const filters = ['r.tenant_id = ?', 'r.period_month = ?'];
  const params = [tenantId, month];

  if (!canSeeAll) { filters.push('r.user_id = ?'); params.push(req.auth.userId); }
  else if (req.auth.role === 'manager') {
    filters.push('(r.user_id = ? OR r.user_id IN (SELECT id FROM users WHERE manager_id = ?))');
    params.push(req.auth.userId, req.auth.userId);
  }
  if (req.query.user_id && canSeeAll) { filters.push('r.user_id = ?'); params.push(req.query.user_id); }

  return ok(res, all(
    `SELECT r.*, u.name AS user_name, u.avatar_url, u.designation, u.role AS user_role,
            rev.name AS reviewer_name
       FROM performance_reviews r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users rev ON rev.id = r.reviewer_id
      WHERE ${filters.join(' AND ')} ORDER BY r.overall_score DESC NULLS LAST, u.name`,
    params,
  ).map((r) => ({
    ...r,
    kpis: all('SELECT * FROM performance_kpi_scores WHERE review_id = ?', [r.id]),
  })));
});

/** Recomputes the data-derived half of a review from source records. */
router.post('/performance/generate', requires('hr_performance', 'create'), (req, res) => {
  const { month = monthIso(), user_id: onlyUser } = req.body || {};
  const { tenantId } = req.auth;
  const from = startOfMonth(month).slice(0, 10);
  const to = endOfMonth(month).slice(0, 10);

  const staff = all(
    `SELECT * FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
       AND role != 'client' ${onlyUser ? 'AND id = ?' : ''}`,
    onlyUser ? [tenantId, onlyUser] : [tenantId],
  );
  let n = 0;

  for (const u of staff) {
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
    const sop = get(
      'SELECT AVG(adherence_pct) AS a FROM sop_runs WHERE tenant_id = ? AND user_id = ? AND started_at >= ?',
      [tenantId, u.id, `${from}T00:00:00Z`],
    ) || {};

    const completion = pct(Number(items.done || 0), Number(items.assigned || 0));
    const attendance = pct(Number(att.p || 0), Number(att.n || 0));
    const kpiScore = round1(completion * 0.5 + attendance * 0.2 + Number(sop.a || 0) * 0.3);

    const existing = get('SELECT * FROM performance_reviews WHERE tenant_id = ? AND user_id = ? AND period_month = ?',
      [tenantId, u.id, month]);
    const reviewId = existing?.id || uuid();

    if (existing) {
      run(
        `UPDATE performance_reviews SET items_assigned = ?, items_completed = ?, items_on_time = ?,
           completion_pct = ?, attendance_pct = ?, kpi_score = ?, updated_at = ? WHERE id = ?`,
        [Number(items.assigned || 0), Number(items.done || 0), Number(items.on_time || 0),
          completion, attendance, kpiScore, nowIso(), reviewId],
      );
    } else {
      run(
        `INSERT INTO performance_reviews (id, tenant_id, user_id, period_month, items_assigned,
           items_completed, items_on_time, completion_pct, attendance_pct, kpi_score, status,
           reviewer_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?)`,
        [reviewId, tenantId, u.id, month, Number(items.assigned || 0), Number(items.done || 0),
          Number(items.on_time || 0), completion, attendance, kpiScore, u.manager_id, nowIso(), nowIso()],
      );
    }

    run('DELETE FROM performance_kpi_scores WHERE review_id = ?', [reviewId]);
    const kpis = all(
      `SELECT * FROM kpis WHERE tenant_id = ? AND deleted_at IS NULL AND active = 1
         AND (applies_role IS NULL OR applies_role = ?)`,
      [tenantId, u.role],
    );
    for (const k of kpis) {
      const actual = {
        'action_items.completion': completion,
        'action_items.on_time': pct(Number(items.on_time || 0), Number(items.done || 0)),
        'attendance.pct': attendance,
        'sop.adherence': round1(Number(sop.a || 0)),
      }[k.source] ?? null;
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

  audit(req, { entity: 'performance_review', action: 'create', after: { generated: n, month } });
  return ok(res, { generated: n, month });
});

router.patch('/performance/:id', requires('hr_performance', 'edit'), (req, res) => {
  const body = validate(z.object({
    manager_rating: z.number().min(1).max(5).optional(),
    strengths: z.string().optional().nullable(),
    improvements: z.string().optional().nullable(),
    status: z.enum(['draft', 'submitted', 'acknowledged']).optional(),
  }), req.body);

  const r = repo('performance_reviews', req.auth.tenantId);
  const before = r.findById(req.params.id);
  if (!before) throw notFound('Performance review');

  const patch = { ...body, updated_at: nowIso() };
  if (body.manager_rating != null) {
    // Overall blends the data-derived KPI score with the manager's judgement.
    patch.overall_score = round1(before.kpi_score * 0.7 + (body.manager_rating / 5) * 100 * 0.3);
    patch.reviewed_at = nowIso();
    patch.reviewer_id = req.auth.userId;
  }

  const after = r.update(req.params.id, patch);
  audit(req, { entity: 'performance_review', entityId: after.id, action: 'update', before, after });
  return ok(res, after);
});

router.get('/performance/history/:userId', requires('hr_performance', 'view'), (req, res) => {
  if (req.params.userId !== req.auth.userId && !can(req.auth, 'hr_performance', 'approve')) throw forbidden();
  return ok(res, all(
    `SELECT period_month, completion_pct, attendance_pct, kpi_score, manager_rating, overall_score, status
       FROM performance_reviews WHERE tenant_id = ? AND user_id = ? ORDER BY period_month DESC LIMIT 24`,
    [req.auth.tenantId, req.params.userId],
  ).reverse());
});

// =============================================================== C4 HIRING
const openingSchema = z.object({
  title: z.string().min(2).max(160),
  service_line_id: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  qualification: z.string().optional().nullable(),
  skills: z.array(z.string()).optional(),
  experience_min_years: z.number().min(0).optional(),
  experience_max_years: z.number().min(0).optional().nullable(),
  headcount: z.number().int().min(1).optional(),
  salary_min_minor: z.number().int().min(0).optional().nullable(),
  salary_max_minor: z.number().int().min(0).optional().nullable(),
  location: z.string().optional().nullable(),
  status: z.enum(['open', 'on_hold', 'closed']).optional(),
  hiring_manager_id: z.string().optional().nullable(),
  target_close_date: z.string().optional().nullable(),
});

router.get('/hiring/openings', requires('hr_hiring', 'view'), (req, res) => ok(res, all(
  `SELECT j.*, sl.name AS service_line_name, u.name AS hiring_manager_name,
          (SELECT COUNT(*) FROM candidates c WHERE c.job_opening_id = j.id AND c.deleted_at IS NULL) AS candidate_count
     FROM job_openings j
     LEFT JOIN service_lines sl ON sl.id = j.service_line_id
     LEFT JOIN users u ON u.id = j.hiring_manager_id
    WHERE j.tenant_id = ? AND j.deleted_at IS NULL ${req.query.status ? 'AND j.status = ?' : ''}
    ORDER BY j.created_at DESC`,
  req.query.status ? [req.auth.tenantId, req.query.status] : [req.auth.tenantId],
).map((j) => ({ ...j, skills: JSON.parse(j.skills || '[]') }))));

router.post('/hiring/openings', requires('hr_hiring', 'create'), (req, res) => {
  const body = validate(openingSchema, req.body);
  const id = uuid();
  run(
    `INSERT INTO job_openings (id, tenant_id, title, service_line_id, department, qualification, skills,
       experience_min_years, experience_max_years, headcount, salary_min_minor, salary_max_minor,
       location, status, hiring_manager_id, target_close_date, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.title, body.service_line_id ?? null, body.department ?? null,
      body.qualification ?? null, JSON.stringify(body.skills || []), body.experience_min_years || 0,
      body.experience_max_years ?? null, body.headcount || 1, body.salary_min_minor ?? null,
      body.salary_max_minor ?? null, body.location ?? null, body.status || 'open',
      body.hiring_manager_id ?? null, body.target_close_date ?? null, nowIso(), nowIso()],
  );
  audit(req, { entity: 'job_opening', entityId: id, action: 'create', after: { title: body.title } });
  return created(res, get('SELECT * FROM job_openings WHERE id = ?', [id]));
});

router.patch('/hiring/openings/:id', requires('hr_hiring', 'edit'), (req, res) => {
  const r = repo('job_openings', req.auth.tenantId);
  if (!r.findById(req.params.id)) throw notFound('Job opening');
  const body = validate(openingSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.skills) patch.skills = JSON.stringify(body.skills);
  return ok(res, r.update(req.params.id, patch));
});

router.delete('/hiring/openings/:id', requires('hr_hiring', 'delete'), (req, res) => {
  repo('job_openings', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

const CANDIDATE_STAGES = ['sourced', 'screened', 'interview', 'offer', 'hired', 'rejected'];

const candidateSchema = z.object({
  job_opening_id: z.string().optional().nullable(),
  name: z.string().min(2).max(120),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  experience_years: z.number().min(0).optional().nullable(),
  current_ctc_minor: z.number().int().min(0).optional().nullable(),
  expected_ctc_minor: z.number().int().min(0).optional().nullable(),
  stage: z.enum(CANDIDATE_STAGES).optional(),
  rating: z.number().min(1).max(5).optional().nullable(),
  notes: z.string().optional().nullable(),
  rejected_reason: z.string().optional().nullable(),
});

/** C4 - the hiring pipeline board. */
router.get('/hiring/candidates', requires('hr_hiring', 'view'), (req, res) => {
  const filters = ['c.tenant_id = ?', 'c.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (req.query.job_opening_id) { filters.push('c.job_opening_id = ?'); params.push(req.query.job_opening_id); }

  const rows = all(
    `SELECT c.*, j.title AS job_title FROM candidates c
       LEFT JOIN job_openings j ON j.id = c.job_opening_id
      WHERE ${filters.join(' AND ')} ORDER BY c.updated_at DESC`,
    params,
  );

  return ok(res, CANDIDATE_STAGES.map((stage) => ({
    stage,
    candidates: rows.filter((c) => c.stage === stage),
    count: rows.filter((c) => c.stage === stage).length,
  })));
});

router.post('/hiring/candidates', requires('hr_hiring', 'create'), (req, res) => {
  const body = validate(candidateSchema, req.body);
  const id = uuid();
  run(
    `INSERT INTO candidates (id, tenant_id, job_opening_id, name, email, phone, source,
       experience_years, current_ctc_minor, expected_ctc_minor, stage, rating, notes,
       stage_changed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.job_opening_id ?? null, body.name, body.email || null,
      body.phone ?? null, body.source ?? null, body.experience_years ?? null,
      body.current_ctc_minor ?? null, body.expected_ctc_minor ?? null, body.stage || 'sourced',
      body.rating ?? null, body.notes ?? null, nowIso(), nowIso(), nowIso()],
  );
  return created(res, get('SELECT * FROM candidates WHERE id = ?', [id]));
});

router.patch('/hiring/candidates/:id', requires('hr_hiring', 'edit'), (req, res) => {
  const r = repo('candidates', req.auth.tenantId);
  const before = r.findById(req.params.id);
  if (!before) throw notFound('Candidate');

  const body = validate(candidateSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.email === '') patch.email = null;

  if (body.stage && body.stage !== before.stage) {
    patch.stage_changed_at = nowIso();
    if (body.stage === 'rejected' && !body.rejected_reason && !before.rejected_reason) {
      throw badRequest('Rejecting a candidate needs a reason');
    }
    if (body.stage === 'hired' && before.job_opening_id) {
      run('UPDATE job_openings SET filled = filled + 1, updated_at = ? WHERE id = ?',
        [nowIso(), before.job_opening_id]);
      const opening = get('SELECT * FROM job_openings WHERE id = ?', [before.job_opening_id]);
      if (opening && opening.filled >= opening.headcount) {
        run("UPDATE job_openings SET status = 'closed', updated_at = ? WHERE id = ?", [nowIso(), opening.id]);
      }
    }
  }

  const after = r.update(req.params.id, patch);
  audit(req, { entity: 'candidate', entityId: after.id, action: 'update', before, after });
  return ok(res, after);
});

router.delete('/hiring/candidates/:id', requires('hr_hiring', 'delete'), (req, res) => {
  repo('candidates', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

router.get('/hiring/candidates/:id/interviews', requires('hr_hiring', 'view'), (req, res) => ok(res, all(
  `SELECT i.*, u.name AS interviewer_name FROM interviews i
     LEFT JOIN users u ON u.id = i.interviewer_id
    WHERE i.tenant_id = ? AND i.candidate_id = ? ORDER BY i.created_at`,
  [req.auth.tenantId, req.params.id],
)));

router.post('/hiring/candidates/:id/interviews', requires('hr_hiring', 'create'), (req, res) => {
  const body = validate(z.object({
    round: z.string().min(1),
    interviewer_id: z.string().optional().nullable(),
    scheduled_at: z.string().optional().nullable(),
    feedback: z.string().optional().nullable(),
    score: z.number().min(1).max(5).optional().nullable(),
    recommendation: z.enum(['proceed', 'hold', 'reject']).optional().nullable(),
  }), req.body);

  if (!get('SELECT id FROM candidates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId])) throw notFound('Candidate');

  const id = uuid();
  run(
    `INSERT INTO interviews (id, tenant_id, candidate_id, round, interviewer_id, scheduled_at,
       feedback, score, recommendation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, req.params.id, body.round, body.interviewer_id ?? null,
      body.scheduled_at ?? null, body.feedback ?? null, body.score ?? null,
      body.recommendation ?? null, nowIso(), nowIso()],
  );
  return created(res, get('SELECT * FROM interviews WHERE id = ?', [id]));
});

router.patch('/hiring/interviews/:id', requires('hr_hiring', 'edit'), (req, res) => {
  const iv = get('SELECT * FROM interviews WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!iv) throw notFound('Interview');

  const body = validate(z.object({
    feedback: z.string().optional().nullable(),
    score: z.number().min(1).max(5).optional().nullable(),
    recommendation: z.enum(['proceed', 'hold', 'reject']).optional().nullable(),
    scheduled_at: z.string().optional().nullable(),
  }), req.body);

  const cols = Object.keys(body);
  if (cols.length) {
    run(`UPDATE interviews SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...cols.map((c) => body[c]), nowIso(), iv.id]);
  }
  return ok(res, get('SELECT * FROM interviews WHERE id = ?', [iv.id]));
});

export { router as hrRouter };
