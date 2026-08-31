import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight, BarChart3, BellRing, BookOpenCheck, CalendarDays, Clock, Eye, EyeOff, FileText,
  ListChecks, Lock, Mail, Receipt, ReceiptIndianRupee, ShieldCheck, TrendingUp, Users2, UsersRound,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { Logo, LogoDisc, Wordmark } from '../components/Logo';

const FEATURES = [
  { icon: BellRing, title: 'Never Miss a Follow-up', body: 'Reminders and automatic escalation.' },
  { icon: ReceiptIndianRupee, title: 'Smart GST Invoicing', body: 'Easy GST, HSN/SAC and numbering.' },
  { icon: UsersRound, title: 'Built for Teams', body: 'Role-based access with audit trails.' },
];

/** The workspace's real modules, in sidebar order. */
const MODULES = [
  { icon: ListChecks, label: 'Action Items' },
  { icon: CalendarDays, label: 'Meetings & MOM' },
  { icon: Clock, label: 'Deadlines' },
  { icon: Users2, label: 'CRM' },
  { icon: FileText, label: 'Proposals' },
  { icon: Receipt, label: 'Invoices' },
  { icon: Wallet, label: 'Cost & Profit' },
  { icon: UsersRound, label: 'HR' },
  { icon: BookOpenCheck, label: 'SOP & KPI' },
  { icon: TrendingUp, label: 'Traction' },
];

const TRUST = [
  { icon: ShieldCheck, top: 'Encrypted', bottom: 'in transit' },
  { icon: Lock, top: 'Two-factor', bottom: 'ready' },
  { icon: ShieldCheck, top: 'Every action', bottom: 'audited' },
];

/** Ember specks drifting off the bird. Fixed offsets so they never re-roll. */
const SPARKS = [
  { x: '58%', y: '30%', s: 3, o: 0.55 }, { x: '66%', y: '18%', s: 2, o: 0.4 },
  { x: '78%', y: '26%', s: 2.5, o: 0.5 }, { x: '54%', y: '52%', s: 2, o: 0.35 },
  { x: '84%', y: '46%', s: 3, o: 0.45 }, { x: '62%', y: '62%', s: 2, o: 0.3 },
  { x: '74%', y: '68%', s: 2.5, o: 0.4 }, { x: '88%', y: '60%', s: 2, o: 0.3 },
];

