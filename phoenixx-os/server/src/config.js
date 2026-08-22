import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4010),
  apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 4010}`,
  webBaseUrl: process.env.WEB_BASE_URL || 'http://localhost:5173',

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
    accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTtl: process.env.REFRESH_TOKEN_TTL || '30d',
  },

  dbFile: path.resolve(ROOT, process.env.DB_FILE || './data/phoenixx.db'),
  storageDir: path.resolve(ROOT, process.env.STORAGE_DIR || './storage'),

  // Single-origin deploys: the API also serves the built web app, so the SPA's
  // relative /api/v1 calls and the chat SSE stream need no CORS at all.
  serveWeb: bool(process.env.SERVE_WEB, false),
  webDist: path.resolve(ROOT, process.env.WEB_DIST || '../web/dist'),

  // For throwaway hosting with no persistent disk: rebuild the demo workspace
  // whenever the database comes up empty, so a cold start is never a dead app.
  seedOnBoot: bool(process.env.SEED_ON_BOOT, false),

  providers: {
    whatsapp: process.env.WHATSAPP_PROVIDER || 'log',
    whatsappToken: process.env.WHATSAPP_TOKEN || '',
    whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || '',
    email: process.env.EMAIL_PROVIDER || 'log',
    smtp: {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.MAIL_FROM || 'no-reply@phoenixxit.com',
    },
    teamsWebhook: process.env.TEAMS_WEBHOOK_URL || '',
  },

  billing: {
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
    stripeSecret: process.env.STRIPE_SECRET_KEY || '',
  },

  jobs: {
    enabled: bool(process.env.JOBS_ENABLED, true),
    tickMs: Number(process.env.JOB_TICK_MS || 60_000),
  },

  rateLimit: { windowMs: 60_000, max: 600 },
};

/**
 * The dev fallbacks above are conveniences, not defaults to ship. Signing
 * tokens with a secret that is published in this repo would let anyone mint a
 * session for any tenant, so production refuses to start with them.
 */
if (config.env === 'production') {
  const weak = Object.entries({
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  }).filter(([, v]) => !v || v.length < 24 || /change-me|dev-/i.test(v));

  if (weak.length) {
    throw new Error(
      `Refusing to start: ${weak.map(([k]) => k).join(' and ')} must be set to a strong random value `
      + '(24+ characters). Generate one with: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"',
    );
  }
}
