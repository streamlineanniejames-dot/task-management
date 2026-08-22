import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Filter, Download, ArrowUpRight, MessageSquare, Paperclip, X, Repeat,
  CheckCircle2, ListChecks, LayoutGrid, List, AlertTriangle, Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, relative, daysUntil, dateTime } from '../lib/format';
import {
  Avatar, AvatarWithName, Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, Drawer,
  EmptyState, ErrorState, Field, Input, Modal, PageHeader, SearchInput, Select, StatusBadge,
  Table, TableSkeleton, TD, TH, THead, TR, Textarea, useToast, cx, Tabs,
} from '../components/ui';

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export default function ActionItems() {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [view, setView] = useState<'list' | 'board'>('list');
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [createOpen, setCreateOpen] = useState(params.get('new') === '1');
  const [openId, setOpenId] = useState<string | null>(params.get('open'));
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const filters = {
    status: params.get('status') || '',
    priority: params.get('priority') || '',
    owner_id: params.get('owner_id') || '',
    client_id: params.get('client_id') || '',
    category_id: params.get('category_id') || '',
    overdue: params.get('overdue') || '',
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('open');
    setParams(next, { replace: true });
    setPage(1);
  };

  const clearFilters = () => { setParams(new URLSearchParams(), { replace: true }); setSearch(''); };
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['action-items', filters, search, page, view],
    queryFn: () => api.get('/action-items', {
      ...filters, search, page, limit: view === 'board' ? 200 : 25,
    }),
  });

  const { data: meta } = useQuery({
    queryKey: ['action-item-meta'],
    queryFn: async () => {
      const [categories, directory, clients] = await Promise.all([
        api.get('/settings/action-categories').then((r) => r.data),
        api.get('/users/directory').then((r) => r.data),
        api.get('/crm/clients', { limit: 200 }).then((r) => r.data).catch(() => []),
      ]);
      return { categories, directory, clients };
    },
    staleTime: 300_000,
  });

  const bulk = useMutation({
    mutationFn: (patch: any) => api.post('/action-items/bulk', { ids: selected, patch }),
    onSuccess: (res: any) => {
      toast.success(`${res.data.updated} item${res.data.updated === 1 ? '' : 's'} updated.`);
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const items = data?.data || [];
  const summary = data?.meta?.summary || {};
  const pageMeta = data?.meta || {};

  useEffect(() => {
    const open = params.get('open');
    if (open) setOpenId(open);
  }, [params]);

  return (
    <>
      <PageHeader
        title="Action items"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{summary.total ?? 0} total</span>
            {summary.overdue > 0 && (
              <span className="text-[var(--negative)] font-medium">{summary.overdue} overdue</span>
            )}
            <span className="text-subtle">{summary.done ?? 0} done</span>
          </span>
        }
        actions={
          <>
            <div className="flex rounded-md border border-line-strong overflow-hidden">
              <button onClick={() => setView('list')} aria-label="List view" aria-pressed={view === 'list'}
                className={cx('grid h-9 w-9 place-items-center cursor-pointer transition-colors duration-150',
                  view === 'list' ? 'bg-brand-soft text-[var(--brand)]' : 'text-subtle hover:bg-sunken')}>
                <List size={15} />
              </button>
              <button onClick={() => setView('board')} aria-label="Board view" aria-pressed={view === 'board'}
                className={cx('grid h-9 w-9 place-items-center cursor-pointer border-l border-line transition-colors duration-150',
                  view === 'board' ? 'bg-brand-soft text-[var(--brand)]' : 'text-subtle hover:bg-sunken')}>
                <LayoutGrid size={15} />
              </button>
            </div>
            <Button icon={<Filter size={15} />} onClick={() => setShowFilters((s) => !s)}>
              Filters {activeFilterCount > 0 && <Badge tone="brand">{activeFilterCount}</Badge>}
            </Button>
            {can('action_items', 'export') && (
              <Button icon={<Download size={15} />}
                onClick={() => api.download('/action-items/export', 'action-items.csv')}>
                Export
              </Button>
            )}
            {can('action_items', 'create') && (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
                New item
              </Button>
            )}
          </>
        }
      />

      {/* -------------------------------------------------------- filters */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }}
            placeholder="Search title or description…" className="flex-1 min-w-[200px]" />
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Status" className="w-[130px]">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </Select>
          <Select value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}
            aria-label="Priority" className="w-[125px]">
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          <Button size="sm" variant={filters.overdue ? 'danger' : 'secondary'}
            onClick={() => setFilter('overdue', filters.overdue ? '' : 'true')}
            icon={<AlertTriangle size={14} />}>
            Overdue only
          </Button>
          {activeFilterCount > 0 && (
            <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={clearFilters}>Clear</Button>
          )}
        </div>

        {showFilters && (
          <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-3">
            <Field label="Owner">
              <Select value={filters.owner_id} onChange={(e) => setFilter('owner_id', e.target.value)}>
                <option value="">Anyone</option>
                <option value={user?.id}>Me</option>
                {meta?.directory?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field label="Client">
              <Select value={filters.client_id} onChange={(e) => setFilter('client_id', e.target.value)}>
                <option value="">Any client</option>
                {meta?.clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Category">
              <Select value={filters.category_id} onChange={(e) => setFilter('category_id', e.target.value)}>
                <option value="">Any category</option>
                {meta?.categories?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------ bulk bar */}
      {selected.length > 0 && (
        <Card className="mb-4 border-[var(--brand)] bg-brand-soft">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <span className="text-[13px] font-medium text-ink">{selected.length} selected</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" onClick={() => bulk.mutate({ status: 'done' })} loading={bulk.isPending}
                icon={<CheckCircle2 size={14} />}>Mark done</Button>
              <Select className="h-8 text-[13px] w-[130px]" aria-label="Set priority"
                onChange={(e) => e.target.value && bulk.mutate({ priority: e.target.value })} defaultValue="">
                <option value="" disabled>Set priority…</option>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>
            </div>
          </div>
        </Card>
      )}

      {/* --------------------------------------------------------- content */}
      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton /></Card>
          : items.length === 0 ? (
            <Card>
              <EmptyState icon={<ListChecks size={20} />} title="No action items match"
                message={activeFilterCount || search ? 'Try loosening the filters.' : 'Create the first item to start tracking work.'}
                action={can('action_items', 'create')
                  ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New item</Button>
                  : undefined} />
            </Card>
          ) : view === 'board' ? (
            <BoardView items={items} onOpen={setOpenId} />
          ) : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH width="36px">
                      <Checkbox label="" checked={selected.length === items.length && items.length > 0}
                        onChange={(v) => setSelected(v ? items.map((i: any) => i.id) : [])} />
                    </TH>
                    <TH>Item</TH>
                    <TH width="150px">Owner</TH>
                    <TH width="150px">Client</TH>
                    <TH width="118px">Due</TH>
                    <TH width="110px">Priority</TH>
                    <TH width="120px">Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {items.map((item: any) => {
                    const days = daysUntil(item.due_date);
                    const overdue = days != null && days < 0 && !['done', 'cancelled'].includes(item.status);
                    return (
                      <TR key={item.id}>
                        <TD>
                          <span onClick={(e) => e.stopPropagation()}>
                            <Checkbox label="" checked={selected.includes(item.id)}
                              onChange={(v) => setSelected((s) => v ? [...s, item.id] : s.filter((x) => x !== item.id))} />
                          </span>
                        </TD>
                        <TD>
                          <button onClick={() => setOpenId(item.id)}
                            className="text-left group cursor-pointer w-full">
                            <span className="block font-medium text-ink group-hover:text-[var(--brand)] transition-colors leading-snug">
                              {item.title}
                            </span>
                            <span className="mt-0.5 flex items-center gap-2.5 text-[12px] text-subtle">
                              {item.category_name && (
                                <span className="inline-flex items-center gap-1">
                                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.category_color }} aria-hidden />
                                  {item.category_name}
                                </span>
                              )}
                              {item.comment_count > 0 && <span className="inline-flex items-center gap-1"><MessageSquare size={11} />{item.comment_count}</span>}
                              {item.attachment_count > 0 && <span className="inline-flex items-center gap-1"><Paperclip size={11} />{item.attachment_count}</span>}
                              {item.recurrence && item.recurrence !== 'none' && <span className="inline-flex items-center gap-1"><Repeat size={11} />{item.recurrence}</span>}
                              {item.escalation_level > 0 && (
                                <span className="inline-flex items-center gap-1 text-[var(--negative)] font-medium">
                                  <ArrowUpRight size={11} />L{item.escalation_level}
                                </span>
                              )}
                            </span>
                          </button>
                        </TD>
                        <TD>{item.owner_name
                          ? <AvatarWithName name={item.owner_name} url={item.owner_avatar} size={24} />
                          : <span className="text-subtle">Unassigned</span>}</TD>
                        <TD><span className="text-muted truncate block max-w-[140px]">{item.client_name || '—'}</span></TD>
                        <TD>
                          <span className={cx('text-[13px]', overdue ? 'text-[var(--negative)] font-medium' : 'text-muted')}>
                            {item.due_date ? (overdue ? `${Math.abs(days!)}d overdue` : relative(item.due_date)) : '—'}
                          </span>
                        </TD>
                        <TD>
                          <Badge tone={item.priority === 'urgent' ? 'negative' : item.priority === 'high' ? 'warning'
                            : item.priority === 'medium' ? 'brand' : 'neutral'}>{item.priority}</Badge>
                        </TD>
                        <TD><StatusBadge status={item.status} /></TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>

              {pageMeta.pages > 1 && (
                <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                  <span className="text-[13px] text-subtle">
                    Page {pageMeta.page} of {pageMeta.pages} · {pageMeta.total} items
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button size="sm" disabled={!pageMeta.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </Card>
          )}

      {createOpen && (
        <CreateItemModal meta={meta} onClose={() => {
          setCreateOpen(false);
          const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true });
        }} />
      )}
      {openId && <ItemDrawer id={openId} meta={meta} onClose={() => {
        setOpenId(null);
        const next = new URLSearchParams(params); next.delete('open'); setParams(next, { replace: true });
      }} />}
    </>
  );
}

/* ---------------------------------------------------------------- board */
function BoardView({ items, onOpen }: { items: any[]; onOpen: (id: string) => void }) {
  const columns = STATUSES.filter((s) => s !== 'cancelled');
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {columns.map((status) => {
        const col = items.filter((i) => i.status === status);
        return (
          <div key={status} className="min-w-0">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-[13px] font-semibold text-ink capitalize">{status.replace('_', ' ')}</span>
              <span className="text-[12px] text-subtle tabular">{col.length}</span>
            </div>
            <div className="space-y-2">
              {col.length === 0 && (
                <div className="rounded-lg border border-dashed border-line py-6 text-center text-[12.5px] text-subtle">
                  Nothing here
                </div>
              )}
              {col.map((item) => {
                const days = daysUntil(item.due_date);
                const overdue = days != null && days < 0 && item.status !== 'done';
                return (
                  <button key={item.id} onClick={() => onOpen(item.id)}
                    className="card w-full p-3 text-left cursor-pointer transition-colors duration-150 hover:border-line-strong">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[13.5px] font-medium text-ink leading-snug line-clamp-2">{item.title}</p>
                      <Badge tone={item.priority === 'urgent' ? 'negative' : item.priority === 'high' ? 'warning' : 'neutral'}>
                        {item.priority[0].toUpperCase()}
                      </Badge>
                    </div>
                    {item.client_name && <p className="mt-1.5 text-[12px] text-subtle truncate">{item.client_name}</p>}
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      {item.owner_name ? <Avatar name={item.owner_name} url={item.owner_avatar} size={22} />
                        : <span className="text-[11.5px] text-subtle">Unassigned</span>}
                      {item.due_date && (
                        <span className={cx('text-[11.5px] tabular', overdue ? 'text-[var(--negative)] font-medium' : 'text-subtle')}>
                          {overdue ? `${Math.abs(days!)}d over` : relative(item.due_date)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- create */
function CreateItemModal({ meta, onClose }: { meta: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();

  const [form, setForm] = useState({
    title: '', description: '', owner_id: user?.id || '', client_id: '', category_id: '',
    priority: 'medium', due_date: '', recurrence: 'none', estimate_minutes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => api.post('/action-items', {
      title: form.title.trim(),
      description: form.description || null,
      owner_id: form.owner_id || null,
      client_id: form.client_id || null,
      category_id: form.category_id || null,
      priority: form.priority,
      due_date: form.due_date || null,
      recurrence: form.recurrence === 'none' ? null : form.recurrence,
      estimate_minutes: form.estimate_minutes ? Number(form.estimate_minutes) : null,
    }),
    onSuccess: () => {
      toast.success('Action item created.');
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      onClose();
    },
    onError: (e: any) => {
      setErrors(e.fieldErrors || {});
      toast.error(e.message);
    },
  });

  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  return (
    <Modal open onClose={onClose} title="New action item"
      subtitle="Owner, due date and category drive the reminder ladder and escalation"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={form.title.trim().length < 2}
            onClick={() => create.mutate()}>Create item</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Title" required error={errors.title}>
          <Input value={form.title} onChange={(e) => set('title', e.target.value)}
            placeholder="Send the August performance report to Cotton India" autoFocus />
        </Field>
        <Field label="Description">
          <Textarea value={form.description} onChange={(e) => set('description', e.target.value)}
            placeholder="Context, links, what 'done' looks like…" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Owner">
            <Select value={form.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
              <option value="">Unassigned</option>
              {meta?.directory?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="Client">
            <Select value={form.client_id} onChange={(e) => set('client_id', e.target.value)}>
              <option value="">No client</option>
              {meta?.clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Category" hint="Sets how many days before it escalates">
            <Select value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">None</option>
              {meta?.categories?.map((c: any) => (
                <option key={c.id} value={c.id}>{c.name} · escalates after {c.escalation_days}d</option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <Field label="Due date" error={errors.due_date}>
            <Input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} />
          </Field>
          <Field label="Repeats">
            <Select value={form.recurrence} onChange={(e) => set('recurrence', e.target.value)}>
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
        </div>
        <Field label="Estimated effort (minutes)" hint="Feeds team utilisation on the dashboard">
          <Input type="number" min={0} step={30} value={form.estimate_minutes}
            onChange={(e) => set('estimate_minutes', e.target.value)} placeholder="120" />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- drawer */
function ItemDrawer({ id, meta, onClose }: { id: string; meta: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, user } = useAuth();
  const [comment, setComment] = useState('');
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: item, isLoading } = useQuery({
    queryKey: ['action-item', id],
    queryFn: () => api.get(`/action-items/${id}`).then((r) => r.data),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['action-item', id] });
    qc.invalidateQueries({ queryKey: ['action-items'] });
    qc.invalidateQueries({ queryKey: ['home-counters'] });
  };

  const update = useMutation({
    mutationFn: (patch: any) => api.patch(`/action-items/${id}`, patch),
    onSuccess: () => { invalidate(); toast.success('Updated.'); },
    onError: (e: any) => toast.error(e.message),
  });

  const addComment = useMutation({
    mutationFn: () => api.post(`/action-items/${id}/comments`, { body: comment.trim() }),
    onSuccess: () => { setComment(''); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/action-items/${id}`),
    onSuccess: () => { toast.success('Deleted.'); invalidate(); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !item) {
    return <Drawer open onClose={onClose} title="Loading…"><div className="p-4"><TableSkeleton rows={4} cols={2} /></div></Drawer>;
  }

  const days = daysUntil(item.due_date);
  const overdue = days != null && days < 0 && !['done', 'cancelled'].includes(item.status);

  return (
    <>
      <Drawer open onClose={onClose} title={item.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={item.status} />
            <Badge tone={item.priority === 'urgent' ? 'negative' : item.priority === 'high' ? 'warning' : 'neutral'}>
              {item.priority}
            </Badge>
            {item.escalation_level > 0 && <Badge tone="negative">escalated L{item.escalation_level}</Badge>}
          </span>
        }
        footer={
          <>
            {can('action_items', 'delete') && (
              <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setDeleteOpen(true)}>Delete</Button>
            )}
            {can('action_items', 'edit') && item.status !== 'done' && (
              <>
                <Button icon={<ArrowUpRight size={15} />} onClick={() => setEscalateOpen(true)}>Escalate</Button>
                <Button variant="primary" icon={<CheckCircle2 size={15} />}
                  loading={update.isPending} onClick={() => update.mutate({ status: 'done' })}>
                  Mark done
                </Button>
              </>
            )}
          </>
        }>
        <div className="p-5 space-y-5">
          {overdue && (
            <div className="flex items-start gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--negative)_30%,transparent)] bg-negative-soft p-3">
              <AlertTriangle size={16} className="mt-0.5 text-[var(--negative)] shrink-0" />
              <div>
                <p className="text-[13px] font-medium text-[var(--negative)]">
                  {Math.abs(days!)} day{Math.abs(days!) > 1 ? 's' : ''} overdue
                </p>
                {item.deadline && (
                  <p className="text-[12.5px] text-muted mt-0.5">
                    Escalates to the reporting manager after {item.deadline.escalation_days} days overdue.
                    Reminders sent: {(JSON.parse(item.deadline.ladder_sent || '[]') || []).length || 0}.
                  </p>
                )}
              </div>
            </div>
          )}

          {item.description && (
            <div>
              <p className="label-cap mb-1.5">Description</p>
              <p className="text-[13.5px] text-muted leading-relaxed whitespace-pre-wrap">{item.description}</p>
            </div>
          )}

          {can('action_items', 'edit') && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Status">
                <Select value={item.status} onChange={(e) => update.mutate({ status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </Select>
              </Field>
              <Field label="Priority">
                <Select value={item.priority} onChange={(e) => update.mutate({ priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </Field>
              <Field label="Owner">
                <Select value={item.owner_id || ''} onChange={(e) => update.mutate({ owner_id: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {meta?.directory?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </Field>
              <Field label="Due date">
                <Input type="date" value={item.due_date || ''}
                  onChange={(e) => update.mutate({ due_date: e.target.value || null })} />
              </Field>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-sunken p-3.5 text-[13px]">
            <Detail label="Client" value={item.client_name} />
            <Detail label="Project" value={item.project_name} />
            <Detail label="Category" value={item.category_name} />
            <Detail label="Created" value={date(item.created_at)} />
            {item.completed_at && <Detail label="Completed" value={dateTime(item.completed_at)} />}
            {item.recurrence && item.recurrence !== 'none' && <Detail label="Repeats" value={item.recurrence} />}
            {item.estimate_minutes && <Detail label="Estimate" value={`${Math.round(item.estimate_minutes / 60)}h`} />}
            {item.source_type && item.source_type !== 'manual' && (
              <Detail label="Source" value={item.source_type.replace('_', ' ')} />
            )}
          </dl>

          {item.escalations?.length > 0 && (
            <div>
              <p className="label-cap mb-2">Escalation history</p>
              <ul className="space-y-2">
                {item.escalations.map((e: any) => (
                  <li key={e.id} className="rounded-md border border-line p-2.5 text-[13px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">Level {e.level} → {e.to_name}</span>
                      <Badge tone={e.resolved_at ? 'positive' : 'negative'}>
                        {e.resolved_at ? 'resolved' : 'open'}
                      </Badge>
                    </div>
                    <p className="text-subtle mt-0.5">{e.reason} · {relative(e.created_at)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* --------------------------------------------------- comments */}
          <div>
            <p className="label-cap mb-2">Comments {item.comments?.length > 0 && `(${item.comments.length})`}</p>
            {item.comments?.length > 0 && (
              <ul className="space-y-3 mb-3">
                {item.comments.map((c: any) => (
                  <li key={c.id} className="flex gap-2.5">
                    <Avatar name={c.author_name} url={c.avatar_url} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px]">
                        <span className="font-medium text-ink">{c.author_name}</span>
                        <span className="text-subtle ml-2">{relative(c.created_at)}</span>
                      </p>
                      <p className="text-[13.5px] text-muted leading-relaxed mt-0.5 whitespace-pre-wrap">{c.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
                placeholder="Add a comment…" className="flex-1"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && comment.trim()) addComment.mutate();
                }} />
              <Button variant="primary" disabled={!comment.trim()} loading={addComment.isPending}
                onClick={() => addComment.mutate()} className="self-end">Post</Button>
            </div>
          </div>
        </div>
      </Drawer>

      {escalateOpen && <EscalateModal id={id} item={item} meta={meta} onClose={() => setEscalateOpen(false)} />}

      <ConfirmDialog
        open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()}
        title="Delete this action item?" danger confirmLabel="Delete" loading={remove.isPending}
        message={<>“{item.title}” will be removed from the register. This is a soft delete — it stays in the audit trail.</>}
      />
    </>
  );
}

const Detail = ({ label, value }: { label: string; value?: string | null }) => (
  value ? (
    <div>
      <dt className="label-cap">{label}</dt>
      <dd className="text-ink mt-0.5 capitalize">{value}</dd>
    </div>
  ) : null
);

function EscalateModal({ id, item, meta, onClose }: { id: string; item: any; meta: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState(`Blocked and past due — needs a decision.`);
  const [toUser, setToUser] = useState('');

  const escalate = useMutation({
    mutationFn: () => api.post(`/action-items/${id}/escalate`, {
      reason: reason.trim(), ...(toUser ? { to_user_id: toUser } : {}),
    }),
    onSuccess: () => {
      toast.success('Escalated. The manager has been notified.');
      qc.invalidateQueries({ queryKey: ['action-item', id] });
      qc.invalidateQueries({ queryKey: ['action-items'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Escalate this item" size="sm"
      subtitle="The escalation is logged and appears in the weekly manager report"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={escalate.isPending} disabled={reason.trim().length < 3}
            onClick={() => escalate.mutate()}>Escalate</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Escalate to" hint="Leave blank to route to the owner's reporting manager">
          <Select value={toUser} onChange={(e) => setToUser(e.target.value)}>
            <option value="">Reporting manager (default)</option>
            {meta?.directory?.filter((u: any) => ['manager', 'owner'].includes(u.role))
              .map((u: any) => <option key={u.id} value={u.id}>{u.name} · {u.designation}</option>)}
          </Select>
        </Field>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}