/** Google's four-colour G, inlined — no network request, no extra dependency. */
function GoogleMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17Z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46Z" />
      <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7Z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07Z" />
    </svg>
  );
}

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email.trim(), password, needsTotp ? totp : undefined);
      navigate((location.state as any)?.from?.pathname || '/', { replace: true });
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsTotp(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(err.message || 'Could not sign you in.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface lg:grid lg:grid-cols-[1.32fr_minmax(430px,1fr)]">

      {/* ------------------------------------------------------- brand side */}
      <aside className="relative hidden overflow-hidden px-12 py-11 text-white lg:flex lg:flex-col lg:justify-between xl:px-14"
        style={{ background: '#0a0908' }}>

        {/* --- the fire, all decorative ------------------------------------ */}
        {/* Two ember blooms give the panel its heat and put the brightest
            point behind the bird rather than behind the copy. */}
        <div aria-hidden className="absolute inset-0"
          style={{ background: 'radial-gradient(circle at 74% 36%, rgba(226,89,38,0.34), transparent 52%)' }} />
        <div aria-hidden className="absolute inset-0"
          style={{ background: 'radial-gradient(circle at 88% 72%, rgba(160,45,10,0.30), transparent 46%)' }} />
        {/* Concentric arcs, echoing the rings in the reference. */}
        {[520, 700, 880].map((d) => (
          <div key={d} aria-hidden className="absolute rounded-full"
            style={{
              width: d, height: d, top: '36%', left: '74%', transform: 'translate(-50%, -50%)',
              border: '1px solid rgba(255,138,70,0.07)',
            }} />
        ))}
        {/* The mark, large and lit. */}
        <div aria-hidden className="pointer-events-none absolute select-none"
          style={{
            // Sized so the full bird clears the panel's right edge — at 620 it
            // overran it and read as flames rather than as the mark. The glow
            // is kept light for the same reason: too much and the silhouette
            // washes out.
            top: '36%', left: '74%', transform: 'translate(-50%, -50%)',
            filter: 'drop-shadow(0 0 46px rgba(226,89,38,0.42)) drop-shadow(0 0 16px rgba(255,120,40,0.28))',
          }}>
          <Logo size={500} alt="" />
        </div>
        {SPARKS.map((p, i) => (
          <span key={i} aria-hidden className="absolute rounded-full"
            style={{
              left: p.x, top: p.y, width: p.s, height: p.s,
              background: '#ffb27a', opacity: p.o, boxShadow: '0 0 6px 1px rgba(255,140,60,0.7)',
            }} />
        ))}
        {/* A vignette so the copy column stays legible over the glow. */}
        <div aria-hidden className="absolute inset-0"
          style={{ background: 'linear-gradient(100deg, #0a0908 17%, rgba(10,9,8,0.82) 33%, rgba(10,9,8,0) 57%)' }} />

        {/* --- content ----------------------------------------------------- */}
        <Wordmark size={62} variant="onDark" tagline="Agency operations, one platform" className="relative" />

        <div className="relative max-w-[36rem]">
          <h1 className="text-[38px] font-bold leading-[1.16] tracking-[-0.022em] xl:text-[42px]">
            Spreadsheets, WhatsApp and missed invoices —
            <span className="block text-[var(--brand-vivid)]">all in one system.</span>
          </h1>
          <p className="mt-6 max-w-[30rem] text-[15.5px] leading-[1.7] text-white/65">
            Manage action items, meetings, deadlines, CRM, invoicing, HR and performance
            from one platform with complete visibility.
          </p>
        </div>

        <div className="relative grid max-w-[46rem] grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-white/[0.08] p-5"
              style={{ background: 'linear-gradient(160deg, rgba(28,22,18,0.92), rgba(14,11,9,0.86))' }}>
              <span className="grid h-11 w-11 place-items-center rounded-full"
                style={{ background: 'linear-gradient(145deg, #e15926, #b8380f)' }}>
                <f.icon size={19} className="text-white" strokeWidth={2} />
              </span>
              <p className="mt-4 text-[15.5px] font-bold leading-snug">{f.title}</p>
              <p className="mt-2 text-[13.5px] leading-relaxed text-white/55">{f.body}</p>
              <span aria-hidden className="mt-4 block h-[3px] w-8 rounded-full"
                style={{ background: 'linear-gradient(90deg, #e15926, rgba(225,89,38,0))' }} />
            </div>
          ))}
        </div>

        <ul className="relative flex max-w-[46rem] flex-wrap gap-2.5" aria-label="Included modules">
          {MODULES.map((m) => (
            <li key={m.label}>
              <span className="inline-flex items-center gap-2.5 rounded-xl border border-white/[0.09] bg-white/[0.035] px-3.5 py-2.5 text-[13.5px] font-medium text-white/90">
                <m.icon size={16} className="text-[var(--brand-vivid)]" strokeWidth={2} />
                {m.label}
              </span>
            </li>
          ))}
        </ul>

        <div className="relative flex items-center gap-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-full border border-[rgba(225,89,38,0.4)]">
            <ShieldCheck size={16} className="text-[var(--brand-vivid)]" />
          </span>
          <p className="text-[13.5px] text-white/55">
            Phoenixx IT · Coimbatore · Beyond Technology
          </p>
        </div>
      </aside>

      {/* -------------------------------------------------------- form side */}
      <main className="relative flex flex-col justify-center overflow-hidden px-5 py-12 sm:px-8 lg:px-10">
        {/* A dot field in the top corner and one soft bloom, to keep the light
            side from reading as flat paper next to all that fire. */}
        <div aria-hidden className="pointer-events-none absolute -top-6 right-0 h-64 w-64"
          style={{
            backgroundImage: 'radial-gradient(circle at center, var(--brand-vivid) 1.1px, transparent 1.2px)',
            backgroundSize: '15px 15px',
            maskImage: 'linear-gradient(to bottom left, #000, transparent 68%)',
            WebkitMaskImage: 'linear-gradient(to bottom left, #000, transparent 68%)',
            opacity: 0.28,
          }} />
        <div aria-hidden className="pointer-events-none absolute -right-24 top-1/3 h-[26rem] w-[26rem] rounded-full bg-white/70 blur-2xl" />

        <div className="relative mx-auto w-full max-w-[26.5rem]">

          {/* The brand panel is desktop-only, so on a phone the lockup carries it. */}
          <div className="mb-7 flex justify-center lg:hidden">
            <Wordmark size={52} tagline="Agency operations, one platform" />
          </div>

          <div className="rounded-[28px] border border-line bg-raised p-8 shadow-[var(--shadow-lg)] sm:p-9">
            <div className="flex justify-center">
              <LogoDisc size={92} tone="light" />
            </div>
            <h2 className="mt-6 text-center text-[28px] font-bold tracking-[-0.022em] text-ink">
              Welcome back!
            </h2>
            <p className="mt-1.5 text-center text-[14.5px] text-muted">
              Sign in to pick up where the team left off.
            </p>

            {/* Field owns the label/input id wiring, so the login-only label
                treatment is applied here rather than by editing the shared
                primitive every other form in the app also uses. */}
            <form onSubmit={submit} noValidate
              className="mt-7 space-y-4 [&_label]:mb-2 [&_label]:text-[13.5px] [&_label]:font-semibold [&_label]:text-ink">
              <Field label="Work email">
                <div className="relative">
                  <Mail aria-hidden size={17} strokeWidth={1.75}
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-subtle" />
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username" required placeholder="you@agency.com"
                    className="h-[52px] rounded-xl border-line pl-12 text-[15px]" />
                </div>
              </Field>

              <Field label="Password">
                <div className="relative">
                  <Lock aria-hidden size={17} strokeWidth={1.75}
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-subtle" />
                  <Input
                    type={showPassword ? 'text' : 'password'} value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password" required
                    className="h-[52px] rounded-xl border-line pl-12 pr-12 text-[15px]"
                  />
                  <button
                    type="button" onClick={() => setShowPassword((v) => !v)} tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center
                               rounded-md text-subtle transition-colors duration-150 hover:text-ink"
                  >
                    {showPassword ? <EyeOff size={17} strokeWidth={1.75} /> : <Eye size={17} strokeWidth={1.75} />}
                  </button>
                </div>
              </Field>

              <div className="-mt-1 flex justify-end">
                <Link to="/recover" className="text-[13.5px] font-medium text-[var(--brand)] hover:underline">
                  Forgot your password?
                </Link>
              </div>

              {needsTotp && (
                <Field label="Authenticator code" hint="Six digits from your authenticator app">
                  <Input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric" autoComplete="one-time-code" placeholder="000000" required
                    className="mono h-[52px] rounded-xl border-line text-center text-base tracking-[0.4em]" />
                </Field>
              )}

              {error && (
                <p role="alert" className="rounded-xl border border-[color-mix(in_srgb,var(--negative)_28%,transparent)] bg-negative-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--negative)]">
                  {error}
                </p>
              )}

              {/* The gradient stops at #e1490b rather than the brighter orange
                  in the mock: past that, white on the fill drops under 3:1.
                  The 19px bold label is what keeps this AA at large-text size. */}
              <Button type="submit" variant="primary" loading={loading}
                className="w-full justify-center rounded-xl font-bold"
                style={{
                  height: 54, fontSize: 19, border: 'none',
                  background: 'linear-gradient(90deg, #c34718 0%, #e1490b 100%)',
                }}
                icon={!loading ? <ArrowRight size={19} /> : undefined}>
                Sign in
              </Button>

              <div className="flex items-center gap-3 pt-1">
                <span className="h-px flex-1 bg-[var(--border)]" />
                <span className="text-[12px] text-subtle">OR</span>
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>

              {/* Visually the control from the design. It is not wired to an
                  identity provider because the API has none — auth.routes.js is
                  email/password plus TOTP — so rather than sit here dead it says
                  so. Swap the handler for a real redirect once OAuth exists. */}
              <button type="button"
                onClick={() => setError('Google sign-in is not enabled for this workspace yet. Please use your work email and password.')}
                className="flex w-full items-center justify-center gap-3 rounded-xl border border-line-strong bg-raised font-semibold text-ink transition-colors duration-150 hover:bg-sunken"
                style={{ height: 54, fontSize: 15 }}>
                <GoogleMark />
                Sign in with Google
              </button>
            </form>
          </div>

          <p className="mt-6 flex items-center justify-center gap-1.5 text-[14px] text-muted">
            New to Phoenixx?
            <Link to="/signup" className="inline-flex items-center gap-1 font-semibold text-[var(--brand)] hover:underline">
              Start a 14-day trial
              <ArrowRight size={14} />
            </Link>
          </p>

          <ul className="mt-8 grid grid-cols-3 divide-x divide-line">
            {TRUST.map((t) => (
              <li key={t.top} className="flex items-center justify-center gap-2 px-2">
                <t.icon size={18} strokeWidth={1.6} className="shrink-0 text-muted" />
                <span className="text-[12.5px] leading-tight text-subtle">
                  {t.top}<br />{t.bottom}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
