import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, toCsv } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, conflict, audit } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { syncProjectChannel } from '../services/chat.js';

const router = Router();

/**
 * Module F - projects and the delivery team behind each one.
 *
 * A project's team is a list of `project_members` rows, each holding a seat:
 * one manager (accountable for the engagement), one lead (runs the day-to-day),
 * then seniors and everyone else. Seats are ranked so every view - list, drawer,
 * workload - orders people the same way without each caller inventing an order.
 *
 * Mounted twice: at `/projects` (canonical) and at `/finance/projects` so the
 * older path used by the cost & profit screens keeps working.
 *
 * Permissions come from the `projects` module rather than `crm`, because who
 * may run a project is a different question from who may work a deal. An
 * employee holds `view` only: they can see every project and its team but
 * cannot create, edit, restaff or delete one. Managers, finance-side admins
 * and owners hold the write actions. Both mounts carry these guards, and every
 * write path below is guarded server-side - hiding the buttons is presentation,
 * not enforcement.
 */

// ------------------------------------------------------------------- seats
export const SEATS = [
  { id: 'manager', label: 'Project manager', rank: 1, single: true, blurb: 'Accountable for scope, budget and the client relationship' },
  { id: 'lead', label: 'Team lead', rank: 2, single: true, blurb: 'Runs delivery day to day and unblocks the team' },
  { id: 'senior', label: 'Senior', rank: 3, single: false, blurb: 'Owns a workstream and reviews juniors' },
  { id: 'member', label: 'Team member', rank: 4, single: false, blurb: 'Executes assigned work' },
  { id: 'junior', label: 'Junior / trainee', rank: 5, single: false, blurb: 'Works under supervision' },
  { id: 'reviewer', label: 'Reviewer / QA', rank: 6, single: false, blurb: 'Signs off quality before it reaches the client' },
  { id: 'observer', label: 'Observer', rank: 7, single: false, blurb: 'Read-only visibility, no delivery load' },
];
const SEAT_IDS = SEATS.map((s) => s.id);
const SEAT_RANK = Object.fromEntries(SEATS.map((s) => [s.id, s.rank]));
/** Seats that may only be held by one person - assigning replaces the incumbent. */
const SINGLE_SEATS = SEATS.filter((s) => s.single).map((s) => s.id);
/** The project column each single seat mirrors into, for cheap list queries. */
const SEAT_COLUMN = { manager: 'manager_id', lead: 'lead_id' };

const seatSql = `CASE pm.seat ${SEATS.map((s) => `WHEN '${s.id}' THEN ${s.rank}`).join(' ')} ELSE 99 END`;

// ---------------------------------------------------------------- projects
const projectSchema = z.object({
  client_id: z.string(),
  name: z.string().min(2).max(160),
  code: z.string().optional().nullable(),
  service_line_id: z.string().optional().nullable(),
  model: z.enum(['retainer', 'project', 'hybrid']).optional(),
  status: z.enum(['planned', 'active', 'on_hold', 'completed', 'cancelled']).optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  budget_minor: z.number().int().min(0).optional(),
  manager_id: z.string().optional().nullable(),
  lead_id: z.string().optional().nullable(),
  scope_total: z.number().int().min(0).optional(),
  scope_delivered: z.number().int().min(0).optional(),
});

const PROJECT_SELECT = `
  SELECT p.*, c.name AS client_name, sl.name AS service_line_name,
         u.name AS manager_name, u.avatar_url AS manager_avatar, u.designation AS manager_designation,
         l.name AS lead_name, l.avatar_url AS lead_avatar, l.designation AS lead_designation,
         (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id AND pm.deleted_at IS NULL) AS team_size,
         (SELECT COALESCE(SUM(pm.allocation_pct),0) FROM project_members pm
            WHERE pm.project_id = p.id AND pm.deleted_at IS NULL) AS allocation_total,
         (SELECT COALESCE(SUM(i.taxable_minor),0) FROM invoices i WHERE i.project_id = p.id
            AND i.deleted_at IS NULL AND i.status NOT IN ('draft','written_off')) AS invoiced_minor,
         (SELECT COALESCE(SUM(co.amount_minor),0) FROM costs co WHERE co.project_id = p.id
            AND co.deleted_at IS NULL) AS cost_minor
    FROM projects p
    JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_lines sl ON sl.id = p.service_line_id
    LEFT JOIN users u ON u.id = p.manager_id
    LEFT JOIN users l ON l.id = p.lead_id`;

