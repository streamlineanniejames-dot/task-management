import { config } from '../config.js';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso, parseJson, renderTemplate } from '../lib/util.js';

/**
 * Module B - multi-channel notifications.
 *
 * AR4: every outbound vendor sits behind this provider interface so WhatsApp
 * vendors (Meta Cloud API / Gupshup / WATI) and mail transports can be swapped
 * without touching call sites. The `log` provider is the default in dev and in
 * tests: it records a delivery row instead of calling out.
 */

export const CHANNELS = ['in_app', 'whatsapp', 'email', 'teams', 'push'];

// ------------------------------------------------------------------ providers
const providers = {
  in_app: {
    id: 'in_app',
    async send() { return { ok: true, ref: null }; }, // the notifications row *is* the delivery
  },

  log: {
    id: 'log',
    async send({ channel, to, subject, body }) {
      console.log(JSON.stringify({ t: nowIso(), notify: channel, to, subject, body: String(body).slice(0, 400) }));
      return { ok: true, ref: `log_${uuid().slice(0, 8)}` };
    },
  },

  // Meta WhatsApp Cloud API. Same shape as Gupshup/WATI adapters would take.
  meta: {
    id: 'meta',
    async send({ to, body }) {
      if (!config.providers.whatsappToken || !config.providers.whatsappPhoneId) {
        return { ok: false, error: 'WhatsApp provider not configured' };
      }
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${config.providers.whatsappPhoneId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.providers.whatsappToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body },
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      return res.ok
        ? { ok: true, ref: json?.messages?.[0]?.id ?? null }
        : { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
    },
  },

  teams: {
    id: 'teams',
    async send({ to, subject, body }) {
      const url = to || config.providers.teamsWebhook;
      if (!url) return { ok: false, error: 'Teams webhook not configured' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: subject, text: body }),
      });
      return res.ok ? { ok: true, ref: null } : { ok: false, error: `HTTP ${res.status}` };
    },
  },

  smtp: {
    id: 'smtp',
    async send({ to, subject, body }) {
      // Intentionally not shipping an SMTP client: wire nodemailer here and the
      // rest of the pipeline (templates, prefs, delivery log) is unchanged.
      console.log(JSON.stringify({ t: nowIso(), notify: 'email(smtp-pending)', to, subject }));
      return { ok: true, ref: null };
    },
  },
};

function providerFor(channel) {
  if (channel === 'in_app') return providers.in_app;
  if (channel === 'whatsapp') return providers[config.providers.whatsapp] || providers.log;
  if (channel === 'email') return providers[config.providers.email === 'smtp' ? 'smtp' : 'log'];
  if (channel === 'teams') return config.providers.teamsWebhook ? providers.teams : providers.log;
  return providers.log;
}

