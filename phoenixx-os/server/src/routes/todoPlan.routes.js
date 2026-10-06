import { Router } from 'express';
import { get } from '../db/index.js';
import { ok, audit } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import * as P from '../services/todoPlan.js';

const router = Router();

/**
 * Where today's To-Do window stands and the caller's own plan for it. Every
 * signed-in person reads this (it drives their "Tomorrow's To-Do" card); only
 * someone who can edit workspace settings sees the edit controls.
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

export { router as todoPlanRouter };
