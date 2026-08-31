/**
 * Seed / demo data script.
 *
 * `npm run seed`          - create the platform plans and Phoenixx IT (tenant #1)
 * `npm run reset`         - drop the database file first, then seed
 *
 * Phase 1 of the PRD is Phoenixx IT using this internally, so tenant #1 is
 * Phoenixx IT with a realistic Coimbatore-agency dataset: four service lines,
 * a team, a pipeline spanning every stage, invoices across two months (one of
 * them deliberately overdue), costs, SOP runs, attendance and action items.
 * A second small tenant is created too, purely to prove tenant isolation.
 */

import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

const reset = process.argv.includes('--reset');
if (reset) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${config.dbFile}${suffix}`;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  console.log('· dropped existing database');
}

const { db, get, all, run, migrate, tx } = await import('./db/index.js');
const { uuid, nowIso, todayIso, addDays, addMonths, monthIso, startOfMonth } = await import('./lib/util.js');
const { provisionTenant } = await import('./services/provisioning.js');
const { createInvoice, syncHrCosts } = await import('./services/invoicing.js');
const { scoreAllClients } = await import('./services/scoring.js');
const { detectImprovementFlags, snapshotMetrics } = await import('./services/analytics.js');
const chat = await import('./services/chat.js');
const { generateDailyReport, generateWeeklyReport, generateMonthlyReport, generateClientMonthlyReport } = await import('./services/reports.js');
const { upsertDeadline } = await import('./services/deadlines.js');
const { allocateNumber } = await import('./services/numbering.js');

migrate();

const ts = nowIso();
const pick = (arr, i) => arr[i % arr.length];
const rupees = (n) => Math.round(n * 100);

// ============================================================ PLATFORM PLANS
function seedPlans() {
  if (get('SELECT id FROM plans LIMIT 1')) return console.log('· plans already present');

  const plans = [
    {
      code: 'starter', name: 'Starter', band_max_users: 15,
      monthly: rupees(7_999), yearly: rupees(79_990), addon: rupees(499),
      features: {
        action_items: true, deadline_engine: true, crm: true, proposals: true, invoicing: true,
        hr: true, sop: true, reports: true, dashboard: true,
        whatsapp: true, custom_roles: false, client_portal: false, report_builder: false,
        api_access: false, white_label_reports: false,
      },
      limits: { clients: 50, storage_mb: 5_000, wa_credits: 1_000 },
    },
    {
      code: 'growth', name: 'Growth', band_min_users: 16, band_max_users: 30,
      monthly: rupees(13_999), yearly: rupees(139_990), addon: rupees(449),
      features: {
        action_items: true, deadline_engine: true, crm: true, proposals: true, invoicing: true,
        hr: true, sop: true, reports: true, dashboard: true,
        whatsapp: true, custom_roles: true, client_portal: true, report_builder: true,
        api_access: false, white_label_reports: false,
      },
      limits: { clients: 200, storage_mb: 20_000, wa_credits: 5_000 },
    },
    {
      code: 'scale', name: 'Scale', band_min_users: 31, band_max_users: 50,
      monthly: rupees(22_999), yearly: rupees(229_990), addon: rupees(399),
      features: {
        action_items: true, deadline_engine: true, crm: true, proposals: true, invoicing: true,
        hr: true, sop: true, reports: true, dashboard: true,
        whatsapp: true, custom_roles: true, client_portal: true, report_builder: true,
        api_access: true, white_label_reports: true,
      },
      limits: { clients: null, storage_mb: 100_000, wa_credits: 15_000 },
    },
  ];

  plans.forEach((p, i) => {
    run(
      `INSERT INTO plans (id, code, name, band_min_users, band_max_users, price_monthly_minor,
         price_yearly_minor, addon_user_monthly_minor, features, limits, sort, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), p.code, p.name, p.band_min_users ?? 1, p.band_max_users, p.monthly, p.yearly,
        p.addon, JSON.stringify(p.features), JSON.stringify(p.limits), i, ts],
    );
  });

  // S3 - launch offer: the first 25 tenants get three months free.
  run(
    `INSERT INTO coupons (id, code, kind, value, duration_months, max_redemptions, valid_until, created_at)
     VALUES (?, 'LAUNCH3', 'free_months', 3, 3, 25, ?, ?)`,
    [uuid(), addMonths(new Date(), 6).toISOString(), ts],
  );
  run(
    `INSERT INTO coupons (id, code, kind, value, max_redemptions, created_at)
     VALUES (?, 'AGENCY20', 'percent', 20, 100, ?)`,
    [uuid(), ts],
  );

  console.log(`✓ ${plans.length} plans + 2 coupons`);
}

