import { Router } from 'express';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { ok, created, validate, notFound, forbidden, badRequest, audit } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import {
  bus, CHANNEL_SELECT, MESSAGE_SELECT, addMember, removeMember, canBroadcast, channelLabel,
  channelsFor, ensureBroadcastChannel, ensureDirectChannel, markRead, membershipOf, memberIdsOf,
  postMessage, systemMessage, totalUnread, unreadCount,
} from '../services/chat.js';

const router = Router();

/**
 * Module B - chat.
 *
 * Every route below answers the same question first: is the caller a member of
 * this channel? Membership is the only authorisation there is - no role can
 * read a room it was not put in, and being in a room is enough to read it.
 */

// ------------------------------------------------------------------ helpers
function channelOr404(req, id) {
  const channel = get(`${CHANNEL_SELECT} WHERE ch.id = ? AND ch.tenant_id = ? AND ch.deleted_at IS NULL`,
    [id, req.auth.tenantId]);
  if (!channel) throw notFound('Conversation');
  return channel;
}

/** Membership is the read gate. Absent membership reads as "does not exist". */
function memberOr404(req, id) {
  const channel = channelOr404(req, id);
  const membership = membershipOf(req.auth.tenantId, id, req.auth.userId);
  if (!membership) throw notFound('Conversation');
  return { channel, membership };
}

/** Who may post here: the broadcast is admin-only, everywhere else members post. */
function assertCanPost(req, channel, membership) {
  if (channel.archived_at) throw forbidden('This conversation is archived');
  if (channel.post_policy === 'admins' && !canBroadcast(req.auth)) {
    throw forbidden('Only owners, managers and HR can post company announcements');
  }
  if (channel.kind === 'project' && channel.project_status === 'cancelled') {
    throw forbidden('This project has been cancelled');
  }
  return membership;
}

const withLabel = (channel, viewerId) => ({ ...channel, label: channelLabel(channel, viewerId) });

// ----------------------------------------------------------------- channels
/**
 * Everything the caller can talk in. The broadcast channel is materialised here
 * rather than by a migration, so a workspace created before chat existed - or a
 * person hired after it - still lands in the company room on first load.
 */
router.get('/channels', (req, res) => {
  ensureBroadcastChannel(req.auth.tenantId, req.auth.userId);
  const channels = channelsFor(req.auth.tenantId, req.auth.userId, {
    includeArchived: req.query.archived === 'true',
  });
  return ok(res, channels, { unread_total: channels.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0) });
});

router.get('/unread', (req, res) => ok(res, { unread: totalUnread(req.auth.tenantId, req.auth.userId) }));

const channelSchema = z.object({
  name: z.string().min(2).max(80),
  topic: z.string().max(240).optional().nullable(),
  member_ids: z.array(z.string()).max(200).optional(),
});

