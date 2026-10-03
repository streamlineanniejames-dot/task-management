import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceToday } from './format';

/* ========================================================= SPEECH CAPTURE */
/**
 * The browser's own speech recognition (Chrome, Edge, Safari). Nothing leaves
 * for a paid service and there is no key to manage; Firefox simply has no mic
 * button. Indian English is the default because it hears local names - Adithya,
 * Cotton India - far better than en-US does.
 */
const Recognition: any = typeof window !== 'undefined'
  ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  : null;

export const speechSupported = !!Recognition;

export function useSpeech({ lang = 'en-IN', onFinal }: {
  lang?: string;
  onFinal: (text: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const rec = useRef<any>(null);
  const finalText = useRef('');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => () => rec.current?.abort(), []);

  const start = useCallback(() => {
    if (!Recognition || rec.current) return;
    const r = new Recognition();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    finalText.current = '';
    setInterim('');
    setError('');

    r.onresult = (e: any) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText.current += `${t} `;
        else live += t;
      }
      setInterim(`${finalText.current}${live}`.trim());
    };
    r.onerror = (e: any) => {
      setError(e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Microphone access is blocked — allow it from the lock icon in the address bar'
        : e.error === 'no-speech' ? 'Didn’t hear anything — try again a little closer to the mic'
          : e.error === 'aborted' ? '' : `Voice input stopped (${e.error})`);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      const text = finalText.current.trim();
      if (text) onFinalRef.current(text);
    };

    rec.current = r;
    r.start();
    setListening(true);
  }, [lang]);

  const stop = useCallback(() => rec.current?.stop(), []);

  return { listening, interim, error, start, stop, supported: speechSupported };
}

/* ========================================================= TASK PARSING */
/**
 * Turns "Ask Adithya to send the August report to Cotton India by Friday 5pm,
 * high priority" into form fields. Deliberately plain rules rather than a model:
 * it is instant, free, and when it guesses wrong the form is right there to fix.
 * Anything it cannot place stays in the title, so nothing said is lost.
 */
type Named = { id: string; name: string };

