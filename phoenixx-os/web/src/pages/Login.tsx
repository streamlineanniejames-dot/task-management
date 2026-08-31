import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, BellRing, Eye, EyeOff, Lock, Mail, ReceiptIndianRupee, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { Logo, Wordmark } from '../components/Logo';

/**
 * Three, not nine. The panel's job is to say what the product is worth while
 * someone types a password — a longer list reads as noise at that moment.
 */
const PROOF = [
  {
    icon: BellRing,
    title: 'Nothing slips',
    body: 'A reminder ladder and automatic escalation on every deadline and action item.',
  },
  {
    icon: ReceiptIndianRupee,
    title: 'Invoicing that adds up',
    body: 'Atomic GST numbering, CGST/SGST/IGST and HSN/SAC codes, straight from the work.',
  },
  {
    icon: ShieldCheck,
    title: 'Multi-tenant from day one',
    body: 'Row-level isolation, role-based access and a full audit trail behind every change.',
  },
];

/** Named plainly, in one quiet line, rather than as a wall of pills. */
const MODULES =
  'Action items · Meetings & MOM · Deadlines · CRM · Proposals · Invoices · Cost & profit · HR · SOP & KPI · Traction';

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
    // Two panels — warm ivory and plain white — parted by a hairline. The
    // panels are the structure, so the form needs no card of its own.
    <div className="min-h-screen bg-raised lg:grid lg:grid-cols-[1.06fr_minmax(456px,0.94fr)]">

      {/* ------------------------------------------------------- brand side */}
      <aside
        className="relative hidden overflow-hidden border-r border-line px-16 py-14 lg:flex lg:flex-col lg:justify-between xl:px-20"
        style={{ background: 'linear-gradient(158deg, #fffdfb 0%, #fdf6f0 58%, #faece2 100%)' }}
      >
        {/* One decorative element, not three: the mark itself, very faint and
            bleeding off the edge so it reads as ground rather than as art. */}
        <div aria-hidden
          className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 translate-x-[26%] select-none"
          style={{ opacity: 0.07 }}>
          <Logo size={660} alt="" />
        </div>

        <Wordmark size={52} tagline="Agency operations, one platform" className="relative" />

        <div className="relative w-full max-w-[620px]">
          <p className="font-serif text-[40px] leading-[1.12] tracking-[-0.015em] text-ink xl:text-[46px]">
            Spreadsheets, WhatsApp and missed invoices
            <span className="block text-[var(--brand-vivid)]">— all in one system.</span>
          </p>

          <p className="mt-6 max-w-[52ch] text-[16px] leading-[1.7] text-muted">
            Action items and MOM, deadlines with WhatsApp escalation, CRM through to invoicing,
            client scoring and SOPs per service line — with a traction dashboard over all of it.
          </p>

          {/* Hairline rows rather than boxed tiles. Fewer edges, more air. */}
          <dl className="mt-12 divide-y divide-line border-y border-line">
            {PROOF.map((p) => (
              <div key={p.title} className="flex gap-5 py-5">
                <p.icon size={19} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--brand-vivid)]" />
                <div className="min-w-0">
                  <dt className="text-[15px] font-semibold tracking-[-0.005em] text-ink">{p.title}</dt>
                  <dd className="mt-1.5 text-[14px] leading-relaxed text-muted">{p.body}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative w-full max-w-[620px]">
          <p className="text-[12.5px] leading-relaxed text-subtle">{MODULES}</p>
          <p className="mt-5 text-[12.5px] text-subtle">
            Phoenixx IT · Coimbatore · Beyond Technology
          </p>
        </div>
      </aside>

      {/* -------------------------------------------------------- form side */}
      <main className="flex flex-col justify-center px-6 py-14 sm:px-10 lg:px-16">
        <div className="mx-auto w-full max-w-[23.5rem]">

          {/* The brand panel is desktop-only, so on a phone the lockup carries it. */}
          <div className="mb-10 flex justify-center lg:hidden">
            <Wordmark size={48} tagline="Agency operations, one platform" />
          </div>

          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-ink">Welcome back</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Sign in to pick up where the team left off.
          </p>

          {/* Field owns the label/input id wiring, so the login-only label
              treatment is applied here rather than by editing the shared
              primitive every other form in the app also uses. */}
          <form onSubmit={submit} noValidate
            className="mt-9 space-y-5 [&_label]:mb-2 [&_label]:text-[13px] [&_label]:font-medium [&_label]:tracking-[0.01em] [&_label]:text-ink">
            <Field label="Work email">
              <div className="relative">
                <Mail aria-hidden size={17} strokeWidth={1.75}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-subtle" />
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username" required placeholder="you@agency.com"
                  className="h-12 rounded-lg border-line pl-11 text-[15px]" />
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
                  className="h-12 rounded-lg border-line pl-11 pr-12 text-[15px]"
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

            {needsTotp && (
              <Field label="Authenticator code" hint="Six digits from your authenticator app">
                <Input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="000000" required
                  className="mono h-12 rounded-lg border-line text-center text-base tracking-[0.4em]" />
              </Field>
            )}

            {error && (
              <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--negative)_28%,transparent)] bg-negative-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--negative)]">
                {error}
              </p>
            )}

            <div className="flex justify-end">
              <Link to="/recover" className="text-[13px] text-muted underline-offset-4 transition-colors hover:text-[var(--brand)] hover:underline">
                Forgot your password?
              </Link>
            </div>

            <Button type="submit" variant="primary" loading={loading}
              className="h-12 w-full justify-center rounded-lg text-[15px] font-semibold"
              icon={!loading ? <ArrowRight size={16} /> : undefined}>
              Sign in
            </Button>
          </form>

          <p className="mt-8 border-t border-line pt-6 text-[13.5px] text-muted">
            New to Phoenixx?{' '}
            <Link to="/signup" className="font-medium text-[var(--brand)] underline-offset-4 hover:underline">
              Start a 14-day trial
            </Link>
          </p>

          <p className="mt-5 flex items-center gap-2 text-[12px] text-subtle">
            <Lock size={12} strokeWidth={1.75} className="shrink-0" />
            Encrypted in transit · two-factor ready · every action audited
          </p>
        </div>
      </main>
    </div>
  );
}
