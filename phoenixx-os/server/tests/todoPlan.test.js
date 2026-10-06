import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Review Agency', email: 'owner@review.test' });
const ownerToken = owner.access_token;
const tenantId = db.get('SELECT tenant_id FROM users WHERE email = ?', ['owner@review.test']).tenant_id;

async function join(name, role = 'employee') {
  const email = `${name.toLowerCase()}@review.test`;
  const invite = await api.post('/users', { name, email, role }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, token: accepted.body.data.access_token, name };
}

const reportTo = async (person, manager) => {
  const res = await api.patch(`/users/${person.id}`, { manager_id: manager.id }, { token: ownerToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

/**
 * Every day a working day, so "today" always has a window whatever the date
 * the suite runs on. `open` keeps the deadline at the end of the day; `closed`
 * puts it a couple of minutes after midnight so anything filed now is late.
 */
const schedule = (kind, extra = {}) => api.put('/todo-plan/settings', {
  enabled: true,
  working_days: [0, 1, 2, 3, 4, 5, 6],
  ...(kind === 'open'
    ? { open_time: '00:00', reminder_time: '00:01', deadline_time: '23:57', escalation_time: '23:58' }
    : { open_time: '00:00', reminder_time: '00:01', deadline_time: '00:02', escalation_time: '00:03' }),
  ...extra,
}, { token: ownerToken });

const inbox = (userId, eventKey) => db.all(
  "SELECT * FROM notifications WHERE tenant_id = ? AND user_id = ? AND event_key = ? AND channel = 'in_app'",
  [tenantId, userId, eventKey],
);

const TASKS = [
  { task: 'Complete lead verification', priority: 'high', expected_time: '10:30', notes: 'Batch from Monday' },
  { task: 'Follow up with 20 prospects', priority: 'medium' },
];

let mani; let ravi; let kumar; let arun; let sita;
let target; let kumarPlan;

before(async () => {
  mani = await join('Mani', 'manager');
  ravi = await join('Ravi', 'manager');
  kumar = await join('Kumar');
  arun = await join('Arun');
  sita = await join('Sita');
  await reportTo(kumar, mani);
  await reportTo(arun, mani);
  await reportTo(sita, ravi);
  const res = await schedule('open');
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

describe('employee: filing tomorrow\'s plan', () => {
  test('the card shows the next working day and who the plan goes to', async () => {
    const res = await api.get('/todo-plan/mine', { token: kumar.token });
    assert.equal(res.status, 200);
    target = res.body.data.window.todo_date;
    assert.ok(target > res.body.data.window.today);
    assert.equal(res.body.data.plan, null);
    assert.equal(res.body.data.reporting_person.name, 'Mani');
    assert.equal(res.body.data.expected, true);
  });

  test('bad tasks are refused with the line that is wrong', async () => {
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: [{ task: 'x', priority: 'urgent' }] }, { token: kumar.token });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /Task 1: priority/);
    const empty = await api.put(`/todo-plan/mine/${target}`, { tasks: [], submit: true }, { token: kumar.token });
    assert.equal(empty.status, 400);
  });

  test('a project the person cannot see is refused', async () => {
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: [{ task: 'x', project_id: crypto.randomUUID() }] }, { token: kumar.token });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /not available to you/);
  });

  test('a plan can only be filed for the next working day', async () => {
    const res = await api.put('/todo-plan/mine/2030-01-01', { tasks: TASKS }, { token: kumar.token });
    assert.equal(res.status, 400);
  });

  test('save draft keeps the tasks without telling anyone', async () => {
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: TASKS }, { token: kumar.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'DRAFT');
    assert.equal(res.body.data.tasks.length, 2);
    assert.equal(res.body.data.tasks[0].priority, 'high');
    assert.equal(res.body.data.tasks[0].expected_time, '10:30');
    assert.equal(inbox(mani.id, 'todo.submitted').length, 0);
    kumarPlan = res.body.data.id;
  });

  test('submitting routes to the reporting person on record, whatever the request says', async () => {
    const res = await api.put(`/todo-plan/mine/${target}`,
      { tasks: TASKS, submit: true, reporting_person_id: ravi.id }, { token: kumar.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'SUBMITTED');
    assert.equal(res.body.data.reporting_person_id, mani.id);
    assert.ok(res.body.data.submitted_at);
    const n = inbox(mani.id, 'todo.submitted');
    assert.equal(n.length, 1);
    assert.equal(n[0].link, `/?plan=${kumarPlan}`);
    assert.equal(inbox(ravi.id, 'todo.submitted').length, 0);
  });

  test('there is only ever one plan per person per day', async () => {
    await api.put(`/todo-plan/mine/${target}`, { tasks: TASKS, submit: true }, { token: kumar.token });
    const rows = db.all('SELECT id FROM todo_submissions WHERE user_id = ? AND todo_date = ?', [kumar.id, target]);
    assert.equal(rows.length, 1);
    assert.throws(() => db.run(
      `INSERT INTO todo_submissions (id, tenant_id, user_id, todo_date, plan_date, status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'DRAFT', ?, ?)`,
      [crypto.randomUUID(), tenantId, kumar.id, target, target, new Date().toISOString(), new Date().toISOString()],
    ), /UNIQUE/);
  });

  test('an employee cannot change their own reporting person', async () => {
    const res = await api.patch(`/users/${kumar.id}`, { manager_id: ravi.id }, { token: kumar.token });
    assert.equal(res.status, 403);
  });
});

