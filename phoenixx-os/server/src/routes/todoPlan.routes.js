import { Router } from 'express';
import { get } from '../db/index.js';
import { ok, audit, badRequest } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import * as P from '../services/todoPlan.js';

const router = Router();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where today's To-Do window stands and the caller's own plan for it. Every
 * signed-in person reads this; only someone who can edit workspace settings
 * sees the edit controls.
 */
router.get('/schedule', (req, res) => {
  const { settings, ...win } = P.windowFor(req.auth.tenantId);
  const mine = win.todo_date
    ? get('SELECT id, status, submitted_at, minutes_late FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
      [req.auth.tenantId, req.auth.userId, win.todo_date])
    : null;
  return ok(res, {
    window: win,
    settings,
    defaults: P.DEFAULT_SETTINGS,
    channel_options: P.CHANNEL_OPTIONS,
    mine: mine || null,
    can_edit_settings: can(req.auth, 'settings', 'edit'),
    // For the owner's access settings: who can be given a view of everyone.
    people: can(req.auth, 'settings', 'edit') ? P.reportingCandidates(req.auth.tenantId) : [],
  });
});

router.put('/settings', requires('settings', 'edit'), (req, res) => {
  const before = P.settingsFor(req.auth.tenantId);
  const after = P.saveSettings(req.auth.tenantId, req.body || {});
  audit(req, { entity: 'todo_settings', entityId: req.auth.tenantId, action: 'update', before, after });
  return ok(res, after);
});

/** Runs this workspace's clock now - the same pass the minute job makes. Safe to repeat. */
router.post('/run', requires('settings', 'edit'), async (req, res) => {
  const sent = await P.todoTick([req.auth.tenantId]);
  return ok(res, { sent, window: (({ settings, ...w }) => w)(P.windowFor(req.auth.tenantId)) });
});

// ------------------------------------------------------------- employee
/** The caller's current plan, their history, and what they can pick from. */
router.get('/mine', (req, res) => ok(res, P.mine(req.auth)));

/** Save a draft, or submit with `submit: true`. Only ever the caller's own plan. */
router.put('/mine/:todoDate', async (req, res) => {
  if (!DAY.test(req.params.todoDate)) throw badRequest('Date must be YYYY-MM-DD');
  const { tasks, submit } = req.body || {};
  return ok(res, await P.savePlan(req.auth, req.params.todoDate, { tasks, submit: submit === true }));
});

// ------------------------------------------------------------- reviewer
/** One planned day for the caller's people (everyone, for an owner) plus the review queue. */
router.get('/team', (req, res) => {
  const day = req.query.date ? String(req.query.date) : null;
  if (day && !DAY.test(day)) throw badRequest('date must be YYYY-MM-DD');
  return ok(res, P.team(req.auth, day));
});

/** Change who someone reports to. The rules (owner, or a manager the owner allows) live in the service. */
router.put('/reporting/:userId', (req, res) => ok(res, P.setReporting(req.auth, req.params.userId, req.body?.manager_id ?? null)));

router.get('/submissions/:id', (req, res) => ok(res, P.getPlan(req.auth, req.params.id)));

router.post('/submissions/:id/open', (req, res) => ok(res, P.startReview(req.auth, req.params.id)));

router.post('/submissions/:id/approve', async (req, res) =>
  ok(res, await P.decide(req.auth, req.params.id, { approve: true, note: req.body?.note })));

router.post('/submissions/:id/request-changes', async (req, res) =>
  ok(res, await P.decide(req.auth, req.params.id, { approve: false, note: req.body?.note })));

/** Add a task to a plan being worked - no re-approval. */
router.post('/submissions/:id/tasks', async (req, res) => ok(res, await P.addTask(req.auth, req.params.id, req.body)));

router.post('/submissions/:id/tasks/:taskId', (req, res) =>
  ok(res, P.setTaskDone(req.auth, req.params.id, req.params.taskId, req.body?.done === true)));

router.post('/submissions/:id/tasks/:taskId/checklist/:index', (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) throw badRequest('index must be a whole number');
  return ok(res, P.setChecklistItem(req.auth, req.params.id, req.params.taskId, index, req.body?.done === true));
});

router.post('/submissions/:id/comments', async (req, res) =>
  ok(res, await P.addComment(req.auth, req.params.id, req.body?.body)));

export { router as todoPlanRouter };