// ------------------------------------------------------------- super admin
function seedSuperAdmin() {
  if (get("SELECT id FROM users WHERE role = 'super_admin'")) return;
  run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, role, status, created_at, updated_at)
     VALUES (?, NULL, 'platform@phoenixxit.com', ?, 'Platform Admin', 'super_admin', 'active', ?, ?)`,
    [uuid(), bcrypt.hashSync('Platform@2026', 10), ts, ts],
  );
  console.log('✓ super admin  platform@phoenixxit.com / Platform@2026');
}

// --------------------------------------------------------------- clients
/**
 * The demo pipeline. Every stage carries five or six cards on purpose: an
 * empty column says nothing about how the board reads or behaves, and a
 * one-card board is not a board.
 */
const CLIENTS = [
    { name: 'Cotton India Textiles', industry: 'textiles', stage: 'execution', status: 'active', model: 'retainer', mrr: 150_000, sls: ['branding', 'digital'], city: 'Tiruppur', state: 'Tamil Nadu', code: '33', gstin: '33AABCC7654D1Z9', owner: 'divya@phoenixxit.com', scope: [24, 19], sat: 4, onboarded: -420 },
    { name: 'Sree Balaji Constructions', industry: 'construction', stage: 'execution', status: 'active', model: 'hybrid', mrr: 120_000, sls: ['digital', 'tech'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', gstin: '33AAECS4321F1ZP', owner: 'divya@phoenixxit.com', scope: [18, 16], sat: 5, onboarded: -300 },
    { name: 'Aroma Kitchens & Catering', industry: 'hospitality', stage: 'execution', status: 'active', model: 'retainer', mrr: 75_000, sls: ['digital'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', gstin: '33AAFFA8765H1ZQ', owner: 'priya@phoenixxit.com', scope: [12, 7], sat: 3, onboarded: -180 },
    { name: 'ThermaCool HVAC Systems', industry: 'hvac', stage: 'execution', status: 'active', model: 'project', mrr: 0, deal: 660_000, sls: ['tech', 'branding'], city: 'Chennai', state: 'Tamil Nadu', code: '33', gstin: '33AAGCT3456K1ZM', owner: 'vignesh@phoenixxit.com', scope: [20, 11], sat: 4, onboarded: -95 },
    { name: 'Meridian Financial Advisory', industry: 'financial advisory', stage: 'retention', status: 'active', model: 'retainer', mrr: 110_000, sls: ['sales', 'digital'], city: 'Bengaluru', state: 'Karnataka', code: '29', gstin: '29AAHCM9876L1ZR', owner: 'nithya@phoenixxit.com', scope: [15, 14], sat: 5, onboarded: -250, renewal: 45 },
    { name: 'Weave & Co. Ecommerce', industry: 'ecommerce', stage: 'execution', status: 'active', model: 'hybrid', mrr: 95_000, sls: ['digital', 'tech'], city: 'Erode', state: 'Tamil Nadu', code: '33', gstin: '33AAJCW6543M1ZS', owner: 'priya@phoenixxit.com', scope: [16, 9], sat: 3, onboarded: -140 },
    { name: 'Kongu Steel Traders', industry: 'construction', stage: 'invoicing', status: 'active', model: 'project', mrr: 0, deal: 320_000, sls: ['branding'], city: 'Salem', state: 'Tamil Nadu', code: '33', owner: 'rahul@phoenixxit.com', scope: [10, 10], sat: 4, onboarded: -60 },
    { name: 'Nilgiri Estate Resorts', industry: 'hospitality', stage: 'onboarding', status: 'active', model: 'retainer', mrr: 90_000, sls: ['branding', 'digital'], city: 'Ooty', state: 'Tamil Nadu', code: '33', owner: 'karthik@phoenixxit.com', scope: [14, 2], sat: null, onboarded: -12 },
    { name: 'Vertex Precision Tools', industry: 'manufacturing', stage: 'proposal', status: 'lead', deal: 550_000, sls: ['tech'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'vignesh@phoenixxit.com', next: 'Follow up on the automation proposal', nextIn: 2 },
    { name: 'Kadambari Silks', industry: 'textiles', stage: 'follow_up', status: 'lead', deal: 280_000, sls: ['branding', 'digital'], city: 'Kanchipuram', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Share the branding case studies', nextIn: 1 },
    { name: 'Southern Spice Restaurants', industry: 'hospitality', stage: 'pitch', status: 'lead', deal: 180_000, sls: ['digital'], city: 'Madurai', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Pitch deck walkthrough call', nextIn: -1 },
    { name: 'Anandha Jewellers', industry: 'retail', stage: 'outreach', status: 'lead', deal: 220_000, sls: ['branding'], city: 'Trichy', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'First outreach on WhatsApp', nextIn: 0 },
    { name: 'GreenBuild Infra', industry: 'construction', stage: 'follow_up', status: 'lead', deal: 400_000, sls: ['digital', 'sales'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com' },
    { name: 'Coastal Logistics', industry: 'logistics', stage: 'outreach', status: 'lead', deal: 150_000, sls: ['tech'], city: 'Tuticorin', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Qualify budget and timeline', nextIn: 4 },
    { name: 'Bharathi Educational Trust', industry: 'education', stage: 'retention', status: 'churned', model: 'retainer', mrr: 0, sls: ['digital'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'divya@phoenixxit.com', churnReason: 'COST', churnedDaysAgo: 40, onboarded: -400 },

    // Bench depth, so every column on the pipeline board carries five or six
    // cards. An empty stage tells you nothing about how the board behaves, and
    // a one-card board is not a board.
    { name: 'Trident Auto Components', industry: 'manufacturing', stage: 'outreach', status: 'lead', deal: 260_000, sls: ['tech'], city: 'Hosur', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Intro call with the plant head', nextIn: 1 },
    { name: 'Vaigai Health Clinics', industry: 'healthcare', stage: 'outreach', status: 'lead', deal: 175_000, sls: ['digital'], city: 'Madurai', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com', next: 'Send the clinic marketing brief', nextIn: 3 },
    { name: 'Marina Realty Group', industry: 'real estate', stage: 'outreach', status: 'lead', deal: 480_000, sls: ['branding', 'digital'], city: 'Chennai', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com' },
    { name: 'Kaveri Organic Foods', industry: 'fmcg', stage: 'outreach', status: 'lead', deal: 195_000, sls: ['branding'], city: 'Erode', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com', next: 'Share the packaging portfolio', nextIn: 5 },

    { name: 'Zenith Fitness Studios', industry: 'fitness', stage: 'pitch', status: 'lead', deal: 210_000, sls: ['digital', 'sales'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Walk through the membership funnel deck', nextIn: 2 },
    { name: 'Pallava Granites', industry: 'mining', stage: 'pitch', status: 'lead', deal: 340_000, sls: ['tech', 'branding'], city: 'Salem', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com', next: 'Pitch the export catalogue site', nextIn: 0 },
    { name: 'Aadhi Pharma Distributors', industry: 'pharma', stage: 'pitch', status: 'lead', deal: 290_000, sls: ['digital'], city: 'Trichy', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Second pitch with the promoter', nextIn: -2 },
    { name: 'Skyline Interiors', industry: 'interiors', stage: 'pitch', status: 'lead', deal: 265_000, sls: ['branding'], city: 'Chennai', state: 'Tamil Nadu', code: '33', owner: 'vignesh@phoenixxit.com' },

    { name: 'Nova Edutech', industry: 'education', stage: 'follow_up', status: 'lead', deal: 320_000, sls: ['tech', 'digital'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com', next: 'Chase the revised requirement list', nextIn: 1 },
    { name: 'Sri Murugan Textile Mills', industry: 'textiles', stage: 'follow_up', status: 'lead', deal: 380_000, sls: ['branding', 'digital'], city: 'Tiruppur', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Follow up after the mill visit', nextIn: -3 },
    { name: 'Blue Harbour Seafoods', industry: 'food processing', stage: 'follow_up', status: 'lead', deal: 240_000, sls: ['sales'], city: 'Tuticorin', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com', next: 'Reconfirm the export budget', nextIn: 6 },

    { name: 'Ambal Hospitals', industry: 'healthcare', stage: 'proposal', status: 'lead', deal: 720_000, sls: ['tech', 'digital'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'vignesh@phoenixxit.com', next: 'Proposal review with the board', nextIn: 3 },
    { name: 'Everest Packaging', industry: 'manufacturing', stage: 'proposal', status: 'lead', deal: 460_000, sls: ['branding', 'tech'], city: 'Hosur', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com', next: 'Send the revised commercials', nextIn: 1 },
    { name: 'Chola Travels and Tours', industry: 'travel', stage: 'proposal', status: 'lead', deal: 390_000, sls: ['tech'], city: 'Madurai', state: 'Tamil Nadu', code: '33', owner: 'sundar@phoenixxit.com', next: 'Close the scope on the booking portal', nextIn: -1 },
    { name: 'Ivory Wedding Studios', industry: 'events', stage: 'proposal', status: 'lead', deal: 300_000, sls: ['branding', 'digital'], city: 'Chennai', state: 'Tamil Nadu', code: '33', owner: 'karthik@phoenixxit.com' },

    { name: 'Pioneer Public School', industry: 'education', stage: 'onboarding', status: 'active', model: 'retainer', mrr: 65_000, sls: ['digital'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'divya@phoenixxit.com', scope: [12, 1], sat: null, onboarded: -9 },
    { name: 'Rathna Home Appliances', industry: 'retail', stage: 'onboarding', status: 'active', model: 'hybrid', mrr: 80_000, sls: ['digital', 'branding'], city: 'Trichy', state: 'Tamil Nadu', code: '33', owner: 'priya@phoenixxit.com', scope: [16, 3], sat: null, onboarded: -18 },
    { name: 'Deccan Agro Exports', industry: 'agriculture', stage: 'onboarding', status: 'active', model: 'project', mrr: 0, deal: 540_000, sls: ['tech'], city: 'Erode', state: 'Tamil Nadu', code: '33', owner: 'karthik@phoenixxit.com', scope: [15, 2], sat: null, onboarded: -6 },
    { name: 'Lakshya Sports Academy', industry: 'sports', stage: 'onboarding', status: 'active', model: 'retainer', mrr: 45_000, sls: ['branding'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'rahul@phoenixxit.com', scope: [10, 2], sat: 4, onboarded: -21 },

    { name: 'Velmurugan Auto Dealers', industry: 'automotive', stage: 'execution', status: 'active', model: 'retainer', mrr: 105_000, sls: ['digital', 'sales'], city: 'Salem', state: 'Tamil Nadu', code: '33', owner: 'vignesh@phoenixxit.com', scope: [18, 12], sat: 4, onboarded: -210 },

    { name: 'Sakthi Engineering Works', industry: 'manufacturing', stage: 'invoicing', status: 'active', model: 'project', mrr: 0, deal: 430_000, sls: ['tech'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'divya@phoenixxit.com', scope: [12, 12], sat: 4, onboarded: -75 },
    { name: 'Crescent Dental Care', industry: 'healthcare', stage: 'invoicing', status: 'active', model: 'retainer', mrr: 55_000, sls: ['digital'], city: 'Chennai', state: 'Tamil Nadu', code: '33', owner: 'priya@phoenixxit.com', scope: [9, 9], sat: 5, onboarded: -120 },
    { name: 'Anicham Furniture', industry: 'retail', stage: 'invoicing', status: 'active', model: 'project', mrr: 0, deal: 275_000, sls: ['branding'], city: 'Erode', state: 'Tamil Nadu', code: '33', owner: 'karthik@phoenixxit.com', scope: [8, 8], sat: 3, onboarded: -55 },
    { name: 'TN Solar Solutions', industry: 'energy', stage: 'invoicing', status: 'active', model: 'hybrid', mrr: 70_000, sls: ['tech', 'digital'], city: 'Madurai', state: 'Tamil Nadu', code: '33', owner: 'vignesh@phoenixxit.com', scope: [14, 13], sat: 4, onboarded: -160 },

    { name: 'Annapoorna Foods', industry: 'hospitality', stage: 'retention', status: 'active', model: 'retainer', mrr: 130_000, sls: ['branding', 'digital'], city: 'Coimbatore', state: 'Tamil Nadu', code: '33', owner: 'divya@phoenixxit.com', scope: [22, 20], sat: 5, onboarded: -520, renewal: 30 },
    { name: 'Global Logistics Park', industry: 'logistics', stage: 'retention', status: 'active', model: 'retainer', mrr: 85_000, sls: ['tech'], city: 'Chennai', state: 'Tamil Nadu', code: '33', owner: 'nithya@phoenixxit.com', scope: [17, 15], sat: 3, onboarded: -365, renewal: 75 },
    { name: 'Sunrise Apparels', industry: 'textiles', stage: 'retention', status: 'active', model: 'hybrid', mrr: 60_000, sls: ['digital'], city: 'Tiruppur', state: 'Tamil Nadu', code: '33', owner: 'priya@phoenixxit.com', scope: [13, 11], sat: 2, onboarded: -280, renewal: 15 },
];

/** Code -> id maps for a tenant that is already in the database. */
function lookups(tenantId) {
  const byCode = (table) => Object.fromEntries(
    all(`SELECT id, code FROM ${table} WHERE tenant_id = ?`, [tenantId]).map((r) => [r.code, r.id]));
  return {
    tenantId,
    sl: byCode('service_lines'),
    stages: byCode('pipeline_stages'),
    reasons: byCode('reason_codes'),
    users: Object.fromEntries(
      all('SELECT id, email FROM users WHERE tenant_id = ?', [tenantId]).map((u) => [u.email, u.id])),
  };
}

/**
 * The client register. Only the won business becomes an account — a lead still
 * being chased is an opportunity, not a client on file, which is exactly the
 * distinction the two tables exist to hold. Each account is linked back to its
 * pipeline record so the Clients page can show the work attached to it.
 */
function seedClientAccounts(ctx, clientIds) {
  const { tenantId, users } = ctx;
  const ts = nowIso();
  let n = 0;

  for (const c of CLIENTS.filter((x) => x.status === 'active')) {
    const clientId = clientIds[c.name];
    const contact = get(
      'SELECT name, designation, email, phone, whatsapp FROM contacts WHERE client_id = ? AND is_primary = 1',
      [clientId],
    );
    const id = uuid();
    run(
      `INSERT INTO client_accounts (id, tenant_id, name, legal_name, industry, status, owner_id,
         contact_name, contact_designation, email, phone, whatsapp, website, gstin,
         address, city, state, state_code, country, currency, payment_terms_days, tags, notes,
         created_at, updated_at)
       VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,'India','INR',?,?,?,?,?)`,
      [id, tenantId, c.name, `${c.name} Private Limited`, c.industry, users[c.owner] ?? null,
        contact?.name ?? null, contact?.designation ?? null, contact?.email ?? null,
        contact?.phone ?? null, contact?.whatsapp ?? null,
        `https://${c.name.split(/[\s&.]/)[0].toLowerCase()}.com`, c.gstin ?? null,
        // No street line in the demo data — city and state carry the address, and
        // repeating them here would render as "Tiruppur, Tamil Nadu, Tiruppur…".
        null, c.city, c.state, c.code, c.model === 'retainer' ? 15 : 30,
        JSON.stringify([c.model]), null, ts, ts],
    );
    run('UPDATE clients SET client_account_id = ? WHERE id = ?', [id, clientId]);
    n++;
  }
  return n;
}

