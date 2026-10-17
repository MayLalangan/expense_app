'use strict';

const express = require('express');
const { wrap, badRequest, conflict, notFound, forbidden, nowIso, parseId } = require('../util');
const { loadMembership, assertCan } = require('../permissions');
const { transaction } = require('../db');
const { audit } = require('../audit');
const { RECORD_TYPES } = require('../records');

/**
 * Deletion policy: one approval from an approver/admin who is not the
 * requester. Approval archives the record (soft delete); attachments and audit
 * history are retained. Rejected/cancelled requests remain visible and a new
 * request may be submitted afterwards.
 */
function deletionsRouter({ db }) {
  const router = express.Router();

  function titleOf(typeKey, recordId) {
    const type = RECORD_TYPES[typeKey];
    const col = type.fields.find((f) => f.key === type.titleField).column;
    return db.prepare(`SELECT ${col} AS title FROM ${type.table} WHERE id = ?`).get(recordId)?.title ?? `#${recordId}`;
  }

  router.get('/groups/:gid/deletion-requests', wrap((req, res) => {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    const status = req.query.status || 'pending';
    if (!['pending', 'approved', 'rejected', 'cancelled', 'all'].includes(status)) throw badRequest('Unknown status filter.');
    const rows = db.prepare(`SELECT d.id, d.record_type AS recordType, d.record_id AS recordId, d.reason, d.status,
                                    d.requested_at AS requestedAt, d.requested_by AS requestedById, rq.name AS requestedBy,
                                    d.decided_at AS decidedAt, dc.name AS decidedBy, d.decision_reason AS decisionReason
                             FROM deletion_requests d JOIN users rq ON rq.id = d.requested_by LEFT JOIN users dc ON dc.id = d.decided_by
                             WHERE d.group_id = ? ${status === 'all' ? '' : 'AND d.status = ?'}
                             ORDER BY d.id DESC LIMIT 200`).all(...(status === 'all' ? [m.group_id] : [m.group_id, status]));
    for (const r of rows) {
      r.recordTitle = titleOf(r.recordType, r.recordId);
      const type = RECORD_TYPES[r.recordType];
      const amountCol = type.fields.find((f) => f.kind === 'money').column;
      r.amountMinor = db.prepare(`SELECT ${amountCol} AS a FROM ${type.table} WHERE id = ?`).get(r.recordId)?.a ?? null;
      r.recordPath = type.path;
      r.canDecide = r.status === 'pending' && r.requestedById !== req.user.id && ['approver', 'admin'].includes(m.role);
    }
    res.json({ requests: rows });
  }));

  function decide(req, res, decision) {
    const m = loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    const id = parseId(req.params.id, 'deletion request');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length > 1000) throw badRequest('Reason is too long.', { reason: 'At most 1000 characters.' });

    const result = transaction(db, () => {
      const d = db.prepare('SELECT * FROM deletion_requests WHERE id = ? AND group_id = ?').get(id, m.group_id);
      if (!d) throw notFound('Deletion request not found.');
      if (decision === 'cancelled') {
        if (d.requested_by !== req.user.id) throw forbidden('Only the requester can cancel a deletion request.');
      } else {
        assertCan(m, 'decideDeletion');
        if (d.requested_by === req.user.id) throw forbidden('You cannot approve or reject your own deletion request.');
      }
      if (d.status !== 'pending') throw conflict(`This request has already been ${d.status}.`);

      const now = nowIso();
      db.prepare(`UPDATE deletion_requests SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ? AND status = 'pending'`)
        .run(decision, decision === 'cancelled' ? null : req.user.id, now, reason || null, id);

      const action = { approved: 'deletion_approved', rejected: 'deletion_rejected', cancelled: 'deletion_cancelled' }[decision];
      audit(db, { groupId: m.group_id, actorId: req.user.id, action, recordType: d.record_type, recordId: d.record_id, details: { requestId: id, ...(reason ? { reason } : {}) } });

      const type = RECORD_TYPES[d.record_type];
      if (decision === 'approved') {
        db.prepare(`UPDATE ${type.table} SET status = 'archived', archived_by = ?, archived_at = ?, version = version + 1
                    WHERE id = ? AND group_id = ? AND status = 'active'`).run(req.user.id, now, d.record_id, m.group_id);
        audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'archived', recordType: d.record_type, recordId: d.record_id, details: { requestId: id } });
      }
      if (decision !== 'cancelled') {
        const title = titleOf(d.record_type, d.record_id);
        const why = reason ? ` Reason: ${reason}` : '';
        db.prepare('INSERT INTO notifications (user_id, group_id, message, link, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(d.requested_by, m.group_id, `${req.user.name} ${decision} your request to delete ${type.label.toLowerCase()} "${title}".${why}`,
            `#/g/${m.group_id}/${type.path}/${d.record_id}`, now);
      }
      return { id, status: decision };
    });
    res.json({ deletionRequest: result });
  }

  router.post('/groups/:gid/deletion-requests/:id/approve', wrap((req, res) => decide(req, res, 'approved')));
  router.post('/groups/:gid/deletion-requests/:id/reject', wrap((req, res) => decide(req, res, 'rejected')));
  router.post('/groups/:gid/deletion-requests/:id/cancel', wrap((req, res) => decide(req, res, 'cancelled')));

  return router;
}

module.exports = { deletionsRouter };
