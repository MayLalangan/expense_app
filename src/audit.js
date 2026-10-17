'use strict';

const { nowIso } = require('./util');

/**
 * Appends an audit entry. The audit_log table rejects UPDATE and DELETE via
 * triggers, so entries are immutable once written. `details` must never
 * contain secrets (passwords, tokens, storage paths).
 */
function audit(db, { groupId = null, actorId = null, action, recordType, recordId = null, details = null }) {
  db.prepare(`INSERT INTO audit_log (group_id, actor_id, action, record_type, record_id, details, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(groupId, actorId, action, recordType, recordId, details == null ? null : JSON.stringify(details), nowIso());
}

function mapAuditRow(row) {
  return {
    id: row.id,
    action: row.action,
    recordType: row.record_type,
    recordId: row.record_id,
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : null,
    details: row.details ? JSON.parse(row.details) : null,
    createdAt: row.created_at,
  };
}

const AUDIT_SELECT = `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id`;

function recordHistory(db, groupId, recordType, recordId) {
  return db.prepare(`${AUDIT_SELECT} WHERE a.group_id = ? AND a.record_type = ? AND a.record_id = ? ORDER BY a.id`)
    .all(groupId, recordType, recordId).map(mapAuditRow);
}

function groupActivity(db, groupId, { limit = 50, beforeId = null } = {}) {
  const rows = beforeId
    ? db.prepare(`${AUDIT_SELECT} WHERE a.group_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT ?`).all(groupId, beforeId, limit)
    : db.prepare(`${AUDIT_SELECT} WHERE a.group_id = ? ORDER BY a.id DESC LIMIT ?`).all(groupId, limit);
  return rows.map(mapAuditRow);
}

module.exports = { audit, recordHistory, groupActivity };
