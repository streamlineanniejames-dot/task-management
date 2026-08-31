import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight, BarChart3, BellRing, BookOpen, CalendarDays, ChevronRight, Clock, Eye, EyeOff,
  FileText, Lock, Mail, Receipt, ReceiptIndianRupee, ShieldCheck, SquareCheck, Target, UserCog,
  Users2, UsersRound,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { Logo, Wordmark } from '../components/Logo';

const FEATURES = [
  { icon: BellRing, title: 'Never Miss a Follow-up', body: 'Reminders and automatic escalation.' },
  { icon: Target, title: 'Track Client Health', body: 'Monitor conversion, risk and retention.' },
  { icon: ReceiptIndianRupee, title: 'Smart GST Invoicing', body: 'Easy GST, HSN/SAC & numbering.' },
  { icon: UsersRound, title: 'Built for Teams', body: 'Secure multi-user access with audit trails.' },
];

/** The workspace's real modules, in the order they appear in the sidebar. */
const MODULES = [
  { icon: SquareCheck, label: 'Tasks' },
  { icon: CalendarDays, label: 'Meetings' },
  { icon: Clock, label: 'Deadlines' },
  { icon: Users2, label: 'CRM' },
  { icon: FileText, label: 'Proposals' },
  { icon: Receipt, label: 'Invoices' },
  { icon: UserCog, label: 'HR' },
  { icon: BookOpen, label: 'SOPs' },
  { icon: BarChart3, label: 'Performance' },
];