/** One client with its primary contact and activity history. */
function insertClient(ctx, c) {
  const { tenantId, stages, users, sl, reasons } = ctx;
  const id = uuid();
  const createdAt = addDays(new Date(), c.onboarded ? c.onboarded - 30 : -(20 + Math.floor(Math.random() * 60))).toISOString();

  run(
    `INSERT INTO clients (id, tenant_id, name, legal_name, industry, stage_id, status, owner_id, source,
       gstin, city, state, state_code, country, currency, service_lines, engagement_model, mrr_minor,
       deal_value_minor, next_action, next_action_date, next_action_owner_id, scope_total, scope_delivered,
       satisfaction, onboarded_at, renewal_date, churned_at, churn_reason_code_id, stage_entered_at,
       last_activity_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'India', 'INR', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, c.name, c.name, c.industry, stages[c.stage], c.status, users[c.owner],
      pick(['referral', 'inbound', 'outreach', 'linkedin', 'event'], c.name.length),
      c.gstin ?? null, c.city, c.state, c.code, JSON.stringify((c.sls || []).map((s) => sl[s])),
      c.model || 'project', rupees(c.mrr || 0), rupees(c.deal || (c.mrr ? c.mrr * 12 : 0)),
      c.next ?? null, c.nextIn != null ? addDays(new Date(), c.nextIn).toISOString().slice(0, 10) : null,
      c.next ? users[c.owner] : null,
      c.scope?.[0] || 0, c.scope?.[1] || 0, c.sat ?? null,
      c.onboarded ? addDays(new Date(), c.onboarded).toISOString() : null,
      c.renewal ? addDays(new Date(), c.renewal).toISOString().slice(0, 10) : null,
      c.churnedDaysAgo ? addDays(new Date(), -c.churnedDaysAgo).toISOString() : null,
      c.churnReason ? reasons[c.churnReason] : null,
      addDays(new Date(), -(5 + Math.floor(Math.random() * 40))).toISOString(),
      addDays(new Date(), -Math.floor(Math.random() * 12)).toISOString(),
      createdAt, ts],
  );

  // Primary contact
  const first = c.name.split(/[\s&]/)[0];
  run(
    `INSERT INTO contacts (id, tenant_id, client_id, name, designation, email, phone, whatsapp,
       is_primary, consent_whatsapp, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,1,?,?)`,
    [uuid(), tenantId, id,
      pick(['Ravi Shankar', 'Lakshmi Narayan', 'Suresh Babu', 'Anitha Raj', 'Mohan Das', 'Deepa Krishnan'], c.name.length),
      pick(['Director', 'Managing Partner', 'Marketing Head', 'Founder', 'CEO'], c.industry.length),
      `contact@${first.toLowerCase()}.com`, '+919440000000', '+919440000000', ts, ts],
  );

  // Activity history so conversion / retention scores have real inputs.
  const activityCount = c.status === 'active' ? 12 : 6;
  for (let i = 0; i < activityCount; i++) {
    const daysAgo = Math.floor((i + 1) * (c.status === 'active' ? 5 : 4)) + Math.floor(Math.random() * 3);
    run(
      `INSERT INTO activities (id, tenant_id, client_id, type, direction, subject, body, outcome,
         occurred_at, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, id,
        pick(['call', 'whatsapp', 'email', 'meeting', 'note'], i),
        i % 3 === 0 ? 'inbound' : 'outbound',
        pick(['Check-in call', 'Shared monthly report', 'Campaign review', 'Requirement discussion', 'Invoice follow-up'], i),
        'Logged from the seed dataset.',
        pick(['connected', 'positive', 'no_response', 'connected', 'positive'], i + c.name.length),
        addDays(new Date(), -daysAgo).toISOString(), users[c.owner], ts],
    );
  }

  // One grievance on the account that should read as at-risk.
  if (c.name === 'Aroma Kitchens & Catering') {
    run(
      `INSERT INTO activities (id, tenant_id, client_id, type, direction, subject, body, outcome,
         occurred_at, user_id, created_at) VALUES (?,?,?, 'grievance', 'inbound', ?, ?, 'negative', ?, ?, ?)`,
      [uuid(), tenantId, id, 'Delay in monthly creative delivery',
        'Client raised that the July creatives landed six days late.',
        addDays(new Date(), -18).toISOString(), users['divya@phoenixxit.com'], ts],
    );
    run(
      `UPDATE clients SET retention_risk = 1, retention_reason_code_id = ?, retention_reason_note = ?
        WHERE id = ?`,
      [reasons.RESULTS_BELOW, 'Creative turnaround slipped twice; engagement is down.', id],
    );
  }
  return id;
}

/**
 * Fill in whatever the pipeline is missing on a database that was seeded
 * before this list grew. Matching is by name, so running it twice adds
 * nothing the second time and no existing card is touched.
 */
function topUpClients() {
  const tenant = get("SELECT id FROM tenants WHERE slug = 'phoenixx-it'");
  if (!tenant) return 0;
  const ctx = lookups(tenant.id);
  let added = 0;
  for (const c of CLIENTS) {
    if (get('SELECT id FROM clients WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL',
      [tenant.id, c.name])) continue;
    insertClient(ctx, c);
    added += 1;
  }
  if (added) scoreAllClients(tenant.id, { snapshot: true });
  return added;
}