export type VoiceParse = {
  title: string;
  owner_id?: string; owner_name?: string;
  client_id?: string; client_name?: string;
  category_id?: string; category_name?: string;
  priority?: string;
  due_date?: string;
  due_time?: string;
  recurrence?: string;
  estimate_minutes?: string;
  unmatchedPerson?: string;
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MONTH_RE = `(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)`;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45,
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad = (n: number) => String(n).padStart(2, '0');

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** The longest catalogue entry named in the text - by full name, else first name. */
function findNamed(text: string, list: Named[], { firstName = false } = {}) {
  let best: { item: Named; match: string } | null = null;
  const consider = (item: Named, phrase: string) => {
    if (phrase.length < 3) return;
    const m = text.match(new RegExp(`\\b${esc(phrase)}\\b`, 'i'));
    if (m && (!best || m[0].length > best.match.length)) best = { item, match: m[0] };
  };
  for (const item of list) {
    consider(item, item.name.trim());
    if (firstName) consider(item, item.name.trim().split(/\s+/)[0]);
  }
  return best as { item: Named; match: string } | null;
}

function toTime(hRaw: string, mRaw: string | undefined, ampm: string | undefined) {
  let h = Number(NUMBER_WORDS[hRaw.toLowerCase()] ?? hRaw);
  const m = mRaw ? Number(mRaw) : 0;
  if (Number.isNaN(h) || h > 23 || m > 59) return '';
  const mer = ampm?.replace(/\./g, '').toLowerCase();
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  // A bare "by 5" in an office means the afternoon, not before dawn.
  if (!mer && h >= 1 && h <= 7) h += 12;
  return `${pad(h)}:${pad(m)}`;
}

export function parseVoiceTask(raw: string, ctx: {
  people: Named[]; clients: Named[]; categories: Named[]; selfId?: string;
}): VoiceParse {
  let t = ` ${raw.replace(/\s+/g, ' ').trim()} `;
  const out: VoiceParse = { title: '' };
  const cut = (re: RegExp) => { t = t.replace(re, ' '); };
  const today = workspaceToday();

  // ---------------------------------------------------------------- priority
  const pr = t.match(/\b(?:(?:it'?s|make it|mark it|set)\s+)?(?:as\s+)?(urgent|high|medium|normal|low)\s+priority\b|\bpriority\s+(?:is\s+)?(urgent|high|medium|normal|low)\b|\b(urgent(?:ly)?|asap|as soon as possible|immediately)\b/i);
  if (pr) {
    const word = (pr[1] || pr[2] || 'urgent').toLowerCase();
    out.priority = word === 'normal' ? 'medium' : word.startsWith('urgent') || pr[3] ? 'urgent' : word;
    cut(new RegExp(`[,.]?\\s*${esc(pr[0])}`, 'i'));
  }

  // -------------------------------------------------------------- recurrence
  const rc = t.match(/\b(every\s*day|daily|every\s+week(?:day)?|weekly|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|every\s+month|monthly)\b/i);
  if (rc) {
    const w = rc[1].toLowerCase();
    out.recurrence = /day$|daily|weekday/.test(w) && !/(mon|tues|wednes|thurs|fri|satur|sun)day/.test(w) ? 'daily'
      : /month/.test(w) ? 'monthly' : 'weekly';
    cut(new RegExp(`[,.]?\\s*(?:and\\s+)?(?:repeat\\s+)?${esc(rc[0])}`, 'i'));
  }

  // -------------------------------------------------------------- estimate
  const es = t.match(/\b(?:(?:it\s+)?(?:will\s+)?(?:takes?|need?s?|estimate[ds]?(?:\s+at)?|effort(?:\s+of)?)\s+(?:about\s+|around\s+)?)?(half an hour|an hour|(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|ten|fifteen|twenty|thirty|forty five|forty)\s*(hours?|hrs?|minutes?|mins?))\b/i);
  if (es && /takes?|need|estimate|effort|hour|min/i.test(es[0])) {
    let mins = 0;
    if (/half an hour/i.test(es[1])) mins = 30;
    else if (/^an hour/i.test(es[1])) mins = 60;
    else {
      const n = Number(NUMBER_WORDS[es[2].toLowerCase()] ?? es[2]);
      mins = /^h/i.test(es[3]) ? Math.round(n * 60) : Math.round(n);
    }
    if (mins > 0) { out.estimate_minutes = String(mins); cut(new RegExp(`[,.]?\\s*${esc(es[0])}`, 'i')); }
  }

  // -------------------------------------------------------------- due time
  const PREP = '(?:by|at|before|around|till|until|due)?\\s*';
  const tm = t.match(new RegExp(`\\b${PREP}(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?|o'?clock)(?=\\W)`, 'i'))
    || t.match(/\b(?:by|at|before|around)\s+(\d{1,2})[:.](\d{2})\b()/i)
    || t.match(/\b(?:by|at|before)\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|days?|weeks?|hours?|mins?|minutes?|\/|-|(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))()/i);
  if (tm) {
    const time = toTime(tm[1], tm[2], /o'?clock/i.test(tm[3] || '') ? undefined : tm[3]);
    if (time) { out.due_time = time; cut(new RegExp(`[,.]?\\s*${esc(tm[0])}`, 'i')); }
  }
  if (!out.due_time) {
    const named = t.match(/\b(?:by|before|at|in the|this)?\s*(noon|midday|lunch(?:time)?|end of (?:the )?day|eod|close of business|cob|this evening|evening|tonight|this morning|morning|afternoon)\b/i);
    if (named) {
      const w = named[1].toLowerCase();
      out.due_time = /noon|midday|lunch/.test(w) ? '12:00' : /morning/.test(w) ? '10:00'
        : /afternoon/.test(w) ? '15:00' : /tonight/.test(w) ? '20:00' : '18:00';
      if (/tonight|this evening|this morning|end of (the )?day|eod|close of business|cob/.test(w)) out.due_date = today;
      cut(new RegExp(`[,.]?\\s*${esc(named[0])}`, 'i'));
    }
  }

  // -------------------------------------------------------------- due date
  const DP = '(?:due\\s+|by\\s+|on\\s+|before\\s+|for\\s+)?';
  const dateRules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [new RegExp(`\\b${DP}(?:the\\s+)?day after tomorrow\\b`, 'i'), () => addDays(today, 2)],
    [new RegExp(`\\b${DP}tomorrow\\b`, 'i'), () => addDays(today, 1)],
    [new RegExp(`\\b${DP}today\\b`, 'i'), () => today],
    [new RegExp(`\\b${DP}(?:in|within)\\s+(\\d+|one|two|three|four|five|six|seven|ten)\\s+(days?|weeks?)\\b`, 'i'),
      (m) => addDays(today, Number(NUMBER_WORDS[m[1].toLowerCase()] ?? m[1]) * (/week/i.test(m[2]) ? 7 : 1))],
    [new RegExp(`\\b${DP}(?:the\\s+)?end of (?:the |this )?week\\b`, 'i'),
      () => addDays(today, (5 - weekdayOf(today) + 7) % 7)],
    [new RegExp(`\\b${DP}(?:the\\s+)?end of (?:the |this )?month\\b`, 'i'), () => {
      const d = new Date(`${today}T00:00:00Z`);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    }],
    [new RegExp(`\\b${DP}next week\\b`, 'i'), () => addDays(today, 7)],
    [new RegExp(`\\b${DP}(this\\s+|next\\s+|coming\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i'), (m) => {
      const target = WEEKDAYS.indexOf(m[2].toLowerCase());
      // "Friday" and "next Friday" both mean the coming one; saying it on a
      // Friday means a week out, never today.
      return addDays(today, (target - weekdayOf(today) + 7) % 7 || 7);
    }],
    // "15th August", "15 of Aug"
    [new RegExp(`\\b${DP}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'i'),
      (m) => monthDay(Number(m[1]), m[2])],
    // "August 15th"
    [new RegExp(`\\b${DP}${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), (m) => monthDay(Number(m[2]), m[1])],
    // "15/10" - day first, as written in India
    [new RegExp(`\\b${DP}(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?\\b`, 'i'), (m) => {
      const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today.slice(0, 4);
      const iso = `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
      return !m[3] && iso < today ? `${Number(y) + 1}${iso.slice(4)}` : iso;
    }],
    // "on the 20th"
    [new RegExp(`\\b(?:due\\s+|by\\s+|on\\s+|before\\s+)(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b`, 'i'), (m) => {
      const day = Number(m[1]);
      let iso = `${today.slice(0, 8)}${pad(day)}`;
      if (iso < today) {
        const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + 1);
        iso = `${d.toISOString().slice(0, 8)}${pad(day)}`;
      }
      return iso;
    }],
  ];
  function monthDay(day: number, monthWord: string) {
    const mi = MONTHS.findIndex((mo) => mo.startsWith(monthWord.toLowerCase().slice(0, 3)));
    const y = Number(today.slice(0, 4));
    const iso = `${y}-${pad(mi + 1)}-${pad(day)}`;
    return iso < today ? `${y + 1}-${pad(mi + 1)}-${pad(day)}` : iso;
  }
  for (const [re, fn] of dateRules) {
    const m = t.match(re);
    if (!m) continue;
    const iso = fn(m);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso))) {
      out.due_date = iso;
      cut(new RegExp(`[,.]?\\s*${esc(m[0])}`, 'i'));
      break;
    }
  }
  // A time with no day said means the next time that hour comes round.
  if (out.due_time && !out.due_date) out.due_date = today;

  // -------------------------------------------------------------- assignee
  const people = ctx.people.filter((p) => p.id !== ctx.selfId);
  const who = findNamed(t, people, { firstName: true });
  if (who) {
    out.owner_id = who.item.id;
    out.owner_name = who.item.name;
    const n = esc(who.match);
    // "assign to X", "ask X to", "tell X to", "X should", "for X" - drop the
    // instruction around the name, keep the work itself.
    cut(new RegExp(`\\b(?:(?:please\\s+)?(?:assign(?:ed)?|give|hand|allot)\\s+(?:this|it|the task)?\\s*to|ask|tell|remind|get|have|for|with|owner(?:\\s+is)?|assignee(?:\\s+is)?)?\\s*${n}\\b(?:\\s+(?:to|should|needs? to|has to|must|will|can you|please))?`, 'i'));
  } else {
    const loose = t.match(/\b(?:assign(?:ed)?\s+(?:this\s+|it\s+)?to|ask|tell|remind)\s+([A-Za-z]+)/i);
    if (loose) out.unmatchedPerson = loose[1];
  }

  // -------------------------------------------------------- client, category
  // Left in the title - "send the report to Cotton India" still reads as said.
  const client = findNamed(t, ctx.clients);
  if (client) { out.client_id = client.item.id; out.client_name = client.item.name; }
  const cat = findNamed(t, ctx.categories);
  if (cat) { out.category_id = cat.item.id; out.category_name = cat.item.name; }

  // ---------------------------------------------------------------- title
  let title = t
    .replace(/\b(?:create|add|new|make)\s+(?:an?\s+)?(?:action item|task)\s*(?:to|for)?\b/gi, ' ')
    .replace(/\b(?:please|kindly|can you|could you)\b/gi, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
    .replace(/^(?:to|and|that|the task is)\s+/i, '')
    .replace(/\s+(?:and|by|on|at|to|for|with|due)$/i, '');
  if (!title) title = raw.trim();
  out.title = title.charAt(0).toUpperCase() + title.slice(1);
  return out;
}
