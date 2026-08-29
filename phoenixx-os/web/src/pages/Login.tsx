import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck, Zap, Target, Wallet } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Field, Input, Checkbox } from '../components/ui';

const DEMO_LOGINS = [
  { role: 'Owner', email: 'arun@phoenixxit.com', note: 'full access' },
  { role: 'Manager', email: 'divya@phoenixxit.com', note: 'team + approvals' },
  { role: 'Finance', email: 'meera@phoenixxit.com', note: 'invoices + costs' },
  { role: 'HR', email: 'sanjay@phoenixxit.com', note: 'people + hiring' },
  { role: 'Employee', email: 'priya@phoenixxit.com', note: 'own work only' },
];

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  const useDemo = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword('Phoenixx@2026');
    setError('');
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-[1fr_minmax(420px,44%)]">
      {/* ------------------------------------------------------- brand side */}
      <aside className="relative hidden lg:flex flex-col justify-between p-10 xl:p-14 text-white overflow-hidden"
        style={{ background: 'linear-gradient(155deg, #1e3a8a 0%, #1e40af 45%, #172554 100%)' }}>
        <div aria-hidden className="absolute inset-0 opacity-[0.13]"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)',
            backgroundSize: '28px 28px',
          }} />
        <div aria-hidden className="absolute -right-24 -top-24 h-80 w-80 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.28), transparent 70%)' }} />

        <div className="relative">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 backdrop-blur font-bold">P</span>
            <div>
              <p className="font-semibold text-[17px] leading-tight">Phoenixx OS</p>
              <p className="text-[12.5px] text-white/65 leading-tight">Agency operations, one platform</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-[34px] xl:text-[40px] leading-[1.15] font-semibold tracking-[-0.02em]">
            Spreadsheets, WhatsApp threads and missed invoices — replaced by one system.
          </h1>
          <p className="mt-5 text-[15px] text-white/75 leading-relaxed">
            Action items and MOM, deadlines with WhatsApp escalation, CRM through to invoicing,
            client scoring, SOPs per service line, and a traction dashboard that rolls it all up.
          </p>

          <dl className="mt-9 grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              { icon: Zap, title: 'Zero missed follow-ups', body: 'A reminder ladder and auto-escalation on every deadline.' },
              { icon: Target, title: 'Quantified client health', body: 'Conversion, risk, relevancy and retention from real data.' },
              { icon: Wallet, title: 'GST invoicing that adds up', body: 'Atomic numbering, CGST/SGST/IGST, HSN/SAC codes.' },
              { icon: ShieldCheck, title: 'Multi-tenant from day one', body: 'Row-level isolation, RBAC and a full audit trail.' },
            ].map((f) => (
              <div key={f.title}>
                <dt className="flex items-center gap-2 text-[14px] font-semibold">
                  <f.icon size={16} className="text-amber-300 shrink-0" />
                  {f.title}
                </dt>
                <dd className="mt-1 text-[13px] text-white/65 leading-snug">{f.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-[12.5px] text-white/50">
          Phoenixx IT · Coimbatore · Branding, Digital &amp; Performance, Sales Consulting, Tech &amp; Automation
        </p>
      </aside>

      {/* -------------------------------------------------------- form side */}
      <main className="flex flex-col justify-center px-5 py-10 sm:px-10 lg:px-12 bg-surface">
        <div className="w-full max-w-sm mx-auto">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--brand)] text-white font-bold">P</span>
            <span className="font-semibold text-ink">Phoenixx OS</span>
          </div>

          <h2 className="text-[24px] font-semibold text-ink tracking-[-0.01em]">Sign in</h2>
          <p className="mt-1 text-[14px] text-subtle">Welcome back. Pick up where the team left off.</p>

          <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
            <Field label="Work email" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="username" required placeholder="you@agency.com" />
            </Field>

            <Field label="Password" required>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" required placeholder="••••••••" />
            </Field>

            <div className="flex justify-end -mt-1">
              <Link to="/recover" className="text-[13px] text-[var(--brand)] hover:underline">
                Forgot your password?
              </Link>
            </div>

            {needsTotp && (
              <Field label="Authenticator code" hint="Six digits from your authenticator app" required>
                <Input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="000000"
                  className="mono tracking-[0.35em] text-center text-base" />
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

          <p className="mt-5 text-center text-[13.5px] text-subtle">
            New agency?{' '}
            <Link to="/signup" className="text-[var(--brand)] font-medium hover:underline">
              Start a 14-day trial
            </Link>
          </p>

          {/* Demo credentials — the seeded workspace ships with these roles. */}
          <div className="mt-8 rounded-lg border border-line bg-raised p-3.5">
            <p className="label-cap mb-2">Demo workspace · password Phoenixx@2026</p>
            <div className="space-y-1">
              {DEMO_LOGINS.map((d) => (
                <button key={d.email} type="button" onClick={() => useDemo(d.email)}
                  className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px]
                             hover:bg-sunken transition-colors duration-150 cursor-pointer">
                  <span className="w-[68px] shrink-0 font-medium text-ink">{d.role}</span>
                  <span className="mono text-subtle truncate flex-1">{d.email}</span>
                  <span className="hidden sm:block text-[11.5px] text-subtle shrink-0">{d.note}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