const MEMBER_SELECT = `
  SELECT pm.*, u.name, u.email, u.avatar_url, u.designation, u.role AS org_role,
         u.phone, u.service_line_id, sl.name AS service_line_name,
         mgr.name AS reports_to_name, ${seatSql} AS seat_rank
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    LEFT JOIN service_lines sl ON sl.id = u.service_line_id
    LEFT JOIN users mgr ON mgr.id = u.manager_id`;

const membersOf = (tenantId, projectId) => all(
  `${MEMBER_SELECT} WHERE pm.tenant_id = ? AND pm.project_id = ? AND pm.deleted_at IS NULL
    ORDER BY seat_rank, u.name`,
  [tenantId, projectId],
);

/** A compact roster (a few people per project) so the list view can show faces. */
function rosterFor(tenantId, projectIds) {
  if (!projectIds.length) return {};
  const rows = all(
    `SELECT pm.project_id, pm.user_id, pm.seat, pm.allocation_pct, pm.responsibility,
            u.name, u.avatar_url, u.designation,
            ${seatSql} AS seat_rank
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL
        AND pm.project_id IN (${projectIds.map(() => '?').join(',')})
      ORDER BY seat_rank, u.name`,
    [tenantId, ...projectIds],
  );
  const byProject = {};
  for (const r of rows) (byProject[r.project_id] ||= []).push(r);
  return byProject;
}