// ------------------------------------------------------------------ templates
/** Built-in copy; tenants may override any of these (B5). */
export const DEFAULT_TEMPLATES = {
  'action_item.assigned': {
    subject: 'New action item: {{title}}',
    body: 'Hi {{user.name}}, you have been assigned "{{title}}" ({{priority}}) due {{due_date}}.',
  },
  'action_item.update_due': {
    subject: 'Daily update pending on {{count}} task(s)',
    body: 'Hi {{user.name}}, you have {{count}} open task(s) with no update logged for today: {{titles}}. Two minutes now saves the standup tomorrow.',
  },
  'action_item.blocked_reported': {
    subject: 'Blocker raised on {{title}}',
    body: '{{person}} reported a blocker on "{{title}}": {{blockers}}',
  },
  'action_item.due_soon': {
    subject: 'Due {{when}}: {{title}}',
    body: 'Reminder - "{{title}}" is due {{when}} ({{due_date}}). Client: {{client}}.',
  },
  'action_item.overdue': {
    subject: 'OVERDUE: {{title}}',
    body: '"{{title}}" was due {{due_date}} and is now {{days_overdue}} day(s) overdue.',
  },
  'chat.broadcast': {
    subject: 'Announcement from {{author}}',
    body: '{{author}} posted to {{channel}}: {{preview}}',
  },
  'chat.mention': {
    subject: '{{author}} mentioned you in {{channel}}',
    body: '{{author}} in {{channel}}: {{preview}}',
  },
  'escalation.raised': {
    subject: 'Escalation L{{level}}: {{title}}',
    body: '{{title}} has been escalated to you by {{from}}. Reason: {{reason}}.',
  },
  'invoice.sent': {
    subject: 'Invoice {{number}} - {{amount}}',
    body: 'Invoice {{number}} for {{amount}} has been sent to {{client}}. Due {{due_date}}.',
  },
  'invoice.due_soon': {
    subject: 'Invoice {{number}} due {{when}}',
    body: 'Invoice {{number}} ({{amount}}) for {{client}} is due {{when}} on {{due_date}}.',
  },
  'invoice.overdue': {
    subject: 'Invoice {{number}} overdue',
    body: 'Invoice {{number}} ({{amount}}) for {{client}} is {{days_overdue}} day(s) overdue. Balance {{balance}}.',
  },
  'invoice.paid': {
    subject: 'Payment received - {{number}}',
    body: 'Payment of {{amount}} recorded against invoice {{number}} ({{client}}).',
  },
  'reimbursement.submitted': {
    subject: 'Reimbursement {{number}} from {{employee}}',
    body: '{{employee}} has claimed {{amount}} for "{{description}}" spent on {{expense_date}}. It is waiting on your approval.',
  },
  'reimbursement.finance_review': {
    subject: 'Reimbursement {{number}} ready for finance review',
    body: '{{number}} ({{employee}}, {{amount}}) was approved by {{decided_by}} and is now in finance review.',
  },
  'reimbursement.decided': {
    subject: 'Reimbursement {{number}} {{status}}',
    body: 'Your claim {{number}} for {{amount}} was {{status}} by {{decided_by}} at {{stage}} review.{{note}}',
  },
  'reimbursement.paid': {
    subject: 'Reimbursement {{number}} paid',
    body: '{{amount}} has been paid to you against {{number}} by {{method}}{{reference}}.',
  },
  'lead.no_next_action': {
    subject: 'Lead without next action: {{client}}',
    body: '{{client}} has no next action set. Every lead must always carry a next action + date.',
  },
  'follow_up.due': {
    subject: 'Follow-up due: {{client}}',
    body: 'Follow-up "{{next_action}}" for {{client}} is due {{due_date}}.',
  },
  'leave.requested': {
    subject: 'Leave request from {{user.name}}',
    body: '{{user.name}} requested {{days}} day(s) {{leave_type}} from {{from_date}} to {{to_date}}. Reason: {{reason}}.',
  },
  'leave.decided': {
    subject: 'Leave {{status}}',
    body: 'Your leave request ({{from_date}} to {{to_date}}) was {{status}}{{note}}.',
  },
  'proposal.viewed': {
    subject: 'Proposal {{number}} viewed',
    body: '{{client}} just opened proposal {{number}} ({{title}}). Views: {{view_count}}.',
  },
  'proposal.accepted': {
    subject: 'Proposal {{number}} ACCEPTED',
    body: '{{client}} accepted proposal {{number}} - {{amount}}. Accepted by {{accepted_by}}.',
  },
  'digest.daily': {
    subject: 'Your day: {{due_today}} due, {{overdue}} overdue',
    body: 'Good morning {{user.name}}. Due today: {{due_today}}. Overdue: {{overdue}}. Follow-ups: {{follow_ups}}. Meetings: {{meetings}}.',
  },
  'digest.weekly_escalation': {
    subject: 'Weekly escalation report',
    body: '{{escalations}} escalation(s), {{overdue}} overdue item(s), SOP adherence {{sop_adherence}}%, follow-up completion {{follow_up_pct}}%.',
  },
  'report.ready': {
    subject: '{{title}} is ready',
    body: '{{title}} for {{period}} has been generated and is awaiting dispatch.',
  },
  'mention.comment': {
    subject: '{{from}} mentioned you',
    body: '{{from}} mentioned you on {{entity}}: "{{excerpt}}"',
  },
  'sop.published': {
    subject: 'SOP updated: {{title}} v{{version}}',
    body: '{{title}} has been published at version {{version}}. Please review and acknowledge.',
  },
};

