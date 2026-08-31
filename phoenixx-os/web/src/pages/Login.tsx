import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, Lock, ShieldCheck, Target, Wallet, Zap } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { Logo, Wordmark } from '../components/Logo';

const PILLARS = [
  { icon: Zap, title: 'Zero missed follow-ups', body: 'A reminder ladder and auto-escalation on every deadline.' },
  { icon: Target, title: 'Quantified client health', body: 'Conversion, risk, relevancy and retention from real data.' },
  { icon: Wallet, title: 'GST invoicing that adds up', body: 'Atomic numbering, CGST/SGST/IGST, HSN/SAC codes.' },
  { icon: ShieldCheck, title: 'Multi-tenant from day one', body: 'Row-level isolation, RBAC and a full audit trail.' },
];

/** The modules a workspace actually ships with — named, not counted. */
const MODULES = [
  'Action items', 'Meetings & MOM', 'Deadlines', 'CRM pipeline', 'Proposals',
  'Invoices', 'Cost & profit', 'HR', 'SOP & KPI', 'Traction',
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
    <div className="min-h-screen bg-surface lg:grid lg:grid-cols-[1.08fr_minmax(432px,0.92fr)]">

      {/* ------------------------------------------------------- brand side */}
      <aside
        className="relative hidden flex-col justify-between overflow-hidden p-10 text-white lg:flex xl:p-14"
        style={{
          // The mark's own shadow-to-body range, lit from the top left so the
          // headline sits on the warmest part of the panel.
          background: 'linear-gradient(152deg, #883111 0%, #6f2a11 34%, #401708 72%, #24100a 100%)',
        }}
      >
        {/* All decorative. A fine dot grid for texture, one ember bloom behind
            the headline, and the mark itself ghosted into the low corner so the
            panel is unmistakably Phoenixx even with the copy stripped out. */}
        <div aria-hidden className="absolute inset-0 opacity-[0.09]"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)',
            backgroundSize: '32px 32px',
          }} />
        <div aria-hidden className="absolute -right-40 -top-40 h-[30rem] w-[30rem] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(225,89,38,0.40), transparent 68%)' }} />
        <div aria-hidden className="absolute -bottom-32 -left-28 h-[26rem] w-[26rem] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(237,140,0,0.16), transparent 70%)' }} />
        <div aria-hidden
          className="pointer-events-none absolute top-1/2 -right-44 -translate-y-1/2 select-none opacity-[0.11]">
          <Logo size={640} alt="" />
        </div>

        <Wordmark size={58} variant="onDark" tagline="Agency operations, one platform" className="relative" />

        <div className="relative max-w-xl">
          <p className="font-serif text-[38px] font-semibold leading-[1.1] tracking-[-0.01em] xl:text-[46px]"
            style={{ textWrap: 'balance' } as any}>
            Spreadsheets, WhatsApp threads and missed invoices
            <span className="text-accent-400"> — replaced by one system.</span>
          </p>

          <p className="mt-6 max-w-md text-[15px] leading-relaxed text-white/70">
            Action items and MOM, deadlines with WhatsApp escalation, CRM through to invoicing,
            client scoring, SOPs per service line, and a traction dashboard that rolls it all up.
          </p>

          <dl className="mt-10 grid max-w-lg grid-cols-2 gap-x-8 gap-y-7">
            {PILLARS.map((f) => (
              <div key={f.title}>
                <dt className="flex items-center gap-2.5 text-[14px] font-semibold">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 ring-1 ring-inset ring-white/15">
                    <f.icon size={15} className="text-accent-400" />
                  </span>
                  {f.title}
                </dt>
                <dd className="mt-2 text-[13px] leading-snug text-white/60">{f.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative">
          {/* What the product contains, rather than a result it cannot show a
              signed-out visitor. These are the workspace's real modules. */}
          <ul className="mb-7 flex flex-wrap gap-2" aria-label="Included modules">
            {MODULES.map((m) => (
              <li key={m}
                className="rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[11.5px] font-medium text-white/65">
                {m}
              </li>
            ))}
          </ul>
          <p className="border-t border-white/10 pt-5 text-[12.5px] text-white/45">
            Phoenixx IT · Coimbatore · Beyond Technology
          </p>
        </div>
      </aside>

      {/* -------------------------------------------------------- form side */}
      <main className="relative flex flex-col justify-center px-5 py-12 sm:px-10 lg:px-14">
        {/* A breath of the brand ember washed down from the top edge. Without it
            a white card on a near-white ground has no edge to speak of. */}
        <div aria-hidden className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(120% 75% at 50% 0%, rgba(225,89,38,0.055), transparent 62%)' }} />
        <div className="relative mx-auto w-full max-w-[26rem]">

          {/* The brand panel is desktop-only, so on a phone the lockup carries it. */}
          <div className="mb-8 flex justify-center lg:hidden">
            <Wordmark size={56} tagline="Agency operations, one platform" />
          </div>

          {/* Raised card: against the warm page ground it gives the form a real
              edge, which is what makes signing in read as a deliberate step
              rather than fields floating on a background. */}
          <div className="card p-7 shadow-[var(--shadow-lg)] sm:p-8">
            <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-ink">Sign in</h1>
            <p className="mt-1.5 text-[14px] text-subtle">Welcome back. Pick up where the team left off.</p>

            <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
              <Field label="Work email" required>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username" required placeholder="you@agency.com" className="h-11" />
              </Field>

              <Field label="Password" required>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'} value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password" required
                    className="h-11 pr-11"
                  />
                  <button
                    type="button" onClick={() => setShowPassword((v) => !v)} tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center
                               rounded-md text-subtle transition-colors duration-150 hover:text-ink"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </Field>

              <div className="-mt-1 flex justify-end">
                <Link to="/recover" className="text-[13px] font-medium text-[var(--brand)] hover:underline">
                  Forgot your password?
                </Link>
              </div>

              {needsTotp && (
                <Field label="Authenticator code" hint="Six digits from your authenticator app" required>
                  <Input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric" autoComplete="one-time-code" placeholder="000000"
                    className="mono h-11 text-center text-base tracking-[0.35em]" />
                </Field>
              )}

              {error && (
                <p role="alert" className="rounded-md border border-[color-mix(in_srgb,var(--negative)_30%,transparent)]
                                            bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]">
                  {error}
                </p>
              )}

              <Button type="submit" variant="primary" size="lg" loading={loading}
                className="w-full justify-center" icon={!loading ? <ArrowRight size={16} /> : undefined}>
                Sign in
              </Button>
            </form>
          </div>

          <p className="mt-6 text-center text-[13.5px] text-subtle">
            New agency?{' '}
            <Link to="/signup" className="font-medium text-[var(--brand)] hover:underline">
              Start a 14-day trial
            </Link>
          </p>

          <div className="mt-8 flex items-center justify-center gap-2 border-t border-line pt-5
                          text-[12px] text-subtle">
            <Lock size={13} className="shrink-0" />
            Encrypted in transit · two-factor ready · every action audited
          </div>
        </div>
      </main>
    </div>
  );
}
