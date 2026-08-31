/**
 * Today — the day's meetings and the follow-ups that are due.
 *
 * Both come from the same /dashboard/home payload Home already holds, so
 * switching to this tab costs no request. The overdue work is pulled in from
 * /action-items/me/today, which is the one thing Home's summary counts but does
 * not list in full.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck, CalendarClock, CheckCircle2, MapPin, PhoneCall, Users, Video,
} from 'lucide-react';
import { api } from '../../lib/api';
import { date as fmtDate, time as fmtTime } from '../../lib/format';
import { useToast } from '../../components/ui';
import { openUrl } from '../../lib/openUrl';
import { HOME_KEY, useHomeFeed } from '../MobileApp';
import {
  Empty, ErrorNote, List, Loading, MButton, MField, Pill, Row, Screen, Section, Sheet, inputClass,
} from '../ui';

/** A location that is a link is a video call; anything else is a place. */
const isLink = (s?: string | null) => !!s && /^https?:\/\//i.test(s.trim());

export default function MobileToday() {
  const { data, isLoading, error, refetch } = useHomeFeed();
  const [followUp, setFollowUp] = useState<any>(null);

  const mine = useQuery({
    queryKey: ['m', 'me-today'],
    queryFn: () => api.get('/action-items/me/today').then((r) => r.data),
    staleTime: 30_000,
  });

  if (isLoading) return <Loading label="Loading today" />;
  if (error) return <div className="p-4"><ErrorNote error={error} retry={refetch} /></div>;

  const meetings: any[] = data?.meetings || [];
  const followUps: any[] = data?.follow_ups || [];
  const overdue: any[] = mine.data?.overdue || [];

  return (
    <>
      <Screen title="Today" subtitle={fmtDate(new Date().toISOString(), 'long')}>

        <Section title={`Meetings${meetings.length ? ` · ${meetings.length}` : ''}`}>
          <List empty={<Empty icon={<CalendarCheck size={22} />} title="No meetings today"
            message="Anything you organise or are invited to shows up here." />}>
            {meetings.map((m) => (
              <Row
                key={m.id}
                leading={(
                  <span className="flex h-10 w-14 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-soft">
                    <span className="text-[13px] font-bold leading-none text-brand tabular-nums">
                      {fmtTime(m.scheduled_at)}
                    </span>
                    <span className="mt-0.5 text-[10px] leading-none text-brand">
                      {m.duration_minutes ? `${m.duration_minutes}m` : ''}
                    </span>
                  </span>
                )}
                title={m.title}
                meta={[m.client_name, m.location].filter(Boolean).join(' · ') || 'No location set'}
                right={isLink(m.location)
                  ? (
                    <button
                      type="button"
                      onClick={() => openUrl(m.location)}
                      aria-label={`Join ${m.title}`}
                      className="flex min-h-[40px] items-center gap-1 rounded-lg bg-[var(--brand)] px-3 text-[12.5px] font-semibold text-white"
                    >
                      <Video size={14} /> Join
                    </button>
                  )
                  : m.location ? <MapPin size={16} /> : undefined}
              />
            ))}
          </List>
        </Section>

        <Section title={`Follow-ups due${followUps.length ? ` · ${followUps.length}` : ''}`}>
          <List empty={<Empty icon={<PhoneCall size={22} />} title="No follow-ups due"
            message="Clients you own with a next action dated today or earlier appear here." />}>
            {followUps.map((f) => (
              <Row
                key={f.id}
                title={f.name}
                meta={f.next_action || 'No action noted'}
                onClick={() => setFollowUp(f)}
                right={(
                  <span className="flex items-center gap-2">
                    <Pill tone={overdueTone(f.next_action_date)}>
                      {fmtDate(f.next_action_date, 'day')}
                    </Pill>
                  </span>
                )}
              />
            ))}
          </List>
        </Section>

        {overdue.length > 0 && (
          <Section title={`Overdue · ${overdue.length}`}>
            <OverdueList items={overdue} />
          </Section>
        )}

        {(mine.data?.upcoming || []).length > 0 && (
          <Section title="Coming up">
            <List>
              {(mine.data.upcoming as any[]).slice(0, 6).map((it) => (
                <Row key={it.id} title={it.title}
                  meta={[it.client_name, `due ${fmtDate(it.due_date, 'day')}`].filter(Boolean).join(' · ')}
                  right={<CalendarClock size={16} />} />
              ))}
            </List>
          </Section>
        )}
      </Screen>

      <FollowUpSheet client={followUp} onClose={() => setFollowUp(null)} />
    </>
  );
}

const overdueTone = (iso?: string | null) => {
  if (!iso) return 'neutral' as const;
  return iso < new Date().toISOString().slice(0, 10) ? ('negative' as const) : ('warning' as const);
};

function OverdueList({ items }: { items: any[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/action-items/${id}`, { status: 'done' }),
    onSuccess: () => {
      toast.success('Marked done.');
      qc.invalidateQueries({ queryKey: HOME_KEY });
      qc.invalidateQueries({ queryKey: ['m', 'me-today'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <List>
      {items.map((it) => (
        <Row
          key={it.id}
          title={it.title}
          meta={[it.client_name, `was due ${fmtDate(it.due_date, 'day')}`].filter(Boolean).join(' · ')}
          right={(
            <button type="button" aria-label={`Mark ${it.title} done`}
              onClick={() => complete.mutate(it.id)} className="text-subtle active:text-positive">
              <CheckCircle2 size={22} />
            </button>
          )}
        />
      ))}
    </List>
  );
}

/**
 * Logging a follow-up writes a CRM activity and moves the next action on, which
 * is the whole reason someone opens this on a phone: they have just come off a
 * call and want it recorded before the next one starts.
 */
function FollowUpSheet({ client, onClose }: { client: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');

  // One call: the API treats logging a touchpoint as the moment to move the
  // next action on, so there is no second request to keep in step.
  const log = useMutation({
    mutationFn: () => api.post(`/crm/clients/${client.id}/activities`, {
      type: 'call',
      direction: 'outbound',
      body: note.trim(),
      occurred_at: new Date().toISOString(),
      ...(next ? { next_action_date: next } : {}),
    }),
    onSuccess: () => {
      toast.success('Follow-up logged.');
      qc.invalidateQueries({ queryKey: HOME_KEY });
      setNote('');
      setNext('');
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (!client) return null;

  return (
    <Sheet
      open={!!client} onClose={onClose} title={client.name}
      footer={(
        <MButton variant="primary" full loading={log.isPending}
          disabled={note.trim().length < 2} onClick={() => log.mutate()}>
          Log follow-up
        </MButton>
      )}
    >
      <div className="card p-3">
        <p className="label-cap">Next action</p>
        <p className="mt-1 text-[14px] text-ink">{client.next_action || 'Not set'}</p>
        <p className="mt-0.5 text-[12.5px] text-subtle">
          Due {fmtDate(client.next_action_date, 'day')}
        </p>
      </div>

      <MField label="What happened?">
        <textarea
          className={`${inputClass} min-h-[96px] py-2.5`} value={note} autoFocus
          placeholder="Spoke to Priya — sending revised scope on Thursday"
          onChange={(e) => setNote(e.target.value)}
        />
      </MField>

      <MField label="Next action date" hint="Leave blank to keep the current date.">
        <input type="date" className={inputClass} value={next}
          onChange={(e) => setNext(e.target.value)} />
      </MField>
    </Sheet>
  );
}
