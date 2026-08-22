/**
 * AR: the API is documented with OpenAPI, and it is the same contract that
 * higher-plan tenants get programmatic access to later. Kept hand-written and
 * concise: the envelope, auth, and one entry per resource group with the
 * parameters that matter, rather than a generated wall of schemas.
 */

const envelope = {
  Envelope: {
    type: 'object',
    properties: {
      data: { description: 'The resource, or an array of resources' },
      meta: {
        type: 'object',
        description: 'Pagination and summary information',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          pages: { type: 'integer' },
          has_more: { type: 'boolean' },
        },
      },
    },
  },
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'unprocessable' },
          message: { type: 'string' },
          details: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  Money: {
    type: 'integer',
    description: 'Minor units (paise for INR). 118000 = ₹1,180.00',
  },
};

const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 200 } },
  { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Field name; prefix with - for descending' },
];

const listOp = (tag, summary, extraParams = []) => ({
  tags: [tag],
  summary,
  parameters: [...pageParams, ...extraParams],
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
  },
});

const simpleOp = (tag, summary, method = 'get') => ({
  tags: [tag],
  summary,
  ...(method !== 'get' && { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } }),
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  },
});

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Phoenixx OS API',
    version: '1.0.0',
    description: [
      'Integrated agency operations and tracking suite.',
      '',
      '**One API, many clients.** The web app and the mobile apps are thin clients over this',
      'contract; no business logic is duplicated in either.',
      '',
      '**Tenancy.** The access token carries `tenant_id` and `role`. Every query is filtered by',
      'tenant at the data layer - a token from one agency can never read another\'s rows.',
      '',
      '**Money** is always an integer in minor units plus a currency code.',
      '**Timestamps** are UTC ISO-8601 and rendered in the tenant timezone by the client.',
      '',
      '**Idempotency.** Send an `Idempotency-Key` header on invoice, payment and billing writes;',
      'a replay returns the original response with `Idempotent-Replay: true`.',
    ].join('\n'),
    contact: { name: 'Phoenixx IT', email: 'hello@phoenixxit.com' },
  },
  servers: [
    { url: '/api/v1', description: 'Current' },
  ],
  tags: [
    { name: 'Auth', description: 'Sign-in, tokens, 2FA, tenant signup' },
    { name: 'Action Items', description: 'Module A - action items, comments, escalation' },
    { name: 'Meetings', description: 'Module A - meetings and MOM' },
    { name: 'Notifications', description: 'Module B - deadlines, alerts, escalations, webhooks' },
    { name: 'HR', description: 'Module C - attendance, leave, performance, hiring' },
    { name: 'SOP', description: 'Module D - SOP library, versions, adherence' },
    { name: 'KPI', description: 'Module D - KPI and KRA definitions' },
    { name: 'CRM', description: 'Module E - pipeline, clients, activities, scoring' },
    { name: 'Proposals', description: 'Module E - proposal generator and e-acceptance' },
    { name: 'Invoices', description: 'Module F - invoicing, GST, payments' },
    { name: 'Chat', description: 'Module B - project rooms, company broadcasts, direct messages' },
    { name: 'Finance', description: 'Module F - costs, profitability, receivables' },
    { name: 'Projects', description: 'Module F - projects and their delivery teams' },
    { name: 'Reports', description: 'Module G - internal and client-facing reporting' },
    { name: 'Dashboard', description: 'Module H - Overview Traction Dashboard' },
    { name: 'Settings', description: 'Tenant configuration, roles, audit' },
    { name: 'Users', description: 'Team management' },
    { name: 'Billing', description: 'Subscription, plans, add-ons' },
    { name: 'Sync', description: 'Mobile delta sync and offline queue' },
    { name: 'Admin', description: 'Platform Super Admin console' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: envelope,
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key', in: 'header', schema: { type: 'string' },
        description: 'Client-generated key; a replay returns the original response',
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': { get: { tags: ['Auth'], summary: 'Liveness probe', security: [], responses: { 200: { description: 'OK' } } } },

    '/auth/signup': {
      post: {
        tags: ['Auth'], summary: 'Create a tenant with a 14-day trial (S7)', security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['agency_name', 'owner_name', 'email', 'password'],
                properties: {
                  agency_name: { type: 'string' },
                  owner_name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  phone: { type: 'string' },
                  city: { type: 'string' },
                  plan_code: { type: 'string', enum: ['starter', 'growth', 'scale'] },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Tenant created, session issued' }, 409: { description: 'Email or workspace taken' } },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Sign in (send totp when 2FA is enabled)', security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                  totp: { type: 'string', description: '6-digit TOTP when 2FA is on' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Access token, refresh token, session payload' },
          401: { description: 'Bad credentials, or code_required' },
        },
      },
    },
    '/auth/refresh': { post: { tags: ['Auth'], summary: 'Rotate the refresh token', security: [], responses: { 200: { description: 'New token pair' } } } },
    '/auth/me': { get: simpleOp('Auth', 'Current session, tenant, plan and permission matrix') },
    '/auth/2fa/setup': { post: simpleOp('Auth', 'Generate a TOTP secret and otpauth URL', 'post') },
    '/auth/2fa/enable': { post: simpleOp('Auth', 'Confirm the code and turn 2FA on', 'post') },

    '/action-items': {
      get: listOp('Action Items', 'List action items', [
        { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Comma separated: open,in_progress,blocked,done,cancelled' },
        { name: 'priority', in: 'query', schema: { type: 'string' } },
        { name: 'owner_id', in: 'query', schema: { type: 'string' } },
        { name: 'client_id', in: 'query', schema: { type: 'string' } },
        { name: 'overdue', in: 'query', schema: { type: 'boolean' } },
        { name: 'search', in: 'query', schema: { type: 'string' } },
      ]),
      post: simpleOp('Action Items', 'Create an action item', 'post'),
    },
    '/action-items/{id}': {
      get: simpleOp('Action Items', 'One item with comments, watchers, escalations'),
      patch: simpleOp('Action Items', 'Update an action item', 'patch'),
      delete: simpleOp('Action Items', 'Soft-delete an action item', 'delete'),
    },
    '/action-items/{id}/escalate': { post: simpleOp('Action Items', 'Escalate to the reporting manager (A4)', 'post') },
    '/action-items/{id}/comments': { post: simpleOp('Action Items', 'Comment with @mentions (A5)', 'post') },
    '/action-items/me/today': { get: simpleOp('Action Items', 'My overdue, today and upcoming work') },

    '/meetings': { get: listOp('Meetings', 'List meetings'), post: simpleOp('Meetings', 'Schedule a meeting with agenda', 'post') },
    '/meetings/{id}/mom': { post: simpleOp('Meetings', 'Capture MOM points', 'post') },
    '/meetings/{id}/mom/{pointId}/convert': { post: simpleOp('Meetings', 'Convert a MOM point into an action item (A2)', 'post') },
    '/meetings/{id}/finalize': { post: simpleOp('Meetings', 'Lock the MOM and convert every action point', 'post') },

    '/notifications': { get: listOp('Notifications', 'In-app inbox') },
    '/notifications/preferences': {
      get: simpleOp('Notifications', 'Channel preferences per event (B2)'),
      put: simpleOp('Notifications', 'Update channel preferences', 'put'),
    },
    '/notifications/templates': {
      get: simpleOp('Notifications', 'Per-tenant notification templates (B5)'),
      put: simpleOp('Notifications', 'Override a template', 'put'),
    },
    '/notifications/deadlines': { get: listOp('Notifications', 'Central deadline register (B1)') },
    '/notifications/escalations': { get: listOp('Notifications', 'Escalation log') },
    '/notifications/webhooks': {
      get: simpleOp('Notifications', 'Webhook endpoints and recent deliveries (AR3)'),
      post: simpleOp('Notifications', 'Register a webhook endpoint', 'post'),
    },

    '/hr/attendance/check-in': { post: simpleOp('HR', 'Check in, optionally geo-tagged (C1)', 'post') },
    '/hr/attendance/check-out': { post: simpleOp('HR', 'Check out', 'post') },
    '/hr/attendance/register': { get: simpleOp('HR', 'Monthly attendance register') },
    '/hr/attendance/regularize': { post: simpleOp('HR', 'Request a regularization', 'post') },
    '/hr/leave/requests': { get: listOp('HR', 'Leave and permission requests'), post: simpleOp('HR', 'Apply for leave', 'post') },
    '/hr/leave/requests/{id}/decide': { post: simpleOp('HR', 'Approve or reject leave', 'post') },
    '/hr/leave/calendar': { get: simpleOp('HR', 'Team availability calendar (C2)') },
    '/hr/performance': { get: simpleOp('HR', 'Monthly performance reviews (C3)') },
    '/hr/performance/generate': { post: simpleOp('HR', 'Recompute reviews from source records', 'post') },
    '/hr/hiring/openings': { get: simpleOp('HR', 'Open roles with qualification standards (C4)'), post: simpleOp('HR', 'Create a role', 'post') },
    '/hr/hiring/candidates': { get: simpleOp('HR', 'Candidate pipeline board'), post: simpleOp('HR', 'Add a candidate', 'post') },

    '/sop': { get: listOp('SOP', 'SOP library by service line and workflow (D1)'), post: simpleOp('SOP', 'Create an SOP', 'post') },
    '/sop/{id}': { get: simpleOp('SOP', 'One SOP with its version history') },
    '/sop/{id}/versions': { post: simpleOp('SOP', 'Open or update the next draft version (D2)', 'post') },
    '/sop/{id}/publish': { post: simpleOp('SOP', 'Publish the draft version', 'post') },
    '/sop/{id}/acknowledge': { post: simpleOp('SOP', 'Acknowledge having read this version', 'post') },
    '/sop/{id}/runs': { post: simpleOp('SOP', 'Start a checklist run against a record', 'post') },
    '/sop/reports/adherence': { get: simpleOp('SOP', 'Checklist completion rates (D4)') },
    '/sop/reports/acknowledgement': { get: simpleOp('SOP', 'Who has read which SOP version') },
    '/kpis': { get: simpleOp('KPI', 'KPI/KRA definitions per role and service line (D3)'), post: simpleOp('KPI', 'Define a KPI', 'post') },

    '/crm/clients': {
      get: listOp('CRM', 'List leads and clients', [
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'stage_id', in: 'query', schema: { type: 'string' } },
        { name: 'retention_risk', in: 'query', schema: { type: 'boolean' } },
        { name: 'filter', in: 'query', schema: { type: 'string', enum: ['no_next_action', 'follow_up_due'] } },
      ]),
      post: simpleOp('CRM', 'Create a lead (duplicate-checked)', 'post'),
    },
    '/crm/pipeline': { get: simpleOp('CRM', 'Pipeline board grouped by stage (E1)') },
    '/crm/clients/{id}': { get: simpleOp('CRM', 'Client with unified timeline and scores (E3, E6)'), patch: simpleOp('CRM', 'Update a client', 'patch') },
    '/crm/clients/{id}/activities': { post: simpleOp('CRM', 'Log a touchpoint and set the next action (E4)', 'post') },
    '/crm/clients/{id}/rescore': { post: simpleOp('CRM', 'Recompute the four client scores (E6)', 'post') },
    '/crm/clients/{id}/score-adjustments': { post: simpleOp('CRM', 'Manual adjustment with a structured reason code', 'post') },
    '/crm/traction': { get: simpleOp('CRM', 'Active vs delivered scope per client (E7)') },
    '/crm/clients/import': { post: simpleOp('CRM', 'CSV import with duplicate detection (E8)', 'post') },

    '/proposals': { get: listOp('Proposals', 'List proposals'), post: simpleOp('Proposals', 'Generate from a service-line template (E5)', 'post') },
    '/proposals/{id}/send': { post: simpleOp('Proposals', 'Render the PDF and issue a tracked share link', 'post') },
    '/public/proposals/{token}': { get: { tags: ['Proposals'], summary: 'Public proposal view (tracks the view)', security: [], responses: { 200: { description: 'OK' } } } },
    '/public/proposals/{token}/accept': { post: { tags: ['Proposals'], summary: 'E-acceptance by the client', security: [], responses: { 200: { description: 'Accepted' } } } },

    '/invoices': {
      get: listOp('Invoices', 'List invoices', [
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'overdue', in: 'query', schema: { type: 'boolean' } },
        { name: 'fy', in: 'query', schema: { type: 'string', example: '2026-27' } },
      ]),
      post: {
        tags: ['Invoices'],
        summary: 'Create an invoice - the number is allocated atomically (F1)',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['client_id', 'items'],
                properties: {
                  client_id: { type: 'string' },
                  project_id: { type: 'string', nullable: true },
                  issue_date: { type: 'string', format: 'date' },
                  payment_terms_days: { type: 'integer', default: 15 },
                  place_of_supply: { type: 'string', description: 'GST state code; drives CGST/SGST vs IGST' },
                  is_export: { type: 'boolean' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['description', 'rate_minor'],
                      properties: {
                        description: { type: 'string' },
                        hsn_sac: { type: 'string' },
                        qty: { type: 'number', default: 1 },
                        rate_minor: { $ref: '#/components/schemas/Money' },
                        discount_pct: { type: 'number' },
                        gst_rate: { type: 'number', default: 18 },
                        service_line_id: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created' }, 409: { description: 'Numbering conflict' } },
      },
    },
    '/invoices/meta': { get: simpleOp('Invoices', 'State codes, SAC codes, next number, numbering audit') },
    '/invoices/{id}/send': { post: simpleOp('Invoices', 'Render the PDF, send, and register the due date with the deadline engine', 'post') },
    '/invoices/{id}/payments': {
      post: {
        tags: ['Invoices'],
        summary: 'Record a payment (F2)',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        responses: { 201: { description: 'Invoice updated' } },
      },
    },
    '/invoices/{id}/credit-notes': { post: simpleOp('Invoices', 'Issue a credit note (F6)', 'post') },
    '/invoices/recurring': { post: simpleOp('Invoices', 'Set up a retainer schedule (F3)', 'post') },
    '/invoices/export': { get: simpleOp('Invoices', 'Tally / Zoho Books CSV export (F6)') },

    '/finance/costs': { get: listOp('Finance', 'Monthly cost entries (F4)'), post: simpleOp('Finance', 'Record a cost', 'post') },
    '/finance/costs/roll-forward': { post: simpleOp('Finance', 'Copy recurring costs and pull HR salary bands into a month', 'post') },
    '/finance/profitability': {
      get: {
        tags: ['Finance'],
        summary: 'Revenue minus allocated cost by client, project, service line and company (F5)',
        parameters: [
          { name: 'months', in: 'query', schema: { type: 'integer', default: 6 } },
          { name: 'end_month', in: 'query', schema: { type: 'string', example: '2026-08' } },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/finance/receivables': { get: simpleOp('Finance', 'AR ageing buckets and DSO') },
    '/finance/projects': { get: simpleOp('Finance', 'Projects with invoiced and cost roll-ups (alias of /projects)'), post: simpleOp('Finance', 'Create a project', 'post') },

    '/chat/channels': {
      get: listOp('Chat', 'Every conversation the caller is in, newest first, with unread counts'),
      post: simpleOp('Chat', 'Start a group conversation', 'post'),
    },
    '/chat/channels/{id}': {
      get: simpleOp('Chat', 'One conversation with its members and pinned messages'),
      patch: simpleOp('Chat', 'Rename, retopic or archive a conversation', 'patch'),
    },
    '/chat/channels/{id}/messages': {
      get: listOp('Chat', 'Message history, paged backwards with ?before='),
      post: simpleOp('Chat', 'Post a message; @names become mentions and notify those people', 'post'),
    },
    '/chat/channels/{id}/read': { post: simpleOp('Chat', 'Mark the conversation caught up', 'post') },
    '/chat/channels/{id}/settings': { patch: simpleOp('Chat', 'Mute or unmute', 'patch') },
    '/chat/channels/{id}/members': { post: simpleOp('Chat', 'Invite people to a group conversation', 'post') },
    '/chat/channels/{id}/members/{userId}': { delete: simpleOp('Chat', 'Remove someone, or leave yourself', 'delete') },
    '/chat/direct': { post: simpleOp('Chat', 'Open the one-to-one conversation with somebody', 'post') },
    '/chat/messages/{id}': {
      patch: simpleOp('Chat', 'Edit your own message', 'patch'),
      delete: simpleOp('Chat', 'Delete your own message (room owners may delete any)', 'delete'),
    },
    '/chat/messages/{id}/pin': { post: simpleOp('Chat', 'Pin or unpin a message', 'post') },
    '/chat/unread': { get: simpleOp('Chat', 'Total unread across every conversation, for the nav badge') },
    '/chat/stream': { get: simpleOp('Chat', 'Server-Sent Events stream of messages for the rooms the caller is in') },

    '/projects': {
      get: listOp('Projects', 'Projects with their delivery team, budget and roll-ups'),
      post: simpleOp('Projects', 'Create a project and seat its manager and lead', 'post'),
    },
    '/projects/seats': { get: simpleOp('Projects', 'Seat catalogue - manager, lead, senior, member, junior, reviewer, observer') },
    '/projects/workload': { get: simpleOp('Projects', 'Every person with the projects they are staffed on and their total allocation') },
    '/projects/{id}': {
      get: simpleOp('Projects', 'One project with its team grouped by seat'),
      patch: simpleOp('Projects', 'Update a project; naming a manager or lead seats them on the team', 'patch'),
      delete: simpleOp('Projects', 'Archive a project and its team', 'delete'),
    },
    '/projects/{id}/members': {
      get: simpleOp('Projects', 'The project team, ordered by seat'),
      post: simpleOp('Projects', 'Add someone to the team, or move an existing member into another seat', 'post'),
    },
    '/projects/{id}/members/bulk': { post: simpleOp('Projects', 'Staff several people onto a project in one call', 'post') },
    '/projects/{id}/available': { get: simpleOp('Projects', 'Employees not yet on this team, with their current load') },
    '/projects/{id}/members/{memberId}': {
      patch: simpleOp('Projects', 'Change seat, responsibility, allocation or dates', 'patch'),
      delete: simpleOp('Projects', 'Remove someone from the team (409 if they still own open items; ?force=true overrides)', 'delete'),
    },
    '/projects/{id}/members/export/csv': { get: simpleOp('Projects', 'Team roster as CSV') },

    '/reports': { get: listOp('Reports', 'Generated report runs') },
    '/reports/generate': { post: simpleOp('Reports', 'Generate daily, weekly, monthly or client report (G1, G2)', 'post') },
    '/reports/{id}/pdf': { get: simpleOp('Reports', 'Branded PDF of a report') },
    '/reports/{id}/dispatch': { post: simpleOp('Reports', 'Approve and deliver through the notification channels', 'post') },
    '/reports/definitions': { post: simpleOp('Reports', 'Save a scheduled report definition (G3)', 'post') },

    '/dashboard/overview': {
      get: {
        tags: ['Dashboard'],
        summary: 'Overview Traction Dashboard - clients, revenue, HR, cost, profit (H1)',
        parameters: [
          { name: 'month', in: 'query', schema: { type: 'string', example: '2026-08' } },
          { name: 'compare', in: 'query', schema: { type: 'string', enum: ['mom', 'qoq'] } },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/dashboard/mobile': { get: simpleOp('Dashboard', 'Condensed pillar cards for mobile (H5)') },
    '/dashboard/improvement-flags': { get: simpleOp('Dashboard', 'Auto-surfaced weak points (H3)') },
    '/dashboard/drilldown/{key}': { get: simpleOp('Dashboard', 'Records behind a dashboard widget (H4)') },
    '/dashboard/home': { get: simpleOp('Dashboard', 'Personal home: my work, approvals, meetings') },

    '/settings/tenant': { get: simpleOp('Settings', 'Tenant profile, branding, GST and numbering'), patch: simpleOp('Settings', 'Update tenant settings', 'patch') },
    '/settings/service-lines': { get: simpleOp('Settings', 'Service lines'), post: simpleOp('Settings', 'Add a service line', 'post') },
    '/settings/pipeline-stages': { get: simpleOp('Settings', 'Configurable pipeline stages (E1)'), post: simpleOp('Settings', 'Add a stage', 'post') },
    '/settings/reason-codes': { get: simpleOp('Settings', 'Managed reason codes (E6, E7)'), post: simpleOp('Settings', 'Add a reason code', 'post') },
    '/settings/roles': { get: simpleOp('Settings', 'Role templates and custom roles'), post: simpleOp('Settings', 'Create a custom role', 'post') },
    '/settings/audit': { get: listOp('Settings', 'Audit log with before/after values') },
    '/settings/data-export': { get: simpleOp('Settings', 'Full tenant data export (DPDP Act 2023)') },

    '/users': { get: listOp('Users', 'Team members'), post: simpleOp('Users', 'Invite a team member', 'post') },
    '/users/directory': { get: simpleOp('Users', 'Lightweight directory for assignee pickers') },
    '/users/org/chart': { get: simpleOp('Users', 'Reporting hierarchy') },

    '/plans': { get: { tags: ['Billing'], summary: 'Public plan matrix - for a pricing page, no auth required (S1, S2)', security: [], responses: { 200: { description: 'OK' } } } },
    '/billing/plans': { get: simpleOp('Billing', 'Plan matrix with features and limits, as seen from inside a workspace') },
    '/billing/subscription': { get: simpleOp('Billing', 'Current subscription with usage against limits') },
    '/billing/subscription/quote': { post: simpleOp('Billing', 'Quote a plan change including proration and GST', 'post') },
    '/billing/subscription/change': { post: simpleOp('Billing', 'Change plan and create a gateway order (S4)', 'post') },
    '/billing/subscription/cancel': { post: simpleOp('Billing', 'Cancel, keeping a 90-day export window (S5)', 'post') },

    '/sync': {
      get: {
        tags: ['Sync'],
        summary: 'Delta sync since a timestamp (AR5)',
        parameters: [
          { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'tables', in: 'query', schema: { type: 'string' }, description: 'Comma separated subset' },
        ],
        responses: { 200: { description: 'Changed rows per table' } },
      },
    },
    '/sync/queue': { post: simpleOp('Sync', 'Replay offline actions; conflicts are last-write-wins and reported', 'post') },
    '/sync/bootstrap': { get: simpleOp('Sync', 'First-run payload for a fresh mobile install') },
    '/files': { post: simpleOp('Sync', 'Upload an attachment or voice note (A5, A6)', 'post') },

    '/admin/metrics': { get: simpleOp('Admin', 'Platform MRR, churn, activation (S9)') },
    '/admin/tenants': { get: simpleOp('Admin', 'Tenant list with plan, usage and health') },
    '/admin/tenants/{id}/impersonate': { post: simpleOp('Admin', 'Impersonate with consent, always audited', 'post') },
    '/admin/health': { get: simpleOp('Admin', 'Job runs, notification delivery, webhook failures') },
  },
};
