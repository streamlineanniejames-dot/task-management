import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Filter, Download, ArrowUpRight, X, MessageSquare, Paperclip, Repeat,
  CheckCircle2, ListChecks, LayoutGrid, List, AlertTriangle, Trash2, Users2, User,
  ClipboardList, CircleAlert, PencilLine, Clock, ShieldCheck, Undo2, History,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, relative, daysUntil, dateTime } from '../lib/format';
import { DailyUpdateModal, UpdateCard, NeedsUpdateRow } from '../components/DailyUpdate';
import {
  Avatar, AvatarWithName, Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, Drawer,
  EmptyState, ErrorState, Field, Input, Modal, PageHeader, SearchInput, Select, StatusBadge,
  Table, TableSkeleton, TD, TH, THead, TR, Textarea, useToast, cx, Tabs, Meter,
} from '../components/ui';

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

/** Overlapping faces for a task worked by more than one person. */
export function AssigneeStack({ assignees, max = 4 }: { assignees: any[]; max?: number }) {
  if (!assignees?.length) return <span className="text-[12.5px] text-subtle">Unassigned</span>;
  const shown = assignees.slice(0, max);
  const rest = assignees.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((a) => (
        <span key={a.user_id} className="-ml-1.5 first:ml-0 rounded-full ring-2 ring-[var(--raised)]"
          title={`${a.name}${a.accountable ? ' · accountable' : ''}`}>
          <Avatar name={a.name} url={a.avatar_url} size={24} />
        </span>
      ))}
      {rest > 0 && (
        <span className="-ml-1.5 grid h-6 w-6 place-items-center rounded-full bg-sunken ring-2
                         ring-[var(--raised)] text-[10.5px] font-medium text-muted tabular">
          +{rest}
        </span>
      )}
    </span>
  );
}

