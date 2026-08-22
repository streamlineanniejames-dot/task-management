/**
 * Formatting helpers. Money always arrives as integer minor units plus a
 * currency code; the tenant decides between Indian (lakh/crore) and
 * international grouping, so every money render goes through here.
 */

let numberFormat: 'indian' | 'international' = 'indian';
let currency = 'INR';
let timezone = 'Asia/Kolkata';

export function configureLocale(opts: { number_format?: string; currency?: string; timezone?: string }) {
  if (opts.number_format === 'indian' || opts.number_format === 'international') numberFormat = opts.number_format;
  if (opts.currency) currency = opts.currency;
  if (opts.timezone) timezone = opts.timezone;
}

const locale = () => (numberFormat === 'indian' ? 'en-IN' : 'en-US');

export function money(minor?: number | null, opts: { compact?: boolean; sign?: boolean; cur?: string } = {}) {
  const value = (minor ?? 0) / 100;
  const cur = opts.cur || currency;

  if (opts.compact) return `${value < 0 ? '-' : opts.sign && value > 0 ? '+' : ''}${compactMoney(Math.abs(value), cur)}`;

  return new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency: cur,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    minimumFractionDigits: 0,
    signDisplay: opts.sign ? 'exceptZero' : 'auto',
  }).format(value);
}

/** ₹1.2 Cr / ₹4.5 L in Indian mode, ₹1.2M / ₹45K otherwise. */
function compactMoney(abs: number, cur: string) {
  const symbol = cur === 'INR' ? '₹' : new Intl.NumberFormat(locale(), { style: 'currency', currency: cur })
    .formatToParts(0).find((p) => p.type === 'currency')?.value || '';

  if (numberFormat === 'indian') {
    if (abs >= 1e7) return `${symbol}${trim(abs / 1e7)} Cr`;
    if (abs >= 1e5) return `${symbol}${trim(abs / 1e5)} L`;
    if (abs >= 1e3) return `${symbol}${trim(abs / 1e3)}K`;
  } else {
    if (abs >= 1e9) return `${symbol}${trim(abs / 1e9)}B`;
    if (abs >= 1e6) return `${symbol}${trim(abs / 1e6)}M`;
    if (abs >= 1e3) return `${symbol}${trim(abs / 1e3)}K`;
  }
  return `${symbol}${Math.round(abs)}`;
}

const trim = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);

export const num = (n?: number | null, digits = 0) =>
  new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n ?? 0);

export const percent = (n?: number | null, digits = 0) =>
  `${new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n ?? 0)}%`;

// ------------------------------------------------------------------- dates
const dateFmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: timezone, ...opts });

export function date(iso?: string | null, style: 'short' | 'long' | 'day' | 'month' = 'short') {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (style === 'long') return dateFmt({ day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  if (style === 'day') return dateFmt({ day: 'numeric', month: 'short' }).format(d);
  if (style === 'month') return dateFmt({ month: 'short', year: 'numeric' }).format(d);
  return dateFmt({ day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

export function dateTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dateFmt({ day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
}

export function time(iso?: string | null) {
  if (!iso) return '—';
  return dateFmt({ hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso));
}

/** "3 days ago" / "in 2 days" / "today" — for anything deadline-shaped. */
export function relative(iso?: string | null) {
  if (!iso) return '—';
  const target = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  const days = Math.round((target.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return days < 30 ? `in ${days} days` : date(iso, 'day');
  return Math.abs(days) < 30 ? `${Math.abs(days)} days ago` : date(iso, 'day');
}

export function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const target = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Math.round((target.getTime() - Date.now()) / 86_400_000);
}

export const monthLabel = (m?: string | null) => (m ? date(`${m}-01`, 'month') : '—');

export const initials = (name?: string | null) =>
  (name || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

export const titleCase = (s?: string | null) =>
  (s || '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** A deterministic accent per name, so avatars stay stable across renders. */
const AVATAR_COLORS = [
  '#1e40af', '#7c3aed', '#be185d', '#0f766e', '#b45309', '#4338ca', '#0369a1', '#9333ea',
];
export function avatarColor(seed?: string | null) {
  const s = seed || '';
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
