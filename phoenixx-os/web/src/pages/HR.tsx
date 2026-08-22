import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts';
import {
  Plus, LogIn, LogOut, CalendarDays, Download, Check, X, Clock, Users2, Briefcase,
  TrendingUp, RefreshCw, Star, AlertTriangle,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, time, monthLabel, percent, relative, money, titleCase, num } from '../lib/format';
import {
  Avatar, AvatarWithName, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input,
  Meter, Modal, PageHeader, Select, Stat, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR,
  Tabs, Textarea, useToast, cx,
} from '../components/ui';

/** Module C — attendance, leave, performance and hiring. */
export default function HR() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') || 'attendance');
  const { can } = useAuth();

  const setTabAndUrl = (id: string) => {
    setTab(id);
    const next = new URLSearchParams(params); next.set('tab', id); setParams(next, { replace: true });
  };

  const tabs = [
    { id: 'attendance', label: 'Attendance', module: 'hr_attendance' },
    { id: 'leave', label: 'Leave & permissions', module: 'hr_leave' },
    { id: 'performance', label: 'Performance', module: 'hr_performance' },
    { id: 'hiring', label: 'Hiring', module: 'hr_hiring' },
  ].filter((t) => can(t.module, 'view'));

  return (
    <>
      <PageHeader
        title="People"
        subtitle="Attendance, leave, monthly performance and the hiring pipeline"
        tabs={<Tabs active={tab} onChange={setTabAndUrl} tabs={tabs} />}
      />
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'leave' && <LeaveTab />}
      {tab === 'performance' && <PerformanceTab />}
      {tab === 'hiring' && <HiringTab />}
    </>
  );
}

