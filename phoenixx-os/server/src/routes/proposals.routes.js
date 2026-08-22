import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, todayIso, addDays, token, parseJson } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, paginate, pageMeta } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { allocateNumber } from '../services/numbering.js';
import { renderProposalPdf } from '../services/pdf.js';
import { notifyMany } from '../services/notifications.js';
import { emitWebhook } from '../services/webhooks.js';
import { upsertDeadline, resolveDeadline } from '../services/deadlines.js';
import { scoreClient } from '../services/scoring.js';
import { config } from '../config.js';

const router = Router();

const itemSchema = z.object({
  description: z.string().min(1).max(240),
  detail: z.string().optional().nullable(),
  qty: z.number().min(0).optional(),
  unit: z.string().optional(),
  rate_minor: z.number().int().min(0),
});

const proposalSchema = z.object({
  client_id: z.string(),
  title: z.string().min(2).max(200),
  service_line_id: z.string().optional().nullable(),
  template_id: z.string().optional().nullable(),
  currency: z.string().optional(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
  terms: z.string().optional().nullable(),
  items: z.array(itemSchema).optional(),
  discount_minor: z.number().int().min(0).optional(),
  tax_rate: z.number().min(0).max(50).optional(),
  valid_until: z.string().optional().nullable(),
  owner_id: z.string().optional().nullable(),
});

const SELECT = `
  SELECT p.*, c.name AS client_name, u.name AS owner_name, sl.name AS service_line_name
    FROM proposals p
    JOIN clients c ON c.id = p.client_id
    LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN service_lines sl ON sl.id = p.service_line_id`;

function recalc(tenantId, proposalId) {
  const items = all('SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY sort', [proposalId]);
  const p = get('SELECT * FROM proposals WHERE id = ? AND tenant_id = ?', [proposalId, tenantId]);
  const subtotal = items.reduce((a, i) => a + i.amount_minor, 0);
  const taxable = Math.max(0, subtotal - (p.discount_minor || 0));
  const tax = Math.round((taxable * (p.tax_rate || 0)) / 100);

  run(
    'UPDATE proposals SET subtotal_minor = ?, tax_minor = ?, total_minor = ?, updated_at = ? WHERE id = ?',
    [subtotal, tax, taxable + tax, nowIso(), proposalId],
  );
  return get('SELECT * FROM proposals WHERE id = ?', [proposalId]);
}

const hydrate = (p) => (p ? { ...p, sections: parseJson(p.sections, []) } : p);

// -------------------------------------------------------------------- list
router.get('/', requires('proposals', 'view'), (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['p.tenant_id = ?', 'p.deleted_at IS NULL'];
  const params = [req.auth.tenantId];

  if (req.query.status) { const s = String(req.query.status).split(','); filters.push(`p.status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (req.query.client_id) { filters.push('p.client_id = ?'); params.push(req.query.client_id); }
  if (req.query.owner_id) { filters.push('p.owner_id = ?'); params.push(req.query.owner_id); }
  if (req.query.search) { filters.push('(p.title LIKE ? OR p.number LIKE ? OR c.name LIKE ?)'); const t = `%${req.query.search}%`; params.push(t, t, t); }

  const where = filters.join(' AND ');
  const total = Number(get(`SELECT COUNT(*) AS n FROM proposals p JOIN clients c ON c.id = p.client_id WHERE ${where}`, params)?.n || 0);
  const rows = all(`${SELECT} WHERE ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

  return ok(res, rows.map(hydrate), {
    ...pageMeta(page, limit, total),
    summary: get(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN p.status = 'draft' THEN 1 END) AS draft,
              COUNT(CASE WHEN p.status IN ('sent','viewed') THEN 1 END) AS pending,
              COUNT(CASE WHEN p.status = 'accepted' THEN 1 END) AS accepted,
              COALESCE(SUM(CASE WHEN p.status = 'accepted' THEN p.total_minor ELSE 0 END),0) AS accepted_value_minor,
              COALESCE(SUM(CASE WHEN p.status IN ('sent','viewed') THEN p.total_minor ELSE 0 END),0) AS pending_value_minor
         FROM proposals p JOIN clients c ON c.id = p.client_id WHERE ${where}`,
      params,
    ),
  });
});

router.get('/templates', requires('proposals', 'view'), (req, res) => ok(res, all(
  `SELECT pt.*, sl.name AS service_line_name FROM proposal_templates pt
     LEFT JOIN service_lines sl ON sl.id = pt.service_line_id
    WHERE pt.tenant_id = ? AND pt.deleted_at IS NULL AND pt.active = 1 ORDER BY pt.name`,
  [req.auth.tenantId],
).map((t) => ({
  ...t,
  sections: parseJson(t.sections, []),
  default_items: parseJson(t.default_items, []),
}))));

router.get('/:id', requires('proposals', 'view'), (req, res) => {
  const p = get(`${SELECT} WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!p) throw notFound('Proposal');

  return ok(res, {
    ...hydrate(p),
    items: all('SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY sort', [p.id]),
    share_url: p.share_token ? `${config.webBaseUrl}/p/${p.share_token}` : null,
  });
});

// ------------------------------------------------------------------ create
/** E5 - auto-populates from the CRM record and the service-line template. */
router.post('/', requires('proposals', 'create'), (req, res) => {
  const body = validate(proposalSchema, req.body);
  const { tenantId, userId } = req.auth;

  const tenant = get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  const client = get('SELECT * FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [body.client_id, tenantId]);
  if (!client) throw notFound('Client');

  const template = body.template_id
    ? get('SELECT * FROM proposal_templates WHERE id = ? AND tenant_id = ?', [body.template_id, tenantId])
    : null;

  const sections = body.sections
    || (template ? parseJson(template.sections, []) : [])
    || [];
  const items = body.items
    || (template ? parseJson(template.default_items, []) : [])
    || [];
  const terms = body.terms ?? template?.terms ?? null;

  const id = uuid();
  const ts = nowIso();

  tx(() => {
    const { number } = allocateNumber({ tenantId, docType: 'proposal', tenant });
    run(
      `INSERT INTO proposals (id, tenant_id, client_id, number, title, service_line_id, template_id,
         owner_id, status, currency, sections, terms, discount_minor, tax_rate, valid_until,
         share_token, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'draft', ?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, client.id, number, body.title, body.service_line_id ?? template?.service_line_id ?? null,
        body.template_id ?? null, body.owner_id || client.owner_id || userId,
        body.currency || client.currency || 'INR', JSON.stringify(sections), terms,
        body.discount_minor || 0, body.tax_rate ?? 18,
        body.valid_until || addDays(new Date(), 30).toISOString().slice(0, 10),
        token(18), ts, ts],
    );
    items.forEach((it, i) => {
      const qty = Number(it.qty ?? 1);
      run(
        `INSERT INTO proposal_items (id, tenant_id, proposal_id, description, detail, qty, unit,
           rate_minor, amount_minor, sort) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), tenantId, id, it.description, it.detail ?? null, qty, it.unit || 'nos',
          it.rate_minor, Math.round(qty * it.rate_minor), i],
      );
    });
  });

  recalc(tenantId, id);
  audit(req, { entity: 'proposal', entityId: id, action: 'create', after: { title: body.title, client: client.name } });
  return created(res, hydrate(get(`${SELECT} WHERE p.id = ?`, [id])));
});

// ------------------------------------------------------------------ update
router.patch('/:id', requires('proposals', 'edit'), (req, res) => {
  const { tenantId } = req.auth;
  const r = repo('proposals', tenantId);
  const before = r.findById(req.params.id);
  if (!before) throw notFound('Proposal');
  if (['accepted', 'rejected'].includes(before.status)) {
    throw badRequest(`A ${before.status} proposal cannot be edited`);
  }

  const body = validate(proposalSchema.partial().omit({ client_id: true }), req.body);
  const patch = { ...body, updated_at: nowIso() };
  delete patch.items;
  if (body.sections) patch.sections = JSON.stringify(body.sections);

  tx(() => {
    r.update(req.params.id, patch);
    if (body.items) {
      run('DELETE FROM proposal_items WHERE proposal_id = ?', [req.params.id]);
      body.items.forEach((it, i) => {
        const qty = Number(it.qty ?? 1);
        run(
          `INSERT INTO proposal_items (id, tenant_id, proposal_id, description, detail, qty, unit,
             rate_minor, amount_minor, sort) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [uuid(), tenantId, req.params.id, it.description, it.detail ?? null, qty, it.unit || 'nos',
            it.rate_minor, Math.round(qty * it.rate_minor), i],
        );
      });
    }
  });

  const after = recalc(tenantId, req.params.id);
  audit(req, { entity: 'proposal', entityId: after.id, action: 'update', before, after });
  return ok(res, hydrate(get(`${SELECT} WHERE p.id = ?`, [after.id])));
});

router.delete('/:id', requires('proposals', 'delete'), (req, res) => {
  const r = repo('proposals', req.auth.tenantId);
  if (!r.findById(req.params.id)) throw notFound('Proposal');
  r.softDelete(req.params.id, nowIso());
  resolveDeadline(req.auth.tenantId, 'proposal', req.params.id, 'cancelled');
  audit(req, { entity: 'proposal', entityId: req.params.id, action: 'delete' });
  return ok(res, { ok: true });
});

// -------------------------------------------------------------------- PDF
router.post('/:id/pdf', requires('proposals', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const p = get('SELECT * FROM proposals WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!p) throw notFound('Proposal');

  const tenant = get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  const client = get('SELECT * FROM clients WHERE id = ?', [p.client_id]);
  const items = all('SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY sort', [p.id]);

  const pdfPath = await renderProposalPdf({
    tenant, proposal: p, items, client, sections: parseJson(p.sections, []),
  });
  run('UPDATE proposals SET pdf_path = ?, updated_at = ? WHERE id = ?', [pdfPath, nowIso(), p.id]);

  return ok(res, { pdf_path: pdfPath, download_url: `/api/v1/files/${pdfPath}` });
});

// ------------------------------------------------------------------- send
router.post('/:id/send', requires('proposals', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const p = get('SELECT * FROM proposals WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!p) throw notFound('Proposal');
  if (!all('SELECT id FROM proposal_items WHERE proposal_id = ?', [p.id]).length) {
    throw badRequest('Add at least one line item before sending');
  }

  const tenant = get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  const client = get('SELECT * FROM clients WHERE id = ?', [p.client_id]);
  const items = all('SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY sort', [p.id]);

  let pdfPath = p.pdf_path;
  try {
    pdfPath = await renderProposalPdf({ tenant, proposal: p, items, client, sections: parseJson(p.sections, []) });
  } catch (err) {
    console.error('[proposal] pdf failed', err.message);
  }

  const shareToken = p.share_token || token(18);
  run(
    `UPDATE proposals SET status = 'sent', sent_at = ?, share_token = ?, pdf_path = ?, updated_at = ? WHERE id = ?`,
    [nowIso(), shareToken, pdfPath, nowIso(), p.id],
  );

  run(
    `INSERT INTO activities (id, tenant_id, client_id, type, subject, body, occurred_at, user_id, meta, created_at)
     VALUES (?,?,?, 'proposal', ?, ?, ?, ?, ?, ?)`,
    [uuid(), tenantId, p.client_id, `Proposal ${p.number} sent`, p.title, nowIso(), req.auth.userId,
      JSON.stringify({ proposal_id: p.id, total_minor: p.total_minor }), nowIso()],
  );

  // The validity date becomes a tracked deadline (B1).
  if (p.valid_until) {
    upsertDeadline({
      tenantId, sourceType: 'proposal', sourceId: p.id,
      title: `Proposal ${p.number} expires - ${client.name}`,
      dueAt: p.valid_until, ownerId: p.owner_id, escalationDays: 2,
      meta: { number: p.number, client: client.name, amount_minor: p.total_minor },
    });
  }

  audit(req, { entity: 'proposal', entityId: p.id, action: 'update', after: { status: 'sent' } });
  return ok(res, {
    ...hydrate(get(`${SELECT} WHERE p.id = ?`, [p.id])),
    share_url: `${config.webBaseUrl}/p/${shareToken}`,
    pdf_path: pdfPath,
  });
});

router.post('/:id/mark', requires('proposals', 'edit'), (req, res) => {
  const { status, reason } = validate(
    z.object({ status: z.enum(['accepted', 'rejected', 'expired']), reason: z.string().optional() }), req.body,
  );
  const { tenantId } = req.auth;
  const p = get('SELECT * FROM proposals WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!p) throw notFound('Proposal');

  acceptOrReject(tenantId, p, status, { by: req.auth.name, reason });
  audit(req, { entity: 'proposal', entityId: p.id, action: 'update', after: { status } });
  return ok(res, hydrate(get(`${SELECT} WHERE p.id = ?`, [p.id])));
});

function acceptOrReject(tenantId, proposal, status, { by, reason, ip } = {}) {
  const ts = nowIso();
  if (status === 'accepted') {
    run(
      `UPDATE proposals SET status = 'accepted', accepted_at = ?, accepted_by_name = ?, accepted_ip = ?, updated_at = ? WHERE id = ?`,
      [ts, by ?? null, ip ?? null, ts, proposal.id],
    );
    // Accepting a proposal advances the client to the onboarding stage.
    const onboarding = get(
      "SELECT * FROM pipeline_stages WHERE tenant_id = ? AND code = 'onboarding' AND deleted_at IS NULL",
      [tenantId],
    );
    if (onboarding) {
      run('UPDATE clients SET stage_id = ?, stage_entered_at = ?, updated_at = ? WHERE id = ?',
        [onboarding.id, ts, ts, proposal.client_id]);
    }
    emitWebhook(tenantId, 'proposal.accepted', {
      proposal_id: proposal.id, number: proposal.number,
      client_id: proposal.client_id, total_minor: proposal.total_minor,
    });
  } else {
    run(
      `UPDATE proposals SET status = ?, rejected_at = ?, rejected_reason = ?, updated_at = ? WHERE id = ?`,
      [status, ts, reason ?? null, ts, proposal.id],
    );
  }

  resolveDeadline(tenantId, 'proposal', proposal.id, status === 'accepted' ? 'met' : 'cancelled');
  run(
    `INSERT INTO activities (id, tenant_id, client_id, type, subject, body, outcome, occurred_at, meta, created_at)
     VALUES (?,?,?, 'proposal', ?, ?, ?, ?, ?, ?)`,
    [uuid(), tenantId, proposal.client_id, `Proposal ${proposal.number} ${status}`,
      reason || proposal.title, status === 'accepted' ? 'positive' : 'negative', ts,
      JSON.stringify({ proposal_id: proposal.id }), ts],
  );
  scoreClient(tenantId, proposal.client_id);
}

// ================================================ PUBLIC SHARE LINK (no auth)
// E5 - share link with view tracking and e-acceptance. Mounted before the
// authenticate middleware in routes/index.js.
const publicRouter = Router();

publicRouter.get('/:token', async (req, res) => {
  const p = get('SELECT * FROM proposals WHERE share_token = ? AND deleted_at IS NULL', [req.params.token]);
  if (!p) throw notFound('Proposal');
  if (p.status === 'draft') throw notFound('Proposal');

  const ts = nowIso();
  const expired = p.valid_until && p.valid_until < todayIso();

  run(
    `UPDATE proposals SET view_count = view_count + 1, last_viewed_at = ?,
       first_viewed_at = COALESCE(first_viewed_at, ?),
       status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = ?`,
    [ts, ts, p.id],
  );

  // Notify the owner the first time it is opened.
  if (!p.first_viewed_at && p.owner_id) {
    const client = get('SELECT name FROM clients WHERE id = ?', [p.client_id]);
    notifyMany({
      tenantId: p.tenant_id,
      userIds: [p.owner_id],
      eventKey: 'proposal.viewed',
      vars: { number: p.number, client: client?.name, title: p.title, view_count: p.view_count + 1 },
      link: `/proposals/${p.id}`,
    }).catch(() => {});
  }

  const tenant = get('SELECT name, logo_url, brand_primary, brand_accent, city, phone, email, website, currency, number_format FROM tenants WHERE id = ?', [p.tenant_id]);
  const client = get('SELECT name, city FROM clients WHERE id = ?', [p.client_id]);
  const fresh = get('SELECT * FROM proposals WHERE id = ?', [p.id]);

  return ok(res, {
    proposal: {
      number: fresh.number, title: fresh.title, status: fresh.status, currency: fresh.currency,
      sections: parseJson(fresh.sections, []), terms: fresh.terms,
      subtotal_minor: fresh.subtotal_minor, discount_minor: fresh.discount_minor,
      tax_rate: fresh.tax_rate, tax_minor: fresh.tax_minor, total_minor: fresh.total_minor,
      valid_until: fresh.valid_until, accepted_at: fresh.accepted_at,
      accepted_by_name: fresh.accepted_by_name, expired: !!expired,
    },
    items: all('SELECT description, detail, qty, unit, rate_minor, amount_minor FROM proposal_items WHERE proposal_id = ? ORDER BY sort', [p.id]),
    tenant,
    client,
  });
});

publicRouter.post('/:token/accept', (req, res) => {
  const p = get('SELECT * FROM proposals WHERE share_token = ? AND deleted_at IS NULL', [req.params.token]);
  if (!p) throw notFound('Proposal');
  if (p.status === 'accepted') throw badRequest('This proposal has already been accepted');
  if (!['sent', 'viewed'].includes(p.status)) throw badRequest('This proposal is not open for acceptance');
  if (p.valid_until && p.valid_until < todayIso()) throw badRequest('This proposal has expired. Please ask for a fresh one.');

  const { name, note } = validate(
    z.object({ name: z.string().min(2).max(120), note: z.string().max(1000).optional() }), req.body,
  );

  acceptOrReject(p.tenant_id, p, 'accepted', { by: name, reason: note, ip: req.ip });

  if (p.owner_id) {
    const client = get('SELECT name FROM clients WHERE id = ?', [p.client_id]);
    const tenant = get('SELECT currency, number_format FROM tenants WHERE id = ?', [p.tenant_id]);
    notifyMany({
      tenantId: p.tenant_id,
      userIds: [p.owner_id],
      eventKey: 'proposal.accepted',
      vars: {
        number: p.number,
        client: client?.name,
        accepted_by: name,
        amount: new Intl.NumberFormat(tenant.number_format === 'indian' ? 'en-IN' : 'en-US',
          { style: 'currency', currency: tenant.currency }).format(p.total_minor / 100),
      },
      link: `/proposals/${p.id}`,
    }).catch(() => {});
  }

  return ok(res, { accepted: true, accepted_by: name, accepted_at: nowIso() });
});

publicRouter.post('/:token/reject', (req, res) => {
  const p = get('SELECT * FROM proposals WHERE share_token = ? AND deleted_at IS NULL', [req.params.token]);
  if (!p) throw notFound('Proposal');
  if (!['sent', 'viewed'].includes(p.status)) throw badRequest('This proposal is not open for a decision');

  const { name, reason } = validate(
    z.object({ name: z.string().min(2).max(120), reason: z.string().max(1000).optional() }), req.body,
  );
  acceptOrReject(p.tenant_id, p, 'rejected', { by: name, reason, ip: req.ip });
  return ok(res, { rejected: true });
});

publicRouter.get('/:token/pdf', async (req, res, next) => {
  try {
    const p = get('SELECT * FROM proposals WHERE share_token = ? AND deleted_at IS NULL', [req.params.token]);
    if (!p || p.status === 'draft') throw notFound('Proposal');

    const tenant = get('SELECT * FROM tenants WHERE id = ?', [p.tenant_id]);
    const client = get('SELECT * FROM clients WHERE id = ?', [p.client_id]);
    const items = all('SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY sort', [p.id]);
    const rel = await renderProposalPdf({ tenant, proposal: p, items, client, sections: parseJson(p.sections, []) });

    const abs = path.join(config.storageDir, rel);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${p.number.replace(/[^\w-]/g, '_')}.pdf"`);
    fs.createReadStream(abs).pipe(res);
  } catch (err) { next(err); }
});

export { router as proposalsRouter, publicRouter as publicProposalRouter };
