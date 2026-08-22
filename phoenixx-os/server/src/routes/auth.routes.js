import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { get, run, all } from '../db/index.js';
import { uuid, nowIso, sha256, token, parseJson } from '../lib/util.js';
import { ok, created, validate, unauthorized, badRequest, forbidden, audit, ApiError } from '../lib/http.js';
import {
  signAccessToken, signRefreshToken, verifyRefreshToken, authenticate,
} from '../middleware/auth.js';
import { permissionMatrix } from '../middleware/rbac.js';
import { provisionTenant } from '../services/provisioning.js';
import { rateLimit } from '../middleware/common.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

const signupSchema = z.object({
  agency_name: z.string().min(2).max(120),
  owner_name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().optional(),
  city: z.string().optional(),
  plan_code: z.enum(['starter', 'growth', 'scale']).optional(),
});

function sessionPayload(user) {
  const tenant = user.tenant_id
    ? get('SELECT id, name, slug, timezone, currency, number_format, brand_primary, brand_accent, logo_url, invoice_prefix, invoice_scheme, fy_start_month, state_code, gstin, city, address, phone, email, settings FROM tenants WHERE id = ?', [user.tenant_id])
    : null;
  const subscription = user.tenant_id
    ? get(`SELECT s.status, s.billing_cycle, s.trial_ends_at, s.current_period_end, p.code AS plan_code,
                  p.name AS plan_name, p.features, p.limits, p.band_max_users
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`, [user.tenant_id])
    : null;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      designation: user.designation,
      avatar_url: user.avatar_url,
      phone: user.phone,
      manager_id: user.manager_id,
      service_line_id: user.service_line_id,
      client_id: user.client_id,
      twofa_enabled: !!user.twofa_enabled,
      notification_prefs: parseJson(user.notification_prefs, {}),
    },
    tenant: tenant ? { ...tenant, settings: parseJson(tenant.settings, {}) } : null,
    subscription: subscription
      ? {
        ...subscription,
        features: parseJson(subscription.features, {}),
        limits: parseJson(subscription.limits, {}),
      }
      : null,
    permissions: permissionMatrix({
      role: user.role,
      customRoleId: user.custom_role_id,
    }),
  };
}

function issueSession(res, user, req) {
  const jti = uuid();
  const refresh = signRefreshToken(user, jti);
  run(
    `INSERT INTO refresh_tokens (id, user_id, tenant_id, token_hash, expires_at, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [jti, user.id, user.tenant_id, sha256(refresh),
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
      req.headers['user-agent'] || null, nowIso()],
  );
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
  return { access_token: signAccessToken(user), refresh_token: refresh, ...sessionPayload(user) };
}

// ------------------------------------------------------------------- signup
// S7: tenant self-signup wizard, 14-day trial, no card.
router.post('/signup', rateLimit({ max: 10, windowMs: 60 * 60_000 }), (req, res) => {
  const body = validate(signupSchema, req.body);
  const { tenantId, ownerId } = provisionTenant({
    agencyName: body.agency_name,
    ownerName: body.owner_name,
    ownerEmail: body.email.toLowerCase(),
    password: body.password,
    phone: body.phone,
    city: body.city,
    planCode: body.plan_code || 'growth',
  });

  const user = get('SELECT * FROM users WHERE id = ?', [ownerId]);
  req.auth = { tenantId, userId: ownerId, name: user.name };
  audit(req, { entity: 'tenant', entityId: tenantId, action: 'create', after: { name: body.agency_name } });

  return created(res, issueSession(res, user, req));
});

// -------------------------------------------------------------------- login
router.post('/login', rateLimit({ max: 20, windowMs: 15 * 60_000 }), (req, res) => {
  const { email, password, totp } = validate(loginSchema, req.body);
  const user = get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [email.toLowerCase()]);

  // Constant-ish work whether or not the account exists.
  const hash = user?.password_hash
    || '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const valid = bcrypt.compareSync(password, hash);

  if (!user || !valid) throw unauthorized('Email or password is incorrect');
  if (user.status === 'disabled') throw forbidden('This account has been disabled');

  // NFR security: 2FA (TOTP) for Admin/Finance.
  if (user.twofa_enabled) {
    if (!totp) throw new ApiError(401, 'totp_required', 'Enter the 6-digit code from your authenticator app');
    if (!verifyTotp(user.twofa_secret, totp)) throw unauthorized('That code is not valid');
  }

  req.auth = { tenantId: user.tenant_id, userId: user.id, name: user.name };
  audit(req, { entity: 'user', entityId: user.id, action: 'login' });

  return ok(res, issueSession(res, user, req));
});

// ------------------------------------------------------------------ refresh
router.post('/refresh', (req, res) => {
  const { refresh_token: refreshToken } = req.body || {};
  if (!refreshToken) throw badRequest('refresh_token is required');

  const payload = verifyRefreshToken(refreshToken);
  const stored = get('SELECT * FROM refresh_tokens WHERE id = ?', [payload.jti]);
  if (!stored || stored.revoked_at || stored.token_hash !== sha256(refreshToken)) {
    throw unauthorized('Refresh token has been revoked');
  }
  if (stored.expires_at < nowIso()) throw unauthorized('Refresh token expired');

  const user = get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [payload.sub]);
  if (!user) throw unauthorized('User no longer exists');

  // Rotate: the presented token is retired as the new one is issued.
  run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [nowIso(), payload.jti]);
  return ok(res, issueSession(res, user, req));
});

// ------------------------------------------------------------------- logout
router.post('/logout', (req, res) => {
  const { refresh_token: refreshToken } = req.body || {};
  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [nowIso(), payload.jti]);
    } catch { /* already invalid - nothing to revoke */ }
  }
  return ok(res, { ok: true });
});

// ---------------------------------------------------------------------- me
router.get('/me', authenticate, (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  return ok(res, sessionPayload(user));
});

router.patch('/me', authenticate, (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    phone: z.string().optional(),
    whatsapp: z.string().optional(),
    avatar_url: z.string().optional(),
    notification_prefs: z.record(z.string(), z.any()).optional(),
  });
  const body = validate(schema, req.body);
  const fields = { ...body, updated_at: nowIso() };
  if (body.notification_prefs) fields.notification_prefs = JSON.stringify(body.notification_prefs);

  const cols = Object.keys(fields);
  run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => fields[c]), req.auth.userId]);

  const user = get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  return ok(res, sessionPayload(user));
});

router.post('/change-password', authenticate, (req, res) => {
  const schema = z.object({ current_password: z.string(), new_password: z.string().min(8) });
  const body = validate(schema, req.body);
  const user = get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);

  if (!bcrypt.compareSync(body.current_password, user.password_hash)) {
    throw badRequest('Your current password is incorrect');
  }
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    [bcrypt.hashSync(body.new_password, 10), nowIso(), user.id]);
  run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [nowIso(), user.id]);

  audit(req, { entity: 'user', entityId: user.id, action: 'update', after: { password: 'changed' } });
  return ok(res, { ok: true, message: 'Password changed. Other sessions have been signed out.' });
});

router.get('/sessions', authenticate, (req, res) => ok(res, all(
  `SELECT id, user_agent, created_at, expires_at, revoked_at FROM refresh_tokens
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
  [req.auth.userId],
)));

