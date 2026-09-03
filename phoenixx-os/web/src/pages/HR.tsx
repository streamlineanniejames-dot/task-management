import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts';
import {
  Plus, LogIn, LogOut, CalendarDays, CalendarOff, Download, Check, X, Clock, Users2, Briefcase,
  TrendingUp, RefreshCw, Star, AlertTriangle, Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  date, dateTime, time, monthLabel, percent, relative, money, titleCase, num, clockTime,
} from '../lib/format';
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
/**
 * The six things a day can be, in the order the register decides them. Each
 * carries its own colour *and* its own word - the swatch is a shortcut for
 * people who already know the grid, never the only way to read it.
 */
const ATTENDANCE_STATUS: Record<string, { label: string; swatch: string; tone: any }> = {
  present: { label: 'Present', swatch: 'bg-[var(--positive)]', tone: 'positive' },
  wfh: { label: 'Work from home', swatch: 'bg-[var(--info)]', tone: 'info' },
  half_day: { label: 'Half day', swatch: 'bg-[var(--warning)]', tone: 'warning' },
  pending_approval: { label: 'Pending approval', swatch: 'bg-[var(--accent)]', tone: 'accent' },
  not_approved: { label: 'Not approved', swatch: 'bg-[var(--negative)]', tone: 'negative' },
  absent: { label: 'Absent', swatch: 'bg-[var(--negative)]', tone: 'negative' },
  leave: { label: 'Leave', swatch: 'bg-[var(--brand)]', tone: 'brand' },
  holiday: { label: 'Holiday', swatch: 'bg-[#8b5cf6]', tone: 'info' },
  weekoff: { label: 'Weekly off', swatch: 'bg-[var(--border)]', tone: 'neutral' },
};

const statusMeta = (s?: string | null) => ATTENDANCE_STATUS[s || '']
  || { label: 'Not marked', swatch: 'bg-transparent border border-line-strong', tone: 'neutral' as const };

function AttendanceTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const approver = can('hr_attendance', 'approve');

  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [filters, setFilters] = useState({ user_id: '', service_line_id: '', status: '' });
  const [regularizeOpen, setRegularizeOpen] = useState(false);
  const [timingsOpen, setTimingsOpen] = useState(false);
  const [holidaysOpen, setHolidaysOpen] = useState(false);
  const [openDay, setOpenDay] = useState<{ userId: string; date: string } | null>(null);
  const [decide, setDecide] = useState<{ row: any; decision: 'approve' | 'reject' } | null>(null);

  const today = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: () => api.get('/hr/attendance/today').then((r) => r.data),
  });

  const register = useQuery({
    queryKey: ['attendance', 'register', month, filters],
    queryFn: () => api.get('/hr/attendance/register', {
      month,
      ...(filters.user_id ? { user_id: filters.user_id } : {}),
      ...(filters.service_line_id ? { service_line_id: filters.service_line_id } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    }).then((r) => r.data),
  });

  const pending = useQuery({
    queryKey: ['attendance', 'pending'],
    queryFn: () => api.get('/hr/attendance/pending').then((r) => r.data),
    enabled: approver,
  });

  const regs = useQuery({
    queryKey: ['regularizations'],
    queryFn: () => api.get('/hr/attendance/regularizations', { status: 'pending' }).then((r) => r.data),
    enabled: approver,
  });

  const meta = useQuery({
    queryKey: ['attendance', 'filter-meta'],
    queryFn: () => api.get('/hr/work-schedules').then((r) => r.data),
    enabled: approver,
  });

  const serviceLines = useQuery({
    queryKey: ['service-lines'],
    queryFn: () => api.get('/settings/service-lines').then((r) => r.data),
    enabled: approver,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['attendance'] });
    qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
    qc.invalidateQueries({ queryKey: ['home-counters'] });
  };

  const checkIn = useMutation({
    mutationFn: () => api.post('/hr/attendance/check-in', { source: 'web' }),
    onSuccess: (res: any) => {
      toast.success(res?.data?.status === 'pending_approval'
        ? `Checked in at ${res.data.check_in_label} — sent to HR for approval.`
        : `Checked in at ${res?.data?.check_in_label}.`);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const checkOut = useMutation({
    mutationFn: () => api.post('/hr/attendance/check-out', {}),
    onSuccess: (res: any) => { toast.success(`Checked out at ${res?.data?.check_out_label}.`); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const decideReg = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      api.post(`/hr/attendance/regularizations/${id}/decide`, { decision }),
    onSuccess: () => {
      toast.success('Decision recorded.');
      qc.invalidateQueries({ queryKey: ['regularizations'] });
      invalidate();
    },
  });

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });

  const me = today.data?.me;
  const dayKind = today.data?.day_kind;
  const schedule = today.data?.schedule;
  const reg = register.data;
  const totals = reg?.totals;

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[300px_1fr] mb-5">
        {/* ------------------------------------------------------ my day */}
        <Card>
          <CardHeader title="Today" subtitle={date(new Date().toISOString(), 'long')} icon={<Clock size={16} />} />
          <div className="p-4">
            {dayKind && dayKind !== 'working' ? (
              <div className="rounded-lg bg-info-soft p-3">
                <p className="text-[13.5px] font-medium text-ink">
                  {dayKind === 'holiday' ? today.data?.holiday?.name || 'Company holiday' : 'Weekly off'}
                </p>
                <p className="text-[12.5px] text-muted mt-0.5">No check-in needed today.</p>
              </div>
            ) : !me?.check_in_at ? (
              <>
                <p className="text-[13px] text-subtle mb-1">
                  Scheduled <strong className="text-ink tabular">{clockTime(schedule?.start)}</strong>
                </p>
                <p className="text-[13.5px] text-muted mb-3">You have not checked in yet.</p>
                <Button variant="accent" className="w-full justify-center" icon={<LogIn size={15} />}
                  loading={checkIn.isPending} onClick={() => checkIn.mutate()}>Check in</Button>
              </>
            ) : !me?.check_out_at ? (
              <>
                <p className="text-[13px] text-subtle">
                  Scheduled <span className="tabular">{clockTime(schedule?.start)}</span>
                </p>
                <p className="text-[13.5px] text-muted mt-1">
                  Checked in at <strong className="text-ink tabular">{me.check_in_label}</strong>
                </p>
                <Badge tone={statusMeta(me.status).tone} dot className="mt-2">
                  {statusMeta(me.status).label}
                </Badge>
                {me.status === 'pending_approval' && (
                  <p className="mt-2 text-[12.5px] text-[var(--warning)]">
                    {me.late_minutes} min late — awaiting HR approval.
                  </p>
                )}
                <Button className="w-full justify-center mt-3" icon={<LogOut size={15} />}
                  loading={checkOut.isPending} onClick={() => checkOut.mutate()}>Check out</Button>
              </>
            ) : (
              <>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-[13px] text-subtle">Hours logged</span>
                  <span className="text-[20px] font-semibold text-ink tabular">{me.work_hours_label}</span>
                </div>
                <p className="text-[12.5px] text-subtle tabular">{me.check_in_label} → {me.check_out_label}</p>
                <Badge tone={statusMeta(me.status).tone} dot className="mt-2">{statusMeta(me.status).label}</Badge>
              </>
            )}
            <Button variant="ghost" size="sm" className="w-full justify-center mt-3"
              onClick={() => setRegularizeOpen(true)}>Request a regularization</Button>
          </div>
        </Card>

        {/* ------------------------------------------------ who is in today */}
        <Card>
          <CardHeader title="Who is in today"
            subtitle={`${today.data?.team?.length || 0} marked · ${today.data?.absent?.length || 0} not marked`}
            icon={<Users2 size={16} />}
            action={approver && (
              <div className="flex gap-2">
                <Button size="sm" icon={<Clock size={14} />} onClick={() => setTimingsOpen(true)}>Work timings</Button>
                <Button size="sm" icon={<CalendarOff size={14} />} onClick={() => setHolidaysOpen(true)}>Holidays</Button>
              </div>
            )} />
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
                      <span className="text-[11px] text-subtle tabular">{a.check_in_label}</span>
                      {a.status === 'pending_approval' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-label="pending approval" />
                      )}
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

      {/* ------------------------------------------- late check-in approvals */}
      {approver && pending.data?.length > 0 && (
        <Card className="mb-5 border-l-4 border-l-[var(--accent-bg)]">
          <CardHeader title="Late check-ins waiting on you"
            subtitle={`${pending.data.length} day${pending.data.length > 1 ? 's' : ''} stay pending until you decide`}
            icon={<AlertTriangle size={16} />} />
          <Table>
            <THead>
              <tr>
                <TH>Employee</TH><TH width="110px">Date</TH><TH width="110px">Scheduled</TH>
                <TH width="110px">Checked in</TH><TH width="90px">Late by</TH><TH width="180px" />
              </tr>
            </THead>
            <tbody>
              {pending.data.map((r: any) => (
                <TR key={r.id}>
                  <TD><AvatarWithName name={r.user_name} url={r.avatar_url} sub={r.designation} size={26} /></TD>
                  <TD><span className="text-muted text-[13px]">{date(r.work_date)}</span></TD>
                  <TD><span className="text-muted text-[13px] tabular">{r.scheduled_start_label}</span></TD>
                  <TD><span className="font-medium text-ink text-[13px] tabular">{r.check_in_label}</span></TD>
                  <TD><Badge tone="warning">{r.late_minutes}m</Badge></TD>
                  <TD>
                    <span className="flex gap-2">
                      <Button size="sm" variant="primary" icon={<Check size={13} />}
                        onClick={() => setDecide({ row: r, decision: 'approve' })}>Approve</Button>
                      <Button size="sm" variant="ghost" icon={<X size={13} />}
                        onClick={() => setDecide({ row: r, decision: 'reject' })}>Reject</Button>
                    </span>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {approver && regs.data?.length > 0 && (
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
                        onClick={() => decideReg.mutate({ id: r.id, decision: 'approved' })}>Approve</Button>
                      <Button size="sm" variant="ghost" icon={<X size={13} />}
                        onClick={() => decideReg.mutate({ id: r.id, decision: 'rejected' })}>Reject</Button>
                    </span>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* ------------------------------------------------- month at a glance */}
      {totals && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-6 mb-5">
          <Stat label="Working days" value={totals.working_days} icon={<CalendarDays size={15} />}
            sub={`${totals.employees} employee${totals.employees === 1 ? '' : 's'}`} />
          <Stat label="Present" value={totals.present} tone="positive" />
          <Stat label="Absent" value={totals.absent} tone={totals.absent ? 'negative' : 'neutral'} />
          <Stat label="Leave" value={totals.leave} />
          <Stat label="Pending" value={totals.pending} tone={totals.pending ? 'warning' : 'neutral'}
            sub={totals.pending ? 'awaiting HR' : 'nothing waiting'} />
          <Stat label="Holidays" value={totals.holiday ? Math.round(totals.holiday / (totals.employees || 1)) : 0}
            sub={`${Math.round((totals.week_off || 0) / (totals.employees || 1))} weekly off`} />
        </div>
      )}

      {/* --------------------------------------------------- monthly register */}
      <Card>
        <CardHeader title="Monthly register" subtitle={monthLabel(month)} icon={<CalendarDays size={16} />}
          action={
            <div className="flex flex-wrap gap-2">
              {approver && (
                <>
                  <Select value={filters.user_id} aria-label="Employee" className="h-8 w-[150px] text-[13px]"
                    onChange={(e) => setFilters((f) => ({ ...f, user_id: e.target.value }))}>
                    <option value="">All employees</option>
                    {meta.data?.employees?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                  <Select value={filters.service_line_id} aria-label="Team" className="h-8 w-[140px] text-[13px]"
                    onChange={(e) => setFilters((f) => ({ ...f, service_line_id: e.target.value }))}>
                    <option value="">All teams</option>
                    {serviceLines.data?.map((sl: any) => <option key={sl.id} value={sl.id}>{sl.name}</option>)}
                  </Select>
                  <Select value={filters.status} aria-label="Status" className="h-8 w-[150px] text-[13px]"
                    onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                    <option value="">Any status</option>
                    {['present', 'pending_approval', 'not_approved', 'absent', 'half_day', 'leave']
                      .map((k) => <option key={k} value={k}>{ATTENDANCE_STATUS[k].label}</option>)}
                  </Select>
                </>
              )}
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
                          title={d.holiday ? d.holiday.name : d.week_off ? 'Weekly off' : undefined}
                          className={cx('label-cap px-1 py-2 text-center border-b border-line min-w-[26px]',
                            // A weekly off column reads differently from a
                            // working one before anybody looks at a single cell.
                            d.week_off && 'bg-sunken text-subtle/70',
                            d.holiday && 'text-[#8b5cf6]')}>
                          {Number(d.date.slice(-2))}
                        </th>
                      ))}
                      <th className="label-cap px-3 py-2 text-right border-b border-line min-w-[130px]">Present</th>
                      <th className="label-cap px-3 py-2 text-right border-b border-line min-w-[110px]">Attendance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reg.rows.map((row: any) => (
                      <tr key={row.user.id} className="row-hover">
                        <td className="px-3 py-2 border-b border-line sticky left-0 bg-raised z-10">
                          <AvatarWithName name={row.user.name} url={row.user.avatar_url} sub={row.user.designation} size={26} />
                        </td>
                        {row.cells.map((c: any) => {
                          const m = statusMeta(c.status);
                          return (
                            <td key={c.date}
                              className={cx('px-1 py-2 border-b border-line text-center', c.week_off && 'bg-sunken')}>
                              <button
                                type="button"
                                onClick={() => setOpenDay({ userId: row.user.id, date: c.date })}
                                title={`${date(c.date)} — ${m.label}${c.work_minutes ? ` · ${Math.floor(c.work_minutes / 60)}h${String(c.work_minutes % 60).padStart(2, '0')}m` : ''}`}
                                aria-label={`${row.user.name}, ${date(c.date)}: ${m.label}`}
                                className={cx('inline-block h-4 w-4 rounded-sm cursor-pointer align-middle',
                                  'hover:ring-2 hover:ring-[var(--brand)] hover:ring-offset-1 hover:ring-offset-[var(--raised)]',
                                  'focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-shadow',
                                  m.swatch)}
                              />
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 border-b border-line text-right">
                          <span className="tabular text-[13px] font-medium">{row.summary.present_days}</span>
                          <span className="text-subtle text-[12px]"> / {row.summary.working_days}</span>
                          {row.summary.pending > 0 && (
                            <Badge tone="warning" className="ml-1.5">{row.summary.pending} pending</Badge>
                          )}
                        </td>
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
          {['present', 'pending_approval', 'absent', 'leave', 'weekoff', 'holiday', 'half_day', 'wfh']
            .map((key) => (
              <span key={key} className="flex items-center gap-1.5">
                <span className={cx('h-3 w-3 rounded-sm', ATTENDANCE_STATUS[key].swatch)} aria-hidden />
                {ATTENDANCE_STATUS[key].label}
              </span>
            ))}
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm border border-line-strong" aria-hidden />Not marked
          </span>
        </div>
      </Card>

      {regularizeOpen && <RegularizeModal onClose={() => setRegularizeOpen(false)} />}
      {timingsOpen && <WorkTimingsModal onClose={() => setTimingsOpen(false)} />}
      {holidaysOpen && <HolidaysModal onClose={() => setHolidaysOpen(false)} />}
      {openDay && (
        <DayDetailModal userId={openDay.userId} workDate={openDay.date}
          canCorrect={approver} onClose={() => setOpenDay(null)} />
      )}
      {decide && (
        <DecideLateModal row={decide.row} decision={decide.decision} onClose={() => setDecide(null)} />
      )}
    </>
  );
}

/* ------------------------------------------------- HR rules on a late day */
/**
 * Approve is one click with an optional note; reject asks for a reason,
 * because the employee reads it and "not approved" on its own explains
 * nothing to somebody who thought they had a good excuse.
 */
function DecideLateModal({ row, decision, onClose }: {
  row: any; decision: 'approve' | 'reject'; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const rejecting = decision === 'reject';

  const save = useMutation({
    mutationFn: () => api.post(`/hr/attendance/${row.id}/decide`, { decision, note: note.trim() || null }),
    onSuccess: () => {
      toast.success(rejecting ? 'Marked not approved.' : 'Approved — the day counts as present.');
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose}
      title={rejecting ? 'Do not approve this check-in' : 'Approve this check-in'}
      subtitle={`${row.user_name} · ${date(row.work_date)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={rejecting ? 'danger' : 'primary'} loading={save.isPending}
            disabled={rejecting && note.trim().length < 3}
            onClick={() => save.mutate()}>
            {rejecting ? 'Not approved' : 'Approve as present'}
          </Button>
        </>
      }>
      <div className="space-y-4">
        <dl className="grid grid-cols-3 gap-3 rounded-lg bg-sunken p-3.5 text-[13px]">
          <div>
            <dt className="label-cap">Scheduled</dt>
            <dd className="text-ink mt-0.5 tabular">{row.scheduled_start_label}</dd>
          </div>
          <div>
            <dt className="label-cap">Checked in</dt>
            <dd className="text-ink mt-0.5 tabular font-medium">{row.check_in_label}</dd>
          </div>
          <div>
            <dt className="label-cap">Late by</dt>
            <dd className="text-[var(--warning)] mt-0.5 tabular font-medium">{row.late_minutes} min</dd>
          </div>
        </dl>
        <Field label={rejecting ? 'Reason' : 'Note'} required={rejecting}
          hint={rejecting
            ? 'The employee sees this on their My Day.'
            : 'Optional — kept on the record alongside your name.'}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={rejecting
              ? 'No prior notice and no reason given.'
              : 'Told the reporting manager the night before.'} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------ one day, in full */
/**
 * What the register cell is a shorthand for: the schedule, the two stamps, the
 * hours between them, and every change the day has ever seen. HR can also put
 * right a checkout somebody forgot - the one way a stamp moves, and it lands
 * in the history with their name on it.
 */
function DayDetailModal({ userId, workDate, canCorrect, onClose }: {
  userId: string; workDate: string; canCorrect: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [fixing, setFixing] = useState(false);
  const [form, setForm] = useState({ check_in_time: '', check_out_time: '', note: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['attendance', 'day', userId, workDate],
    queryFn: () => api.get('/hr/attendance/day', { user_id: userId, date: workDate }).then((r) => r.data),
  });

  const correct = useMutation({
    mutationFn: () => api.post(`/hr/attendance/${data.attendance.id}/correct`, {
      ...(form.check_in_time ? { check_in_time: form.check_in_time } : {}),
      ...(form.check_out_time ? { check_out_time: form.check_out_time } : {}),
      note: form.note.trim(),
    }),
    onSuccess: () => {
      toast.success('Corrected — the change is on the record.');
      qc.invalidateQueries({ queryKey: ['attendance'] });
      setFixing(false);
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const a = data?.attendance;
  const meta = statusMeta(data?.day_kind === 'holiday' ? 'holiday'
    : data?.day_kind === 'weekoff' ? 'weekoff' : a?.status);

  return (
    <Modal open onClose={onClose} title={data?.user?.name || 'Attendance'}
      subtitle={date(workDate, 'long')}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {canCorrect && a && !fixing && (
            <Button icon={<RefreshCw size={14} />} onClick={() => {
              setForm({
                check_in_time: '', check_out_time: '', note: '',
              });
              setFixing(true);
            }}>Correct this day</Button>
          )}
          {fixing && (
            <Button variant="primary" loading={correct.isPending}
              disabled={form.note.trim().length < 3 || (!form.check_in_time && !form.check_out_time)}
              onClick={() => correct.mutate()}>Save correction</Button>
          )}
        </>
      }>
      {isLoading || !data ? <TableSkeleton rows={3} cols={2} /> : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge tone={meta.tone} dot>{meta.label}</Badge>
            {data.day_kind === 'holiday' && data.holiday && (
              <span className="text-[13px] text-muted">{data.holiday.name}</span>
            )}
            {a?.checkout_missing && <Badge tone="warning">Check-out missing</Badge>}
          </div>

          {data.day_kind !== 'working' ? (
            <p className="text-[13.5px] text-muted">
              Nobody was expected in. {data.day_kind === 'weekoff' ? 'Weekly off.' : 'Company holiday.'}
            </p>
          ) : !a ? (
            <p className="text-[13.5px] text-muted">
              {data.leave
                ? `On approved ${data.leave.leave_type_name || 'leave'} for this day.`
                : 'Nothing was recorded for this day.'}
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-sunken p-3.5 text-[13px]">
              <Detail label="Scheduled"
                value={`${clockTime(a.scheduled_start) || clockTime(data.schedule.start)} – ${clockTime(a.scheduled_end) || clockTime(data.schedule.end)}`} />
              <Detail label="Check-in" value={a.check_in_label} />
              <Detail label="Check-out" value={a.check_out_label || (a.checkout_missing ? 'Missing' : 'Still in')} />
              <Detail label="Working hours" value={a.work_hours_label} />
              {a.late_minutes > 0 && <Detail label="Late by" value={`${a.late_minutes} min`} />}
              {a.approved_by && <Detail label="Decided by" value={data.history.find((h: any) => ['approved', 'rejected', 'corrected'].includes(h.event))?.actor_name} />}
              {a.approved_at && <Detail label="Decided at" value={dateTime(a.approved_at)} />}
              <Detail label="Source" value={a.source} />
            </dl>
          )}

          {a?.approval_note && (
            <p className="rounded-md bg-raised border border-line px-3 py-2 text-[13px] text-muted">
              “{a.approval_note}”
            </p>
          )}

          {fixing && (
            <div className="rounded-lg border border-line bg-sunken p-3 space-y-3">
              <p className="label-cap">Correct the record</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Check-in" hint={a?.check_in_label ? `Now ${a.check_in_label}` : undefined}>
                  <Input type="time" value={form.check_in_time}
                    onChange={(e) => setForm((f) => ({ ...f, check_in_time: e.target.value }))} />
                </Field>
                <Field label="Check-out" hint={a?.check_out_label ? `Now ${a.check_out_label}` : 'Missing'}>
                  <Input type="time" value={form.check_out_time}
                    onChange={(e) => setForm((f) => ({ ...f, check_out_time: e.target.value }))} />
                </Field>
              </div>
              <Field label="Why" required hint="Kept on the day's history under your name.">
                <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder="Forgot to check out — confirmed with the reporting manager." />
              </Field>
            </div>
          )}

          {data.history?.length > 0 && (
            <div>
              <p className="label-cap mb-2">History</p>
              <ul className="space-y-2">
                {data.history.map((h: any) => (
                  <li key={h.id} className="flex items-start gap-2.5 text-[12.5px]">
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--border-strong)] shrink-0" aria-hidden />
                    <span className="min-w-0">
                      <span className="text-ink font-medium capitalize">{h.event.replace('_', ' ')}</span>
                      <span className="text-subtle"> · {h.actor_name || 'system'} · {dateTime(h.at)}</span>
                      {h.note && <span className="block text-muted">{h.note}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- work timings */
/**
 * HR's roster of who is expected when. The workspace default sits at the top
 * because most people are on it; an employee row left blank stays on it, so a
 * later change to the company day still reaches them.
 */
function WorkTimingsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['attendance', 'work-schedules'],
    queryFn: () => api.get('/hr/work-schedules').then((r) => r.data),
  });

  const [ws, setWs] = useState<any>(null);
  const workspace = ws || data?.workspace;

  const saveWorkspace = useMutation({
    mutationFn: (patch: any) => api.patch('/hr/work-schedules', patch),
    onSuccess: () => { toast.success('Workspace hours updated.'); qc.invalidateQueries({ queryKey: ['attendance'] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const saveOne = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: any }) => api.patch(`/hr/work-schedules/${id}`, patch),
    onSuccess: () => { toast.success('Saved.'); qc.invalidateQueries({ queryKey: ['attendance'] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <Modal open onClose={onClose} title="Work timings"
      subtitle="The scheduled start every check-in is measured against"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {isLoading || !workspace ? <TableSkeleton rows={4} cols={3} /> : (
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-sunken p-3">
            <p className="label-cap mb-2.5">Workspace default</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Work start">
                <Input type="time" value={workspace.work_start}
                  onChange={(e) => setWs({ ...workspace, work_start: e.target.value })}
                  onBlur={(e) => saveWorkspace.mutate({ work_start: e.target.value })} />
              </Field>
              <Field label="Work end">
                <Input type="time" value={workspace.work_end}
                  onChange={(e) => setWs({ ...workspace, work_end: e.target.value })}
                  onBlur={(e) => saveWorkspace.mutate({ work_end: e.target.value })} />
              </Field>
              <Field label="Grace" hint="Minutes still on time">
                <Input type="number" min={0} max={240} value={workspace.late_grace_minutes}
                  onChange={(e) => setWs({ ...workspace, late_grace_minutes: Number(e.target.value) })}
                  onBlur={(e) => saveWorkspace.mutate({ late_grace_minutes: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="mt-3">
              <p className="label-cap mb-1.5">Weekly off</p>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d, i) => {
                  const on = workspace.week_off_days.includes(i);
                  return (
                    <button key={d} type="button" aria-pressed={on}
                      onClick={() => {
                        const next = on
                          ? workspace.week_off_days.filter((x: number) => x !== i)
                          : [...workspace.week_off_days, i].sort();
                        setWs({ ...workspace, week_off_days: next });
                        saveWorkspace.mutate({ week_off_days: next });
                      }}
                      className={cx('h-8 min-w-[46px] rounded-md border text-[12.5px] font-medium cursor-pointer',
                        'transition-colors duration-150',
                        on ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                          : 'border-line-strong bg-raised text-subtle hover:bg-sunken')}>
                      {d}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[12.5px] text-subtle">
                Marked days need no check-in and show as a weekly off on the register.
              </p>
            </div>
          </div>

          <div>
            <p className="label-cap mb-2">Per employee</p>
            <Table>
              <THead>
                <tr><TH>Employee</TH><TH width="130px">Work start</TH><TH width="130px">Work end</TH><TH width="90px" /></tr>
              </THead>
              <tbody>
                {data.employees.map((u: any) => (
                  <TR key={u.id}>
                    <TD><AvatarWithName name={u.name} url={u.avatar_url} sub={u.designation} size={26} /></TD>
                    <TD>
                      <Input type="time" defaultValue={u.effective_start} aria-label={`${u.name} work start`}
                        onBlur={(e) => e.target.value !== u.effective_start
                          && saveOne.mutate({ id: u.id, patch: { work_start: e.target.value } })} />
                    </TD>
                    <TD>
                      <Input type="time" defaultValue={u.effective_end} aria-label={`${u.name} work end`}
                        onBlur={(e) => e.target.value !== u.effective_end
                          && saveOne.mutate({ id: u.id, patch: { work_end: e.target.value } })} />
                    </TD>
                    <TD>
                      {u.custom ? (
                        <Button size="sm" variant="ghost"
                          onClick={() => saveOne.mutate({ id: u.id, patch: { work_start: null, work_end: null, grace_minutes: null } })}>
                          Reset
                        </Button>
                      ) : <span className="text-[12px] text-subtle">Default</span>}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- holidays */
/** One date, one name, and it lands on every employee's calendar at once. */
function HolidaysModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [year, setYear] = useState(new Date().getFullYear());
  const [draft, setDraft] = useState({ holiday_date: '', name: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['attendance', 'holidays', year],
    queryFn: () => api.get('/hr/holidays', { year }).then((r) => r.data),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['attendance'] });
  const add = useMutation({
    mutationFn: () => api.post('/hr/holidays', draft),
    onSuccess: () => { toast.success('Holiday added for everyone.'); setDraft({ holiday_date: '', name: '' }); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch(`/hr/holidays/${id}`, { name }),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/hr/holidays/${id}`),
    onSuccess: () => { toast.success('Removed.'); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Company holidays"
      subtitle="Added once, applied to every employee — nobody is expected to check in"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <Field label="Date" className="w-[160px]">
            <Input type="date" value={draft.holiday_date}
              onChange={(e) => setDraft((d) => ({ ...d, holiday_date: e.target.value }))} />
          </Field>
          <Field label="Name" className="flex-1">
            <Input value={draft.name} placeholder="Onam"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          </Field>
          <Button variant="primary" icon={<Plus size={14} />} loading={add.isPending}
            disabled={!draft.holiday_date || draft.name.trim().length < 2}
            onClick={() => add.mutate()}>Add</Button>
        </div>

        <div className="flex items-center justify-between">
          <p className="label-cap">{year}</p>
          <span className="flex gap-2">
            <Button size="sm" onClick={() => setYear((y) => y - 1)}>{year - 1}</Button>
            <Button size="sm" onClick={() => setYear((y) => y + 1)}>{year + 1}</Button>
          </span>
        </div>

        {isLoading ? <TableSkeleton rows={3} cols={2} />
          : !data?.length ? <EmptyState compact title={`No holidays set for ${year}`} />
            : (
              <Table>
                <THead><tr><TH width="130px">Date</TH><TH>Name</TH><TH width="60px" /></tr></THead>
                <tbody>
                  {data.map((h: any) => (
                    <TR key={h.id}>
                      <TD><span className="text-muted text-[13px] tabular">{date(h.holiday_date)}</span></TD>
                      <TD>
                        <Input defaultValue={h.name} aria-label={`${h.name} name`}
                          onBlur={(e) => e.target.value.trim() !== h.name && e.target.value.trim().length > 1
                            && rename.mutate({ id: h.id, name: e.target.value.trim() })} />
                      </TD>
                      <TD>
                        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />}
                          aria-label={`Delete ${h.name}`} onClick={() => remove.mutate(h.id)} />
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
      </div>
    </Modal>
  );
}

const Detail = ({ label, value }: { label: string; value?: string | null }) => (
  value ? (
    <div>
      <dt className="label-cap">{label}</dt>
      <dd className="text-ink mt-0.5">{value}</dd>
    </div>
  ) : null
);

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