const TRUST = [
  { icon: ShieldCheck, label: 'Secure' },
  { icon: Lock, label: '2FA Ready' },
  { icon: ShieldCheck, label: 'Fully Audited' },
];

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
    <div className="min-h-screen bg-surface lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(444px,0.95fr)]">

      {/* ------------------------------------------------------- brand side */}
      <aside
        className="relative hidden overflow-hidden border-r border-line px-14 py-12 lg:flex lg:flex-col lg:justify-between xl:px-16"
        // Warm white that deepens toward the divider, so the two panels
        // separate on tone rather than on a hard colour change.
        style={{ background: 'linear-gradient(115deg, #ffffff 0%, #fffaf7 55%, #fff2ea 100%)' }}
      >
        {/* Decorative. The mark ghosted large behind the copy, and a halftone
            that fades out of the low corner. */}
        <div aria-hidden
          className="pointer-events-none absolute top-[8%] right-0 translate-x-[16%] select-none"
          // Left at full chroma but very faint: desaturating turns the ember a
          // dirty grey, whereas 7% of the real orange over white lands on the
          // pale peach the bird should be.
          style={{ opacity: 0.075 }}>
          <Logo size={560} alt="" />
        </div>
        <div aria-hidden className="pointer-events-none absolute bottom-0 right-0 h-72 w-96"
          style={{
            backgroundImage: 'radial-gradient(circle at center, var(--brand-vivid) 1.1px, transparent 1.2px)',
            backgroundSize: '14px 14px',
            maskImage: 'linear-gradient(to top left, #000, transparent 62%)',
            WebkitMaskImage: 'linear-gradient(to top left, #000, transparent 62%)',
            opacity: 0.25,
          }} />

        <Wordmark size={54} tagline="Agency operations, one platform" className="relative" />

        <div className="relative">
          <p className="max-w-xl text-[38px] font-bold leading-[1.2] tracking-[-0.022em] text-ink xl:text-[42px]">
            Spreadsheets, WhatsApp &amp; missed invoices —
            <span className="mt-1 block text-[var(--brand-vivid)]">all in one system.</span>
          </p>

          <p className="mt-6 max-w-md text-[16px] leading-relaxed text-muted">
            Manage tasks, meetings, deadlines, CRM, invoices, HR and performance from one platform.
          </p>

          <dl className="mt-11 grid max-w-2xl grid-cols-2 gap-x-10 gap-y-8">
            {FEATURES.map((f) => (
              <div key={f.title} className="flex gap-4">
                <span className="grid h-[58px] w-[58px] shrink-0 place-items-center rounded-2xl bg-brand-soft
                                 ring-1 ring-inset ring-[color-mix(in_srgb,var(--brand)_12%,transparent)]">
                  <f.icon size={25} className="text-[var(--brand-vivid)]" />
                </span>
                <div className="min-w-0">
                  <dt className="text-[15.5px] font-semibold leading-snug text-ink">{f.title}</dt>
                  <dd className="mt-1 text-[14px] leading-snug text-muted">{f.body}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative">
          <ul className="flex flex-wrap gap-2.5 border-t border-line pt-9" aria-label="Included modules">
            {MODULES.map((m) => (
              <li key={m.label}>
                <span className="inline-flex items-center gap-2 rounded-full border bg-raised px-3.5 py-2 text-[13.5px] font-medium text-[var(--brand)]"
                  style={{ borderColor: 'color-mix(in srgb, var(--brand) 24%, transparent)' }}>
                  <m.icon size={15} />
                  {m.label}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-9 border-t border-line pt-7 text-[14px] text-subtle">
            Phoenixx IT · Coimbatore · Beyond Technology
          </p>
        </div>
      </aside>

      {/* -------------------------------------------------------- form side */}
      <main className="flex flex-col justify-center px-5 py-12 sm:px-10 lg:px-14">
        <div className="mx-auto w-full max-w-[27rem]">

          {/* The brand panel is desktop-only, so on a phone the lockup carries it. */}
          <div className="mb-8 flex justify-center lg:hidden">
            <Wordmark size={50} tagline="Agency operations, one platform" />
          </div>

          <div className="rounded-3xl border border-line bg-raised p-8 shadow-[var(--shadow-lg)] sm:p-9">
            <div className="flex justify-center">
              <Logo size={54} alt="" />
            </div>
            <h1 className="mt-5 text-center text-[27px] font-bold tracking-[-0.02em] text-ink">
              Welcome back!
            </h1>
            <p className="mt-1.5 text-center text-[15px] text-muted">Continue where you left off.</p>

            {/* Field owns the label/input id wiring, so the login-only label
                treatment is applied here rather than by editing the shared
                primitive every other form in the app also uses. */}
            <form onSubmit={submit} noValidate
              className="mt-7 space-y-4 [&_label]:text-[14px] [&_label]:font-semibold [&_label]:text-ink">
              <Field label="Work email">
                <div className="relative">
                  <Mail aria-hidden size={17}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username" required placeholder="name@phoenixxit.com"
                    className="h-12 rounded-xl pl-11" />
                </div>
              </Field>

              <Field label="Password">
                <div className="relative">
                  <Lock aria-hidden size={17}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
                  <Input
                    type={showPassword ? 'text' : 'password'} value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password" required
                    className="h-12 rounded-xl pl-11 pr-11"
                  />
                  <button
                    type="button" onClick={() => setShowPassword((v) => !v)} tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center
                               rounded-md text-subtle transition-colors duration-150 hover:text-ink"
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </Field>

              <div className="-mt-1 flex justify-end">
                <Link to="/recover" className="text-[13.5px] font-medium text-[var(--brand)] hover:underline">
                  Forgot password?
                </Link>
              </div>

              {needsTotp && (
                <Field label="Authenticator code" hint="Six digits from your authenticator app">
                  <Input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric" autoComplete="one-time-code" placeholder="000000" required
                    className="mono h-12 rounded-xl text-center text-base tracking-[0.35em]" />
                </Field>
              )}

              {error && (
                <p role="alert" className="rounded-xl border border-[color-mix(in_srgb,var(--negative)_30%,transparent)] bg-negative-soft px-3.5 py-2.5 text-[13px] text-[var(--negative)]">
                  {error}
                </p>
              )}

              <Button type="submit" variant="primary" loading={loading}
                className="h-[52px] w-full justify-center rounded-xl text-[16px] font-semibold"
                icon={!loading ? <ArrowRight size={17} /> : undefined}>
                Sign in
              </Button>
            </form>
          </div>

          <p className="mt-6 flex items-center justify-center gap-1.5 text-[14px] text-muted">
            New here?
            <Link to="/signup" className="inline-flex items-center font-semibold text-[var(--brand)] hover:underline">
              Start your 14-day trial
              <ChevronRight size={15} className="ml-0.5" />
            </Link>
          </p>

          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-2 text-[13px] text-subtle">
            {TRUST.map((t, i) => (
              <li key={t.label} className="flex items-center gap-3.5">
                {i > 0 && <span aria-hidden className="text-line-strong">&middot;</span>}
                <span className="flex items-center gap-1.5">
                  <t.icon size={14} className="shrink-0" />
                  {t.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
