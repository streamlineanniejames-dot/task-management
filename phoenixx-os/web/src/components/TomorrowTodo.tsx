import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardList, Plus, Trash2, CheckCircle2, MessageSquare, Send, Undo2, Users2, Clock, AlertTriangle,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, time, dateTime, clockTime } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, Select, Skeleton, Textarea, useToast, cx,
} from './ui';

/**
 * Tomorrow's To-Do: the plan each person files for their next working day,
 * and the reporting person's review of it. The server decides every rule
 * (who may edit, what is late, who reviews); these screens only show it.
 */

type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning' | 'accent' | 'info';

export const PLAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Submitted', tone: 'brand' },
  UNDER_REVIEW: { label: 'Under review', tone: 'info' },
  APPROVED: { label: 'Approved', tone: 'positive' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'warning' },
  LATE: { label: 'Submitted late', tone: 'warning' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  MISSED: { label: 'Missed', tone: 'negative' },
};

const PRIORITY: Record<string, { label: string; dot: string }> = {
  high: { label: 'High', dot: 'bg-[var(--negative)]' },
  medium: { label: 'Medium', dot: 'bg-[var(--warning)]' },
  low: { label: 'Low', dot: 'bg-[var(--positive)]' },
};

const FILED = ['SUBMITTED', 'LATE', 'UNDER_REVIEW', 'APPROVED'];

export function PlanStatus({ status }: { status?: string | null }) {
  if (!status) return <Badge tone="neutral" dot>Not submitted</Badge>;
  const s = PLAN_STATUS[status] || { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone} dot>{s.label}</Badge>;
}

const PriorityDot = ({ p }: { p: string }) => (
  <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', PRIORITY[p]?.dot)} aria-label={`${PRIORITY[p]?.label} priority`} />
);

/* ================================================================ the row on Home */
/**
 * Sits between the counters and the chat. The person's own card is always
 * first; a reporting person also gets their team beside it.
 */
export function TodoPlanSection() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('plan');
  const [editing, setEditing] = useState(false);

  const mine = useQuery({ queryKey: ['todo-plan', 'mine'], queryFn: () => api.get('/todo-plan/mine').then((r) => r.data) });
  const team = useQuery({ queryKey: ['todo-plan', 'team'], queryFn: () => api.get('/todo-plan/team').then((r) => r.data) });

  const close = () => { params.delete('plan'); setParams(params, { replace: true }); };
  const view = (id: string) => { params.set('plan', id); setParams(params, { replace: true }); };

  const showMine = !!mine.data?.expected && !!mine.data?.settings?.enabled;
  const showTeam = !!team.data?.is_reviewer;
  if (mine.isLoading || team.isLoading) return <Skeleton className="h-[150px] mb-5" />;
  if (!showMine && !showTeam) return null;

  return (
    <>
      <div className={cx('grid gap-5 mb-5', showMine && showTeam && 'lg:grid-cols-3')}>
        {showMine && <MyPlanCard data={mine.data} onCreate={() => setEditing(true)} onView={view} />}
        {showTeam && <TeamPlanCard initial={team.data} onView={view} className={showMine ? 'lg:col-span-2' : ''} />}
      </div>
      {editing && <PlanEditor onClose={() => setEditing(false)} />}
      {openId && !editing && (
        <PlanModal id={openId} onClose={close} onEdit={() => { close(); setEditing(true); }} />
      )}
    </>
  );
}

