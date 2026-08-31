import { Router } from 'express';
import { get, all } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { ok } from '../lib/http.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { rateLimit } from '../middleware/common.js';

import { authRouter } from './auth.routes.js';
import { actionItemsRouter } from './actionItems.routes.js';
import { meetingsRouter } from './meetings.routes.js';
import { notificationsRouter } from './notifications.routes.js';
import { chatRouter } from './chat.routes.js';
import { hrRouter } from './hr.routes.js';
import { sopRouter, kpiRouter } from './sop.routes.js';
import { crmRouter } from './crm.routes.js';
import { clientsRouter } from './clients.routes.js';
import { proposalsRouter, publicProposalRouter } from './proposals.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { financeRouter } from './finance.routes.js';
import { projectsRouter } from './projects.routes.js';
import { reportsRouter } from './reports.routes.js';
import { dashboardRouter } from './dashboard.routes.js';
import { settingsRouter } from './settings.routes.js';
import { usersRouter } from './users.routes.js';
import { billingRouter } from './billing.routes.js';
import { adminRouter } from './admin.routes.js';
import { syncRouter, fileRouter } from './sync.routes.js';
import { openapi } from '../openapi.js';

const api = Router();

// ------------------------------------------------------------------- public
api.get('/health', (req, res) => res.json({
  status: 'ok',
  time: nowIso(),
  version: '1.0.0',
  service: 'phoenixx-os-api',
}));

api.get('/openapi.json', (req, res) => res.json(openapi));

api.get('/announcements', (req, res) => ok(res, all(
  `SELECT id, title, body, level FROM announcements
    WHERE (active_from IS NULL OR active_from <= ?) AND (active_to IS NULL OR active_to >= ?)
    ORDER BY created_at DESC`,
  [nowIso(), nowIso()],
)));

api.get('/plans', (req, res) => ok(res, all('SELECT * FROM plans WHERE active = 1 ORDER BY sort')
  .map((p) => ({ ...p, features: JSON.parse(p.features || '{}'), limits: JSON.parse(p.limits || '{}') }))));

api.use('/auth', authRouter);

// E5 - proposal share links are deliberately unauthenticated.
api.use('/public/proposals', rateLimit({ max: 120 }), publicProposalRouter);

// ---------------------------------------------------------------- protected
api.use(authenticate);
api.use(rateLimit());

api.use('/action-items', actionItemsRouter);
api.use('/meetings', meetingsRouter);
api.use('/notifications', notificationsRouter);
api.use('/chat', chatRouter);
api.use('/hr', hrRouter);
api.use('/sop', sopRouter);
api.use('/kpis', kpiRouter);
api.use('/crm', crmRouter);
// The client master. /crm stays the pipeline; this is the register behind it.
api.use('/clients', clientsRouter);
api.use('/proposals', proposalsRouter);
api.use('/invoices', invoicesRouter);
api.use('/finance', financeRouter);
api.use('/projects', projectsRouter);
api.use('/reports', reportsRouter);
api.use('/dashboard', dashboardRouter);
api.use('/settings', settingsRouter);
api.use('/users', usersRouter);
api.use('/billing', billingRouter);
api.use('/sync', syncRouter);
api.use('/files', fileRouter);

// S9 - platform console
api.use('/admin', requireSuperAdmin, adminRouter);

export { api };
