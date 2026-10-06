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

describe('reporting structure', () => {
  const setLine = (who, managerId, token) => api.put(`/todo-plan/reporting/${who.id}`, { manager_id: managerId }, { token });

  test('an employee cannot change anyone\'s reporting person, their own included', async () => {
    assert.equal((await setLine(kumar, ravi.id, kumar.token)).status, 403);
    assert.equal((await setLine(arun, kumar.id, kumar.token)).status, 403);
  });

  test('a manager cannot build a team until the owner allows it', async () => {
    const usha = await join('Usha');
    const res = await setLine(usha, mani.id, mani.token);
    assert.equal(res.status, 403);
    const team = await api.get('/todo-plan/team', { token: mani.token });
    assert.equal(team.body.data.can_assign, false);
    assert.deepEqual(team.body.data.assignable, []);
  });

  test('once allowed, a manager can take in someone unassigned and release their own', async () => {
    assert.equal((await api.put('/todo-plan/settings', { managers_can_assign: true }, { token: ownerToken })).status, 200);
    const usha = db.get("SELECT id FROM users WHERE email = 'usha@review.test'");
    const team = await api.get('/todo-plan/team', { token: mani.token });
    assert.ok(team.body.data.assignable.some((u) => u.id === usha.id));
    assert.ok(!team.body.data.assignable.some((u) => u.id === sita.id), 'someone else\'s person is not offered');

    assert.equal((await setLine(usha, mani.id, mani.token)).status, 200);
    assert.equal(db.get('SELECT manager_id FROM users WHERE id = ?', [usha.id]).manager_id, mani.id);
    assert.equal((await setLine(usha, null, mani.token)).status, 200);
    assert.equal(db.get('SELECT manager_id FROM users WHERE id = ?', [usha.id]).manager_id, null);
  });

  test('a manager can never take someone from another manager, or hand someone to another', async () => {
    assert.equal((await setLine(sita, mani.id, mani.token)).status, 403);
    assert.equal((await setLine(kumar, ravi.id, mani.token)).status, 403);
  });

  test('the owner can set anyone\'s line, but not into a loop', async () => {
    const team = await api.get('/todo-plan/team', { token: ownerToken });
    assert.ok(team.body.data.reporting_options.some((u) => u.id === mani.id));
    assert.equal((await setLine(mani, kumar.id, ownerToken)).status, 400, 'Kumar reports to Mani');
    const moved = await setLine(kumar, ravi.id, ownerToken);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.manager_name, 'Ravi');
    assert.ok(db.get("SELECT id FROM audit_logs WHERE entity = 'user' AND entity_id = ? AND action = 'reporting_change'", [kumar.id]));
    await setLine(kumar, mani.id, ownerToken);
  });
});

describe('owner-granted view of everyone', () => {
  test('a manager sees only their own people until the owner grants more', async () => {
    const before = await api.get('/todo-plan/team', { token: ravi.token });
    assert.ok(!before.body.data.rows.some((r) => r.user.name === 'Kumar'));
    assert.equal((await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: ravi.token })).status, 404);
  });

  test('with the grant they see everyone, but reviewing stays with the reporting person', async () => {
    assert.equal((await api.put('/todo-plan/settings', { full_view_user_ids: [ravi.id] }, { token: ownerToken })).status, 200);
    const team = await api.get('/todo-plan/team', { token: ravi.token });
    assert.equal(team.body.data.scope, 'everyone');
    assert.ok(team.body.data.rows.some((r) => r.user.name === 'Kumar'));
    const plan = await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: ravi.token });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.data.can_review, false);
    assert.equal((await api.post(`/todo-plan/submissions/${kumarPlan}/request-changes`, { note: 'x' }, { token: ravi.token })).status, 403);
  });

  test('the grant only accepts people in this workspace', async () => {
    const res = await api.put('/todo-plan/settings', { full_view_user_ids: [crypto.randomUUID()] }, { token: ownerToken });
    assert.equal(res.status, 400);
  });
});