router.get('/', requires('projects', 'view'), (req, res) => {
  const filters = ['p.tenant_id = ?', 'p.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (req.query.client_id) { filters.push('p.client_id = ?'); params.push(req.query.client_id); }
  if (req.query.status) { filters.push('p.status = ?'); params.push(req.query.status); }
  if (req.query.manager_id) { filters.push('p.manager_id = ?'); params.push(req.query.manager_id); }
  if (req.query.service_line_id) { filters.push('p.service_line_id = ?'); params.push(req.query.service_line_id); }
  if (req.query.member_id) {
    filters.push(`EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id
                            AND pm.user_id = ? AND pm.deleted_at IS NULL)`);
    params.push(req.query.member_id);
  }
  if (req.query.search) {
    filters.push('(p.name LIKE ? OR p.code LIKE ? OR c.name LIKE ?)');
    const q = `%${req.query.search}%`;
    params.push(q, q, q);
  }

  const projects = all(`${PROJECT_SELECT} WHERE ${filters.join(' AND ')} ORDER BY p.created_at DESC`, params);
  const roster = rosterFor(req.auth.tenantId, projects.map((p) => p.id));
  return ok(res, projects.map((p) => ({ ...p, team: roster[p.id] || [] })));
});

router.get('/seats', (req, res) => ok(res, SEATS));

/** Who is on what, across every project - the staffing view. */
router.get('/workload', requires('projects', 'view'), (req, res) => {
  const people = all(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.designation, u.role, sl.name AS service_line_name
       FROM users u
       LEFT JOIN service_lines sl ON sl.id = u.service_line_id
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status != 'disabled' AND u.role != 'client'
      ORDER BY u.name`,
    [req.auth.tenantId],
  );
  const rows = all(
    `SELECT pm.user_id, pm.seat, pm.allocation_pct, pm.responsibility,
            p.id AS project_id, p.name AS project_name, p.status AS project_status,
            c.name AS client_name, ${seatSql} AS seat_rank
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
       JOIN clients c ON c.id = p.client_id
      WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL
      ORDER BY seat_rank, p.name`,
    [req.auth.tenantId],
  );
  const byUser = {};
  for (const r of rows) (byUser[r.user_id] ||= []).push(r);

  return ok(res, people.map((u) => {
    const projects = byUser[u.id] || [];
    return {
      ...u,
      projects,
      project_count: projects.length,
      allocation_pct: projects.reduce((n, p) => n + Number(p.allocation_pct || 0), 0),
      leads: projects.filter((p) => p.seat === 'manager' || p.seat === 'lead').length,
    };
  }));
});

router.get('/:id', requires('projects', 'view'), (req, res) => {
  const project = get(`${PROJECT_SELECT} WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!project) throw notFound('Project');

  const team = membersOf(req.auth.tenantId, project.id);
  return ok(res, {
    ...project,
    team,
    /** Same people, bucketed by seat, so the UI does not have to group them. */
    team_by_seat: SEATS.map((s) => ({ ...s, members: team.filter((m) => m.seat === s.id) }))
      .filter((s) => s.members.length),
    open_items: Number(get(
      `SELECT COUNT(*) AS n FROM action_items
        WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL AND status != 'done'`,
      [req.auth.tenantId, project.id],
    )?.n || 0),
  });
});

router.post('/', requires('projects', 'create'), (req, res) => {
  const body = validate(projectSchema, req.body);
  const id = uuid();
  const at = nowIso();

  tx(() => {
    run(
      `INSERT INTO projects (id, tenant_id, client_id, name, code, service_line_id, model, status,
         start_date, end_date, budget_minor, manager_id, lead_id, scope_total, scope_delivered, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.auth.tenantId, body.client_id, body.name, body.code ?? null, body.service_line_id ?? null,
        body.model || 'project', body.status || 'active', body.start_date ?? null, body.end_date ?? null,
        body.budget_minor || 0, body.manager_id ?? null, body.lead_id ?? null,
        body.scope_total || 0, body.scope_delivered || 0, at, at],
    );
    // Whoever was named at creation joins the team in that seat straight away.
    if (body.manager_id) addMember(req, id, { user_id: body.manager_id, seat: 'manager' });
    if (body.lead_id && body.lead_id !== body.manager_id) addMember(req, id, { user_id: body.lead_id, seat: 'lead' });
  });

  // The team gets a room the moment the project exists (Module B).
  syncProjectChannel(req.auth.tenantId, id, { actorId: req.auth.userId });

  audit(req, { entity: 'project', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, get(`${PROJECT_SELECT} WHERE p.id = ?`, [id]));
});

router.patch('/:id', requires('projects', 'edit'), (req, res) => {
  const r = repo('projects', req.auth.tenantId);
  const before = r.findById(req.params.id);
  if (!before) throw notFound('Project');

  const body = validate(projectSchema.partial().omit({ client_id: true }), req.body);
  const after = tx(() => {
    const row = r.update(req.params.id, { ...body, updated_at: nowIso() });
    // Naming a manager or lead here is the same act as seating them on the team.
    for (const seat of SINGLE_SEATS) {
      const key = SEAT_COLUMN[seat];
      if (body[key] === undefined || body[key] === before[key]) continue;
      if (body[key]) addMember(req, row.id, { user_id: body[key], seat });
      else clearSeat(req.auth.tenantId, row.id, seat);
    }
    return row;
  });

  // E7: project scope rolls up to the client's delivered-vs-committed view.
  const totals = get(
    `SELECT COALESCE(SUM(scope_total),0) AS t, COALESCE(SUM(scope_delivered),0) AS d
       FROM projects WHERE tenant_id = ? AND client_id = ? AND deleted_at IS NULL`,
    [req.auth.tenantId, after.client_id],
  );
  run('UPDATE clients SET scope_total = ?, scope_delivered = ?, updated_at = ? WHERE id = ?',
    [Number(totals.t), Number(totals.d), nowIso(), after.client_id]);

  syncProjectChannel(req.auth.tenantId, after.id, { actorId: req.auth.userId });

  audit(req, { entity: 'project', entityId: after.id, action: 'update', before, after });
  return ok(res, get(`${PROJECT_SELECT} WHERE p.id = ?`, [after.id]));
});

router.delete('/:id', requires('projects', 'delete'), (req, res) => {
  const at = nowIso();
  tx(() => {
    repo('projects', req.auth.tenantId).softDelete(req.params.id, at);
    run('UPDATE project_members SET deleted_at = ? WHERE project_id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [at, req.params.id, req.auth.tenantId]);
  });
  syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  audit(req, { entity: 'project', entityId: req.params.id, action: 'delete' });
  return ok(res, { ok: true });
});

// -------------------------------------------------------------- the team
const memberSchema = z.object({
  user_id: z.string(),
  seat: z.enum(SEAT_IDS).optional(),
  responsibility: z.string().max(240).optional().nullable(),
  allocation_pct: z.number().int().min(0).max(100).optional(),
  billable: z.boolean().optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

function projectOr404(tenantId, id) {
  const p = get('SELECT * FROM projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [id, tenantId]);
  if (!p) throw notFound('Project');
  return p;
}

/** Keep `projects.manager_id` / `lead_id` pointing at whoever holds that seat. */
function syncSeatColumn(tenantId, projectId, seat) {
  const column = SEAT_COLUMN[seat];
  if (!column) return;
  const holder = get(
    'SELECT user_id FROM project_members WHERE project_id = ? AND tenant_id = ? AND seat = ? AND deleted_at IS NULL',
    [projectId, tenantId, seat],
  );
  run(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    [holder?.user_id ?? null, nowIso(), projectId, tenantId]);
}

/** Vacate a single-holder seat: the incumbent stays on the team as a member. */
function clearSeat(tenantId, projectId, seat, exceptUserId) {
  const rows = all(
    'SELECT id, user_id FROM project_members WHERE project_id = ? AND tenant_id = ? AND seat = ? AND deleted_at IS NULL',
    [projectId, tenantId, seat],
  ).filter((r) => r.user_id !== exceptUserId);
  for (const r of rows) {
    run('UPDATE project_members SET seat = ?, updated_at = ? WHERE id = ?', ['member', nowIso(), r.id]);
  }
  syncSeatColumn(tenantId, projectId, seat);
}

/**
 * Seat someone on a project. Idempotent: an existing member is moved into the
 * new seat rather than duplicated, which is what "make Priya the lead" means
 * when Priya is already on the team.
 */
function addMember(req, projectId, body) {
  const { tenantId } = req.auth;
  const seat = body.seat || 'member';
  const at = nowIso();

  const user = get(
    "SELECT id, name, role FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role != 'client'",
    [body.user_id, tenantId],
  );
  if (!user) throw badRequest('That person is not in this workspace');

  if (SINGLE_SEATS.includes(seat)) clearSeat(tenantId, projectId, seat, body.user_id);

  const existing = get(
    'SELECT * FROM project_members WHERE project_id = ? AND user_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [projectId, body.user_id, tenantId],
  );

  let id;
  if (existing) {
    id = existing.id;
    run(
      `UPDATE project_members SET seat = ?, responsibility = ?, allocation_pct = ?, billable = ?,
         start_date = ?, end_date = ?, notes = ?, updated_at = ? WHERE id = ?`,
      [seat,
        body.responsibility ?? existing.responsibility,
        body.allocation_pct ?? existing.allocation_pct,
        body.billable === undefined ? existing.billable : (body.billable ? 1 : 0),
        body.start_date ?? existing.start_date,
        body.end_date ?? existing.end_date,
        body.notes ?? existing.notes,
        at, id],
    );
  } else {
    id = uuid();
    run(
      `INSERT INTO project_members (id, tenant_id, project_id, user_id, seat, responsibility,
         allocation_pct, billable, start_date, end_date, notes, added_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, projectId, body.user_id, seat, body.responsibility ?? null,
        body.allocation_pct ?? 0, body.billable === false ? 0 : 1,
        body.start_date ?? null, body.end_date ?? null, body.notes ?? null,
        req.auth.userId ?? null, at, at],
    );
  }

  syncSeatColumn(tenantId, projectId, seat);
  return { id, user, existed: !!existing };
}

router.get('/:id/members', requires('projects', 'view'), (req, res) => {
  projectOr404(req.auth.tenantId, req.params.id);
  return ok(res, membersOf(req.auth.tenantId, req.params.id));
});

/** Everyone who could still be added - the directory minus the current team. */
router.get('/:id/available', requires('projects', 'view'), (req, res) => {
  projectOr404(req.auth.tenantId, req.params.id);
  return ok(res, all(
    `SELECT u.id, u.name, u.email, u.role, u.designation, u.avatar_url, u.service_line_id,
            sl.name AS service_line_name, mgr.name AS reports_to_name,
            (SELECT COUNT(*) FROM project_members pm2
               JOIN projects p2 ON p2.id = pm2.project_id AND p2.deleted_at IS NULL
              WHERE pm2.user_id = u.id AND pm2.deleted_at IS NULL) AS project_count,
            (SELECT COALESCE(SUM(pm3.allocation_pct),0) FROM project_members pm3
               JOIN projects p3 ON p3.id = pm3.project_id AND p3.deleted_at IS NULL
              WHERE pm3.user_id = u.id AND pm3.deleted_at IS NULL) AS allocation_pct
       FROM users u
       LEFT JOIN service_lines sl ON sl.id = u.service_line_id
       LEFT JOIN users mgr ON mgr.id = u.manager_id
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status != 'disabled' AND u.role != 'client'
        AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ?
                          AND pm.user_id = u.id AND pm.deleted_at IS NULL)
      ORDER BY u.name`,
    [req.auth.tenantId, req.params.id],
  ));
});

router.post('/:id/members', requires('projects', 'edit'), (req, res) => {
  projectOr404(req.auth.tenantId, req.params.id);
  const body = validate(memberSchema, req.body);
  const { id, user, existed } = tx(() => addMember(req, req.params.id, body));

  syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  audit(req, {
    entity: 'project_member',
    entityId: id,
    action: existed ? 'update' : 'create',
    after: { project_id: req.params.id, user: user.name, seat: body.seat || 'member' },
  });
  return created(res, get(`${MEMBER_SELECT} WHERE pm.id = ?`, [id]));
});

/** Bulk add - staffing a new project one seat at a time is tedious. */
router.post('/:id/members/bulk', requires('projects', 'edit'), (req, res) => {
  projectOr404(req.auth.tenantId, req.params.id);
  const body = validate(z.object({ members: z.array(memberSchema).min(1).max(50) }), req.body);
  tx(() => { for (const m of body.members) addMember(req, req.params.id, m); });

  syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  audit(req, { entity: 'project', entityId: req.params.id, action: 'update', after: { added: body.members.length } });
  return created(res, membersOf(req.auth.tenantId, req.params.id));
});

router.patch('/:id/members/:memberId', requires('projects', 'edit'), (req, res) => {
  projectOr404(req.auth.tenantId, req.params.id);
  const before = get(
    'SELECT * FROM project_members WHERE id = ? AND project_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.memberId, req.params.id, req.auth.tenantId],
  );
  if (!before) throw notFound('Team member');

  const body = validate(memberSchema.partial().omit({ user_id: true }), req.body);
  tx(() => {
    if (body.seat && SINGLE_SEATS.includes(body.seat)) clearSeat(req.auth.tenantId, req.params.id, body.seat, before.user_id);
    const patch = { ...body, updated_at: nowIso() };
    if (patch.billable !== undefined) patch.billable = patch.billable ? 1 : 0;
    repo('project_members', req.auth.tenantId).update(before.id, patch);
    // The seat they left, and the seat they moved into, both need re-mirroring.
    for (const seat of new Set([before.seat, body.seat].filter(Boolean))) {
      syncSeatColumn(req.auth.tenantId, req.params.id, seat);
    }
  });

  syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  audit(req, { entity: 'project_member', entityId: before.id, action: 'update', before, after: body });
  return ok(res, get(`${MEMBER_SELECT} WHERE pm.id = ?`, [before.id]));
});

router.delete('/:id/members/:memberId', requires('projects', 'edit'), (req, res) => {
  projectOr404(req.auth.tenantId, req.params.id);
  const before = get(
    'SELECT * FROM project_members WHERE id = ? AND project_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.memberId, req.params.id, req.auth.tenantId],
  );
  if (!before) throw notFound('Team member');

  // Open work would silently lose its owner, so say so instead of guessing.
  const openItems = Number(get(
    `SELECT COUNT(*) AS n FROM action_items WHERE tenant_id = ? AND project_id = ?
       AND owner_id = ? AND deleted_at IS NULL AND status != 'done'`,
    [req.auth.tenantId, req.params.id, before.user_id],
  )?.n || 0);
  if (openItems && req.query.force !== 'true') {
    throw conflict(`They still own ${openItems} open item(s) on this project. Reassign those first, or confirm to remove anyway.`,
      [{ field: 'open_items', message: String(openItems) }]);
  }

  tx(() => {
    repo('project_members', req.auth.tenantId).softDelete(before.id, nowIso());
    syncSeatColumn(req.auth.tenantId, req.params.id, before.seat);
  });

  syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  audit(req, { entity: 'project_member', entityId: before.id, action: 'delete', before });
  return ok(res, { ok: true, open_items: openItems });
});

router.get('/:id/members/export/csv', requires('projects', 'view'), (req, res) => {
  const project = projectOr404(req.auth.tenantId, req.params.id);
  const rows = membersOf(req.auth.tenantId, req.params.id).map((m) => ({
    project: project.name,
    name: m.name,
    email: m.email,
    seat: SEATS.find((s) => s.id === m.seat)?.label || m.seat,
    designation: m.designation || '',
    service_line: m.service_line_name || '',
    reports_to: m.reports_to_name || '',
    responsibility: m.responsibility || '',
    allocation_pct: m.allocation_pct,
    billable: m.billable ? 'yes' : 'no',
    start_date: m.start_date || '',
    end_date: m.end_date || '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="project-team.csv"');
  return res.send(toCsv(rows));
});

export { router as projectsRouter, SEAT_RANK };
