'use strict';

const { forbidden, notFound } = require('./util');

/**
 * Role matrix. Roles are cumulative: each role has everything below it.
 *   viewer   – read records, attachments, history
 *   editor   – + create/edit records, upload attachments, request deletion
 *   approver – + approve/reject other members' deletion requests,
 *               mark suggested purchases as Approved
 *   admin    – + manage members and invitations
 */
const ROLES = ['viewer', 'editor', 'approver', 'admin'];

const PERMISSIONS = {
  read: 'viewer',
  write: 'editor',
  requestDeletion: 'editor',
  decideDeletion: 'approver',
  approveSuggestion: 'approver',
  manageMembers: 'admin',
};

function can(role, permission) {
  const needed = PERMISSIONS[permission];
  if (!needed) throw new Error(`Unknown permission ${permission}`);
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

function permissionsFor(role) {
  return Object.fromEntries(Object.keys(PERMISSIONS).map((p) => [p, can(role, p)]));
}

/** Returns the caller's active membership in a group or throws 404 (no existence leak). */
async function loadMembership(db, groupId, userId) {
  const row = await db.get(`SELECT m.role, g.id AS group_id, g.name AS group_name, g.currency
                            FROM memberships m JOIN groups g ON g.id = m.group_id
                            WHERE m.group_id = ? AND m.user_id = ? AND m.status = 'active'`, [groupId, userId]);
  if (!row) throw notFound('Group not found.');
  return row;
}

function assertCan(membership, permission) {
  if (!can(membership.role, permission)) throw forbidden();
}

module.exports = { ROLES, PERMISSIONS, can, permissionsFor, loadMembership, assertCan };