// ================================================================= TENANT #1
function seedPhoenixx() {
  if (get("SELECT id FROM tenants WHERE slug = 'phoenixx-it'")) {
    // Already seeded: leave everything alone except the pipeline, which is
    // topped up so a database created before this list grew still shows a
    // full board. `--reset` is still the way to rebuild from scratch.
    const added = topUpClients();
    console.log(added
      ? `· Phoenixx IT already seeded — added ${added} missing pipeline cards`
      : '· Phoenixx IT already seeded (use --reset to rebuild)');
    return;
  }

  const { tenantId, ownerId } = provisionTenant({
    agencyName: 'Phoenixx IT',
    ownerName: 'Arun Prakash',
    ownerEmail: 'arun@phoenixxit.com',
    password: 'Phoenixx@2026',
    phone: '+919876543210',
    city: 'Coimbatore',
    planCode: 'growth',
    slug: 'phoenixx-it',
  });

  run(
    `UPDATE tenants SET legal_name = 'Phoenixx IT Solutions', gstin = '33AAKCP1234R1Z5',
       pan = 'AAKCP1234R', state_code = '33', address = 'RS Puram, Coimbatore, Tamil Nadu 641002',
       website = 'https://phoenixxit.com', invoice_prefix = 'PHX',
       invoice_scheme = '{prefix}/{fy}/{seq:4}', proposal_prefix = 'PHXP',
       brand_primary = '#1E40AF', brand_accent = '#F59E0B', settings = ?
     WHERE id = ?`,
    [JSON.stringify({
      icp: {
        industries: ['construction', 'hospitality', 'textiles', 'ecommerce', 'hvac', 'financial advisory'],
        target_deal_value_minor: rupees(150_000),
      },
      support_access_enabled: true,
      escalation_matrix: { grievance_hours: 4, deadline_days: 3 },
    }), tenantId],
  );

  // The trial is converted so the workspace behaves like a paying tenant.
  run(
    `UPDATE subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?
      WHERE tenant_id = ?`,
    [ts, addMonths(new Date(), 1).toISOString(), tenantId],
  );

  const sl = Object.fromEntries(
    all('SELECT id, code FROM service_lines WHERE tenant_id = ?', [tenantId]).map((s) => [s.code, s.id]),
  );
  const stages = Object.fromEntries(
    all('SELECT id, code FROM pipeline_stages WHERE tenant_id = ?', [tenantId]).map((s) => [s.code, s.id]),
  );
  const cats = Object.fromEntries(
    all('SELECT id, code FROM action_categories WHERE tenant_id = ?', [tenantId]).map((c) => [c.code, c.id]),
  );
  const reasons = Object.fromEntries(
    all('SELECT id, code FROM reason_codes WHERE tenant_id = ?', [tenantId]).map((r) => [r.code, r.id]),
  );

  // ------------------------------------------------------------------ team
  const team = [
    { name: 'Divya Ramesh', email: 'divya@phoenixxit.com', role: 'manager', designation: 'Delivery Manager', sl: 'digital', cost: 95_000 },
    { name: 'Karthik Subramanian', email: 'karthik@phoenixxit.com', role: 'manager', designation: 'Brand Lead', sl: 'branding', cost: 88_000 },
    { name: 'Meera Nair', email: 'meera@phoenixxit.com', role: 'finance', designation: 'Finance Manager', sl: null, cost: 72_000 },
    { name: 'Sanjay Kumar', email: 'sanjay@phoenixxit.com', role: 'hr', designation: 'HR & Operations', sl: null, cost: 58_000 },
    { name: 'Priya Venkatesh', email: 'priya@phoenixxit.com', role: 'employee', designation: 'Performance Marketer', sl: 'digital', cost: 55_000, mgr: 'divya@phoenixxit.com' },
    { name: 'Rahul Menon', email: 'rahul@phoenixxit.com', role: 'employee', designation: 'Senior Designer', sl: 'branding', cost: 52_000, mgr: 'karthik@phoenixxit.com' },
    { name: 'Aishwarya Iyer', email: 'aishwarya@phoenixxit.com', role: 'employee', designation: 'Content Strategist', sl: 'digital', cost: 46_000, mgr: 'divya@phoenixxit.com' },
    { name: 'Vignesh Balan', email: 'vignesh@phoenixxit.com', role: 'employee', designation: 'Full-stack Developer', sl: 'tech', cost: 78_000, mgr: 'divya@phoenixxit.com' },
    { name: 'Nithya Krishnan', email: 'nithya@phoenixxit.com', role: 'employee', designation: 'Sales Consultant', sl: 'sales', cost: 62_000, mgr: 'karthik@phoenixxit.com' },
    { name: 'Sundar Rajan', email: 'sundar@phoenixxit.com', role: 'employee', designation: 'Account Executive', sl: 'sales', cost: 42_000, mgr: 'karthik@phoenixxit.com' },
  ];

  const users = { 'arun@phoenixxit.com': ownerId };
  for (const t of team) {
    const id = uuid();
    users[t.email] = id;
    run(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, phone, whatsapp, role, designation,
         service_line_id, employment_type, date_of_joining, monthly_cost_minor, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'full_time', ?, ?, 'active', ?, ?)`,
      [id, tenantId, t.email, bcrypt.hashSync('Phoenixx@2026', 10), t.name,
        `+9198${String(40000000 + Math.floor(Math.random() * 9999999))}`,
        `+9198${String(40000000 + Math.floor(Math.random() * 9999999))}`,
        t.role, t.designation, t.sl ? sl[t.sl] : null,
        addDays(new Date(), -(200 + Math.floor(Math.random() * 600))).toISOString().slice(0, 10),
        rupees(t.cost), ts, ts],
    );
  }
  for (const t of team.filter((x) => x.mgr)) {
    run('UPDATE users SET manager_id = ? WHERE id = ?', [users[t.mgr], users[t.email]]);
  }
  // Managers report to the owner.
  run(`UPDATE users SET manager_id = ? WHERE tenant_id = ? AND role IN ('manager','finance','hr')`,
    [ownerId, tenantId]);

  const staff = Object.values(users);
  console.log(`✓ Phoenixx IT: ${staff.length} team members`);

  // --------------------------------------------------------------- clients
  const clientIds = {};
  const ctx = { tenantId, stages, users, sl, reasons };
  for (const c of CLIENTS) clientIds[c.name] = insertClient(ctx, c);
  console.log(`✓ ${CLIENTS.length} clients with contacts and activity history`);

  const accounts = seedClientAccounts(ctx, clientIds);
  console.log(`✓ ${accounts} client accounts on the register, linked to their pipeline records`);

  // -------------------------------------------------------------- projects
  const projects = [
    { client: 'Cotton India Textiles', name: 'Brand refresh & always-on marketing', sl: 'branding', model: 'retainer', budget: 1_020_000, scope: [24, 19] },
    { client: 'Sree Balaji Constructions', name: 'Lead-gen engine + project microsite', sl: 'digital', model: 'hybrid', budget: 780_000, scope: [18, 16] },
    { client: 'ThermaCool HVAC Systems', name: 'Service automation platform', sl: 'tech', model: 'project', budget: 480_000, scope: [20, 11] },
    { client: 'Weave & Co. Ecommerce', name: 'D2C growth programme', sl: 'digital', model: 'hybrid', budget: 660_000, scope: [16, 9] },
    { client: 'Meridian Financial Advisory', name: 'Sales process rebuild', sl: 'sales', model: 'retainer', budget: 864_000, scope: [15, 14] },
    { client: 'Kongu Steel Traders', name: 'Identity & collateral system', sl: 'branding', model: 'project', budget: 320_000, scope: [10, 10] },
  ];
  // Each project carries a delivery team: one accountable manager, one lead who
  // runs it day to day, then seniors and the rest of the crew (Module F).
  const teams = {
    'Cotton India Textiles': [
      ['karthik@phoenixxit.com', 'manager', 'Client relationship, scope and budget', 25],
      ['rahul@phoenixxit.com', 'lead', 'Creative direction and weekly delivery', 45],
      ['priya@phoenixxit.com', 'senior', 'Always-on performance campaigns', 35],
      ['aishwarya@phoenixxit.com', 'member', 'Content calendar and copy', 30],
      ['sundar@phoenixxit.com', 'observer', 'Account updates', 0],
    ],
    'Sree Balaji Constructions': [
      ['divya@phoenixxit.com', 'manager', 'Delivery governance and escalations', 20],
      ['priya@phoenixxit.com', 'lead', 'Lead-gen funnel and media budget', 40],
      ['vignesh@phoenixxit.com', 'senior', 'Microsite build and tracking', 30],
      ['aishwarya@phoenixxit.com', 'member', 'Landing page copy', 15],
    ],
    'ThermaCool HVAC Systems': [
      ['divya@phoenixxit.com', 'manager', 'Scope, timeline and client sign-off', 20],
      ['vignesh@phoenixxit.com', 'lead', 'Platform architecture and releases', 55],
      ['rahul@phoenixxit.com', 'senior', 'Product UI and design system', 20],
      ['sanjay@phoenixxit.com', 'reviewer', 'UAT sign-off with the client team', 10],
    ],
    'Weave & Co. Ecommerce': [
      ['divya@phoenixxit.com', 'manager', 'Growth targets and reporting', 15],
      ['aishwarya@phoenixxit.com', 'lead', 'Campaign narrative and calendar', 40],
      ['priya@phoenixxit.com', 'senior', 'Paid media and CRO experiments', 25],
    ],
    'Meridian Financial Advisory': [
      ['karthik@phoenixxit.com', 'manager', 'Programme ownership', 20],
      ['nithya@phoenixxit.com', 'lead', 'Sales process design and enablement', 45],
      ['sundar@phoenixxit.com', 'junior', 'CRM hygiene and call logging', 30],
    ],
    'Kongu Steel Traders': [
      ['karthik@phoenixxit.com', 'manager', 'Brand direction and approvals', 15],
      ['rahul@phoenixxit.com', 'lead', 'Identity system and collateral', 35],
    ],
  };

  const projectIds = {};
  let memberCount = 0;
  for (const p of projects) {
    const id = uuid();
    projectIds[p.client] = id;
    const team = teams[p.client] || [];
    const seatHolder = (seat) => team.find((m) => m[1] === seat)?.[0];
    const startDate = addDays(new Date(), -120).toISOString().slice(0, 10);

    run(
      `INSERT INTO projects (id, tenant_id, client_id, name, service_line_id, model, status,
         start_date, budget_minor, manager_id, lead_id, scope_total, scope_delivered, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, clientIds[p.client], p.name, sl[p.sl], p.model, startDate, rupees(p.budget),
        users[seatHolder('manager')] ?? users['divya@phoenixxit.com'],
        users[seatHolder('lead')] ?? null,
        p.scope[0], p.scope[1], ts, ts],
    );

    for (const [email, seat, responsibility, allocation] of team) {
      run(
        `INSERT INTO project_members (id, tenant_id, project_id, user_id, seat, responsibility,
           allocation_pct, billable, start_date, added_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), tenantId, id, users[email], seat, responsibility, allocation,
          seat === 'observer' ? 0 : 1, startDate, ownerId, ts, ts],
      );
      memberCount += 1;
    }
  }
  console.log(`✓ ${projects.length} projects staffed with ${memberCount} team assignments`);

  // ---------------------------------------------------------- action items
  const items = [
    { title: 'Publish August performance report for Cotton India', client: 'Cotton India Textiles', owner: 'priya@phoenixxit.com', cat: 'delivery', pri: 'high', due: 1 },
    { title: 'Creative refresh - Aroma Kitchens festive campaign', client: 'Aroma Kitchens & Catering', owner: 'rahul@phoenixxit.com', cat: 'delivery', pri: 'urgent', due: -4 },
    { title: 'Resolve delivery-delay grievance with Aroma Kitchens', client: 'Aroma Kitchens & Catering', owner: 'divya@phoenixxit.com', cat: 'grievance', pri: 'urgent', due: -2 },
    { title: 'Send automation proposal to Vertex Precision', client: 'Vertex Precision Tools', owner: 'vignesh@phoenixxit.com', cat: 'outreach_pitch', pri: 'high', due: 0 },
    { title: 'Follow up: Kadambari Silks branding case studies', client: 'Kadambari Silks', owner: 'sundar@phoenixxit.com', cat: 'follow_up', pri: 'medium', due: 1 },
    { title: 'Southern Spice pitch deck walkthrough', client: 'Southern Spice Restaurants', owner: 'sundar@phoenixxit.com', cat: 'outreach_pitch', pri: 'high', due: -1 },
    { title: 'ThermaCool UAT round 2 with client team', client: 'ThermaCool HVAC Systems', owner: 'vignesh@phoenixxit.com', cat: 'delivery', pri: 'high', due: 3 },
    { title: 'Nilgiri Estate onboarding kickoff call', client: 'Nilgiri Estate Resorts', owner: 'karthik@phoenixxit.com', cat: 'delivery', pri: 'medium', due: 2 },
    { title: 'Weave & Co. Q3 catalogue shoot planning', client: 'Weave & Co. Ecommerce', owner: 'aishwarya@phoenixxit.com', cat: 'delivery', pri: 'medium', due: 5 },
    { title: 'Chase payment on PHX invoice - Kongu Steel', client: 'Kongu Steel Traders', owner: 'meera@phoenixxit.com', cat: 'follow_up', pri: 'high', due: -6 },
    { title: 'Meridian monthly sales review', client: 'Meridian Financial Advisory', owner: 'nithya@phoenixxit.com', cat: 'delivery', pri: 'medium', due: 4, recurrence: 'monthly' },
    { title: 'Update the SOP for outreach after the new script test', owner: 'karthik@phoenixxit.com', cat: 'internal', pri: 'low', due: 8 },
    { title: 'Quarterly tooling cost review', owner: 'meera@phoenixxit.com', cat: 'internal', pri: 'low', due: 12 },
    { title: 'Interview shortlist for Performance Marketer role', owner: 'sanjay@phoenixxit.com', cat: 'internal', pri: 'medium', due: 2 },
    { title: 'Sree Balaji microsite content sign-off', client: 'Sree Balaji Constructions', owner: 'aishwarya@phoenixxit.com', cat: 'delivery', pri: 'medium', due: 6 },
    { title: 'GreenBuild Infra discovery call', client: 'GreenBuild Infra', owner: 'nithya@phoenixxit.com', cat: 'follow_up', pri: 'medium', due: 0 },
  ];

  for (const it of items) {
    const id = uuid();
    const dueDate = addDays(new Date(), it.due).toISOString().slice(0, 10);
    run(
      `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
         project_id, category_id, priority, status, due_date, recurrence, source_type,
         estimate_minutes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?,?, 'manual', ?, ?, ?)`,
      [id, tenantId, it.title, null, users[it.owner], ownerId,
        it.client ? clientIds[it.client] : null,
        it.client ? projectIds[it.client] ?? null : null,
        cats[it.cat], it.pri, dueDate, it.recurrence ?? null,
        60 * (2 + Math.floor(Math.random() * 6)),
        addDays(new Date(), -(3 + Math.floor(Math.random() * 20))).toISOString(), ts],
    );
    const owner = get('SELECT manager_id FROM users WHERE id = ?', [users[it.owner]]);
    upsertDeadline({
      tenantId, sourceType: 'action_item', sourceId: id, title: it.title, dueAt: dueDate,
      ownerId: users[it.owner], escalateToId: owner?.manager_id,
      escalationDays: get('SELECT escalation_days FROM action_categories WHERE id = ?', [cats[it.cat]])?.escalation_days ?? 3,
      meta: { priority: it.pri, client: it.client },
    });
  }

  // Delivery history so completion rates, performance reviews and utilisation
  // are computed from real rows rather than invented numbers. Items are sized
  // like actual agency deliverables (half a day to a week), which is what makes
  // the utilisation figure on the dashboard mean anything.
  const DELIVERABLES = [
    ['Monthly performance report', 'digital', 480],
    ['Campaign creative batch', 'branding', 1_800],
    ['Ad account optimisation sprint', 'digital', 1_200],
    ['Content calendar & production', 'digital', 1_500],
    ['Landing page build', 'tech', 2_400],
    ['SEO technical fixes', 'tech', 900],
    ['Brand collateral set', 'branding', 1_800],
    ['Sales playbook section', 'sales', 1_200],
    ['CRM hygiene & pipeline review', 'sales', 600],
    ['Client review deck', 'digital', 480],
    ['Automation workflow build', 'tech', 2_100],
    ['Photoshoot planning & direction', 'branding', 1_500],
  ];

  const activeClients = CLIENTS.filter((c) => c.status === 'active');
  const deliveryTeam = team.filter((t) => ['employee', 'manager'].includes(t.role));
  let historyCount = 0;

  for (let monthsAgo = 2; monthsAgo >= 0; monthsAgo--) {
    const monthStart = addMonths(new Date(), -monthsAgo);
    const perMonth = 42;

    for (let i = 0; i < perMonth; i++) {
      const owner = pick(deliveryTeam, i + monthsAgo * 7);
      const [title, slCode, estimate] = pick(DELIVERABLES, i + monthsAgo * 3);
      const client = pick(activeClients, i + monthsAgo * 5);

      // Spread due dates across the month; the current month only runs to today.
      const dayOfMonth = 1 + Math.floor((i / perMonth) * (monthsAgo === 0 ? new Date().getUTCDate() : 28));
      const due = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), dayOfMonth));
      const dueIso = due.toISOString().slice(0, 10);
      if (dueIso > todayIso()) continue;

      // Completion improves with age: older months are settled, the current one
      // is still in flight, which is what produces a real month-on-month trend.
      const completionOdds = monthsAgo === 2 ? 0.94 : monthsAgo === 1 ? 0.88 : 0.55;
      const done = Math.random() < completionOdds;
      const lateBy = Math.random() > 0.78 ? 2 : -1;   // most land on or before the due date

      run(
        `INSERT INTO action_items (id, tenant_id, title, owner_id, created_by, client_id, project_id,
           category_id, priority, status, due_date, completed_at, source_type, estimate_minutes,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'manual', ?, ?, ?)`,
        [uuid(), tenantId, `${title} - ${client.name.split(' ')[0]}`,
          users[owner.email], ownerId, clientIds[client.name], projectIds[client.name] ?? null,
          cats.delivery, pick(['low', 'medium', 'high'], i),
          done ? 'done' : (monthsAgo === 0 ? 'in_progress' : 'open'),
          dueIso,
          done ? addDays(dueIso, lateBy).toISOString() : null,
          estimate,
          addDays(dueIso, -12).toISOString(), ts],
      );
      historyCount++;
    }
  }
  console.log(`✓ ${items.length} live action items + ${historyCount} delivery history`);

  // -------------------------------------------------------------- meetings
  for (let i = 0; i < 6; i++) {
    const meetingId = uuid();
    const client = pick(CLIENTS.filter((c) => c.status === 'active'), i);
    const when = addDays(new Date(), i < 3 ? -(2 + i * 3) : (1 + i)).toISOString();
    run(
      `INSERT INTO meetings (id, tenant_id, title, agenda, client_id, organizer_id, scheduled_at,
         duration_minutes, location, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [meetingId, tenantId, `${client.name} - monthly review`,
        'Performance recap, blockers, next month plan, commercial updates.',
        clientIds[client.name], users[client.owner], when, 45,
        i % 2 ? 'Google Meet' : 'Client office', i < 3 ? 'completed' : 'scheduled', ts, ts],
    );
    if (i < 3) {
      const points = [
        { kind: 'decision', text: 'Approved the festive campaign creative direction.' },
        { kind: 'action', text: 'Share the revised media plan by Friday.' },
        { kind: 'risk', text: 'Client budget approval may slip to next month.' },
      ];
      points.forEach((p, j) => {
        run(
          `INSERT INTO mom_points (id, tenant_id, meeting_id, kind, text, owner_id, due_date, sort, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [uuid(), tenantId, meetingId, p.kind, p.text, users[client.owner],
            p.kind === 'action' ? addDays(new Date(), 3).toISOString().slice(0, 10) : null, j, ts, ts],
        );
      });
    }
  }

  // -------------------------------------------------------------- proposals
  const templates = all('SELECT * FROM proposal_templates WHERE tenant_id = ?', [tenantId]);
  const proposalSpecs = [
    { client: 'Vertex Precision Tools', title: 'Service automation platform', tpl: 3, status: 'sent', views: 3 },
    { client: 'Kadambari Silks', title: 'Brand identity & digital launch', tpl: 0, status: 'viewed', views: 5 },
    { client: 'Nilgiri Estate Resorts', title: 'Resort brand & always-on marketing', tpl: 1, status: 'accepted', views: 7 },
    { client: 'Southern Spice Restaurants', title: 'Multi-outlet performance marketing', tpl: 1, status: 'draft', views: 0 },
  ];

  const tenant = get('SELECT * FROM tenants WHERE id = ?', [tenantId]);

  for (const spec of proposalSpecs) {
    const tpl = templates[spec.tpl];
    const propId = uuid();
    const items2 = JSON.parse(tpl.default_items);
    const subtotal = items2.reduce((a, it) => a + Math.round((it.qty ?? 1) * it.rate_minor), 0);
    const tax = Math.round(subtotal * 0.18);

    tx(() => {
      const { number } = allocateNumber({ tenantId, docType: 'proposal', tenant });
      run(
        `INSERT INTO proposals (id, tenant_id, client_id, number, title, service_line_id, template_id,
           owner_id, status, currency, sections, terms, subtotal_minor, tax_rate, tax_minor, total_minor,
           valid_until, share_token, sent_at, first_viewed_at, last_viewed_at, view_count, accepted_at,
           accepted_by_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'INR', ?,?,?,18,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [propId, tenantId, clientIds[spec.client], number, spec.title, tpl.service_line_id, tpl.id,
          users[CLIENTS.find((c) => c.name === spec.client).owner], spec.status,
          tpl.sections, tpl.terms, subtotal, tax, subtotal + tax,
          addDays(new Date(), 25).toISOString().slice(0, 10),
          uuid().replace(/-/g, '').slice(0, 22),
          spec.status !== 'draft' ? addDays(new Date(), -8).toISOString() : null,
          spec.views ? addDays(new Date(), -6).toISOString() : null,
          spec.views ? addDays(new Date(), -1).toISOString() : null,
          spec.views,
          spec.status === 'accepted' ? addDays(new Date(), -3).toISOString() : null,
          spec.status === 'accepted' ? 'Ramesh Gopal' : null, ts, ts],
      );
      items2.forEach((it, i) => {
        run(
          `INSERT INTO proposal_items (id, tenant_id, proposal_id, description, detail, qty, unit,
             rate_minor, amount_minor, sort) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [uuid(), tenantId, propId, it.description, it.detail ?? null, it.qty ?? 1, it.unit || 'nos',
            it.rate_minor, Math.round((it.qty ?? 1) * it.rate_minor), i],
        );
      });
    });
  }
  console.log(`✓ ${proposalSpecs.length} proposals`);

  // --------------------------------------------------------------- invoices
  const sac = { branding: '998391', digital: '998361', sales: '998311', tech: '998314' };
  // Retainers plus project milestones across three months. The values are sized
  // so the demo shows a working agency: roughly Rs 12-13 L billed against a
  // Rs 8 L cost base, i.e. a believable 30-35% gross margin rather than a loss.
  const RETAINERS = [
    { client: 'Cotton India Textiles', label: 'Monthly retainer - branding & digital', sl: 'digital', rate: 150_000 },
    { client: 'Sree Balaji Constructions', label: 'Lead-gen engine & content retainer', sl: 'digital', rate: 120_000 },
    { client: 'Aroma Kitchens & Catering', label: 'Social media & performance retainer', sl: 'digital', rate: 75_000 },
    { client: 'Meridian Financial Advisory', label: 'Sales consulting retainer', sl: 'sales', rate: 110_000, interstate: true },
    { client: 'Weave & Co. Ecommerce', label: 'D2C growth retainer', sl: 'digital', rate: 95_000 },
  ];

  // month offset -> extra project / milestone invoices for that month
  const MILESTONES = {
    2: [
      { client: 'ThermaCool HVAC Systems', items: [{ d: 'Service automation platform - discovery & design', sl: 'tech', rate: 220_000 }] },
      { client: 'Kongu Steel Traders', items: [{ d: 'Identity system - concepts & direction', sl: 'branding', rate: 175_000 }] },
      { client: 'Cotton India Textiles', items: [{ d: 'Festive campaign creative production', sl: 'branding', rate: 140_000 }] },
    ],
    1: [
      { client: 'ThermaCool HVAC Systems', items: [{ d: 'Service automation platform - build milestone', sl: 'tech', rate: 220_000 }] },
      { client: 'Kongu Steel Traders', items: [{ d: 'Identity system - final delivery & collateral', sl: 'branding', rate: 175_000 }] },
      { client: 'Weave & Co. Ecommerce', items: [{ d: 'Catalogue shoot & storefront optimisation', sl: 'tech', rate: 165_000 }] },
      { client: 'Sree Balaji Constructions', items: [{ d: 'Project microsite - milestone 2', sl: 'tech', rate: 130_000 }] },
    ],
    0: [
      { client: 'ThermaCool HVAC Systems', items: [{ d: 'Service automation platform - UAT & deployment', sl: 'tech', rate: 220_000 }], overdue: false },
      { client: 'Nilgiri Estate Resorts', items: [{ d: 'Brand foundation & onboarding sprint', sl: 'branding', rate: 180_000 }] },
      { client: 'Meridian Financial Advisory', items: [{ d: 'Playbook & enablement workshop', sl: 'sales', rate: 145_000 }], interstate: true },
    ],
  };

  // Payment behaviour by month: older months settle, the current one is still open.
  const invoiceSpecs = [];
  for (const monthsAgo of [2, 1, 0]) {
    for (const r of RETAINERS) {
      // Nilgiri only came on board this month; Kongu is a project, not a retainer.
      const paid = monthsAgo === 2 ? 'full'
        : monthsAgo === 1 ? (r.client === 'Aroma Kitchens & Catering' ? 'partial' : 'full')
          : (r.client === 'Weave & Co. Ecommerce' ? 'partial' : 'none');
      invoiceSpecs.push({
        client: r.client,
        monthsAgo,
        items: [{ d: r.label, sl: r.sl, rate: r.rate }],
        paid,
        interstate: r.interstate,
        // The Aroma invoice is deliberately left to age so the reminder ladder,
        // escalation and receivables ageing all have something real to show.
        overdue: monthsAgo === 0 && r.client === 'Aroma Kitchens & Catering',
      });
    }
    for (const m of MILESTONES[monthsAgo] || []) {
      invoiceSpecs.push({
        ...m,
        monthsAgo,
        paid: monthsAgo === 0 ? 'none' : 'full',
        overdue: monthsAgo === 0 && m.client === 'Nilgiri Estate Resorts' ? false : m.overdue,
      });
    }
  }
  invoiceSpecs.push({
    client: 'Kongu Steel Traders', monthsAgo: 0,
    items: [{ d: 'Collateral rollout - final invoice', sl: 'branding', rate: 165_000 }],
    paid: 'none', overdue: true,
  });

  for (const spec of invoiceSpecs) {
    const issue = spec.monthsAgo
      ? addMonths(new Date(), -spec.monthsAgo).toISOString().slice(0, 8) + '05'
      : addDays(new Date(), spec.overdue ? -35 : -6).toISOString().slice(0, 10);

    const invoice = tx(() => createInvoice(tenantId, {
      clientId: clientIds[spec.client],
      projectId: projectIds[spec.client] ?? null,
      issueDate: issue,
      paymentTermsDays: 15,
      items: spec.items.map((it) => ({
        description: it.d,
        hsn_sac: sac[it.sl],
        qty: 1,
        rate_minor: rupees(it.rate),
        gst_rate: 18,
        service_line_id: sl[it.sl],
      })),
      notes: 'Thank you for your business.',
      terms: 'Payment due within 15 days. Interest at 1.5% per month applies on overdue amounts.',
      createdBy: users['meera@phoenixxit.com'],
      status: 'sent',
    }));

    run("UPDATE invoices SET sent_at = ?, approved_by = ?, approved_at = ? WHERE id = ?",
      [issue, users['meera@phoenixxit.com'], issue, invoice.id]);

    if (spec.paid !== 'none') {
      const amount = spec.paid === 'full' ? invoice.total_minor : Math.round(invoice.total_minor * 0.5);
      // Payment terms are 15 days, but a payment must never be dated in the
      // future - that would inflate "collected this month" with money not yet in.
      const settled = addDays(issue, 8 + Math.floor(Math.random() * 12));
      const paidAt = (settled > new Date() ? addDays(new Date(), -1) : settled).toISOString();
      run(
        `INSERT INTO payments (id, tenant_id, invoice_id, client_id, amount_minor, paid_at, method,
           reference, recorded_by, created_at) VALUES (?,?,?,?,?,?, 'neft', ?, ?, ?)`,
        [uuid(), tenantId, invoice.id, clientIds[spec.client], amount, paidAt,
          `NEFT${Math.floor(Math.random() * 900000 + 100000)}`, users['meera@phoenixxit.com'], ts],
      );
      run(
        `UPDATE invoices SET paid_minor = ?, balance_minor = ?, status = ?, paid_at = ? WHERE id = ?`,
        [amount, invoice.total_minor - amount, spec.paid === 'full' ? 'paid' : 'partially_paid',
          spec.paid === 'full' ? paidAt : null, invoice.id],
      );
    } else if (spec.overdue) {
      run("UPDATE invoices SET status = 'overdue' WHERE id = ?", [invoice.id]);
    }
  }

  // F3 - a live retainer schedule.
  run(
    `INSERT INTO recurring_invoices (id, tenant_id, client_id, project_id, title, frequency,
       day_of_month, next_run_date, payment_terms_days, template, created_at, updated_at)
     VALUES (?,?,?,?, 'Cotton India monthly retainer', 'monthly', 5, ?, 15, ?, ?, ?)`,
    [uuid(), tenantId, clientIds['Cotton India Textiles'], projectIds['Cotton India Textiles'],
      addMonths(new Date(), 1).toISOString().slice(0, 8) + '05',
      JSON.stringify({
        items: [{ description: 'Monthly retainer - branding & digital', hsn_sac: '998361', qty: 1, rate_minor: rupees(150_000), gst_rate: 18, service_line_id: sl.digital }],
        notes: 'Monthly retainer as per agreement.',
      }), ts, ts],
  );
  console.log(`✓ ${invoiceSpecs.length} invoices + 1 retainer schedule`);

  // ----------------------------------------------------------------- costs
  const months = [monthIso(addMonths(new Date(), -2)), monthIso(addMonths(new Date(), -1)), monthIso()];
  const overheads = [
    { cat: 'rent', label: 'Office rent - RS Puram', amount: 65_000 },
    { cat: 'tools', label: 'Google Workspace + Adobe CC', amount: 28_000 },
    { cat: 'tools', label: 'Ad management & analytics tools', amount: 18_000 },
    { cat: 'maintenance', label: 'Internet, electricity & housekeeping', amount: 22_000 },
    { cat: 'marketing', label: 'Own brand marketing', amount: 35_000 },
    { cat: 'misc', label: 'Travel & client entertainment', amount: 14_000 },
  ];
  for (const month of months) {
    for (const o of overheads) {
      run(
        `INSERT INTO costs (id, tenant_id, category, label, amount_minor, period_month, recurring,
           recorded_by, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)`,
        [uuid(), tenantId, o.cat, o.label,
          rupees(o.amount + Math.floor(Math.random() * 4000 - 2000)), month,
          users['meera@phoenixxit.com'], ts, ts],
      );
    }
    syncHrCosts(tenantId, month);
  }
  console.log(`✓ costs for ${months.length} months (overheads + HR from salary bands)`);

  // ------------------------------------------------------------ attendance
  const staffIds = all("SELECT id FROM users WHERE tenant_id = ? AND role != 'client' AND deleted_at IS NULL", [tenantId]);
  for (let d = 45; d >= 0; d--) {
    const date = addDays(new Date(), -d);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const iso = date.toISOString().slice(0, 10);
    for (const u of staffIds) {
      const roll = Math.random();
      if (roll < 0.05) continue;                       // absent
      const status = roll < 0.10 ? 'wfh' : roll < 0.13 ? 'half_day' : 'present';
      const inAt = new Date(`${iso}T0${3 + Math.floor(Math.random() * 2)}:${String(Math.floor(Math.random() * 59)).padStart(2, '0')}:00Z`);
      const minutes = status === 'half_day' ? 210 : 460 + Math.floor(Math.random() * 90);
      run(
        `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, check_out_at, source,
           status, work_minutes, late_minutes, created_at, updated_at)
         VALUES (?,?,?,?,?,?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, user_id, work_date) DO NOTHING`,
        [uuid(), tenantId, u.id, iso, inAt.toISOString(),
          new Date(inAt.getTime() + minutes * 60_000).toISOString(),
          Math.random() > 0.7 ? 'mobile' : 'web', status, minutes,
          Math.max(0, Math.round((inAt - new Date(`${iso}T04:00:00Z`)) / 60_000)), ts, ts],
      );
    }
  }

  // Leave requests
  const leaveTypes = all('SELECT * FROM leave_types WHERE tenant_id = ?', [tenantId]);
  const leaves = [
    { user: 'rahul@phoenixxit.com', type: 'CL', from: 4, days: 2, status: 'pending', reason: 'Family function in Madurai' },
    { user: 'aishwarya@phoenixxit.com', type: 'SL', from: -6, days: 1, status: 'approved', reason: 'Fever' },
    { user: 'sundar@phoenixxit.com', type: 'CL', from: 9, days: 3, status: 'pending', reason: 'Personal travel' },
    { user: 'priya@phoenixxit.com', type: 'EL', from: -20, days: 4, status: 'approved', reason: 'Annual vacation' },
  ];
  for (const l of leaves) {
    const type = leaveTypes.find((t) => t.code === l.type);
    const from = addDays(new Date(), l.from).toISOString().slice(0, 10);
    run(
      `INSERT INTO leave_requests (id, tenant_id, user_id, leave_type_id, from_date, to_date, days,
         reason, status, approver_id, decided_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, users[l.user], type.id, from,
        addDays(from, l.days - 1).toISOString().slice(0, 10), l.days, l.reason, l.status,
        get('SELECT manager_id FROM users WHERE id = ?', [users[l.user]])?.manager_id ?? ownerId,
        l.status !== 'pending' ? ts : null,
        addDays(new Date(), l.from - 3).toISOString(), ts],
    );
  }
  console.log('✓ 45 days of attendance + 4 leave requests');

  // -------------------------------------------------------------- SOP runs
  const sops = all("SELECT * FROM sops WHERE tenant_id = ? AND status = 'published'", [tenantId]);
  for (let i = 0; i < 22; i++) {
    const sop = pick(sops, i);
    const version = get('SELECT * FROM sop_versions WHERE sop_id = ? AND version = ?', [sop.id, sop.current_version]);
    const checklist = JSON.parse(version.checklist);
    const completedCount = Math.random() > 0.28 ? checklist.length : Math.max(1, checklist.length - 1 - Math.floor(Math.random() * 2));
    const state = Object.fromEntries(checklist.map((c, j) => [c.id, j < completedCount]));
    const started = addDays(new Date(), -(1 + Math.floor(Math.random() * 28))).toISOString();

    run(
      `INSERT INTO sop_runs (id, tenant_id, sop_id, version, entity, entity_id, user_id, checklist_state,
         total_items, completed_items, adherence_pct, started_at, completed_at, created_at, updated_at)
       VALUES (?,?,?,?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), tenantId, sop.id, sop.current_version,
        clientIds[pick(CLIENTS.filter((c) => c.status === 'active'), i).name],
        users[pick(team, i).email], JSON.stringify(state), checklist.length, completedCount,
        Math.round((completedCount / checklist.length) * 1000) / 10, started,
        completedCount === checklist.length ? started : null, ts, ts],
    );
  }

  // SOP acknowledgements - deliberately incomplete so the coverage report has signal.
  for (const sop of sops) {
    for (const u of staffIds) {
      if (Math.random() < 0.72) {
        run(
          `INSERT INTO sop_acknowledgements (id, tenant_id, sop_id, version, user_id, acknowledged_at)
           VALUES (?,?,?,?,?,?) ON CONFLICT (sop_id, version, user_id) DO NOTHING`,
          [uuid(), tenantId, sop.id, sop.current_version, u.id,
            addDays(new Date(), -Math.floor(Math.random() * 30)).toISOString()],
        );
      }
    }
  }
  console.log(`✓ ${sops.length} SOPs published, 22 runs, acknowledgements recorded`);

  // ---------------------------------------------------------------- hiring
  const openingId = uuid();
  run(
    `INSERT INTO job_openings (id, tenant_id, title, service_line_id, department, qualification, skills,
       experience_min_years, experience_max_years, headcount, salary_min_minor, salary_max_minor,
       location, status, hiring_manager_id, target_close_date, created_at, updated_at)
     VALUES (?,?, 'Performance Marketer', ?, 'Delivery', ?, ?, 2, 4, 2, ?, ?, 'Coimbatore', 'open', ?, ?, ?, ?)`,
    [openingId, tenantId, sl.digital,
      'Graduate in marketing or equivalent; Google Ads and Meta Blueprint certification preferred.',
      JSON.stringify(['Google Ads', 'Meta Ads', 'GA4', 'Looker Studio', 'Copywriting']),
      rupees(35_000), rupees(60_000), users['divya@phoenixxit.com'],
      addDays(new Date(), 30).toISOString().slice(0, 10), ts, ts],
  );
  const openingId2 = uuid();
  run(
    `INSERT INTO job_openings (id, tenant_id, title, service_line_id, department, qualification, skills,
       experience_min_years, headcount, salary_min_minor, salary_max_minor, location, status,
       hiring_manager_id, created_at, updated_at)
     VALUES (?,?, 'Full-stack Developer', ?, 'Tech', ?, ?, 3, 1, ?, ?, 'Coimbatore / Hybrid', 'open', ?, ?, ?)`,
    [openingId2, tenantId, sl.tech,
      'B.E./B.Tech in Computer Science or equivalent practical experience.',
      JSON.stringify(['Node.js', 'React', 'PostgreSQL', 'AWS']),
      rupees(60_000), rupees(95_000), users['vignesh@phoenixxit.com'], ts, ts],
  );

  const candidates = [
    { name: 'Harish Kumar', stage: 'interview', exp: 3, opening: openingId, rating: 4 },
    { name: 'Swetha Raghavan', stage: 'screened', exp: 2.5, opening: openingId, rating: 3 },
    { name: 'Manoj Pillai', stage: 'offer', exp: 4, opening: openingId, rating: 5 },
    { name: 'Divya Bhaskar', stage: 'sourced', exp: 2, opening: openingId },
    { name: 'Arjun Sethu', stage: 'interview', exp: 4, opening: openingId2, rating: 4 },
    { name: 'Praveen Anand', stage: 'sourced', exp: 3.5, opening: openingId2 },
    { name: 'Lakshmi Priya', stage: 'rejected', exp: 1, opening: openingId, rating: 2 },
  ];
  for (const c of candidates) {
    run(
      `INSERT INTO candidates (id, tenant_id, job_opening_id, name, email, phone, source,
         experience_years, current_ctc_minor, expected_ctc_minor, stage, rating, rejected_reason,
         stage_changed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'naukri', ?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, c.opening, c.name,
        `${c.name.split(' ')[0].toLowerCase()}@example.com`, '+919500000000', c.exp,
        rupees(c.exp * 12_000), rupees(c.exp * 16_000), c.stage, c.rating ?? null,
        c.stage === 'rejected' ? 'Experience below the required band' : null,
        addDays(new Date(), -Math.floor(Math.random() * 20)).toISOString(),
        addDays(new Date(), -(10 + Math.floor(Math.random() * 20))).toISOString(), ts],
    );
  }
  console.log(`✓ 2 open roles, ${candidates.length} candidates`);

  return tenantId;
}

// ================================================= TENANT #2 (isolation proof)
function seedSecondTenant() {
  if (get("SELECT id FROM tenants WHERE slug = 'northstar-media'")) return;

  const { tenantId, ownerId } = provisionTenant({
    agencyName: 'Northstar Media',
    ownerName: 'Rekha Sharma',
    ownerEmail: 'rekha@northstarmedia.in',
    password: 'Northstar@2026',
    city: 'Bengaluru',
    planCode: 'starter',
    slug: 'northstar-media',
  });

  const stage = get('SELECT id FROM pipeline_stages WHERE tenant_id = ? ORDER BY sort LIMIT 1', [tenantId]);
  for (const name of ['Lumen Interiors', 'Bytecraft Labs', 'Saffron Hospitality']) {
    run(
      `INSERT INTO clients (id, tenant_id, name, industry, stage_id, status, owner_id, city, state_code,
         service_lines, engagement_model, deal_value_minor, next_action, next_action_date,
         stage_entered_at, created_at, updated_at)
       VALUES (?,?,?, 'services', ?, 'lead', ?, 'Bengaluru', '29', '[]', 'project', ?, 'Initial discovery call', ?, ?, ?, ?)`,
      [uuid(), tenantId, name, stage.id, ownerId, rupees(200_000),
        addDays(new Date(), 3).toISOString().slice(0, 10), ts, ts, ts],
    );
  }
  console.log('✓ Northstar Media (tenant #2, proves isolation)  rekha@northstarmedia.in / Northstar@2026');
}

// ================================================================== RUN
console.log('\nSeeding Phoenixx OS\n' + '─'.repeat(52));
seedPlans();
seedSuperAdmin();
const phoenixxId = seedPhoenixx();
seedSecondTenant();

if (phoenixxId) {
  console.log('\nComputing derived data…');
  const scored = scoreAllClients(phoenixxId, { snapshot: true });

  // Backfill score history so the client trend charts have a shape.
  const clientsForHistory = all('SELECT id FROM clients WHERE tenant_id = ? AND deleted_at IS NULL', [phoenixxId]);
  for (let d = 30; d > 0; d -= 3) {
    for (const c of clientsForHistory) {
      const base = get('SELECT * FROM client_score_history WHERE client_id = ? ORDER BY snapshot_date DESC LIMIT 1', [c.id]);
      if (!base) continue;
      const jitter = (v) => Math.max(0, Math.min(100, Math.round((v + (Math.random() * 12 - 6)) * 10) / 10));
      run(
        `INSERT INTO client_score_history (id, tenant_id, client_id, snapshot_date, conversion, risk,
           relevancy, retention, health, breakdown, created_at)
         VALUES (?,?,?,?,?,?,?,?,?, '{}', ?)
         ON CONFLICT (tenant_id, client_id, snapshot_date) DO NOTHING`,
        [uuid(), phoenixxId, c.id, addDays(new Date(), -d).toISOString().slice(0, 10),
          jitter(base.conversion), jitter(base.risk), jitter(base.relevancy),
          jitter(base.retention), jitter(base.health), ts],
      );
    }
  }

  const flags = detectImprovementFlags(phoenixxId);
  snapshotMetrics(phoenixxId);
  generateDailyReport(phoenixxId);
  generateWeeklyReport(phoenixxId);
  generateMonthlyReport(phoenixxId, { month: monthIso(addMonths(new Date(), -1)) });
  for (const c of all("SELECT id FROM clients WHERE tenant_id = ? AND status = 'active' LIMIT 4", [phoenixxId])) {
    generateClientMonthlyReport(phoenixxId, c.id, { month: monthIso(addMonths(new Date(), -1)) });
  }
  console.log(`✓ scored ${scored} clients, ${flags} improvement flags, 7 reports generated`);

  // ------------------------------------------------------------------ chat
  // Every project team gets its room, then the company channel and a few of the
  // project rooms get some history so the chat screen is not empty on install.
  const staff = Object.fromEntries(
    all("SELECT id, email FROM users WHERE tenant_id = ? AND role != 'client'", [phoenixxId])
      .map((u) => [u.email, u.id]),
  );
  const owner = staff['arun@phoenixxit.com'];

  for (const p of all('SELECT id FROM projects WHERE tenant_id = ? AND deleted_at IS NULL', [phoenixxId])) {
    chat.syncProjectChannel(phoenixxId, p.id, { actorId: owner });
  }

  /** Writes one backdated message and moves the channel's clock with it. */
  const seedMessage = (channelId, authorEmail, body, daysAgo) => {
    const at = addDays(new Date(), -daysAgo).toISOString();
    run(
      `INSERT INTO messages (id, tenant_id, channel_id, author_id, kind, body, mentions, created_at)
       VALUES (?,?,?,?, 'text', ?, ?, ?)`,
      [uuid(), phoenixxId, channelId, staff[authorEmail], body,
        JSON.stringify(chat.resolveMentions(phoenixxId, channelId, body)), at],
    );
    run('UPDATE channels SET message_count = message_count + 1, updated_at = ? WHERE id = ?', [at, channelId]);
    run(`UPDATE channels SET last_message_at = ? WHERE id = ?
           AND (last_message_at IS NULL OR last_message_at < ?)`, [at, channelId, at]);
  };

  const broadcast = chat.ensureBroadcastChannel(phoenixxId, owner);
  const announcements = [
    ['arun@phoenixxit.com', 'Welcome to Phoenixx OS. Every project now has its own room here, and this channel is for anything the whole team needs to know.', 6],
    ['sanjay@phoenixxit.com', 'Payroll runs on the 1st. Please get August attendance regularisations in before Friday.', 3],
    ['arun@phoenixxit.com', 'We crossed 40 lakh in invoiced revenue this quarter. Thank you all - the detail is in the monthly report.', 1],
  ];
  for (const [email, body, daysAgo] of announcements) seedMessage(broadcast.id, email, body, daysAgo);

  let chatted = announcements.length;
  const roomChatter = {
    'Cotton India Textiles': [
      ['karthik@phoenixxit.com', 'Kicking off the festive campaign this week. Rahul, can you get the key visuals to me by Wednesday?', 4],
      ['rahul@phoenixxit.com', 'On it. First cut of the visuals by Tuesday evening so we have a day to iterate.', 4],
      ['priya@phoenixxit.com', 'Budget for the festive push is loaded. I will hold spend until the creatives land.', 3],
      ['aishwarya@phoenixxit.com', 'Copy deck is drafted - @Karthik Subramanian tagging you for a look before it goes to the client.', 2],
    ],
    'ThermaCool HVAC Systems': [
      ['vignesh@phoenixxit.com', 'UAT round 2 build is deployed. Known gap: the service-history export is still slow on large accounts.', 3],
      ['divya@phoenixxit.com', 'Noted. Let us tell the client up front rather than have them find it.', 3],
      ['sanjay@phoenixxit.com', 'I will sit in on the UAT call and take the sign-off notes.', 2],
    ],
    'Meridian Financial Advisory': [
      ['nithya@phoenixxit.com', 'New call script is live in the CRM. Sundar, use it from tomorrow and log what lands.', 2],
      ['sundar@phoenixxit.com', 'Will do. Twelve calls booked for this week already.', 1],
    ],
  };
  for (const [clientName, lines] of Object.entries(roomChatter)) {
    const room = get(
      `SELECT ch.id FROM channels ch
         JOIN projects p ON p.id = ch.project_id
         JOIN clients c ON c.id = p.client_id
        WHERE ch.tenant_id = ? AND c.name = ? LIMIT 1`,
      [phoenixxId, clientName],
    );
    if (!room) continue;
    for (const [email, body, daysAgo] of lines) {
      seedMessage(room.id, email, body, daysAgo);
      chatted += 1;
    }
  }
  console.log(`✓ ${chatted} chat messages across the company channel and the project rooms`);
}

/**
 * Account recovery needs a question on every demo account, or the "Forgot your
 * password?" flow has nothing to show. One shared question and answer, printed
 * below with the passwords - this is seed data for a workspace that is rebuilt
 * on every cold start, not a credential worth protecting.
 */
const DEMO_QUESTION = 'Which city were you in when you started your first job?';
const DEMO_ANSWER = 'Coimbatore';
{
  const answerHash = bcrypt.hashSync(DEMO_ANSWER.toLowerCase(), 10);
  const { changes } = run(
    `UPDATE users SET security_question = ?, security_answer_hash = ?, security_updated_at = ?
      WHERE security_answer_hash IS NULL AND deleted_at IS NULL`,
    [DEMO_QUESTION, answerHash, nowIso()],
  );
  console.log(`✓ security question set on ${changes} account${changes === 1 ? '' : 's'}`);
}

console.log('\n' + '─'.repeat(52));
console.log('Sign in at http://localhost:5173\n');
console.log('  Owner      arun@phoenixxit.com       Phoenixx@2026');
console.log('  Manager    divya@phoenixxit.com      Phoenixx@2026');
console.log('  Finance    meera@phoenixxit.com      Phoenixx@2026');
console.log('  HR         sanjay@phoenixxit.com     Phoenixx@2026');
console.log('  Employee   priya@phoenixxit.com      Phoenixx@2026');
console.log('  Platform   platform@phoenixxit.com   Platform@2026');
console.log('');
console.log('Forgot-password demo — every account answers the same question:');
console.log(`  "${DEMO_QUESTION}"`);
console.log(`  ${DEMO_ANSWER}`);
console.log('');