function templateFor(tenantId, eventKey, channel) {
  const custom = get(
    'SELECT subject, body FROM notification_templates WHERE tenant_id = ? AND event_key = ? AND channel = ? AND active = 1',
    [tenantId, eventKey, channel],
  );
  return custom || DEFAULT_TEMPLATES[eventKey] || { subject: eventKey, body: eventKey };
}

// --------------------------------------------------------------- preferences
const DEFAULT_PREFS = {
  in_app: true,
  email: true,
  whatsapp: true,
  teams: false,
  push: true,
};

/** B2: channel preference per user and per event type. */
export function channelsFor(user, eventKey) {
  const prefs = parseJson(user.notification_prefs, {}) || {};
  const global = { ...DEFAULT_PREFS, ...(prefs.channels || {}) };
  const perEvent = prefs.events?.[eventKey];
  const merged = perEvent ? { ...global, ...perEvent } : global;
  return CHANNELS.filter((c) => merged[c]);
}

// ------------------------------------------------------------------- sending
const addressFor = (user, channel) => {
  if (channel === 'whatsapp') return user.whatsapp || user.phone;
  if (channel === 'email') return user.email;
  if (channel === 'teams') return config.providers.teamsWebhook;
  return user.id;
};

/**
 * Queue + deliver a notification to one user across their preferred channels.
 * Every send is logged with delivery status (B5). `dedupeKey` makes the
 * reminder ladder safely re-runnable.
 */
export async function notify({
  tenantId, user, eventKey, vars = {}, link = null, channels = null, dedupeKey = null,
}) {
  if (!user) return [];
  const targets = channels || channelsFor(user, eventKey);
  const results = [];

  for (const channel of targets) {
    if (channel === 'push') continue; // FCM/APNs: mobile device tokens, out of scope for the dev harness
    const tpl = templateFor(tenantId, eventKey, channel);
    const scope = { ...vars, user };
    const subject = renderTemplate(tpl.subject || eventKey, scope);
    const body = renderTemplate(tpl.body, scope);
    const key = dedupeKey ? `${dedupeKey}:${channel}:${user.id}` : null;

    if (key && get('SELECT id FROM notifications WHERE tenant_id = ? AND dedupe_key = ?', [tenantId, key])) {
      continue; // already sent this rung of the ladder
    }

    const id = uuid();
    const provider = providerFor(channel);
    let status = 'queued';
    let error = null;
    let ref = null;

    try {
      const to = addressFor(user, channel);
      if (!to && channel !== 'in_app') {
        status = 'failed';
        error = `no ${channel} address on file`;
      } else {
        const res = await provider.send({ channel, to, subject, body });
        status = res.ok ? (channel === 'in_app' ? 'sent' : 'delivered') : 'failed';
        error = res.error || null;
        ref = res.ref || null;
      }
    } catch (err) {
      status = 'failed';
      error = err.message;
    }

    run(
      `INSERT INTO notifications (id, tenant_id, user_id, event_key, channel, title, body, link,
         status, provider, provider_ref, error, dedupe_key, meta, sent_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, user.id, eventKey, channel, subject, body, link, status, provider.id, ref,
        error, key, JSON.stringify(vars), status === 'failed' ? null : nowIso(), nowIso()],
    );
    results.push({ id, channel, status, error });
  }
  return results;
}

/** Fan out one event to several users. */
export async function notifyMany({ tenantId, userIds, ...rest }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  const users = all(
    `SELECT * FROM users WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL AND status != 'disabled'`,
    [tenantId, ...ids],
  );
  const out = [];
  for (const user of users) out.push(...(await notify({ tenantId, user, ...rest })));
  return out;
}

/** Notify everyone holding a given role in the tenant. */
export async function notifyRole({ tenantId, roles, ...rest }) {
  const list = Array.isArray(roles) ? roles : [roles];
  const users = all(
    `SELECT id FROM users WHERE tenant_id = ? AND role IN (${list.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    [tenantId, ...list],
  ).map((u) => u.id);
  return notifyMany({ tenantId, userIds: users, ...rest });
}