router.post('/channels', requires('chat', 'create'), (req, res) => {
  const body = validate(channelSchema, req.body);
  const { tenantId, userId } = req.auth;
  const id = uuid();
  const at = nowIso();

  run(
    `INSERT INTO channels (id, tenant_id, kind, name, topic, created_by, created_at, updated_at)
     VALUES (?,?, 'group', ?,?,?,?,?)`,
    [id, tenantId, body.name.trim(), body.topic ?? null, userId, at, at],
  );
  addMember(tenantId, id, userId, 'owner');
  for (const memberId of body.member_ids || []) addMember(tenantId, id, memberId);
  systemMessage(tenantId, id, `${req.auth.name} started this conversation.`);

  audit(req, { entity: 'channel', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, withLabel(channelOr404(req, id), userId));
});

/** Opens (or reuses) the one-to-one room with somebody. */
router.post('/direct', requires('chat', 'create'), (req, res) => {
  const body = validate(z.object({ user_id: z.string() }), req.body);
  const { tenantId, userId } = req.auth;
  if (body.user_id === userId) throw badRequest('You cannot start a conversation with yourself');

  const other = get(
    "SELECT id FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role != 'client'",
    [body.user_id, tenantId],
  );
  if (!other) throw badRequest('That person is not in this workspace');

  const channel = ensureDirectChannel(tenantId, userId, body.user_id);
  return created(res, withLabel(channelOr404(req, channel.id), userId));
});

router.get('/channels/:id', (req, res) => {
  const { channel, membership } = memberOr404(req, req.params.id);
  const members = all(
    `SELECT cm.user_id, cm.role, cm.joined_at, cm.last_read_at, u.name, u.avatar_url, u.designation,
            u.role AS org_role, pm.seat AS project_seat
       FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN project_members pm ON pm.user_id = cm.user_id AND pm.project_id = ?
            AND pm.deleted_at IS NULL
      WHERE cm.channel_id = ? AND cm.deleted_at IS NULL
      ORDER BY u.name`,
    [channel.project_id ?? '__none__', channel.id],
  );

  return ok(res, {
    ...withLabel(channel, req.auth.userId),
    my_role: membership.role,
    muted: membership.muted === 1,
    last_read_at: membership.last_read_at,
    unread: unreadCount(channel.id, req.auth.userId, membership.last_read_at),
    can_post: !channel.archived_at && (channel.post_policy !== 'admins' || canBroadcast(req.auth)),
    members,
    pinned: all(
      `${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
        ORDER BY m.pinned_at DESC LIMIT 5`,
      [channel.id],
    ),
  });
});

router.patch('/channels/:id', (req, res) => {
  const { channel, membership } = memberOr404(req, req.params.id);
  if (channel.kind === 'direct') throw badRequest('A direct conversation has nothing to rename');
  if (membership.role !== 'owner' && !canBroadcast(req.auth)) {
    throw forbidden('Only the conversation owner can change it');
  }

  const body = validate(z.object({
    name: z.string().min(2).max(80).optional(),
    topic: z.string().max(240).optional().nullable(),
    archived: z.boolean().optional(),
  }), req.body);

  // A project room takes its name from the project, so renaming would silently
  // undo itself on the next team change.
  if (body.name && channel.kind === 'project') throw badRequest('This room is named after its project');

  const patch = [];
  const params = [];
  if (body.name) { patch.push('name = ?'); params.push(body.name.trim()); }
  if (body.topic !== undefined) { patch.push('topic = ?'); params.push(body.topic); }
  if (body.archived !== undefined) { patch.push('archived_at = ?'); params.push(body.archived ? nowIso() : null); }
  if (patch.length) {
    run(`UPDATE channels SET ${patch.join(', ')}, updated_at = ? WHERE id = ?`, [...params, nowIso(), channel.id]);
  }
  if (body.name) systemMessage(req.auth.tenantId, channel.id, `${req.auth.name} renamed this to "${body.name.trim()}".`);

  audit(req, { entity: 'channel', entityId: channel.id, action: 'update', before: channel, after: body });
  return ok(res, withLabel(channelOr404(req, channel.id), req.auth.userId));
});

/** Mute or unmute: mutes stay out of the badge and out of mention alerts. */
router.patch('/channels/:id/settings', (req, res) => {
  const { membership } = memberOr404(req, req.params.id);
  const body = validate(z.object({ muted: z.boolean() }), req.body);
  run('UPDATE channel_members SET muted = ? WHERE id = ?', [body.muted ? 1 : 0, membership.id]);
  return ok(res, { muted: body.muted });
});

// ------------------------------------------------------------------ members
router.post('/channels/:id/members', (req, res) => {
  const { channel, membership } = memberOr404(req, req.params.id);
  if (channel.kind !== 'group') {
    throw badRequest(channel.kind === 'project'
      ? 'This room follows the project team — add them to the project instead'
      : 'This conversation manages its own members');
  }
  if (membership.role !== 'owner') throw forbidden('Only the conversation owner can invite people');

  const body = validate(z.object({ user_ids: z.array(z.string()).min(1).max(50) }), req.body);
  const added = [];
  for (const userId of body.user_ids) {
    const person = get(
      "SELECT id, name FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role != 'client'",
      [userId, req.auth.tenantId],
    );
    if (person && addMember(req.auth.tenantId, channel.id, userId)) added.push(person.name);
  }
  if (added.length) systemMessage(req.auth.tenantId, channel.id, `${req.auth.name} added ${added.join(', ')}.`);
  return created(res, { added: added.length });
});

router.delete('/channels/:id/members/:userId', (req, res) => {
  const { channel, membership } = memberOr404(req, req.params.id);
  const leaving = req.params.userId === req.auth.userId;

  if (channel.kind === 'project') throw badRequest('Membership here follows the project team');
  if (channel.kind === 'broadcast') throw badRequest('Everyone belongs to the company channel');
  if (channel.kind === 'direct') throw badRequest('A direct conversation cannot be left');
  if (!leaving && membership.role !== 'owner') throw forbidden('Only the conversation owner can remove people');

  const person = get('SELECT name FROM users WHERE id = ?', [req.params.userId]);
  if (removeMember(channel.id, req.params.userId)) {
    systemMessage(req.auth.tenantId, channel.id,
      leaving ? `${req.auth.name} left.` : `${req.auth.name} removed ${person?.name || 'someone'}.`);
  }
  return ok(res, { ok: true });
});

// ----------------------------------------------------------------- messages
/**
 * History, newest-first from the server and reversed for the caller so the
 * client can render top-to-bottom without sorting. `before` pages backwards
 * through the conversation using the previous page's oldest timestamp.
 */
router.get('/channels/:id/messages', (req, res) => {
  const { channel, membership } = memberOr404(req, req.params.id);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));

  const filters = ['m.channel_id = ?', 'm.tenant_id = ?', 'm.deleted_at IS NULL'];
  const params = [channel.id, req.auth.tenantId];
  if (req.query.before) { filters.push('m.created_at < ?'); params.push(req.query.before); }
  if (req.query.search) { filters.push('m.body LIKE ?'); params.push(`%${req.query.search}%`); }

  const rows = all(
    `${MESSAGE_SELECT} WHERE ${filters.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();

  return ok(res, page.map((m) => ({ ...m, mentions: JSON.parse(m.mentions || '[]') })), {
    has_more: hasMore,
    oldest: page[0]?.created_at ?? null,
    last_read_at: membership.last_read_at,
  });
});

router.post('/channels/:id/messages', requires('chat', 'create'), async (req, res) => {
  const { channel, membership } = memberOr404(req, req.params.id);
  assertCanPost(req, channel, membership);

  const body = validate(z.object({
    body: z.string().min(1).max(4000),
    reply_to_id: z.string().optional().nullable(),
  }), req.body);

  const message = await postMessage({
    tenantId: req.auth.tenantId,
    channelId: channel.id,
    author: { id: req.auth.userId, name: req.auth.name },
    body: body.body.trim(),
    replyToId: body.reply_to_id ?? null,
  });

  // Announcements are the one kind of message worth an audit trail.
  if (channel.kind === 'broadcast') {
    audit(req, { entity: 'broadcast', entityId: message.id, action: 'create', after: { body: message.body } });
  }
  return created(res, { ...message, mentions: JSON.parse(message.mentions || '[]') });
});

router.patch('/messages/:id', (req, res) => {
  const message = get('SELECT * FROM messages WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!message) throw notFound('Message');
  memberOr404(req, message.channel_id);
  if (message.author_id !== req.auth.userId) throw forbidden('You can only edit your own messages');

  const body = validate(z.object({ body: z.string().min(1).max(4000) }), req.body);
  run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', [body.body.trim(), nowIso(), message.id]);
  return ok(res, get(`${MESSAGE_SELECT} WHERE m.id = ?`, [message.id]));
});

router.delete('/messages/:id', (req, res) => {
  const message = get('SELECT * FROM messages WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!message) throw notFound('Message');
  const { membership } = memberOr404(req, message.channel_id);

  // Your own words, or a room owner clearing something up.
  if (message.author_id !== req.auth.userId && membership.role !== 'owner' && !canBroadcast(req.auth)) {
    throw forbidden('You can only delete your own messages');
  }
  run('UPDATE messages SET deleted_at = ? WHERE id = ?', [nowIso(), message.id]);
  return ok(res, { ok: true });
});

/** Pin the decisions, so a new joiner does not scroll to find them. */
router.post('/messages/:id/pin', (req, res) => {
  const message = get('SELECT * FROM messages WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!message) throw notFound('Message');
  memberOr404(req, message.channel_id);

  const pinning = !message.pinned_at;
  run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?',
    [pinning ? nowIso() : null, pinning ? req.auth.userId : null, message.id]);
  return ok(res, get(`${MESSAGE_SELECT} WHERE m.id = ?`, [message.id]));
});

router.post('/channels/:id/read', (req, res) => {
  memberOr404(req, req.params.id);
  return ok(res, { last_read_at: markRead(req.auth.tenantId, req.params.id, req.auth.userId) });
});

// ------------------------------------------------------------------- stream
/**
 * Live delivery over Server-Sent Events. The client reads this with `fetch`
 * rather than `EventSource` so the access token travels in the Authorization
 * header instead of the query string, where request logs would capture it.
 *
 * Events are filtered per connection by channel membership, computed at emit
 * time, so a listener never receives a room they are not in. Missing an event
 * costs nothing: the next fetch of the channel returns the same rows.
 */
router.get('/stream', (req, res) => {
  const { tenantId, userId } = req.auth;

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`);

  const onEvent = ({ tenantId: t, event, payload }) => {
    if (t !== tenantId) return;
    const audience = payload.member_ids || memberIdsOf(payload.channel_id);
    if (!audience.includes(userId)) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify({ ...payload, member_ids: undefined })}\n\n`);
  };
  bus.on('event', onEvent);

  // Proxies and load balancers drop a silent connection; a comment line every
  // 25s keeps it open without being a message the client has to understand.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off('event', onEvent);
    res.end();
  });
});

export { router as chatRouter };