// ---------------------------------------------------------------------- 2FA
// RFC 6238 TOTP over SHA-1, 30-second step, 6 digits - what authenticator apps expect.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function totpAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  const counter = Math.floor(Date.now() / 30_000);
  // +/- one step tolerance for clock drift.
  return [-1, 0, 1].some((d) => totpAt(secret, counter + d) === String(code).trim());
}

router.post('/2fa/setup', authenticate, (req, res) => {
  const secret = base32Encode(crypto.randomBytes(20));
  run('UPDATE users SET twofa_secret = ?, updated_at = ? WHERE id = ?', [secret, nowIso(), req.auth.userId]);
  const label = encodeURIComponent(`Phoenixx OS:${req.auth.email}`);
  return ok(res, {
    secret,
    otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=Phoenixx%20OS&algorithm=SHA1&digits=6&period=30`,
  });
});

router.post('/2fa/enable', authenticate, (req, res) => {
  const { code } = validate(z.object({ code: z.string().length(6) }), req.body);
  const user = get('SELECT twofa_secret FROM users WHERE id = ?', [req.auth.userId]);
  if (!verifyTotp(user.twofa_secret, code)) throw badRequest('That code is not valid. Try the next one.');

  run('UPDATE users SET twofa_enabled = 1, updated_at = ? WHERE id = ?', [nowIso(), req.auth.userId]);
  audit(req, { entity: 'user', entityId: req.auth.userId, action: 'update', after: { twofa: 'enabled' } });
  return ok(res, { twofa_enabled: true });
});

router.post('/2fa/disable', authenticate, (req, res) => {
  const { password } = validate(z.object({ password: z.string() }), req.body);
  const user = get('SELECT password_hash FROM users WHERE id = ?', [req.auth.userId]);
  if (!bcrypt.compareSync(password, user.password_hash)) throw badRequest('Password is incorrect');

  run('UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, updated_at = ? WHERE id = ?',
    [nowIso(), req.auth.userId]);
  return ok(res, { twofa_enabled: false });
});

// ----------------------------------------------------------- invite accept
router.post('/accept-invite', (req, res) => {
  const schema = z.object({ token: z.string(), password: z.string().min(8), name: z.string().optional() });
  const body = validate(schema, req.body);
  const user = get("SELECT * FROM users WHERE invite_token = ? AND status = 'invited' AND deleted_at IS NULL",
    [body.token]);
  if (!user) throw badRequest('This invitation is invalid or has already been used');

  run(
    `UPDATE users SET password_hash = ?, name = COALESCE(?, name), status = 'active',
       invite_token = NULL, updated_at = ? WHERE id = ?`,
    [bcrypt.hashSync(body.password, 10), body.name || null, nowIso(), user.id],
  );
  const fresh = get('SELECT * FROM users WHERE id = ?', [user.id]);
  return ok(res, issueSession(res, fresh, req));
});

export { router as authRouter, sessionPayload };