describe('who can see a plan', () => {
  test('another employee cannot open it', async () => {
    assert.equal((await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: arun.token })).status, 404);
  });

  test('an unrelated manager can neither open nor review it', async () => {
    assert.equal((await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: ravi.token })).status, 404);
    assert.equal((await api.post(`/todo-plan/submissions/${kumarPlan}/approve`, {}, { token: ravi.token })).status, 404);
  });

  test('the owner can open any plan', async () => {
    const res = await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.can_review, true);
  });

  test('nobody approves their own plan', async () => {
    assert.equal((await api.post(`/todo-plan/submissions/${kumarPlan}/approve`, {}, { token: kumar.token })).status, 403);
  });

  test('a manager\'s team view holds only their own people', async () => {
    const res = await api.get('/todo-plan/team', { token: mani.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.rows.map((r) => r.user.name), ['Arun', 'Kumar']);
    assert.deepEqual(res.body.data.pending.map((p) => p.id), [kumarPlan]);
    assert.equal(res.body.data.counts.SUBMITTED, 1);
    assert.equal(res.body.data.counts.not_submitted, 1);

    const r2 = await api.get('/todo-plan/team', { token: ravi.token });
    assert.deepEqual(r2.body.data.rows.map((r) => r.user.name), ['Sita']);
    assert.equal(r2.body.data.pending.length, 0);
  });

  test('an employee with nobody reporting to them is not a reviewer', async () => {
    const res = await api.get('/todo-plan/team', { token: arun.token });
    assert.equal(res.body.data.is_reviewer, false);
    assert.equal(res.body.data.rows.length, 0);
  });
});