/* ============================================================ ATTENDANCE */
function AttendanceTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [regularizeOpen, setRegularizeOpen] = useState(false);

  const today = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: () => api.get('/hr/attendance/today').then((r) => r.data),
  });

  const register = useQuery({
    queryKey: ['attendance', 'register', month],
    queryFn: () => api.get('/hr/attendance/register', { month }).then((r) => r.data),
  });

  const regs = useQuery({
    queryKey: ['regularizations'],
    queryFn: () => api.get('/hr/attendance/regularizations', { status: 'pending' }).then((r) => r.data),
    enabled: can('hr_attendance', 'approve'),
  });

  const checkIn = useMutation({
    mutationFn: () => api.post('/hr/attendance/check-in', { source: 'web' }),
    onSuccess: () => { toast.success('Checked in.'); qc.invalidateQueries({ queryKey: ['attendance'] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const checkOut = useMutation({
    mutationFn: () => api.post('/hr/attendance/check-out', {}),
    onSuccess: () => { toast.success('Checked out.'); qc.invalidateQueries({ queryKey: ['attendance'] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      api.post(`/hr/attendance/regularizations/${id}/decide`, { decision }),
    onSuccess: () => {
      toast.success('Decision recorded.');
      qc.invalidateQueries({ queryKey: ['regularizations'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
    },
  });

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });

  const me = today.data?.me;
  const reg = register.data;

  const statusColor = (s?: string | null) => ({
    present: 'bg-[var(--positive)]', wfh: 'bg-[var(--info)]', half_day: 'bg-[var(--warning)]',
    leave: 'bg-[var(--brand)]', absent: 'bg-[var(--negative)]', weekoff: 'bg-[var(--border)]',
  }[s || ''] || 'bg-transparent border border-line');

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[300px_1fr] mb-5">
        <Card>
          <CardHeader title="Today" subtitle={date(new Date().toISOString(), 'long')} icon={<Clock size={16} />} />
          <div className="p-4">
            {!me?.check_in_at ? (
              <>
                <p className="text-[13.5px] text-muted mb-3">You have not checked in yet.</p>
                <Button variant="accent" className="w-full justify-center" icon={<LogIn size={15} />}
                  loading={checkIn.isPending} onClick={() => checkIn.mutate()}>Check in</Button>
              </>
            ) : !me?.check_out_at ? (
              <>
                <p className="text-[13.5px] text-muted">Checked in at <strong className="text-ink">{time(me.check_in_at)}</strong></p>
                {me.late_minutes > 0 && (
                  <p className="mt-1 text-[12.5px] text-[var(--warning)]">{me.late_minutes} minutes after shift start</p>
                )}
                <Button className="w-full justify-center mt-3" icon={<LogOut size={15} />}
                  loading={checkOut.isPending} onClick={() => checkOut.mutate()}>Check out</Button>
              </>
            ) : (
              <>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-[13px] text-subtle">Hours logged</span>
                  <span className="text-[20px] font-semibold text-ink tabular">
                    {Math.floor(me.work_minutes / 60)}h {me.work_minutes % 60}m
                  </span>
                </div>
                <p className="text-[12.5px] text-subtle">{time(me.check_in_at)} → {time(me.check_out_at)}</p>
                <Badge tone="positive" dot className="mt-2">Day complete</Badge>
              </>
            )}
            <Button variant="ghost" size="sm" className="w-full justify-center mt-3"
              onClick={() => setRegularizeOpen(true)}>Request a regularization</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Who is in today"
            subtitle={`${today.data?.team?.length || 0} present · ${today.data?.absent?.length || 0} not marked`}
            icon={<Users2 size={16} />} />
          <div className="p-4">
            {!today.data?.team?.length && !today.data?.absent?.length ? (
              <EmptyState compact title="No attendance recorded today" />
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {today.data?.team?.map((a: any) => (
                    <span key={a.id} className="flex items-center gap-2 rounded-full border border-line bg-raised px-2.5 py-1">
                      <Avatar name={a.name} url={a.avatar_url} size={22} />
                      <span className="text-[12.5px] text-ink">{a.name}</span>
                      <span className="text-[11px] text-subtle tabular">{time(a.check_in_at)}</span>
                      {a.check_out_at && <span className="h-1.5 w-1.5 rounded-full bg-[var(--ink-subtle)]" aria-label="checked out" />}
                    </span>
                  ))}
                </div>
                {today.data?.absent?.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-line">
                    <p className="label-cap mb-2">Not marked yet</p>
                    <div className="flex flex-wrap gap-2">
                      {today.data.absent.map((u: any) => (
                        <span key={u.id} className="flex items-center gap-1.5 rounded-full border border-dashed border-line px-2.5 py-1 text-[12.5px] text-subtle">
                          <Avatar name={u.name} size={18} /> {u.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      {can('hr_attendance', 'approve') && regs.data?.length > 0 && (
        <Card className="mb-5 border-l-4 border-l-[var(--accent-bg)]">
          <CardHeader title="Regularization requests" subtitle={`${regs.data.length} waiting on a decision`} />
          <Table>
            <THead>
              <tr><TH>Employee</TH><TH width="120px">Date</TH><TH>Reason</TH><TH width="140px">Requested</TH><TH width="150px" /></tr>
            </THead>
            <tbody>
              {regs.data.map((r: any) => (
                <TR key={r.id}>
                  <TD><AvatarWithName name={r.user_name} url={r.avatar_url} size={26} /></TD>
                  <TD><span className="text-muted text-[13px]">{date(r.work_date)}</span></TD>
                  <TD><span className="text-muted text-[13px]">{r.reason}</span></TD>
                  <TD><span className="text-subtle text-[12.5px]">{relative(r.created_at)}</span></TD>
                  <TD>
                    <span className="flex gap-2">
                      <Button size="sm" icon={<Check size={13} />}
                        onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>Approve</Button>
                      <Button size="sm" variant="ghost" icon={<X size={13} />}
                        onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}>Reject</Button>
                    </span>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card>
        <CardHeader title="Monthly register" subtitle={monthLabel(month)} icon={<CalendarDays size={16} />}
          action={
            <div className="flex gap-2">
              <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" className="h-8 w-[140px] text-[13px]">
                {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </Select>
              {can('hr_attendance', 'export') && (
                <Button size="sm" icon={<Download size={14} />}
                  onClick={() => api.download('/hr/attendance/export', `attendance-${month}.csv`, { month })}>
                  Export
                </Button>
              )}
            </div>
          } />

        {register.isLoading ? <TableSkeleton cols={8} />
          : !reg?.rows?.length ? <EmptyState compact title="No attendance data for this month" />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-sunken">
                    <tr>
                      <th className="label-cap px-3 py-2 text-left border-b border-line sticky left-0 bg-sunken z-10 min-w-[170px]">
                        Employee
                      </th>
                      {reg.days.map((d: any) => (
                        <th key={d.date}
                          className={cx('label-cap px-1 py-2 text-center border-b border-line min-w-[26px]',
                            d.weekend && 'text-subtle/60')}>
                          {Number(d.date.slice(-2))}
                        </th>
                      ))}
                      <th className="label-cap px-3 py-2 text-right border-b border-line min-w-[110px]">Attendance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reg.rows.map((row: any) => (
                      <tr key={row.user.id} className="row-hover">
                        <td className="px-3 py-2 border-b border-line sticky left-0 bg-raised z-10">
                          <AvatarWithName name={row.user.name} url={row.user.avatar_url} sub={row.user.designation} size={26} />
                        </td>
                        {row.cells.map((c: any) => (
                          <td key={c.date} className="px-1 py-2 border-b border-line text-center">
                            <span
                              title={`${date(c.date)} — ${c.status || 'not marked'}${c.work_minutes ? ` · ${Math.floor(c.work_minutes / 60)}h${c.work_minutes % 60}m` : ''}`}
                              className={cx('inline-block h-4 w-4 rounded-sm', statusColor(c.status))}
                              aria-label={`${date(c.date)}: ${c.status || 'not marked'}`}
                            />
                          </td>
                        ))}
                        <td className="px-3 py-2 border-b border-line text-right">
                          <span className="flex items-center gap-2 justify-end">
                            <Meter value={row.summary.attendance_pct}
                              tone={row.summary.attendance_pct >= 95 ? 'positive' : row.summary.attendance_pct >= 85 ? 'warning' : 'negative'}
                              className="w-12" />
                            <span className="tabular text-[13px] w-10 text-right font-medium">
                              {percent(row.summary.attendance_pct)}
                            </span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

        <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-line px-4 py-2.5 text-[12px] text-subtle">
          {[['present', 'Present'], ['wfh', 'WFH'], ['half_day', 'Half day'], ['leave', 'Leave'], ['absent', 'Absent'], ['weekoff', 'Week off']]
            .map(([key, label]) => (
              <span key={key} className="flex items-center gap-1.5">
                <span className={cx('h-3 w-3 rounded-sm', statusColor(key))} aria-hidden />
                {label}
              </span>
            ))}
        </div>
      </Card>

      {regularizeOpen && <RegularizeModal onClose={() => setRegularizeOpen(false)} />}
    </>
  );
}

function RegularizeModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    work_date: new Date().toISOString().slice(0, 10),
    requested_in: '09:30', requested_out: '18:30', requested_status: 'present', reason: '',
  });

  const submit = useMutation({
    mutationFn: () => api.post('/hr/attendance/regularize', {
      work_date: form.work_date,
      requested_in: `${form.work_date}T${form.requested_in}:00.000Z`,
      requested_out: `${form.work_date}T${form.requested_out}:00.000Z`,
      requested_status: form.requested_status,
      reason: form.reason.trim(),
    }),
    onSuccess: () => {
      toast.success('Request sent to your reporting manager.');
      qc.invalidateQueries({ queryKey: ['regularizations'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Request a regularization" size="sm"
      subtitle="For a day you forgot to mark, or where the recorded times are wrong"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={submit.isPending} disabled={form.reason.trim().length < 5}
            onClick={() => submit.mutate()}>Send request</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Date" required>
          <Input type="date" value={form.work_date} max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setForm((f) => ({ ...f, work_date: e.target.value }))} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="In">
            <Input type="time" value={form.requested_in} onChange={(e) => setForm((f) => ({ ...f, requested_in: e.target.value }))} />
          </Field>
          <Field label="Out">
            <Input type="time" value={form.requested_out} onChange={(e) => setForm((f) => ({ ...f, requested_out: e.target.value }))} />
          </Field>
          <Field label="Mark as">
            <Select value={form.requested_status} onChange={(e) => setForm((f) => ({ ...f, requested_status: e.target.value }))}>
              <option value="present">Present</option>
              <option value="wfh">WFH</option>
              <option value="half_day">Half day</option>
            </Select>
          </Field>
        </div>
        <Field label="Reason" required hint="Your manager sees this when deciding">
          <Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={3}
            placeholder="Was at the client site all day and could not check in." />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================= LEAVE */
function LeaveTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, user } = useAuth();
  const [applyOpen, setApplyOpen] = useState(false);
  const [status, setStatus] = useState('');

  const requests = useQuery({
    queryKey: ['leave-requests', status],
    queryFn: () => api.get('/hr/leave/requests', { status, limit: 100 }).then((r) => r.data),
  });
  const balances = useQuery({
    queryKey: ['leave-balances'],
    queryFn: () => api.get('/hr/leave/balances').then((r) => r.data),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      api.post(`/hr/leave/requests/${id}/decide`, { decision }),
    onSuccess: () => {
      toast.success('Decision recorded and the employee notified.');
      qc.invalidateQueries({ queryKey: ['leave-requests'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-5">
        {balances.data?.map((b: any) => (
          <Card key={b.leave_type_id} className="p-3.5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: b.color }} aria-hidden />
              <span className="label-cap truncate">{b.name}</span>
            </div>
            <p className="mt-1.5 text-[20px] font-semibold text-ink tabular">{b.available}</p>
            <p className="text-[12px] text-subtle">of {b.entitled} · {b.used} used</p>
            <Meter value={b.used} max={b.entitled || 1} tone={b.used / (b.entitled || 1) > 0.8 ? 'warning' : 'brand'} className="mt-2" />
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="Leave & permission requests" icon={<CalendarDays size={16} />}
          action={
            <div className="flex gap-2">
              <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="h-8 w-[130px] text-[13px]">
                <option value="">All</option>
                {['pending', 'approved', 'rejected', 'withdrawn'].map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
              <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setApplyOpen(true)}>Apply</Button>
            </div>
          } />

        {requests.isLoading ? <TableSkeleton cols={6} />
          : !requests.data?.length ? (
            <EmptyState compact icon={<CalendarDays size={18} />} title="No requests"
              message="Leave and hourly permission requests appear here." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Employee</TH>
                  <TH width="150px">Type</TH>
                  <TH width="190px">Dates</TH>
                  <TH width="70px">Days</TH>
                  <TH>Reason</TH>
                  <TH width="180px">Status</TH>
                </tr>
              </THead>
              <tbody>
                {requests.data.map((r: any) => (
                  <TR key={r.id}>
                    <TD><AvatarWithName name={r.user_name} url={r.avatar_url} size={26} /></TD>
                    <TD>
                      <span className="flex items-center gap-1.5 text-[13px] text-muted">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: r.color }} aria-hidden />
                        {r.leave_type_name}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-[13px] text-ink">
                        {r.from_date === r.to_date ? date(r.from_date) : `${date(r.from_date, 'day')} – ${date(r.to_date)}`}
                      </span>
                      <span className="block text-[11.5px] text-subtle">{relative(r.from_date)}</span>
                    </TD>
                    <TD><span className="tabular text-muted">{r.days}</span></TD>
                    <TD><span className="text-muted text-[13px] line-clamp-1">{r.reason}</span></TD>
                    <TD>
                      {r.status === 'pending' && can('hr_leave', 'approve') && r.user_id !== user?.id ? (
                        <span className="flex gap-2">
                          <Button size="sm" icon={<Check size={13} />}
                            onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>Approve</Button>
                          <Button size="sm" variant="ghost" icon={<X size={13} />}
                            onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}>Reject</Button>
                        </span>
                      ) : (
                        <span>
                          <StatusBadge status={r.status} />
                          {r.approver_name && r.status !== 'pending' && (
                            <span className="block text-[11.5px] text-subtle mt-0.5">by {r.approver_name}</span>
                          )}
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
      </Card>

      {applyOpen && <ApplyLeaveModal onClose={() => setApplyOpen(false)} />}
    </>
  );
}

function ApplyLeaveModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    leave_type_id: '', kind: 'leave', from_date: '', to_date: '', reason: '',
  });

  const { data: types } = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => api.get('/hr/leave/types').then((r) => r.data),
  });

  const apply = useMutation({
    mutationFn: () => api.post('/hr/leave/requests', {
      leave_type_id: form.leave_type_id,
      kind: form.kind,
      from_date: form.from_date,
      to_date: form.to_date || form.from_date,
      reason: form.reason.trim(),
    }),
    onSuccess: () => {
      toast.success('Request sent to your reporting manager.');
      qc.invalidateQueries({ queryKey: ['leave-requests'] });
      qc.invalidateQueries({ queryKey: ['leave-balances'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const days = form.from_date && form.to_date
    ? Math.max(1, Math.round((new Date(form.to_date).getTime() - new Date(form.from_date).getTime()) / 86_400_000) + 1)
    : form.from_date ? 1 : 0;

  return (
    <Modal open onClose={onClose} title="Apply for leave"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={apply.isPending}
            disabled={!form.leave_type_id || !form.from_date || form.reason.trim().length < 3}
            onClick={() => apply.mutate()}>
            Submit{days > 0 && ` · ${days} day${days === 1 ? '' : 's'}`}
          </Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Leave type" required>
            <Select value={form.leave_type_id} onChange={(e) => setForm((f) => ({ ...f, leave_type_id: e.target.value }))} autoFocus>
              <option value="">Select…</option>
              {types?.map((t: any) => (
                <option key={t.id} value={t.id}>{t.name}{t.paid ? '' : ' (unpaid)'}</option>
              ))}
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
              <option value="leave">Full day leave</option>
              <option value="permission">Hourly permission</option>
            </Select>
          </Field>
          <Field label="From" required>
            <Input type="date" value={form.from_date}
              onChange={(e) => setForm((f) => ({ ...f, from_date: e.target.value, to_date: f.to_date || e.target.value }))} />
          </Field>
          <Field label="To" required>
            <Input type="date" value={form.to_date} min={form.from_date}
              onChange={(e) => setForm((f) => ({ ...f, to_date: e.target.value }))} />
          </Field>
        </div>
        <Field label="Reason" required>
          <Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={3}
            placeholder="Family function out of town." />
        </Field>
      </div>
    </Modal>
  );
}

/* =========================================================== PERFORMANCE */
function PerformanceTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [reviewing, setReviewing] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['performance', month],
    queryFn: () => api.get('/hr/performance', { month }).then((r) => r.data),
  });

  const generate = useMutation({
    mutationFn: () => api.post('/hr/performance/generate', { month }),
    onSuccess: (res: any) => {
      toast.success(`${res.data.generated} review(s) recomputed from source records.`);
      qc.invalidateQueries({ queryKey: ['performance'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" className="w-[150px]">
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </Select>
        {can('hr_performance', 'create') && (
          <Button className="ml-auto" icon={<RefreshCw size={15} className={generate.isPending ? 'animate-spin' : ''} />}
            loading={generate.isPending} onClick={() => generate.mutate()}>
            Recompute from data
          </Button>
        )}
      </div>

      {isLoading ? <Card><TableSkeleton cols={6} /></Card>
        : !data?.length ? (
          <Card>
            <EmptyState icon={<TrendingUp size={20} />} title={`No reviews for ${monthLabel(month)}`}
              message="Completion, attendance and KPI achievement are computed from real records — generate them here."
              action={can('hr_performance', 'create')
                ? <Button variant="primary" loading={generate.isPending} onClick={() => generate.mutate()}>Generate reviews</Button>
                : undefined} />
          </Card>
        ) : (
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH>Employee</TH>
                  <TH align="right" width="130px">Items</TH>
                  <TH width="150px">Completion</TH>
                  <TH width="150px">Attendance</TH>
                  <TH align="right" width="100px">KPI score</TH>
                  <TH width="120px">Rating</TH>
                  <TH width="120px">Status</TH>
                </tr>
              </THead>
              <tbody>
                {data.map((r: any) => (
                  <TR key={r.id} onClick={() => setReviewing(r)}>
                    <TD><AvatarWithName name={r.user_name} url={r.avatar_url} sub={r.designation} size={28} /></TD>
                    <TD align="right">
                      <span className="tabular">{r.items_completed}/{r.items_assigned}</span>
                      <span className="block text-[11.5px] text-subtle">{r.items_on_time} on time</span>
                    </TD>
                    <TD>
                      <span className="flex items-center gap-2">
                        <Meter value={r.completion_pct}
                          tone={r.completion_pct >= 90 ? 'positive' : r.completion_pct >= 70 ? 'warning' : 'negative'}
                          className="w-16" />
                        <span className="tabular text-[13px] w-10 text-right">{percent(r.completion_pct)}</span>
                      </span>
                    </TD>
                    <TD>
                      <span className="flex items-center gap-2">
                        <Meter value={r.attendance_pct}
                          tone={r.attendance_pct >= 95 ? 'positive' : r.attendance_pct >= 85 ? 'warning' : 'negative'}
                          className="w-16" />
                        <span className="tabular text-[13px] w-10 text-right">{percent(r.attendance_pct)}</span>
                      </span>
                    </TD>
                    <TD align="right" className="font-medium">{num(r.kpi_score, 1)}</TD>
                    <TD>
                      {r.manager_rating ? (
                        <span className="flex items-center gap-0.5" aria-label={`${r.manager_rating} out of 5`}>
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star key={i} size={13}
                              className={i < Math.round(r.manager_rating) ? 'fill-[var(--accent-bg)] text-[var(--accent-bg)]' : 'text-line-strong'} />
                          ))}
                        </span>
                      ) : <span className="text-subtle text-[13px]">not rated</span>}
                    </TD>
                    <TD><StatusBadge status={r.status} /></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

      {reviewing && <ReviewModal review={reviewing} onClose={() => setReviewing(null)} />}
    </>
  );
}

function ReviewModal({ review, onClose }: { review: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [rating, setRating] = useState(review.manager_rating || 0);
  const [strengths, setStrengths] = useState(review.strengths || '');
  const [improvements, setImprovements] = useState(review.improvements || '');

  const { data: history } = useQuery({
    queryKey: ['performance-history', review.user_id],
    queryFn: () => api.get(`/hr/performance/history/${review.user_id}`).then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: () => api.patch(`/hr/performance/${review.id}`, {
      manager_rating: rating || undefined,
      strengths: strengths || null,
      improvements: improvements || null,
      status: 'submitted',
    }),
    onSuccess: () => {
      toast.success('Review saved.');
      qc.invalidateQueries({ queryKey: ['performance'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const editable = can('hr_performance', 'edit');

  return (
    <Modal open onClose={onClose} title={`${review.user_name} · ${monthLabel(review.period_month)}`} size="lg"
      subtitle="The data half is computed; the rating and notes are yours"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {editable && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save review</Button>}
        </>
      }>
      <div className="space-y-5">
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <Stat label="Completion" value={percent(review.completion_pct)} />
          <Stat label="On time" value={`${review.items_on_time}/${review.items_completed}`} />
          <Stat label="Attendance" value={percent(review.attendance_pct)} />
          <Stat label="KPI score" value={num(review.kpi_score, 1)} />
        </div>

        {history?.length > 2 && (
          <div>
            <p className="label-cap mb-2">Trend</p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={history.map((h: any) => ({ ...h, label: monthLabel(h.period_month).split(' ')[0] }))}
                margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={32} />
                <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="completion_pct" name="Completion" stroke="#1e40af" strokeWidth={2} dot={{ r: 2.5 }} />
                <Line type="monotone" dataKey="attendance_pct" name="Attendance" stroke="#15803d" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {review.kpis?.length > 0 && (
          <div>
            <p className="label-cap mb-2">KPI / KRA achievement</p>
            <Table>
              <THead>
                <tr><TH>Metric</TH><TH align="right" width="90px">Target</TH><TH align="right" width="90px">Actual</TH><TH width="140px">Achievement</TH></tr>
              </THead>
              <tbody>
                {review.kpis.map((k: any) => (
                  <tr key={k.id} className="border-b border-line last:border-0">
                    <TD className="font-medium">{k.kpi_name}</TD>
                    <TD align="right">{k.target_value ?? '—'}</TD>
                    <TD align="right">{k.actual_value != null ? num(k.actual_value, 1) : '—'}</TD>
                    <TD>
                      {k.achievement_pct != null ? (
                        <span className="flex items-center gap-2">
                          <Meter value={Math.min(100, k.achievement_pct)}
                            tone={k.achievement_pct >= 100 ? 'positive' : k.achievement_pct >= 80 ? 'warning' : 'negative'}
                            className="w-14" />
                          <span className="tabular text-[13px]">{percent(k.achievement_pct)}</span>
                        </span>
                      ) : <span className="text-subtle text-[13px]">manual</span>}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {editable && (
          <>
            <Field label="Manager rating" hint="Blended 30% with the computed KPI score for the overall">
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" onClick={() => setRating(n)}
                    aria-label={`${n} out of 5`} className="cursor-pointer p-0.5">
                    <Star size={24} className={cx('transition-colors duration-150',
                      n <= rating ? 'fill-[var(--accent-bg)] text-[var(--accent-bg)]' : 'text-line-strong hover:text-[var(--accent-bg)]')} />
                  </button>
                ))}
                {rating > 0 && <span className="ml-2 text-[13px] text-muted">{rating} of 5</span>}
              </div>
            </Field>
            <Field label="What went well">
              <Textarea value={strengths} onChange={(e) => setStrengths(e.target.value)} rows={3} />
            </Field>
            <Field label="What to improve next month">
              <Textarea value={improvements} onChange={(e) => setImprovements(e.target.value)} rows={3} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ================================================================ HIRING */
function HiringTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [roleOpen, setRoleOpen] = useState(false);
  const [candidateOpen, setCandidateOpen] = useState(false);

  const openings = useQuery({
    queryKey: ['job-openings'],
    queryFn: () => api.get('/hr/hiring/openings').then((r) => r.data),
  });
  const board = useQuery({
    queryKey: ['candidates'],
    queryFn: () => api.get('/hr/hiring/candidates').then((r) => r.data),
  });

  const moveStage = useMutation({
    mutationFn: ({ id, stage, reason }: { id: string; stage: string; reason?: string }) =>
      api.patch(`/hr/hiring/candidates/${id}`, { stage, ...(reason ? { rejected_reason: reason } : {}) }),
    onSuccess: () => {
      toast.success('Candidate moved.');
      qc.invalidateQueries({ queryKey: ['candidates'] });
      qc.invalidateQueries({ queryKey: ['job-openings'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="text-[15px] font-semibold text-ink">Open roles</h2>
        {can('hr_hiring', 'create') && (
          <div className="ml-auto flex gap-2">
            <Button icon={<Plus size={15} />} onClick={() => setCandidateOpen(true)}>Add candidate</Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setRoleOpen(true)}>New role</Button>
          </div>
        )}
      </div>

      {openings.isLoading ? <Card className="mb-5"><TableSkeleton cols={5} /></Card>
        : !openings.data?.length ? (
          <Card className="mb-5">
            <EmptyState compact icon={<Briefcase size={18} />} title="No open roles"
              message="Define the qualification standard and experience band before sourcing." />
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 mb-6">
            {openings.data.map((j: any) => (
              <Card key={j.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-[14.5px] font-semibold text-ink">{j.title}</h3>
                    <p className="text-[12.5px] text-subtle">{j.service_line_name || j.department} · {j.location}</p>
                  </div>
                  <StatusBadge status={j.status} />
                </div>
                <div className="mt-3 flex items-center gap-4 text-[12.5px]">
                  <span className="text-muted">
                    <span className="tabular font-semibold text-ink">{j.filled}/{j.headcount}</span> filled
                  </span>
                  <span className="text-muted">
                    <span className="tabular font-semibold text-ink">{j.candidate_count}</span> candidates
                  </span>
                  <span className="text-muted">{j.experience_min_years}–{j.experience_max_years || '+'} yrs</span>
                </div>
                {j.salary_min_minor && (
                  <p className="mt-1.5 text-[12.5px] text-subtle">
                    {money(j.salary_min_minor, { compact: true })} – {money(j.salary_max_minor, { compact: true })} per month
                  </p>
                )}
                {j.qualification && (
                  <p className="mt-2 text-[12px] text-subtle leading-snug line-clamp-2">{j.qualification}</p>
                )}
                {j.skills?.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {j.skills.slice(0, 5).map((s: string) => <Badge key={s} tone="neutral">{s}</Badge>)}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}

      <h2 className="text-[15px] font-semibold text-ink mb-3">Candidate pipeline</h2>
      {board.isLoading ? (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-48" />)}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {board.data?.map((col: any) => (
            <section key={col.stage} className="min-w-0">
              <header className="flex items-center justify-between px-1 pb-2">
                <h3 className="text-[13px] font-semibold text-ink capitalize">{col.stage}</h3>
                <span className="text-[11.5px] text-subtle tabular">{col.count}</span>
              </header>
              <div className="space-y-2">
                {!col.candidates.length && (
                  <div className="rounded-lg border border-dashed border-line py-5 text-center text-[12px] text-subtle">
                    Empty
                  </div>
                )}
                {col.candidates.map((c: any) => (
                  <article key={c.id} className="card p-3">
                    <div className="flex items-start gap-2">
                      <Avatar name={c.name} size={26} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-ink truncate">{c.name}</p>
                        <p className="text-[11.5px] text-subtle truncate">{c.job_title || 'Unassigned'}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-[11.5px] text-subtle">
                      {c.experience_years} yrs
                      {c.expected_ctc_minor ? ` · expects ${money(c.expected_ctc_minor, { compact: true })}` : ''}
                    </p>
                    {c.rating && (
                      <span className="mt-1.5 flex gap-0.5" aria-label={`${c.rating} out of 5`}>
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star key={i} size={11}
                            className={i < c.rating ? 'fill-[var(--accent-bg)] text-[var(--accent-bg)]' : 'text-line-strong'} />
                        ))}
                      </span>
                    )}
                    {can('hr_hiring', 'edit') && !['hired', 'rejected'].includes(c.stage) && (
                      <Select aria-label={`Move ${c.name}`} value={c.stage} className="mt-2.5 h-7 text-[12px]"
                        onChange={(e) => {
                          const stage = e.target.value;
                          if (stage === 'rejected') {
                            const reason = window.prompt('Reason for rejecting this candidate?');
                            if (!reason) return;
                            moveStage.mutate({ id: c.id, stage, reason });
                          } else moveStage.mutate({ id: c.id, stage });
                        }}>
                        {['sourced', 'screened', 'interview', 'offer', 'hired', 'rejected'].map((s) => (
                          <option key={s} value={s}>{titleCase(s)}</option>
                        ))}
                      </Select>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {roleOpen && <RoleModal onClose={() => setRoleOpen(false)} />}
      {candidateOpen && <CandidateModal openings={openings.data || []} onClose={() => setCandidateOpen(false)} />}
    </>
  );
}

function RoleModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    title: '', service_line_id: '', department: '', qualification: '', skills: '',
    experience_min_years: '2', experience_max_years: '5', headcount: '1',
    salary_min: '', salary_max: '', location: 'Coimbatore',
  });

  const { data: serviceLines } = useQuery({
    queryKey: ['service-lines'],
    queryFn: () => api.get('/settings/service-lines').then((r) => r.data),
    staleTime: 300_000,
  });

  const create = useMutation({
    mutationFn: () => api.post('/hr/hiring/openings', {
      title: form.title.trim(),
      service_line_id: form.service_line_id || null,
      department: form.department || null,
      qualification: form.qualification || null,
      skills: form.skills.split(',').map((s) => s.trim()).filter(Boolean),
      experience_min_years: Number(form.experience_min_years),
      experience_max_years: form.experience_max_years ? Number(form.experience_max_years) : null,
      headcount: Number(form.headcount),
      salary_min_minor: form.salary_min ? Math.round(Number(form.salary_min) * 100) : null,
      salary_max_minor: form.salary_max ? Math.round(Number(form.salary_max) * 100) : null,
      location: form.location || null,
    }),
    onSuccess: () => {
      toast.success('Role opened.');
      qc.invalidateQueries({ queryKey: ['job-openings'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title="Open a role" size="lg"
      subtitle="Qualification standard and experience band are part of the definition, not an afterthought"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={form.title.trim().length < 2}
            onClick={() => create.mutate()}>Open role</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" required>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)}
              placeholder="Performance Marketer" autoFocus />
          </Field>
          <Field label="Service line">
            <Select value={form.service_line_id} onChange={(e) => set('service_line_id', e.target.value)}>
              <option value="">Not specific</option>
              {serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Qualification standard" hint="What a candidate must have to be considered">
          <Textarea value={form.qualification} onChange={(e) => set('qualification', e.target.value)} rows={2}
            placeholder="Graduate in marketing or equivalent; Google Ads certification preferred." />
        </Field>
        <Field label="Skills" hint="Comma separated">
          <Input value={form.skills} onChange={(e) => set('skills', e.target.value)}
            placeholder="Google Ads, Meta Ads, GA4, Copywriting" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Min experience (yrs)">
            <Input type="number" min={0} step={0.5} value={form.experience_min_years}
              onChange={(e) => set('experience_min_years', e.target.value)} />
          </Field>
          <Field label="Max experience (yrs)">
            <Input type="number" min={0} step={0.5} value={form.experience_max_years}
              onChange={(e) => set('experience_max_years', e.target.value)} />
          </Field>
          <Field label="Headcount">
            <Input type="number" min={1} value={form.headcount} onChange={(e) => set('headcount', e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Salary from (₹/month)">
            <Input type="number" min={0} step={1000} value={form.salary_min} onChange={(e) => set('salary_min', e.target.value)} />
          </Field>
          <Field label="Salary to (₹/month)">
            <Input type="number" min={0} step={1000} value={form.salary_max} onChange={(e) => set('salary_max', e.target.value)} />
          </Field>
          <Field label="Location">
            <Input value={form.location} onChange={(e) => set('location', e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function CandidateModal({ openings, onClose }: { openings: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '', email: '', phone: '', job_opening_id: '', source: 'naukri',
    experience_years: '', expected_ctc: '', notes: '',
  });

  const create = useMutation({
    mutationFn: () => api.post('/hr/hiring/candidates', {
      name: form.name.trim(),
      email: form.email || null,
      phone: form.phone || null,
      job_opening_id: form.job_opening_id || null,
      source: form.source,
      experience_years: form.experience_years ? Number(form.experience_years) : null,
      expected_ctc_minor: form.expected_ctc ? Math.round(Number(form.expected_ctc) * 100) : null,
      notes: form.notes || null,
    }),
    onSuccess: () => {
      toast.success('Candidate added to the pipeline.');
      qc.invalidateQueries({ queryKey: ['candidates'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title="Add a candidate"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={form.name.trim().length < 2}
            onClick={() => create.mutate()}>Add candidate</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Field>
          <Field label="Role">
            <Select value={form.job_opening_id} onChange={(e) => set('job_opening_id', e.target.value)}>
              <option value="">Unassigned</option>
              {openings.map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}
            </Select>
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Experience (years)">
            <Input type="number" min={0} step={0.5} value={form.experience_years}
              onChange={(e) => set('experience_years', e.target.value)} />
          </Field>
          <Field label="Expected (₹/month)">
            <Input type="number" min={0} step={1000} value={form.expected_ctc}
              onChange={(e) => set('expected_ctc', e.target.value)} />
          </Field>
        </div>
        <Field label="Source">
          <Select value={form.source} onChange={(e) => set('source', e.target.value)}>
            {['naukri', 'linkedin', 'referral', 'walk_in', 'agency', 'website'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
