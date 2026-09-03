import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock, AlertTriangle, PhoneCall, CalendarDays, CheckCircle2, LogIn, LogOut,
  ListChecks, ArrowUpRight, Bell, Stamp, Plus, PencilLine, Users2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, relative, time, daysUntil } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, EmptyState, PageHeader, Skeleton, StatusBadge,
  useToast, cx, Stat,
} from '../components/ui';
import MiniChat from '../components/MiniChat';
import PersonalTodos from '../components/PersonalTodos';
import { DailyUpdateModal } from '../components/DailyUpdate';

/**
 * The landing page answers one question: what does *this person* need to do
 * today. Company-wide numbers live on the traction dashboard instead.
 */
export default function Home() {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [logging, setLogging] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'home'],
    queryFn: () => api.get('/dashboard/home').then((r) => r.data),
  });

  const checkIn = useMutation({
    mutationFn: () => api.post('/hr/attendance/check-in', { source: 'web' }),
    onSuccess: () => {
      toast.success('Checked in. Have a good one.');
      qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const checkOut = useMutation({
    mutationFn: () => api.post('/hr/attendance/check-out', {}),
    onSuccess: () => {
      toast.success('Checked out.');
      qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/action-items/${id}`, { status: 'done' }),
    onSuccess: (res: any) => {
      // Done is not the end of it when somebody else raised the task.
      toast.success(res?.data?.validation_status === 'pending'
        ? 'Marked done — sent to whoever raised it for validation.'
        : 'Marked done.');
      qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      qc.invalidateQueries({ queryKey: ['action-items'] });
    },
  });

  if (isLoading) return <HomeSkeleton />;

  const c = data?.counters || {};
  const attendance = data?.attendance;
  const approvals = data?.pending_approvals || {};
  const approvalTotal = (approvals.leave || 0) + (approvals.regularizations || 0)
    + (can('invoices', 'approve') ? approvals.invoices || 0 : 0);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader
        title={`${greeting}, ${data?.greeting_name || user?.name?.split(' ')[0]}`}
        subtitle={date(new Date().toISOString(), 'long')}
        actions={
          <>
            {can('action_items', 'create') && (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/action-items?new=1')}>
                Quick add
              </Button>
            )}
            {!attendance?.check_in_at ? (
              <Button variant="accent" icon={<LogIn size={15} />} loading={checkIn.isPending}
                onClick={() => checkIn.mutate()}>
                Check in
              </Button>
            ) : !attendance?.check_out_at ? (
              <Button icon={<LogOut size={15} />} loading={checkOut.isPending} onClick={() => checkOut.mutate()}>
                Check out · in since {time(attendance.check_in_at)}
              </Button>
            ) : (
              <Badge tone="positive" dot>
                {Math.floor((attendance.work_minutes || 0) / 60)}h {(attendance.work_minutes || 0) % 60}m logged
              </Badge>
            )}
          </>
        }
      />

      {/* ------------------------------------------------------- counters */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-6 mb-5">
        <Stat label="Overdue" value={c.overdue ?? 0} tone={c.overdue ? 'negative' : 'neutral'}
          icon={<AlertTriangle size={15} />} onClick={() => navigate('/action-items?overdue=true')}
          sub={c.overdue ? 'needs attention now' : 'nothing overdue'} />
        <Stat label="Due today" value={c.due_today ?? 0} icon={<Clock size={15} />}
          onClick={() => navigate('/action-items')} />
        <Stat label="In progress" value={c.in_progress ?? 0} icon={<ListChecks size={15} />}
          onClick={() => navigate('/action-items?status=in_progress')} />
        <Stat label="Needs update" value={c.needs_update ?? 0}
          tone={c.needs_update ? 'warning' : 'neutral'} icon={<PencilLine size={15} />}
          onClick={() => navigate('/action-items?tab=updates')}
          sub={c.needs_update ? 'not written up today' : 'all written up'} />
        <Stat label="Escalations" value={c.escalations ?? 0} tone={c.escalations ? 'warning' : 'neutral'}
          icon={<ArrowUpRight size={15} />} onClick={() => navigate('/deadlines?tab=escalations')} />
        <Stat label="Unread" value={c.unread ?? 0} icon={<Bell size={15} />}
          onClick={() => navigate('/notifications')} />
      </div>

      {/* Chat is the wide column: most of a working day here is talking to the
          team, and the queues on the left are short lists that read fine narrow. */}
      <div className="grid gap-5 lg:grid-cols-4">
        {/* --------------------------------------------------- work queues */}
        <div className="min-w-0 space-y-5 lg:col-span-1">
          {/* The personal list sits above the assigned work on purpose: the
              first thing someone does with this page is add what they already
              know they have to do today. */}
          <PersonalTodos />

          <Card>
            <CardHeader
              title="Assigned to me"
              subtitle="Company tasks due, overdue or started"
              icon={<ListChecks size={16} />}
              action={<Link to="/action-items" className="text-[13px] text-[var(--brand)] hover:underline">All items</Link>}
            />
            {!data?.today_items?.length ? (
              <EmptyState compact icon={<CheckCircle2 size={20} className="text-[var(--positive)]" />}
                title="You're clear" message="Nothing overdue or due today. A good moment to get ahead on this week." />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {data.today_items.map((item: any) => {
                  const days = daysUntil(item.due_date);
                  const overdue = days != null && days < 0;
                  return (
                    <li key={item.id} className="flex items-start gap-3 px-4 py-3 row-hover">
                      <button
                        onClick={() => complete.mutate(item.id)}
                        aria-label={`Mark "${item.title}" done`}
                        className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2
                                   border-line-strong hover:border-[var(--positive)] hover:bg-positive-soft
                                   transition-colors duration-150 cursor-pointer group"
                      >
                        <CheckCircle2 size={11} className="opacity-0 group-hover:opacity-100 text-[var(--positive)]" />
                      </button>

                      <span className="min-w-0 flex-1">
                        <Link to={`/action-items?open=${item.id}`} className="block">
                          <p className="text-[14px] font-medium text-ink leading-snug">{item.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-subtle">
                            {item.client_name && <span className="truncate max-w-[180px]">{item.client_name}</span>}
                            {!item.accountable && (
                              <span className="inline-flex items-center gap-1" title="Shared with others">
                                <Users2 size={11} />shared
                              </span>
                            )}
                            <span className={cx(overdue && 'text-[var(--negative)] font-medium')}>
                              {overdue ? `${Math.abs(days!)} day${Math.abs(days!) > 1 ? 's' : ''} overdue` : `due ${relative(item.due_date)}`}
                            </span>
                            {item.escalation_level > 0 && <Badge tone="negative">escalated L{item.escalation_level}</Badge>}
                          </div>
                        </Link>

                        {/* The daily update lives on the row it is about, so it
                            takes one click from the page people already open. */}
                        <button
                          onClick={() => setLogging(item)}
                          className={cx(
                            'mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px]',
                            'font-medium transition-colors duration-150 cursor-pointer',
                            item.has_update_today
                              ? 'text-subtle hover:bg-sunken hover:text-ink'
                              : 'bg-warning-soft text-[var(--warning)] hover:brightness-95',
                          )}
                        >
                          <PencilLine size={11} />
                          {item.has_update_today ? 'Update logged' : 'Add today’s update'}
                        </button>
                      </span>

                      <Badge tone={item.priority === 'urgent' ? 'negative' : item.priority === 'high' ? 'warning' : 'neutral'}>
                        {item.priority}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Today's meetings" icon={<CalendarDays size={16} />}
              action={<Link to="/meetings" className="text-[13px] text-[var(--brand)] hover:underline">All</Link>} />
            {!data?.meetings?.length ? (
              <EmptyState compact title="No meetings today" message="Your calendar is clear." />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {data.meetings.map((m: any) => (
                  <li key={m.id} className="px-4 py-3">
                    <Link to={`/meetings?open=${m.id}`} className="block group">
                      <p className="text-[13.5px] font-medium text-ink group-hover:text-[var(--brand)] transition-colors leading-snug">
                        {m.title}
                      </p>
                      <p className="mt-0.5 text-[12.5px] text-subtle">
                        {time(m.scheduled_at)} · {m.duration_minutes} min{m.location ? ` · ${m.location}` : ''}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Follow-ups due" icon={<PhoneCall size={16} />}
              subtitle="Every lead carries a next action"
              action={<Link to="/crm?filter=follow_up_due" className="text-[13px] text-[var(--brand)] hover:underline">All</Link>} />
            {!data?.follow_ups?.length ? (
              <EmptyState compact title="Nothing due" message="No follow-ups are waiting on you today." />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {data.follow_ups.map((f: any) => {
                  const days = daysUntil(f.next_action_date);
                  return (
                    <li key={f.id} className="px-4 py-3 row-hover">
                      <Link to={`/crm/${f.id}`} className="block group">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[13.5px] font-medium text-ink truncate group-hover:text-[var(--brand)] transition-colors">
                            {f.name}
                          </p>
                          <span className={cx('text-[11.5px] shrink-0 tabular',
                            days != null && days < 0 ? 'text-[var(--negative)] font-medium' : 'text-subtle')}>
                            {relative(f.next_action_date)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[12.5px] text-subtle line-clamp-1">{f.next_action}</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {approvalTotal > 0 && (
            <Card>
              <CardHeader title="Waiting on your approval" icon={<Stamp size={16} />} />
              <ul className="divide-y divide-[var(--border)]">
                {approvals.leave > 0 && (
                  <ApprovalRow label="Leave requests" count={approvals.leave} to="/hr?tab=leave" />
                )}
                {approvals.regularizations > 0 && (
                  <ApprovalRow label="Attendance regularizations" count={approvals.regularizations} to="/hr?tab=attendance" />
                )}
                {can('invoices', 'approve') && approvals.invoices > 0 && (
                  <ApprovalRow label="Draft invoices" count={approvals.invoices} to="/invoices?status=draft" />
                )}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Recent alerts" icon={<Bell size={16} />}
              action={<Link to="/notifications" className="text-[13px] text-[var(--brand)] hover:underline">All</Link>} />
            {!data?.recent_notifications?.length ? (
              <EmptyState compact title="All quiet" />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {data.recent_notifications.slice(0, 5).map((n: any) => (
                  <li key={n.id} className={cx('px-4 py-2.5', !n.read_at && 'bg-brand-soft/40')}>
                    <p className="text-[13px] text-ink leading-snug">{n.title}</p>
                    <p className="text-[11.5px] text-subtle mt-0.5">{relative(n.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------------ team chat */}
        {/* Sticky so the conversation stays put while the queues scroll past. */}
        <div className="min-w-0 lg:col-span-3">
          <MiniChat className="lg:sticky lg:top-5 h-[calc(100dvh-19rem)] min-h-[560px]" />
        </div>
      </div>

      {logging && (
        <DailyUpdateModal task={logging} existing={null} onClose={() => setLogging(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['dashboard', 'home'] })} />
      )}
    </>
  );
}

const ApprovalRow = ({ label, count, to }: { label: string; count: number; to: string }) => (
  <li>
    <Link to={to} className="flex items-center justify-between gap-3 px-4 py-3 row-hover group">
      <span className="text-[13.5px] text-ink group-hover:text-[var(--brand)] transition-colors">{label}</span>
      <Badge tone="accent">{count}</Badge>
    </Link>
  </li>
);

function HomeSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-64 mb-2" />
      <Skeleton className="h-4 w-40 mb-6" />
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-6 mb-5">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)}
      </div>
      <div className="grid gap-5 lg:grid-cols-4">
        <div className="space-y-5 lg:col-span-1">
          <Skeleton className="h-52" />
          <Skeleton className="h-64" />
          <Skeleton className="h-44" />
        </div>
        <Skeleton className="h-[560px] lg:col-span-3" />
      </div>
    </div>
  );
}