describe('ticking tasks off', () => {
  test('the employee marks a task complete and it lands on the activity feed', async () => {
    const plan = (await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: kumar.token })).body.data;
    const res = await api.post(`/todo-plan/submissions/${kumarPlan}/tasks/${plan.tasks[0].id}`, { done: true }, { token: kumar.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.tasks[0].done_at);
    const entry = res.body.data.comments.at(-1);
    assert.equal(entry.kind, 'task_done');
    assert.match(entry.body, /lead verification/);
  });

  test('only the person who planned it can tick it', async () => {
    const plan = (await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: mani.token })).body.data;
    const res = await api.post(`/todo-plan/submissions/${kumarPlan}/tasks/${plan.tasks[1].id}`, { done: true }, { token: mani.token });
    assert.equal(res.status, 403);
  });

  test('a task can be reopened', async () => {
    const plan = (await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: kumar.token })).body.data;
    const res = await api.post(`/todo-plan/submissions/${kumarPlan}/tasks/${plan.tasks[0].id}`, { done: false }, { token: kumar.token });
    assert.equal(res.body.data.tasks[0].done_at, null);
    assert.equal(res.body.data.comments.at(-1).kind, 'task_reopened');
  });

  test('a draft cannot be ticked off', async () => {
    const usha = db.get("SELECT id FROM users WHERE email = 'usha@review.test'");
    const draftId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(`INSERT INTO todo_submissions (id, tenant_id, user_id, todo_date, plan_date, status, created_at, updated_at)
            VALUES (?,?,?, '2031-01-02', '2031-01-01', 'DRAFT', ?, ?)`, [draftId, tenantId, usha.id, now, now]);
    db.run(`INSERT INTO todo_tasks (id, tenant_id, submission_id, task, created_at, updated_at) VALUES (?,?,?, 'x', ?, ?)`,
      [taskId, tenantId, draftId, now, now]);
    const res = await api.post(`/todo-plan/submissions/${draftId}/tasks/${taskId}`, { done: true }, { token: ownerToken });
    assert.equal(res.status, 403, 'not the owner\'s plan');
  });
});

describe('checklists under a task', () => {
  let charu; let planId; let taskId;

  test('checklist items are saved with the task, blank ones dropped', async () => {
    await schedule('open', { allow_late: true });
    charu = await join('Charu');
    const res = await api.put(`/todo-plan/mine/${target}`, {
      submit: true,
      tasks: [{ task: 'Lead outreach', priority: 'high', checklist: [{ text: 'Call 10 leads' }, { text: 'Email 10 leads' }, { text: '  ' }] }],
    }, { token: charu.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.tasks[0].checklist, [{ text: 'Call 10 leads', done: false }, { text: 'Email 10 leads', done: false }]);
    planId = res.body.data.id;
    taskId = res.body.data.tasks[0].id;
  });

  test('ticking an item records it on the feed and freezes the plan', async () => {
    const res = await api.post(`/todo-plan/submissions/${planId}/tasks/${taskId}/checklist/1`, { done: true }, { token: charu.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.tasks[0].checklist[1].done, true);
    assert.equal(res.body.data.comments.at(-1).kind, 'check_done');
    assert.equal(res.body.data.comments.at(-1).body, 'Email 10 leads');
    assert.equal(res.body.data.can_edit, false);
  });

  test('a missing item is not found, and too many items are refused', async () => {
    assert.equal((await api.post(`/todo-plan/submissions/${planId}/tasks/${taskId}/checklist/9`, { done: true }, { token: charu.token })).status, 404);
    const many = Array.from({ length: 21 }, (_, i) => ({ text: `step ${i}` }));
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: [{ task: 'x', checklist: many }] }, { token: (await join('Dev')).token });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /at most 20 items/);
  });
});

describe('employees never see the team view', () => {
  test('not even with a custom role that can edit settings', async () => {
    const esha = await join('Esha');
    const roleId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(`INSERT INTO custom_roles (id, tenant_id, name, base_role, permissions, created_at, updated_at)
            VALUES (?,?, 'Employee+settings', 'employee', ?, ?, ?)`,
      [roleId, tenantId, JSON.stringify({ settings: ['view', 'edit'] }), now, now]);
    db.run('UPDATE users SET custom_role_id = ? WHERE id = ?', [roleId, esha.id]);

    const team = await api.get('/todo-plan/team', { token: esha.token });
    assert.equal(team.status, 200);
    assert.equal(team.body.data.is_reviewer, false);
    assert.deepEqual(team.body.data.rows, []);
    assert.equal((await api.get(`/todo-plan/submissions/${kumarPlan}`, { token: esha.token })).status, 404);
  });

  test('not even if a stale grant names them, and that grant does not block saving settings', async () => {
    const esha = db.get("SELECT id FROM users WHERE email = 'esha@review.test'");
    const row = db.get('SELECT todo_settings FROM tenants WHERE id = ?', [tenantId]);
    const saved = JSON.parse(row.todo_settings);
    db.run('UPDATE tenants SET todo_settings = ? WHERE id = ?', [JSON.stringify({ ...saved, full_view_user_ids: [esha.id, ravi.id] }), tenantId]);

    const login = await api.post('/auth/login', { email: 'esha@review.test', password: 'Password@123' });
    const team = await api.get('/todo-plan/team', { token: login.body.data.access_token });
    assert.equal(team.body.data.is_reviewer, false);

    const res = await api.put('/todo-plan/settings', { allow_late: true }, { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.full_view_user_ids, [ravi.id], 'the employee is dropped, the manager kept');
  });

  test('the owner cannot grant an employee the view of everyone', async () => {
    const res = await api.put('/todo-plan/settings', { full_view_user_ids: [kumar.id] }, { token: ownerToken });
    assert.equal(res.status, 400);
  });

  test('an employee cannot be made someone\'s reporting person', async () => {
    const res = await api.put(`/todo-plan/reporting/${arun.id}`, { manager_id: kumar.id }, { token: ownerToken });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /manager or the owner/);
  });
});