/* ================================================================ employee card */
function MyPlanCard({ data, onCreate, onView }: { data: any; onCreate: () => void; onView: (id: string) => void }) {
  const { window: win, settings, plan, reporting_person: rp, history } = data;
  const status = plan?.status;
  const filed = status && FILED.includes(status);
  const lastNote = plan?.comments?.filter((c: any) => c.kind === 'changes_requested').at(-1);
  const deadline = clockTime(settings.deadline_time);

  let body;
  if (!win.todo_date && !plan) {
    body = <EmptyState compact icon={<ClipboardList size={18} />} title="No To-Do to file today"
      message="Today is not a working day. Your next plan opens on the next working day." />;
  } else if (status === 'CHANGES_REQUESTED') {
    body = (
      <div className="space-y-3">
        <div className="rounded-md border border-[var(--warning)]/40 bg-warning-soft px-3 py-2.5 text-[13px]">
          <p className="font-medium text-ink">{lastNote?.user_name || 'Your reporting person'} asked for changes</p>
          {lastNote?.body && <p className="text-muted mt-0.5">“{lastNote.body}”</p>}
        </div>
        <Button variant="primary" icon={<Undo2 size={15} />} onClick={onCreate}>Edit & resubmit</Button>
      </div>
    );
  } else if (filed) {
    body = (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
          <CheckCircle2 size={17} className="text-[var(--positive)]" /> Submitted
          <span className="text-muted font-normal">at {time(plan.submitted_at)}</span>
          {plan.minutes_late ? <span className="text-[12.5px] text-[var(--warning)] font-normal">· {plan.minutes_late} min late</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <PlanStatus status={status} />
          <span className="text-[12.5px] text-subtle">{plan.tasks.length} task(s)</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onView(plan.id)}>View submission</Button>
          {plan.can_edit && <Button variant="ghost" onClick={onCreate}>Edit before deadline</Button>}
        </div>
      </div>
    );
  } else if (status === 'MISSED') {
    body = <p className="text-[13px] text-muted">The plan for {date(plan.todo_date, 'long')} was not submitted.</p>;
  } else {
    const closed = win.phase === 'past_deadline' && !settings.allow_late;
    body = (
      <div className="space-y-3">
        <div className="text-[13px] space-y-1">
          <p className="text-muted">Submission deadline <span className="text-ink font-medium">{deadline}</span>
            {win.phase === 'not_open' && <span> · opens {clockTime(settings.open_time)}</span>}</p>
          <p className="flex items-center gap-2 text-muted">Status
            {status === 'OVERDUE' || (win.phase === 'past_deadline' && !plan)
              ? <PlanStatus status="OVERDUE" />
              : status === 'DRAFT' ? <PlanStatus status="DRAFT" /> : <PlanStatus status={null} />}
          </p>
        </div>
        {closed ? (
          <p className="text-[12.5px] text-[var(--negative)]">The deadline has passed and late plans are not accepted.</p>
        ) : (
          <Button variant="primary" icon={<Plus size={15} />} onClick={onCreate}>
            {plan ? 'Continue my To-Do' : 'Create tomorrow\'s To-Do'}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader title="Tomorrow's To-Do" icon={<ClipboardList size={16} />}
        subtitle={(win.todo_date || plan?.todo_date)
          ? `For ${date(plan?.todo_date || win.todo_date, 'long')}${rp ? ` · goes to ${rp.name}` : ''}`
          : undefined} />
      <div className="p-4">{body}</div>
      {history?.length > 0 && (
        <details className="border-t border-line">
          <summary className="px-4 py-2 text-[12.5px] text-subtle cursor-pointer hover:text-ink">Previous plans</summary>
          <ul className="px-4 pb-3 space-y-1.5">
            {history.slice(0, 7).map((h: any) => (
              <li key={h.id}>
                <button onClick={() => onView(h.id)}
                  className="w-full flex items-center justify-between gap-2 text-[12.5px] cursor-pointer hover:text-ink text-muted">
                  <span>{date(h.todo_date, 'day')} · {h.task_count} task(s)</span>
                  <PlanStatus status={h.status} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/* ================================================================ editor */
type TaskRow = { key: string; task: string; project_id: string; client_id: string; priority: string; expected_time: string; notes: string };
const blank = (): TaskRow => ({ key: Math.random().toString(36).slice(2), task: '', project_id: '', client_id: '', priority: 'medium', expected_time: '', notes: '' });

function PlanEditor({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ['todo-plan', 'mine'], queryFn: () => api.get('/todo-plan/mine').then((r) => r.data) });
  const [rows, setRows] = useState<TaskRow[] | null>(null);

  useEffect(() => {
    if (!data || rows) return;
    const existing = data.plan?.tasks || [];
    setRows(existing.length
      ? existing.map((t: any) => ({ ...blank(), ...t, project_id: t.project_id || '', client_id: t.client_id || '', expected_time: t.expected_time || '', notes: t.notes || '' }))
      : [blank()]);
  }, [data]);

  const todoDate = data?.plan?.todo_date || data?.window?.todo_date;
  const save = useMutation({
    mutationFn: (submit: boolean) => api.put(`/todo-plan/mine/${todoDate}`, {
      submit,
      tasks: (rows || []).map(({ key, ...t }) => ({ ...t, project_id: t.project_id || null, client_id: t.client_id || null, expected_time: t.expected_time || null })),
    }),
    onSuccess: (r: any, submit) => {
      qc.invalidateQueries({ queryKey: ['todo-plan'] });
      if (submit) {
        toast.success(r.data.status === 'LATE' ? `Submitted (${r.data.minutes_late} min late).` : `Submitted to ${r.data.reporting_person_name || 'your reporting person'}.`);
        onClose();
      } else toast.success('Draft saved.');
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (key: string, k: keyof TaskRow, v: string) =>
    setRows((rs) => (rs || []).map((r) => (r.key === key ? { ...r, [k]: v } : r)));
  const opts = data?.options || { projects: [], clients: [] };
  const lastNote = data?.plan?.comments?.filter((c: any) => c.kind === 'changes_requested').at(-1);

  return (
    <Modal open onClose={onClose} size="lg" title="Tomorrow's To-Do"
      subtitle={data ? `${user?.name} · ${date(todoDate, 'long')} · reporting to ${data.reporting_person?.name || '—'}` : undefined}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending && save.variables === false} disabled={save.isPending} onClick={() => save.mutate(false)}>Save draft</Button>
          <Button variant="primary" icon={<Send size={15} />} loading={save.isPending && save.variables === true}
            disabled={save.isPending} onClick={() => save.mutate(true)}>
            {data?.plan?.status === 'CHANGES_REQUESTED' ? 'Resubmit' : 'Submit To-Do'}
          </Button>
        </>
      )}>
      {!rows ? <Skeleton className="h-40" /> : (
        <div className="space-y-4">
          {lastNote?.body && (
            <div className="rounded-md border border-[var(--warning)]/40 bg-warning-soft px-3 py-2.5 text-[13px]">
              <span className="font-medium text-ink">{lastNote.user_name}:</span> <span className="text-muted">{lastNote.body}</span>
            </div>
          )}
          {rows.map((r, i) => (
            <fieldset key={r.key} className="rounded-lg border border-line p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <legend className="text-[12.5px] font-semibold text-subtle">Task {i + 1}</legend>
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                    className="text-subtle hover:text-[var(--negative)] cursor-pointer" aria-label={`Remove task ${i + 1}`}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <Field label="Task" required>
                <Input value={r.task} maxLength={300} autoFocus={i === rows.length - 1}
                  placeholder="e.g. Follow up with 20 prospects" onChange={(e) => set(r.key, 'task', e.target.value)} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Project">
                  <Select value={r.project_id} onChange={(e) => set(r.key, 'project_id', e.target.value)}>
                    <option value="">— None —</option>
                    {opts.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
                {opts.clients.length > 0 && (
                  <Field label="Client">
                    <Select value={r.client_id} onChange={(e) => set(r.key, 'client_id', e.target.value)}>
                      <option value="">— None —</option>
                      {opts.clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                  </Field>
                )}
                <Field label="Priority">
                  <div className="flex gap-1.5" role="radiogroup" aria-label="Priority">
                    {Object.entries(PRIORITY).map(([k, p]) => (
                      <button key={k} type="button" role="radio" aria-checked={r.priority === k}
                        onClick={() => set(r.key, 'priority', k)}
                        className={cx('flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-[13px] cursor-pointer transition-colors duration-150',
                          r.priority === k ? 'border-[var(--brand)] bg-brand-soft text-ink font-medium' : 'border-line-strong text-muted hover:text-ink')}>
                        <PriorityDot p={k} /> {p.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Expected completion">
                  <Input type="time" value={r.expected_time} onChange={(e) => set(r.key, 'expected_time', e.target.value)} />
                </Field>
              </div>
              <Field label="Notes">
                <Textarea rows={2} value={r.notes} maxLength={1000} onChange={(e) => set(r.key, 'notes', e.target.value)} />
              </Field>
            </fieldset>
          ))}
          {rows.length < 30 && (
            <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setRows([...rows, blank()])}>Add another task</Button>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ================================================================ one plan, read + review */
function PlanModal({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const key = ['todo-plan', 'submission', id];
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [commentText, setCommentText] = useState('');

  const { data: plan, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/todo-plan/submissions/${id}`).then((r) => r.data) });

  // The reporting person opening a fresh plan marks it under review.
  const opened = useRef(false);
  useEffect(() => {
    if (!plan || opened.current || !plan.can_review || !['SUBMITTED', 'LATE'].includes(plan.status)) return;
    opened.current = true;
    api.post(`/todo-plan/submissions/${id}/open`).then((r) => {
      qc.setQueryData(key, r.data);
      qc.invalidateQueries({ queryKey: ['todo-plan', 'team'] });
    }).catch(() => {});
  }, [plan]);

  const done = (r: any, msg: string) => {
    qc.setQueryData(key, r.data);
    qc.invalidateQueries({ queryKey: ['todo-plan', 'team'] });
    qc.invalidateQueries({ queryKey: ['todo-plan', 'mine'] });
    toast.success(msg);
  };
  const approve = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${id}/approve`, { note: note || undefined }),
    onSuccess: (r) => { done(r, 'Approved.'); setNote(''); },
    onError: (e: any) => toast.error(e.message),
  });
  const changes = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${id}/request-changes`, { note }),
    onSuccess: (r) => { done(r, 'Sent back for changes.'); setNote(''); setAsking(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const comment = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${id}/comments`, { body: commentText }),
    onSuccess: (r) => { done(r, 'Comment added.'); setCommentText(''); },
    onError: (e: any) => toast.error(e.message),
  });

  const reviewable = plan?.can_review && ['SUBMITTED', 'LATE', 'UNDER_REVIEW'].includes(plan.status);
  const own = plan && plan.user_id === user?.id;

  return (
    <Modal open onClose={onClose} size="lg"
      title={plan ? `${own ? 'My' : `${plan.employee_name}'s`} To-Do for ${date(plan.todo_date, 'long')}` : 'To-Do'}
      subtitle={plan ? `Reporting person: ${plan.reporting_person_name || '—'}` : undefined}
      footer={plan && (
        <>
          {own && plan.can_edit && <Button onClick={onEdit}>Edit</Button>}
          {reviewable && !asking && (
            <>
              <Button icon={<Undo2 size={15} />} onClick={() => setAsking(true)}>Request changes</Button>
              <Button variant="primary" icon={<CheckCircle2 size={15} />} loading={approve.isPending} onClick={() => approve.mutate()}>Approve</Button>
            </>
          )}
          {reviewable && asking && (
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>Back</Button>
              <Button variant="primary" loading={changes.isPending} disabled={!note.trim()} onClick={() => changes.mutate()}>Send back for changes</Button>
            </>
          )}
          {!reviewable && !(own && plan.can_edit) && <Button onClick={onClose}>Close</Button>}
        </>
      )}>
      {error ? (
        <EmptyState compact icon={<AlertTriangle size={18} />} title="Not available" message="This To-Do does not exist or is not yours to see." />
      ) : isLoading || !plan ? <Skeleton className="h-48" /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted">
            <PlanStatus status={plan.status} />
            {plan.submitted_at && <span className="flex items-center gap-1"><Clock size={13} /> Submitted {dateTime(plan.submitted_at)}</span>}
            {plan.minutes_late ? <span className="text-[var(--warning)]">{plan.minutes_late} min late</span> : null}
            {plan.reviewed_by_name && plan.status === 'APPROVED' && <span>Approved by {plan.reviewed_by_name}</span>}
          </div>

          {plan.tasks.length === 0 ? (
            <p className="text-[13px] text-subtle">No tasks yet.</p>
          ) : (
            <ol className="divide-y divide-[var(--border)] rounded-lg border border-line">
              {plan.tasks.map((t: any, i: number) => (
                <li key={t.id} className="flex gap-3 px-3.5 py-3">
                  <span className="text-[12px] text-subtle tabular w-4 shrink-0 pt-0.5">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[14px] text-ink font-medium"><PriorityDot p={t.priority} /> {t.task}</p>
                    <p className="text-[12.5px] text-subtle mt-0.5">
                      {[PRIORITY[t.priority]?.label, t.project_name, t.client_name, t.expected_time && `by ${clockTime(t.expected_time)}`].filter(Boolean).join(' · ')}
                    </p>
                    {t.notes && <p className="text-[12.5px] text-muted mt-1 whitespace-pre-line">{t.notes}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {reviewable && asking && (
            <Field label="What needs to change?" required>
              <Textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Please add the expected number of leads to be completed." />
            </Field>
          )}

          <div>
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-subtle mb-2"><MessageSquare size={13} /> Activity</p>
            <ul className="space-y-2">
              {plan.comments.map((c: any) => (
                <li key={c.id} className="text-[13px]">
                  <span className="text-ink font-medium">{c.user_name || 'System'}</span>{' '}
                  <span className="text-muted">
                    {c.kind === 'submitted' ? (c.body || 'submitted the plan')
                      : c.kind === 'approved' ? `approved${c.body ? `: “${c.body}”` : ''}`
                        : c.kind === 'changes_requested' ? `asked for changes: “${c.body}”` : c.body}
                  </span>
                  <span className="text-[11.5px] text-subtle"> · {dateTime(c.created_at)}</span>
                </li>
              ))}
              {plan.comments.length === 0 && <li className="text-[12.5px] text-subtle">Nothing yet.</li>}
            </ul>
            <div className="mt-3 flex gap-2">
              <Input value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Add a comment…" maxLength={2000}
                onKeyDown={(e) => { if (e.key === 'Enter' && commentText.trim()) comment.mutate(); }} />
              <Button loading={comment.isPending} disabled={!commentText.trim()} onClick={() => comment.mutate()}>Comment</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ================================================================ reviewer card */
function TeamPlanCard({ initial, onView, className }: { initial: any; onView: (id: string) => void; className?: string }) {
  const [day, setDay] = useState<string>(initial.todo_date);
  const { data = initial } = useQuery({
    queryKey: ['todo-plan', 'team', day],
    queryFn: () => api.get('/todo-plan/team', { date: day }).then((r) => r.data),
    initialData: day === initial.todo_date ? initial : undefined,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const reporting = useMutation({
    mutationFn: ({ userId, managerId }: { userId: string; managerId: string | null }) =>
      api.put(`/todo-plan/reporting/${userId}`, { manager_id: managerId }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['todo-plan', 'team'] });
      toast.success(r.data.manager_name ? `Now reports to ${r.data.manager_name}.` : 'Now reports to the owner.');
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Reporting to an owner and reporting to nobody route the same way, so both read "Owner (direct)".
  const ownerIds = new Set<string>((data.reporting_options || []).filter((o: any) => o.role === 'owner').map((o: any) => o.id));

  const c = data.counts;
  const submitted = c.SUBMITTED + c.LATE + c.UNDER_REVIEW + c.APPROVED + c.CHANGES_REQUESTED;
  // Lateness outlives the LATE status: a late plan that has since been reviewed still counts.
  const late = data.rows.filter((r: any) => r.plan?.minutes_late > 0).length;
  const toReview = c.SUBMITTED + c.LATE + c.UNDER_REVIEW;

  return (
    <Card className={className}>
      <CardHeader title={data.scope === 'everyone' ? 'Team To-Do · everyone' : 'Team To-Do'} icon={<Users2 size={16} />}
        subtitle={`Plans for ${date(data.todo_date, 'long')} · deadline ${clockTime(data.deadline_time)}`}
        action={<Input type="date" value={day} onChange={(e) => setDay(e.target.value || initial.todo_date)}
          aria-label="Planned day" className="h-8 w-[150px] text-[13px]" />} />

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-[var(--border)] border-b border-line">
        {[
          ['People', c.total, ''],
          ['Submitted', submitted, ''],
          ['Approved', c.APPROVED, 'text-[var(--positive)]'],
          ['To review', toReview, toReview ? 'text-[var(--brand)]' : ''],
          ['Late', late, late ? 'text-[var(--warning)]' : ''],
          ['Not in', c.not_submitted, c.not_submitted ? 'text-[var(--negative)]' : ''],
        ].map(([label, n, tone]) => (
          <div key={label as string} className="bg-raised px-3 py-2.5">
            <p className="text-[11.5px] text-subtle">{label}</p>
            <p className={cx('text-[18px] font-semibold tabular text-ink', tone as string)}>{n}</p>
          </div>
        ))}
      </div>

      {data.pending.length > 0 && (
        <div className="border-b border-line">
          <p className="px-4 pt-3 pb-1.5 text-[12.5px] font-semibold text-subtle">Waiting on your review</p>
          <ul>
            {data.pending.map((p: any) => (
              <li key={p.id}>
                <button onClick={() => onView(p.id)} className="w-full flex items-center gap-3 px-4 py-2 row-hover cursor-pointer text-left">
                  <span className="min-w-0 flex-1 text-[13.5px] text-ink font-medium truncate">{p.employee_name}</span>
                  <span className="text-[12.5px] text-subtle">{date(p.todo_date, 'day')} · {time(p.submitted_at)}{p.minutes_late ? ` · ${p.minutes_late}m late` : ''}</span>
                  <PlanStatus status={p.status} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.can_assign && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-line">
          <span className="text-[12.5px] text-subtle">Add to my team</span>
          <Select value="" disabled={reporting.isPending || !data.assignable.length} aria-label="Add someone to my team"
            onChange={(e) => e.target.value && reporting.mutate({ userId: e.target.value, managerId: user!.id })}
            className="h-8 w-auto min-w-[200px] text-[13px]">
            <option value="">{data.assignable.length ? 'Choose a person…' : 'Nobody unassigned'}</option>
            {data.assignable.map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.designation ? ` · ${u.designation}` : ''}</option>)}
          </Select>
        </div>
      )}

      {data.rows.length === 0 ? (
        <EmptyState compact title="Nobody reports to you"
          message={data.can_assign ? 'Add people who are not on anyone\'s team yet.' : 'The owner decides who reports to whom.'} />
      ) : (
        <ul className="divide-y divide-[var(--border)] max-h-[360px] overflow-y-auto">
          {data.rows.map((r: any) => (
            <li key={r.user.id} className={cx('flex items-center gap-3 px-4 py-2', r.plan && 'row-hover')}>
              <button disabled={!r.plan} onClick={() => r.plan && onView(r.plan.id)}
                className={cx('min-w-0 flex-1 flex items-center gap-3 text-left', r.plan ? 'cursor-pointer' : 'cursor-default')}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] text-ink truncate">{r.user.name}</span>
                  {!data.is_admin && data.scope === 'everyone' && (
                    <span className="block text-[11.5px] text-subtle truncate">reports to {r.reporting_person_name || '—'}</span>
                  )}
                </span>
                {r.plan?.submitted_at && <span className="hidden sm:inline text-[12px] text-subtle">{time(r.plan.submitted_at)} · {r.plan.task_count} task(s)</span>}
              </button>
              {data.is_admin && (
                <Select value={r.manager_id && !ownerIds.has(r.manager_id) ? r.manager_id : ''} disabled={reporting.isPending} aria-label={`${r.user.name} reports to`}
                  onChange={(e) => reporting.mutate({ userId: r.user.id, managerId: e.target.value || null })}
                  className="h-8 w-[170px] shrink-0 text-[12.5px]">
                  <option value="">Owner (direct)</option>
                  {data.reporting_options.filter((o: any) => o.id !== r.user.id && o.role !== 'owner')
                    .map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              )}
              {r.can_release && (
                <button onClick={() => reporting.mutate({ userId: r.user.id, managerId: null })} disabled={reporting.isPending}
                  className="text-[12px] text-subtle hover:text-[var(--negative)] cursor-pointer shrink-0">Remove</button>
              )}
              <PlanStatus status={r.plan?.status === 'DRAFT' ? null : r.plan?.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
