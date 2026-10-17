'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { wrap, badRequest, conflict, notFound, nowIso, parseId } = require('../util');
const { ROLES, loadMembership, assertCan, permissionsFor } = require('../permissions');
const { transaction } = require('../db');
const { audit, groupActivity } = require('../audit');
const { sha256, normalizeName } = require('../auth');
const { CURRENCIES } = require('../../public/js/money');

function validRole(role) {
  if (!ROLES.includes(role)) throw badRequest('Choose a valid role.', { role: `Role must be one of ${ROLES.join(', ')}.` });
  return role;
}

function groupsRouter({ db, config }) {
  const router = express.Router();

  function activeAdminCount(groupId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE group_id = ? AND role = 'admin' AND status = 'active'`)
      .get(groupId).n;
  }

  router.get('/groups', wrap((req, res) => {
    const rows = db.prepare(`SELECT g.id, g.name, g.currency, m.role FROM memberships m JOIN groups g ON g.id = m.group_id
                             WHERE m.user_id = ? AND m.status = 'active' ORDER BY g.name COLLATE NOCASE`).all(req.user.id);
    res.json({ groups: rows });
  }));

  router.post('/groups', wrap((req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const currency = req.body?.currency || 'PHP';
    const errors = {};
    if (name.length < 1 || name.length > 100) errors.name = 'Group name must be 1–100 characters.';
    if (!CURRENCIES.includes(currency)) errors.currency = `Currency must be one of ${CURRENCIES.join(', ')}.`;
    if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);
    const group = transaction(db, () => {
      const now = nowIso();
      const id = Number(db.prepare('INSERT INTO groups (name, currency, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(name, currency, req.user.id, now).lastInsertRowid);
      db.prepare(`INSERT INTO memberships (group_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)`)
        .run(id, req.user.id, now, now);
      audit(db, { groupId: id, actorId: req.user.id, action: 'group_created', recordType: 'group', recordId: id, details: { name, currency } });
      return { id, name, currency, role: 'admin' };
    });
    res.status(201).json({ group });
  }));

  router.get('/groups/:gid', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    res.json({ group: { id: m.group_id, name: m.group_name, currency: m.currency, role: m.role, permissions: permissionsFor(m.role) } });
  }));

  router.get('/groups/:gid/activity', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const beforeId = req.query.beforeId ? Number(req.query.beforeId) : null;
    res.json({ activity: groupActivity(db, m.group_id, { limit, beforeId }) });
  }));

  // ---- Members -------------------------------------------------------------

  router.get('/groups/:gid/members', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    const members = db.prepare(`SELECT u.id, u.name, m.role, m.status, m.created_at AS joinedAt
                                FROM memberships m JOIN users u ON u.id = m.user_id
                                WHERE m.group_id = ? ORDER BY m.status, u.name COLLATE NOCASE`).all(m.group_id);
    res.json({ members });
  }));

  // Add an existing user directly by their (unique) name.
  router.post('/groups/:gid/members', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'manageMembers');
    const role = validRole(req.body?.role || 'editor');
    const name = normalizeName(req.body?.name);
    const user = name && db.prepare('SELECT id, name FROM users WHERE name = ?').get(name);
    if (!user) throw badRequest('No user with that name. Ask them to sign up first, or send an invite link.', { name: 'No user with that name.' });
    const member = transaction(db, () => {
      const existing = db.prepare('SELECT status FROM memberships WHERE group_id = ? AND user_id = ?').get(m.group_id, user.id);
      if (existing?.status === 'active') throw conflict(`${user.name} is already a member.`);
      const now = nowIso();
      if (existing) {
        db.prepare(`UPDATE memberships SET status = 'active', role = ?, updated_at = ? WHERE group_id = ? AND user_id = ?`)
          .run(role, now, m.group_id, user.id);
      } else {
        db.prepare('INSERT INTO memberships (group_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(m.group_id, user.id, role, now, now);
      }
      audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'member_added', recordType: 'member', recordId: user.id, details: { name: user.name, role } });
      return { id: user.id, name: user.name, role, status: 'active' };
    });
    res.status(201).json({ member });
  }));

  router.patch('/groups/:gid/members/:uid', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'manageMembers');
    const uid = parseId(req.params.uid, 'member');
    const role = validRole(req.body?.role);
    transaction(db, () => {
      const target = db.prepare(`SELECT role FROM memberships WHERE group_id = ? AND user_id = ? AND status = 'active'`).get(m.group_id, uid);
      if (!target) throw notFound('Member not found.');
      if (target.role === 'admin' && role !== 'admin' && activeAdminCount(m.group_id) <= 1) {
        throw conflict('A group needs at least one admin. Promote someone else first.');
      }
      if (target.role === role) return;
      db.prepare('UPDATE memberships SET role = ?, updated_at = ? WHERE group_id = ? AND user_id = ?').run(role, nowIso(), m.group_id, uid);
      audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'member_role_changed', recordType: 'member', recordId: uid, details: { role: { old: target.role, new: role } } });
    });
    res.json({ ok: true });
  }));

  router.post('/groups/:gid/members/:uid/revoke', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    const uid = parseId(req.params.uid, 'member');
    // Members may leave on their own; removing others requires admin.
    if (uid !== req.user.id) assertCan(m, 'manageMembers');
    transaction(db, () => {
      const target = db.prepare(`SELECT role FROM memberships WHERE group_id = ? AND user_id = ? AND status = 'active'`).get(m.group_id, uid);
      if (!target) throw notFound('Member not found.');
      if (target.role === 'admin' && activeAdminCount(m.group_id) <= 1) {
        throw conflict('A group needs at least one admin. Promote someone else first.');
      }
      db.prepare(`UPDATE memberships SET status = 'revoked', updated_at = ? WHERE group_id = ? AND user_id = ?`).run(nowIso(), m.group_id, uid);
      audit(db, { groupId: m.group_id, actorId: req.user.id, action: uid === req.user.id ? 'member_left' : 'member_revoked', recordType: 'member', recordId: uid });
    });
    res.json({ ok: true });
  }));

  // ---- Invitations ---------------------------------------------------------
  // Single-use, expiring links. Whoever opens the link first (while signed in)
  // joins with the chosen role, so share links only over trusted channels.

  router.get('/groups/:gid/invitations', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'manageMembers');
    const rows = db.prepare(`SELECT i.id, i.role, i.created_at AS createdAt, i.expires_at AS expiresAt, i.accepted_at AS acceptedAt,
                                    i.revoked_at AS revokedAt, inv.name AS invitedBy, acc.name AS acceptedBy
                             FROM invitations i JOIN users inv ON inv.id = i.invited_by LEFT JOIN users acc ON acc.id = i.accepted_by
                             WHERE i.group_id = ? ORDER BY i.id DESC LIMIT 50`).all(m.group_id);
    res.json({ invitations: rows });
  }));

  router.post('/groups/:gid/invitations', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'manageMembers');
    const role = validRole(req.body?.role || 'editor');
    const token = crypto.randomBytes(24).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.invitationTtlDays * 86400000).toISOString();
    const id = transaction(db, () => {
      const newId = Number(db.prepare(`INSERT INTO invitations (group_id, role, token_hash, invited_by, created_at, expires_at)
                                       VALUES (?, ?, ?, ?, ?, ?)`).run(m.group_id, role, sha256(token), req.user.id, now.toISOString(), expiresAt).lastInsertRowid);
      audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'invitation_created', recordType: 'invitation', recordId: newId, details: { role, expiresAt } });
      return newId;
    });
    // The raw token is returned exactly once and never stored or logged.
    res.status(201).json({ invitation: { id, role, expiresAt, token } });
  }));

  router.post('/groups/:gid/invitations/:iid/revoke', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'manageMembers');
    const iid = parseId(req.params.iid, 'invitation');
    transaction(db, () => {
      const r = db.prepare(`UPDATE invitations SET revoked_at = ? WHERE id = ? AND group_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
        .run(nowIso(), iid, m.group_id);
      if (!r.changes) throw notFound('Invitation not found or no longer open.');
      audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'invitation_revoked', recordType: 'invitation', recordId: iid });
    });
    res.json({ ok: true });
  }));

  function openInvitation(token) {
    const inv = typeof token === 'string' && token.length < 100
      ? db.prepare(`SELECT i.*, g.name AS group_name, u.name AS inviter FROM invitations i
                    JOIN groups g ON g.id = i.group_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ?`).get(sha256(token))
      : null;
    if (!inv || inv.accepted_at || inv.revoked_at || Date.parse(inv.expires_at) < Date.now()) {
      throw notFound('This invitation link is invalid, expired, or has already been used.');
    }
    return inv;
  }

  router.get('/invitations/:token', wrap((req, res) => {
    const inv = openInvitation(req.params.token);
    res.json({ invitation: { groupName: inv.group_name, role: inv.role, invitedBy: inv.inviter, expiresAt: inv.expires_at } });
  }));

  router.post('/invitations/:token/accept', wrap((req, res) => {
    const groupId = transaction(db, () => {
      const inv = openInvitation(req.params.token);
      const existing = db.prepare('SELECT status FROM memberships WHERE group_id = ? AND user_id = ?').get(inv.group_id, req.user.id);
      if (existing?.status === 'active') throw conflict('You are already a member of this group.');
      const now = nowIso();
      if (existing) {
        db.prepare(`UPDATE memberships SET status = 'active', role = ?, updated_at = ? WHERE group_id = ? AND user_id = ?`)
          .run(inv.role, now, inv.group_id, req.user.id);
      } else {
        db.prepare('INSERT INTO memberships (group_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(inv.group_id, req.user.id, inv.role, now, now);
      }
      db.prepare('UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE id = ?').run(req.user.id, now, inv.id);
      audit(db, { groupId: inv.group_id, actorId: req.user.id, action: 'invitation_accepted', recordType: 'invitation', recordId: inv.id, details: { role: inv.role } });
      return inv.group_id;
    });
    res.json({ groupId });
  }));

  // ---- Notifications -------------------------------------------------------

  router.get('/notifications', wrap((req, res) => {
    const rows = db.prepare(`SELECT n.id, n.group_id AS groupId, n.message, n.link, n.created_at AS createdAt, n.read_at AS readAt
                             FROM notifications n JOIN memberships m ON m.group_id = n.group_id AND m.user_id = n.user_id AND m.status = 'active'
                             WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30`).all(req.user.id);
    res.json({ notifications: rows, unread: rows.filter((r) => !r.readAt).length });
  }));

  router.post('/notifications/read', wrap((req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), req.user.id);
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { groupsRouter };