export default function ActionItems() {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  // Four jobs on one screen: the register, work that is finished and waiting on
  // sign-off, my own daily updates, and - for a manager - the team's. The tab
  // lives in the URL so the reminder can link straight at it.
  const TABS = ['tasks', 'completed', 'updates', 'team'];
  const tab = TABS.includes(params.get('tab') || '') ? params.get('tab')! : 'tasks';
  const setTab = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === 'tasks') next.delete('tab'); else next.set('tab', id);
    next.delete('open');
    setParams(next, { replace: true });
  };
  // Only somebody who can see beyond their own rows has a team to review.
  const canReviewTeam = user?.role !== 'employee' && user?.role !== 'client';

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

  // The working list holds work that is still being worked. The moment the
  // assignee marks something done it belongs to the Completed tab, whether or
  // not the creator has signed it off yet - asking for a status explicitly is
  // still honoured, so the filter can pull done items back into view.
  const bucket = filters.status ? '' : 'active';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['action-items', filters, search, page, view, bucket],
    queryFn: () => api.get('/action-items', {
      ...filters, bucket, search, page, limit: view === 'board' ? 200 : 25,
    }),
  });

  const { data: meta } = useQuery({
    queryKey: ['action-item-meta'],
    queryFn: async () => {
      const [categories, directory, clients, projects] = await Promise.all([
        api.get('/settings/action-categories').then((r) => r.data),
        api.get('/users/directory').then((r) => r.data),
        // The whole client register, not the pipeline list: that one is filtered
        // to the rows you own, so an employee's picker came back empty.
        api.get('/crm/clients/options').then((r) => r.data).catch(() => []),
        // Teams come from the projects module - there is no second list of
        // teams to keep in step with it.
        api.get('/projects').then((r) => r.data).catch(() => []),
      ]);
      return { categories, directory, clients, projects };
    },
    staleTime: 300_000,
  });

  const bulk = useMutation({
    mutationFn: (patch: any) => api.post('/action-items/bulk', { ids: selected, patch }),
    onSuccess: (res: any) => {
      const { updated, skipped } = res.data;
      toast.success(`${updated} item${updated === 1 ? '' : 's'} updated.`
        + (skipped ? ` ${skipped} left alone — already validated.` : ''));
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Same query key as the tab itself, so React Query serves both from one
  // request and one cache entry - a badge that disagrees with the list it
  // points at is worse than no badge.
  const { data: mineMeta } = useQuery({
    queryKey: ['my-updates'],
    queryFn: () => api.get('/action-items/updates/mine').then((r) => r.data),
    staleTime: 30_000,
  });

  const items = data?.data || [];
  const summary = data?.meta?.summary || {};
  const pageMeta = data?.meta || {};
  const owed = mineMeta?.needs_update?.length || 0;
  // Tasks this person raised, that somebody has finished, that nobody has
  // signed off yet. Counted server-side across every filter so the badge and
  // the tab it points at can never disagree.
  const toValidate = data?.meta?.my_validation_queue || 0;

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
            <span>{summary.total ?? 0} {bucket === 'active' ? 'in progress' : 'total'}</span>
            {summary.overdue > 0 && (
              <span className="text-[var(--negative)] font-medium">{summary.overdue} overdue</span>
            )}
            {toValidate > 0
              ? <span className="text-[var(--warning)] font-medium">{toValidate} awaiting your sign-off</span>
              : <span className="text-subtle">{summary.done ?? 0} done</span>}
          </span>
        }
        tabs={
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'tasks', label: 'All tasks' },
            { id: 'completed', label: 'Completed', count: toValidate || undefined },
            { id: 'updates', label: 'My daily updates', count: owed || undefined },
            ...(canReviewTeam ? [{ id: 'team', label: 'Team updates' }] : []),
          ]} />
        }
        actions={tab !== 'tasks' ? null : (
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
        )}
      />

      {tab === 'completed' && <CompletedView onOpen={setOpenId} />}
      {tab === 'updates' && <MyUpdatesView />}
      {tab === 'team' && canReviewTeam && <TeamUpdatesView />}

      {tab === 'tasks' && (
        <>
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
                    <TH width="160px">Assigned to</TH>
                    <TH width="120px">Created by</TH>
                    <TH width="140px">Client</TH>
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
                              {item.validation_status === 'changes_requested' && (
                                <span className="inline-flex items-center gap-1 text-[var(--warning)] font-medium">
                                  <Undo2 size={11} />sent back
                                  {item.rework_count > 1 && ` ·  ${item.rework_count}×`}
                                </span>
                              )}
                            </span>
                          </button>
                        </TD>
                        <TD>
                          {item.owner_name ? (
                            <span className="flex items-center gap-1.5">
                              <AvatarWithName name={item.owner_name} url={item.owner_avatar} size={24}
                                sub={item.extra_assignee_count > 0
                                  ? `+${item.extra_assignee_count} more` : item.owner_designation} />
                            </span>
                          ) : <span className="text-subtle">Unassigned</span>}
                        </TD>
                        <TD><span className="text-muted truncate block max-w-[110px]">
                          {item.created_by_name || '—'}
                        </span></TD>
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
        </>
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

/* ====================================================== CREATOR SIGN-OFF */
/**
 * Done is the assignee's word for it; validated is the creator's. Everywhere a
 * completed task is shown, this badge says which of the two has happened.
 */
export function ValidationBadge({ item, compact }: { item: any; compact?: boolean }) {
  if (item.validation_status === 'validated') {
    return (
      <Badge tone="positive" dot>
        validated{!compact && item.validated_by_name ? ` · ${item.validated_by_name}` : ''}
      </Badge>
    );
  }
  if (item.validation_status === 'changes_requested') {
    return <Badge tone="warning" dot>needs changes</Badge>;
  }
  if (item.status === 'done') return <Badge tone="warning" dot>awaiting validation</Badge>;
  return <span className="text-[13px] text-subtle">—</span>;
}

const COMPLETED_TABS = [
  // Finished, and waiting on whoever raised it.
  { id: 'pending', label: 'Awaiting validation', query: { bucket: 'completed', validation: 'pending' } },
  // Signed off. This is the only state that means the task is actually over.
  { id: 'validated', label: 'Validated', query: { validation: 'validated' } },
  // Rejected and back with the assignee - listed here because this is where
  // somebody comes looking for "what happened to the task I sent back".
  { id: 'changes_requested', label: 'Needs changes', query: { validation: 'changes_requested' } },
];

/**
 * Completed work, split by where it stands with the person who raised it. The
 * Validate button is shown on the strength of `can_validate`, which the server
 * computes - the browser is never the thing deciding who may sign off.
 */
function CompletedView({ onOpen }: { onOpen: (id: string) => void }) {
  const [sub, setSub] = useState('pending');
  const [mineOnly, setMineOnly] = useState(false);
  const [validating, setValidating] = useState<any>(null);

  const conf = COMPLETED_TABS.find((t) => t.id === sub) || COMPLETED_TABS[0];
  const onlyMine = mineOnly && sub === 'pending';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['action-items', 'completed', sub, onlyMine],
    queryFn: () => api.get('/action-items', {
      ...conf.query, ...(onlyMine ? { to_validate: 'true' } : {}), limit: 50,
    }),
  });

  // One unfiltered read purely for the three tab counts, so each tab shows its
  // own size rather than only the one you happen to be standing on.
  const { data: counts } = useQuery({
    queryKey: ['action-items', 'completed-counts'],
    queryFn: () => api.get('/action-items', { limit: 1 }).then((r: any) => r.meta?.summary || {}),
    staleTime: 15_000,
  });

  const rows = data?.data || [];

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Tabs active={sub} onChange={setSub} className="border-0" tabs={COMPLETED_TABS.map((t) => ({
            id: t.id,
            label: t.label,
            count: (t.id === 'pending' ? counts?.awaiting_validation
              : t.id === 'validated' ? counts?.validated
                : counts?.changes_requested) || undefined,
          }))} />
          {sub === 'pending' && (
            <Button size="sm" className="ml-auto" variant={mineOnly ? 'primary' : 'secondary'}
              icon={<ShieldCheck size={14} />} onClick={() => setMineOnly((m) => !m)}>
              Only mine to sign off
            </Button>
          )}
        </div>
      </Card>

      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton cols={6} /></Card>
          : !rows.length ? (
            <Card>
              <EmptyState icon={<CheckCircle2 size={20} />}
                title={sub === 'pending' ? 'Nothing waiting on a sign-off'
                  : sub === 'validated' ? 'Nothing validated yet' : 'Nothing has been sent back'}
                message={sub === 'pending'
                  ? 'When somebody marks their task done it lands here for whoever raised it.'
                  : sub === 'validated'
                    ? 'Work appears here once the person who raised it has accepted it.'
                    : 'Tasks a creator sends back for changes show up here until they are done again.'} />
            </Card>
          ) : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH>Task</TH>
                    <TH width="150px">Assigned to</TH>
                    <TH width="150px">Completed by</TH>
                    <TH width="140px">Completed</TH>
                    <TH width="170px">Validation</TH>
                    <TH width="130px">Action</TH>
                  </tr>
                </THead>
                <tbody>
                  {rows.map((item: any) => (
                    <TR key={item.id}>
                      <TD>
                        <button onClick={() => onOpen(item.id)} className="text-left group cursor-pointer w-full">
                          <span className="block font-medium text-ink group-hover:text-[var(--brand)] transition-colors leading-snug">
                            {item.title}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2.5 text-[12px] text-subtle">
                            <span>Raised by {item.created_by_name || 'someone'}</span>
                            {item.client_name && <span className="truncate">{item.client_name}</span>}
                            {item.rework_count > 0 && (
                              <span className="text-[var(--warning)]">
                                sent back {item.rework_count}×
                              </span>
                            )}
                          </span>
                        </button>
                      </TD>
                      <TD>
                        {item.owner_name
                          ? <AvatarWithName name={item.owner_name} url={item.owner_avatar} size={24}
                            sub={item.owner_designation} />
                          : <span className="text-subtle">Unassigned</span>}
                      </TD>
                      <TD><span className="text-muted">{item.completed_by_name || '—'}</span></TD>
                      <TD>
                        <span className="text-[13px] text-muted">
                          {item.completed_at ? date(item.completed_at) : '—'}
                        </span>
                      </TD>
                      <TD>
                        <span className="flex flex-col items-start gap-1">
                          <ValidationBadge item={item} compact />
                          {item.validated_at && item.validation_status !== 'pending' && (
                            <span className="text-[11.5px] text-subtle">
                              {[item.validated_by_name, date(item.validated_at)].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </span>
                      </TD>
                      <TD>
                        {item.can_validate ? (
                          <Button size="sm" variant="primary" icon={<ShieldCheck size={14} />}
                            onClick={() => setValidating(item)}>Validate</Button>
                        ) : item.validation_status === 'pending' ? (
                          <span className="text-[12.5px] text-subtle">
                            with {item.created_by_name || 'the creator'}
                          </span>
                        ) : <span className="text-subtle">—</span>}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

      {validating && <ValidateModal item={validating} onClose={() => setValidating(null)} />}
    </>
  );
}

/**
 * The creator's ruling. Two outcomes, and the one that sends work back insists
 * on a reason - "rejected" with no note is how a task ends up bouncing between
 * two people who each think the other is being unreasonable.
 */
function ValidateModal({ item, onClose, onDone }: { item: any; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [note, setNote] = useState('');

  const submit = useMutation({
    mutationFn: () => api.post(`/action-items/${item.id}/validate`, { decision, note: note.trim() || null }),
    onSuccess: () => {
      toast.success(decision === 'approve'
        ? 'Validated — the task is complete.'
        : 'Sent back to the assignee with your note.');
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['action-item', item.id] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      onDone?.();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const blocked = decision === 'reject' && note.trim().length < 3;

  return (
    <Modal open onClose={onClose} title="Validate completed work"
      subtitle="You raised this task, so the call on whether it is finished is yours"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={decision === 'approve' ? 'primary' : 'danger'} loading={submit.isPending}
            disabled={blocked} onClick={() => submit.mutate()}>
            {decision === 'approve' ? 'Approve & complete' : 'Send back for changes'}
          </Button>
        </>
      }>
      <div className="space-y-4">
        <div className="rounded-lg bg-sunken p-3.5">
          <p className="text-[14px] font-medium text-ink leading-snug">{item.title}</p>
          <p className="mt-1 text-[12.5px] text-subtle">
            Completed by {item.completed_by_name || item.owner_name || 'the assignee'}
            {item.completed_at ? ` on ${date(item.completed_at)}` : ''}
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {([
            { id: 'approve', title: 'Approve', line: 'The work is accepted and the task is closed.', icon: <CheckCircle2 size={16} /> },
            { id: 'reject', title: 'Needs changes', line: 'Goes back to the assignee as live work.', icon: <Undo2 size={16} /> },
          ] as const).map((o) => (
            <button key={o.id} type="button" onClick={() => setDecision(o.id)}
              aria-pressed={decision === o.id}
              className={cx('rounded-lg border p-3 text-left cursor-pointer transition-colors duration-150',
                decision === o.id
                  ? o.id === 'approve'
                    ? 'border-[var(--positive)] bg-positive-soft'
                    : 'border-[var(--warning)] bg-warning-soft'
                  : 'border-line hover:border-line-strong')}>
              <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                {o.icon}{o.title}
              </span>
              <span className="mt-1 block text-[12.5px] text-subtle">{o.line}</span>
            </button>
          ))}
        </div>

        <Field
          label={decision === 'approve' ? 'Note (optional)' : 'What needs changing'}
          required={decision === 'reject'}
          hint={decision === 'approve'
            ? 'Kept on the task record with your sign-off'
            : 'The assignee sees this, so be specific about what is missing'}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
            placeholder={decision === 'approve'
              ? 'Anything worth recording alongside the sign-off…'
              : 'The August figures are missing from section 3 — please add them and resubmit.'} />
        </Field>
      </div>
    </Modal>
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
  // Assigning to a team means a project team: everyone seated on it, with one
  // of them still named accountable for the due date.
  const [mode, setMode] = useState<'person' | 'team'>('person');
  const [projectId, setProjectId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: team } = useQuery({
    queryKey: ['project-team', projectId],
    queryFn: () => api.get(`/projects/${projectId}/members`).then((r) => r.data),
    enabled: mode === 'team' && !!projectId,
  });

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
      ...(mode === 'team' && projectId ? { assign_from_project_id: projectId } : {}),
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
      subtitle="Who is responsible, by when — the assignee, due date and category drive reminders and escalation"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={form.title.trim().length < 2 || (mode === 'team' && (!projectId || !form.owner_id))}
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
        {/* ------------------------------------------------- assignment */}
        <div className="rounded-lg border border-line bg-sunken p-3">
          <div className="mb-2.5 flex items-center gap-2">
            <p className="label-cap">Assign to</p>
            <div className="ml-auto flex rounded-md border border-line-strong overflow-hidden">
              {([['person', 'One person', User], ['team', 'A project team', Users2]] as const).map(
                ([id, label, Icon]) => (
                  <button
                    key={id} type="button" onClick={() => setMode(id)} aria-pressed={mode === id}
                    className={cx('flex items-center gap-1.5 px-2.5 h-7 text-[12.5px] font-medium cursor-pointer',
                      'transition-colors duration-150 first:border-r first:border-line',
                      mode === id ? 'bg-brand-soft text-[var(--brand)]' : 'text-subtle hover:bg-raised')}
                  >
                    <Icon size={13} />{label}
                  </button>
                ),
              )}
            </div>
          </div>

          {mode === 'team' && (
            <Field label="Project team" className="mb-3"
              hint="Everyone seated on the project is assigned; pick who answers for it below">
              <Select value={projectId} onChange={(e) => {
                setProjectId(e.target.value);
                set('owner_id', '');
              }}>
                <option value="">Choose a project…</option>
                {meta?.projects?.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.client_name ? ` · ${p.client_name}` : ''} ({p.team_size} on team)
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {mode === 'team' && !!team?.length && (
            <ul className="mb-3 flex flex-wrap gap-1.5">
              {team.map((m: any) => (
                <li key={m.user_id}
                  className="flex items-center gap-1.5 rounded-full border border-line bg-raised py-0.5 pl-0.5 pr-2.5">
                  <Avatar name={m.name} url={m.avatar_url} size={20} />
                  <span className="text-[12.5px] text-ink">{m.name}</span>
                </li>
              ))}
            </ul>
          )}

          <Field
            label={mode === 'team' ? 'Accountable for it' : 'Assigned to'}
            required={mode === 'team'}
            hint={mode === 'team'
              ? 'One name answers for the due date, even when several people work it'
              : 'Who is responsible for getting this done'}
          >
            <Select value={form.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
              <option value="">{mode === 'team' ? 'Pick from the team…' : 'Unassigned'}</option>
              {(mode === 'team' ? (team || []).map((m: any) => ({ id: m.user_id, name: m.name }))
                : meta?.directory || []
              ).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
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

/* =============================================== DAILY UPDATES: EMPLOYEE */
/**
 * "What is on me, what still owes an update, what I have already written."
 * Deliberately three plain lists rather than a board: the point of this screen
 * is to be finished with in two minutes at the end of the day.
 */
function MyUpdatesView() {
  const [logging, setLogging] = useState<{ task: any; existing?: any } | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['my-updates'],
    queryFn: () => api.get('/action-items/updates/mine').then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <Card><TableSkeleton cols={3} /></Card>;

  const { needs_update: needs = [], submitted = [], due_today: due = [], tasks = [], recent = [] } = data;

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-3">
          <p className="label-cap">On my plate</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{tasks.length}</p>
          <p className="text-[12px] text-subtle">open tasks assigned to me</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Due today or overdue</p>
          <p className={cx('mt-1 text-[19px] font-semibold tabular',
            due.length ? 'text-[var(--negative)]' : 'text-ink')}>{due.length}</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Needs my update</p>
          <p className={cx('mt-1 text-[19px] font-semibold tabular',
            needs.length ? 'text-[var(--warning)]' : 'text-[var(--positive)]')}>{needs.length}</p>
          <p className="text-[12px] text-subtle">{needs.length ? 'not written up yet' : 'all caught up'}</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Logged today</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{submitted.length}</p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Needs today's update" icon={<CircleAlert size={16} />}
            subtitle="Open work assigned to you that you have not written up" />
          {!needs.length ? (
            <EmptyState compact icon={<CheckCircle2 size={20} className="text-[var(--positive)]" />}
              title="All caught up" message="Every task on you has an update logged for today." />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {needs.map((t: any) => (
                <NeedsUpdateRow key={t.id} task={t} onLog={() => setLogging({ task: t })} />
              ))}
            </ul>
          )}
        </Card>

        <Card className="min-w-0">
          <CardHeader title="My updates today" icon={<ClipboardList size={16} />}
            subtitle={submitted.length ? 'Click one to top it up' : undefined} />
          {!submitted.length ? (
            <EmptyState compact icon={<PencilLine size={20} />} title="Nothing written yet"
              message="Log an update against a task and it appears here." />
          ) : (
            <div className="space-y-2.5 p-3">
              {submitted.map((u: any) => (
                <button key={u.id} className="block w-full text-left cursor-pointer"
                  onClick={() => setLogging({
                    task: { id: u.action_item_id, title: u.task_title, status: u.task_status },
                    existing: u,
                  })}>
                  <UpdateCard update={u} showTask compact />
                </button>
              ))}
            </div>
          )}
        </Card>

        {recent.length > 0 && (
          <Card className="min-w-0 lg:col-span-2">
            <CardHeader title="Earlier updates" icon={<Clock size={16} />}
              subtitle="What you reported on previous days" />
            <div className="space-y-2.5 p-3">
              {recent.slice(0, 12).map((u: any) => (
                <div key={u.id}>
                  <p className="mb-1 text-[12px] font-medium text-subtle">{date(u.update_date, 'long')}</p>
                  <UpdateCard update={u} showTask compact />
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {logging && (
        <DailyUpdateModal task={logging.task} existing={logging.existing}
          onClose={() => setLogging(null)} />
      )}
    </>
  );
}

/* ================================================ DAILY UPDATES: MANAGER */
/**
 * One day, one row per person: what they are carrying, what they said, what is
 * blocking them, and what happens next. People who wrote nothing are shown as
 * loudly as people who did — silence is the thing a manager needs to see.
 */
function TeamUpdatesView() {
  const { can } = useAuth();
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [only, setOnly] = useState<'all' | 'silent' | 'blocked'>('all');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['team-updates', day],
    queryFn: () => api.get('/action-items/updates/team', { date: day }).then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <Card><TableSkeleton cols={5} /></Card>;

  const s = data.summary || {};
  const shown = (data.people || []).filter((p: any) => {
    if (only === 'silent') return p.status === 'silent';
    if (only === 'blocked') return p.blockers.length > 0;
    return p.status !== 'no_open_tasks' || p.updates.length;
  });

  const shift = (days: number) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const next = d.toISOString().slice(0, 10);
    if (next <= new Date().toISOString().slice(0, 10)) setDay(next);
  };

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => shift(-1)} aria-label="Previous day">←</Button>
            <Input type="date" value={day} max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDay(e.target.value)} className="w-[150px]" aria-label="Day" />
            <Button size="sm" onClick={() => shift(1)} aria-label="Next day">→</Button>
          </div>

          <Tabs active={only} onChange={(id) => setOnly(id as any)} className="border-0" tabs={[
            { id: 'all', label: 'Everyone', count: s.people },
            { id: 'silent', label: 'No update', count: s.silent || undefined },
            { id: 'blocked', label: 'Blocked', count: s.blocked || undefined },
          ]} />

          {can('action_items', 'export') && (
            <Button size="sm" icon={<Download size={14} />} className="ml-auto"
              onClick={() => api.download('/action-items/updates/export', `daily-updates-${day}.csv`,
                { from: day, to: day })}>
              Export
            </Button>
          )}
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-3">
          <p className="label-cap">Updated</p>
          <p className="mt-1 text-[19px] font-semibold text-[var(--positive)] tabular">{s.updated ?? 0}</p>
          <p className="text-[12px] text-subtle">of {s.people ?? 0} people</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">No update</p>
          <p className={cx('mt-1 text-[19px] font-semibold tabular',
            s.silent ? 'text-[var(--warning)]' : 'text-ink')}>{s.silent ?? 0}</p>
          <p className="text-[12px] text-subtle">have open work</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Reporting blockers</p>
          <p className={cx('mt-1 text-[19px] font-semibold tabular',
            s.blocked ? 'text-[var(--negative)]' : 'text-ink')}>{s.blocked ?? 0}</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Hours logged</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{s.hours_logged ?? 0}</p>
        </Card>
      </div>

      {!shown.length ? (
        <Card><EmptyState icon={<Users2 size={20} />} title="Nobody to show"
          message={only === 'all'
            ? 'No one on your team has open work on this day.'
            : 'Nothing matches that filter for this day.'} /></Card>
      ) : (
        <div className="space-y-3">
          {shown.map((p: any) => (
            <PersonUpdateCard key={p.user.id} row={p}
              open={expanded === p.user.id}
              onToggle={() => setExpanded(expanded === p.user.id ? null : p.user.id)} />
          ))}
        </div>
      )}
    </>
  );
}

function PersonUpdateCard({ row, open, onToggle }: { row: any; open: boolean; onToggle: () => void }) {
  const tone = row.status === 'updated' ? 'positive' : row.status === 'silent' ? 'warning' : 'neutral';
  const label = row.status === 'updated' ? 'updated'
    : row.status === 'silent' ? 'no update' : 'no open tasks';

  // The most recent update carries the headline answers for the collapsed row.
  const latest = row.updates[0];

  return (
    <Card>
      <button onClick={onToggle} aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left cursor-pointer row-hover">
        <Avatar name={row.user.name} url={row.user.avatar_url} size={32} />
        <span className="min-w-0">
          <span className="block text-[14px] font-medium text-ink">{row.user.name}</span>
          <span className="block text-[12px] text-subtle">{row.user.designation || 'Team member'}</span>
        </span>

        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={tone} dot>{label}</Badge>
          {row.blockers.length > 0 && <Badge tone="negative">{row.blockers.length} blocker{row.blockers.length > 1 ? 's' : ''}</Badge>}
          {row.overdue_tasks > 0 && <Badge tone="negative">{row.overdue_tasks} overdue</Badge>}
        </span>

        <span className="ml-auto flex items-center gap-4 text-[12.5px] text-subtle">
          <span className="tabular">{row.open_tasks} open</span>
          {row.avg_progress_pct != null && (
            <span className="hidden items-center gap-2 sm:flex">
              <Meter value={row.avg_progress_pct} className="w-20" />
              <span className="tabular w-9 text-right">{row.avg_progress_pct}%</span>
            </span>
          )}
          {row.hours_logged > 0 && <span className="tabular">{row.hours_logged}h</span>}
        </span>
      </button>

      {/* Collapsed: the one line a manager scans for. Expanded: everything. */}
      {!open && latest && (
        <div className="border-t border-line px-4 py-2.5">
          <p className="line-clamp-2 text-[13px] text-muted">
            <span className="font-medium text-ink">{latest.task_title}</span>
            {latest.completed_today && ` — ${latest.completed_today}`}
          </p>
          {latest.next_action && (
            <p className="mt-0.5 text-[12.5px] text-subtle">
              <span className="font-medium">Next:</span> {latest.next_action}
            </p>
          )}
        </div>
      )}

      {open && (
        <div className="space-y-3 border-t border-line p-4">
          {row.updates.length > 0 ? (
            row.updates.map((u: any) => <UpdateCard key={u.id} update={u} showTask />)
          ) : (
            <p className="text-[13px] text-subtle">Nothing written for this day.</p>
          )}

          {row.missing.length > 0 && (
            <div className="rounded-lg border border-dashed border-line p-3">
              <p className="mb-1.5 text-[12.5px] font-medium text-[var(--warning)]">
                Open with no update on this day
              </p>
              <ul className="space-y-1">
                {row.missing.map((t: any) => (
                  <li key={t.id} className="flex items-center gap-2 text-[13px] text-muted">
                    <span className="truncate">{t.title}</span>
                    <StatusBadge status={t.status} className="ml-auto shrink-0" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
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
  const [logOpen, setLogOpen] = useState(false);
  const [validateOpen, setValidateOpen] = useState(false);

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
    onSuccess: (res: any) => {
      invalidate();
      toast.success(res?.data?.validation_status === 'pending'
        ? 'Marked done — sent to whoever raised it for validation.'
        : 'Updated.');
    },
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
  // Only people on the task write updates against it.
  const onTask = (item.assignees || []).some((a: any) => a.user_id === user?.id);
  // A task somebody raised for themselves signs itself off; one raised for
  // someone else goes back to the creator when the assignee marks it done.
  const selfRaised = !item.created_by || item.created_by === user?.id;

  return (
    <>
      <Drawer open onClose={onClose} title={item.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={item.status} />
            {item.validation_status && <ValidationBadge item={item} compact />}
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
            {onTask && item.status !== 'done' && (
              <Button icon={<PencilLine size={15} />} onClick={() => setLogOpen(true)}>
                {item.my_update_today ? "Edit today's update" : 'Log daily update'}
              </Button>
            )}
            {item.can_validate && (
              <Button variant="primary" icon={<ShieldCheck size={15} />} onClick={() => setValidateOpen(true)}>
                Validate
              </Button>
            )}
            {can('action_items', 'edit') && item.status !== 'done' && (
              <>
                <Button icon={<ArrowUpRight size={15} />} onClick={() => setEscalateOpen(true)}>Escalate</Button>
                <Button variant="primary" icon={<CheckCircle2 size={15} />}
                  loading={update.isPending} onClick={() => update.mutate({ status: 'done' })}>
                  {selfRaised ? 'Mark done' : 'Mark done for validation'}
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

          {/* ------------------------------------------ who is on this */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="label-cap">Assigned to</p>
              <p className="text-[12px] text-subtle">
                Raised by {item.created_by_name || 'someone'} · {date(item.created_at)}
              </p>
            </div>
            {!item.assignees?.length ? (
              <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-center text-[13px] text-subtle">
                Nobody is assigned yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {item.assignees.map((a: any) => (
                  <li key={a.user_id}
                    className="flex items-center gap-2.5 rounded-md border border-line bg-sunken px-3 py-2">
                    <Avatar name={a.name} url={a.avatar_url} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">{a.name}</span>
                      <span className="block truncate text-[12px] text-subtle">
                        {a.designation || 'Team member'}
                      </span>
                    </span>
                    {a.accountable
                      ? <Badge tone="brand">accountable</Badge>
                      : <Badge tone="neutral">working on it</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* -------------------------------------------- creator sign-off */}
          {(item.validation_status || item.status === 'done') && (
            <div className={cx('rounded-lg border p-3.5',
              item.validation_status === 'validated'
                ? 'border-[color-mix(in_srgb,var(--positive)_30%,transparent)] bg-positive-soft'
                : 'border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-warning-soft')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <ShieldCheck size={15} />
                  {item.validation_status === 'validated' ? 'Validated'
                    : item.validation_status === 'changes_requested' ? 'Sent back for changes'
                      : 'Awaiting the creator’s validation'}
                </span>
                {item.can_validate && (
                  <Button size="sm" variant="primary" icon={<ShieldCheck size={14} />}
                    onClick={() => setValidateOpen(true)}>Validate</Button>
                )}
              </div>
              <p className="mt-1.5 text-[12.5px] text-muted">
                {item.validation_status === 'validated' ? (
                  // No name means it closed before sign-off existed and was
                  // settled by the migration, not by a person.
                  item.validated_by_name
                    ? <>Accepted by {item.validated_by_name}
                      {item.validated_at ? ` on ${dateTime(item.validated_at)}` : ''}.</>
                    : <>Closed{item.validated_at ? ` on ${dateTime(item.validated_at)}` : ''}, before
                      sign-off was part of the workflow.</>
                ) : item.validation_status === 'changes_requested' ? (
                  <>{item.validated_by_name || 'The creator'} sent this back
                    {item.validated_at ? ` on ${dateTime(item.validated_at)}` : ''} — it is live work again.</>
                ) : (
                  <>Completed by {item.completed_by_name || item.owner_name || 'the assignee'}
                    {item.completed_at ? ` on ${dateTime(item.completed_at)}` : ''}.
                    {' '}Waiting on {item.created_by_name || 'whoever raised it'} to accept it.</>
                )}
              </p>
              {item.validation_note && (
                <p className="mt-2 rounded-md bg-raised px-2.5 py-2 text-[13px] text-muted whitespace-pre-wrap">
                  “{item.validation_note}”
                </p>
              )}
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
              <Field label="Accountable" hint="One name answers for the due date">
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
            {item.completed_by_name && <Detail label="Completed by" value={item.completed_by_name} />}
            {item.validated_at && item.validation_status === 'validated' && (
              <Detail label="Validated" value={`${item.validated_by_name || '—'} · ${date(item.validated_at)}`} />
            )}
            {item.rework_count > 0 && (
              <Detail label="Sent back" value={`${item.rework_count} time${item.rework_count > 1 ? 's' : ''}`} />
            )}
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

          {/* ------------------------------------------ sign-off history */}
          {item.validations?.length > 0 && (
            <div>
              <p className="label-cap mb-2 flex items-center gap-1.5">
                <History size={13} /> Completion & validation history
              </p>
              <ul className="space-y-2">
                {item.validations.map((v: any) => (
                  <li key={v.id} className="rounded-md border border-line p-2.5 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">
                        {v.event === 'submitted' ? `Marked done by ${v.actor_name || 'someone'}`
                          : v.event === 'validated' ? `Validated by ${v.actor_name || 'someone'}`
                            : v.event === 'changes_requested' ? `Sent back by ${v.actor_name || 'someone'}`
                              : `Reopened by ${v.actor_name || 'someone'}`}
                      </span>
                      <span className="text-subtle text-[12px]">
                        attempt {v.round} · {dateTime(v.created_at)}
                      </span>
                    </div>
                    {v.note && <p className="mt-1 text-muted whitespace-pre-wrap">{v.note}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---------------------------------------------- daily updates */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="label-cap">
                Daily updates {item.updates?.length > 0 && `(${item.updates.length})`}
              </p>
              {onTask && item.status !== 'done' && (
                <Button size="sm" variant={item.my_update_today ? 'secondary' : 'primary'}
                  icon={<PencilLine size={14} />} onClick={() => setLogOpen(true)}>
                  {item.my_update_today ? 'Edit mine' : 'Log update'}
                </Button>
              )}
            </div>
            {!item.updates?.length ? (
              <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-subtle">
                No progress has been written up on this task yet.
              </p>
            ) : (
              <div className="space-y-2.5">
                {item.updates.map((u: any) => (
                  <div key={u.id}>
                    <p className="mb-1 text-[12px] font-medium text-subtle">{date(u.update_date, 'long')}</p>
                    <UpdateCard update={u} showPerson compact />
                  </div>
                ))}
              </div>
            )}
          </div>

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

      {validateOpen && (
        <ValidateModal item={item} onClose={() => setValidateOpen(false)} onDone={invalidate} />
      )}

      {logOpen && (
        <DailyUpdateModal task={item} existing={item.my_update_today}
          onClose={() => setLogOpen(false)} onSaved={invalidate} />
      )}

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