describe('review', () => {
  test('opening it puts it under review and freezes the employee\'s copy', async () => {
    const res = await api.post(`/todo-plan/submissions/${kumarPlan}/open`, {}, { token: mani.token });
    assert.equal(res.body.data.status, 'UNDER_REVIEW');
    const edit = await api.put(`/todo-plan/mine/${target}`, { tasks: TASKS }, { token: kumar.token });
    assert.equal(edit.status, 403);
  });

  test('requesting changes needs a note and tells the employee', async () => {
    assert.equal((await api.post(`/todo-plan/submissions/${kumarPlan}/request-changes`, {}, { token: mani.token })).status, 400);
    const res = await api.post(`/todo-plan/submissions/${kumarPlan}/request-changes`,
      { note: 'Please add the expected number of leads to be completed.' }, { token: mani.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'CHANGES_REQUESTED');
    const n = inbox(kumar.id, 'todo.changes_requested');
    assert.equal(n.length, 1);
    assert.match(n[0].body, /expected number of leads/);
    assert.match(n[0].body, /Mani/);
  });

  test('the employee sees the note and can edit and resubmit', async () => {
    const mine = await api.get('/todo-plan/mine', { token: kumar.token });
    assert.equal(mine.body.data.plan.status, 'CHANGES_REQUESTED');
    assert.equal(mine.body.data.plan.can_edit, true);
    assert.ok(mine.body.data.plan.comments.some((c) => c.kind === 'changes_requested'));

    const res = await api.put(`/todo-plan/mine/${target}`, {
      tasks: [{ ...TASKS[0], task: 'Complete lead verification (40 leads)' }, TASKS[1]], submit: true,
    }, { token: kumar.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'SUBMITTED');
    assert.equal(inbox(mani.id, 'todo.submitted').length, 3, 'first submit, re-save, and the resubmission');
  });

  test('comments reach the other side', async () => {
    const res = await api.post(`/todo-plan/submissions/${kumarPlan}/comments`, { body: 'Leads count added.' }, { token: kumar.token });
    assert.equal(res.status, 200);
    assert.equal(inbox(mani.id, 'todo.comment').length, 1);
  });

  test('approving tells the employee and locks the plan', async () => {
    const res = await api.post(`/todo-plan/submissions/${kumarPlan}/approve`, {}, { token: mani.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'APPROVED');
    assert.ok(res.body.data.approved_at);
    assert.equal(res.body.data.reviewed_by, mani.id);
    assert.equal(inbox(kumar.id, 'todo.approved').length, 1);
    assert.equal((await api.put(`/todo-plan/mine/${target}`, { tasks: TASKS }, { token: kumar.token })).status, 403);
    assert.equal((await api.post(`/todo-plan/submissions/${kumarPlan}/approve`, {}, { token: mani.token })).status, 400);

    const teamView = await api.get('/todo-plan/team', { token: mani.token });
    assert.equal(teamView.body.data.counts.APPROVED, 1);
  });

  test('every step is in the audit log', () => {
    const actions = db.all("SELECT action FROM audit_logs WHERE entity = 'todo_submission' AND entity_id = ?", [kumarPlan]).map((r) => r.action);
    for (const a of ['create', 'submit', 'review_start', 'request_changes', 'resubmit', 'comment', 'approve']) {
      assert.ok(actions.includes(a), `missing ${a} in ${actions}`);
    }
  });
});

describe('reporting person changes', () => {
  test('after the owner reassigns someone, their next plan goes to the new person', async () => {
    await reportTo(arun, ravi);
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: TASKS, submit: true }, { token: arun.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.reporting_person_id, ravi.id);
    assert.equal(inbox(ravi.id, 'todo.submitted').length, 1);
    assert.equal(inbox(mani.id, 'todo.submitted').filter((n) => /Arun/.test(n.body)).length, 0);
    assert.equal((await api.get(`/todo-plan/submissions/${res.body.data.id}`, { token: ravi.token })).status, 200);
  });
});

describe('late submission', () => {
  test('after the deadline a plan is accepted but marked LATE with the minutes', async () => {
    await schedule('closed', { allow_late: true });
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: TASKS, submit: true }, { token: sita.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'LATE');
    assert.ok(res.body.data.minutes_late > 0);
    const toRavi = inbox(ravi.id, 'todo.submitted').find((n) => /Sita/.test(n.body));
    assert.match(toRavi.body, /Sita \(\d+ min late\)/);
  });

  test('with late submission off, the deadline is final', async () => {
    await schedule('closed', { allow_late: false });
    const late = await join('Latif');
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: TASKS, submit: true }, { token: late.token });
    assert.equal(res.status, 403);
    assert.match(JSON.stringify(res.body), /late plans are not accepted/);
  });
});
