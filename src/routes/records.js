'use strict';

const express = require('express');
const { wrap, badRequest, conflict, notFound, forbidden, nowIso, parseId } = require('../util');
const { loadMembership, assertCan, can } = require('../permissions');
const { audit, recordHistory } = require('../audit');
const { RECORD_TYPES, validateRecord, mapRecord } = require('../records');
const { validateUpload } = require('../attachments');

const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function selectSql(typeKey) {
  const type = RECORD_TYPES[typeKey];
  // typeKey and table come from the fixed registry, never from user input.
  return `SELECT r.*, cu.name AS created_by_name, uu.name AS updated_by_name, au.name AS archived_by_name,
            dr.id AS pending_deletion_id, dr.requested_by AS pending_deletion_requested_by,
            (SELECT COUNT(*) FROM attachments a WHERE a.record_type = '${typeKey}' AND a.record_id = r.id AND a.removed_at IS NULL) AS attachment_count
          FROM ${type.table} r
          JOIN users cu ON cu.id = r.created_by
          JOIN users uu ON uu.id = r.updated_by
          LEFT JOIN users au ON au.id = r.archived_by
          LEFT JOIN deletion_requests dr ON dr.record_type = '${typeKey}' AND dr.record_id = r.id AND dr.status = 'pending'`;
}

/** Loads a record scoped to the group; 404 for anything outside it. */
async function loadRecord(db, typeKey, groupId, id) {
  const row = await db.get(`${selectSql(typeKey)} WHERE r.group_id = ? AND r.id = ?`, [groupId, id]);
  if (!row) throw notFound(`${RECORD_TYPES[typeKey].label} not found.`);
  return row;
}

function assertEditable(row, typeKey) {
  const label = RECORD_TYPES[typeKey].label;
  if (row.status === 'archived') throw conflict(`This ${label.toLowerCase()} has been archived and can no longer be changed.`);
  if (row.pending_deletion_id) {
    throw conflict(`This ${label.toLowerCase()} has a pending deletion request. It cannot be changed until the request is decided or cancelled.`);
  }
}

function attachmentsFor(db, typeKey, recordId) {
  return db.all(`SELECT a.id, a.original_name AS name, a.mime_type AS "mimeType", a.size_bytes AS "sizeBytes",
                        a.uploaded_at AS "uploadedAt", up.name AS "uploadedBy", a.removed_at AS "removedAt", rm.name AS "removedBy",
                        a.replaces_id AS "replacesId"
                 FROM attachments a JOIN users up ON up.id = a.uploaded_by LEFT JOIN users rm ON rm.id = a.removed_by
                 WHERE a.record_type = ? AND a.record_id = ? ORDER BY a.id`, [typeKey, recordId]);
}

function deletionRequestsFor(db, typeKey, recordId) {
  return db.all(`SELECT d.id, d.reason, d.status, d.requested_at AS "requestedAt", d.decided_at AS "decidedAt",
                        d.decision_reason AS "decisionReason", d.requested_by AS "requestedById", rq.name AS "requestedBy", dc.name AS "decidedBy"
                 FROM deletion_requests d JOIN users rq ON rq.id = d.requested_by LEFT JOIN users dc ON dc.id = d.decided_by
                 WHERE d.record_type = ? AND d.record_id = ? ORDER BY d.id DESC`, [typeKey, recordId]);
}

function recordsRouter({ db, config, fileStore, uploadMiddleware }) {
  const router = express.Router();

  for (const [typeKey, type] of Object.entries(RECORD_TYPES)) {
    const base = `/groups/:gid/${type.path}`;

    // ---- List with search, filters, sorting and pagination -----------------
    router.get(base, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      const q = req.query;
      const where = ['r.group_id = ?'];
      const params = [m.group_id];

      const status = q.status || 'active';
      if (status === 'active' || status === 'archived') { where.push('r.status = ?'); params.push(status); }
      else if (status !== 'all') throw badRequest('status must be active, archived or all.');

      if (typeof q.q === 'string' && q.q.trim()) {
        const like = `%${escapeLike(q.q.trim().slice(0, 100))}%`;
        where.push(`(${type.search.map((c) => `r.${c} ILIKE ? ESCAPE '\\'`).join(' OR ')})`);
        params.push(...type.search.map(() => like));
      }
      for (const [key, col] of Object.entries(type.filters || {})) {
        if (typeof q[key] === 'string' && q[key] !== '') { where.push(`r.${col} = ?`); params.push(q[key]); }
      }
      if (type.states && typeof q.state === 'string' && q.state) {
        if (!type.states[q.state]) throw badRequest(`state must be one of ${Object.keys(type.states).join(', ')}.`);
        where.push(type.states[q.state]);
      }
      if (q.from) { where.push(`r.${type.dateColumn} >= ?`); params.push(String(q.from)); }
      if (q.to) { where.push(`r.${type.dateColumn} <= ?`); params.push(String(q.to)); }
      if (q.pendingDeletion === '1') where.push('dr.id IS NOT NULL');

      const sortCol = type.sorts[q.sort] || type.sorts.date;
      const order = q.order === 'asc' ? 'ASC' : 'DESC';
      const pageSize = Math.min(Math.max(Number.parseInt(q.pageSize, 10) || 20, 1), 100);
      const page = Math.max(Number.parseInt(q.page, 10) || 1, 1);
      const amountCol = type.fields.find((f) => f.kind === 'money').column;

      const whereSql = where.join(' AND ');
      const totals = await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(r.${amountCol}), 0) AS sum FROM ${type.table} r
                                   LEFT JOIN deletion_requests dr ON dr.record_type = '${typeKey}' AND dr.record_id = r.id AND dr.status = 'pending'
                                   WHERE ${whereSql}`, params);
      const rows = await db.all(`${selectSql(typeKey)} WHERE ${whereSql}
                                 ORDER BY r.${sortCol} IS NULL, r.${sortCol} ${order}, r.id ${order} LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]);

      res.json({
        items: rows.map((r) => mapRecord(type, r)),
        total: totals.n,
        sumMinor: totals.sum,
        page,
        pageSize,
        pages: Math.max(Math.ceil(totals.n / pageSize), 1),
      });
    }));

    // Distinct categories for filter drop-downs.
    if (typeKey === 'expense') {
      router.get(`${base}-categories`, wrap(async (req, res) => {
        const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
        const rows = await db.all(`SELECT category FROM expenses WHERE group_id = ? AND category IS NOT NULL
                                   GROUP BY category ORDER BY lower(category)`, [m.group_id]);
        res.json({ categories: rows.map((r) => r.category) });
      }));
    }

    // ---- Detail ------------------------------------------------------------
    router.get(`${base}/:id`, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      const row = await loadRecord(db, typeKey, m.group_id, parseId(req.params.id));
      const record = mapRecord(type, row);
      if (typeKey === 'expense') {
        record.linkedSuggestion = (await db.get('SELECT id, item_name AS "itemName" FROM suggested_purchases WHERE expense_id = ? AND group_id = ?', [row.id, m.group_id])) || null;
      }
      if (typeKey === 'suggested_purchase' && row.expense_id) {
        record.linkedExpense = (await db.get('SELECT id, title, amount_minor AS "amountMinor", status FROM expenses WHERE id = ? AND group_id = ?', [row.expense_id, m.group_id])) || null;
      }
      res.json({
        record,
        attachments: await attachmentsFor(db, typeKey, row.id),
        history: await recordHistory(db, m.group_id, typeKey, row.id),
        deletionRequests: await deletionRequestsFor(db, typeKey, row.id),
      });
    }));

    // ---- Create ------------------------------------------------------------
    router.post(base, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      assertCan(m, 'write');
      const clientRequestId = req.body?.clientRequestId ?? null;
      if (clientRequestId !== null && !CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
        throw badRequest('clientRequestId must be 8–64 letters, digits or dashes.');
      }
      const { values, errors } = validateRecord(type, req.body, { partial: false });
      if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);
      if (values.purchase_status === 'approved' && !can(m.role, 'approveSuggestion')) {
        throw forbidden('Only approvers can mark a suggestion as Approved.');
      }

      const result = await db.tx(async (db) => {
        const now = nowIso();
        const cols = [...Object.keys(values), 'group_id', 'client_request_id', 'created_by', 'created_at', 'updated_by', 'updated_at'];
        const vals = [...Object.values(values), m.group_id, clientRequestId, req.user.id, now, req.user.id, now];
        // Idempotent create: a retried or double-submitted form returns the original record.
        const inserted = await db.get(`INSERT INTO ${type.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
                                       ON CONFLICT (group_id, client_request_id) DO NOTHING RETURNING id`, vals);
        if (!inserted) {
          const existing = await db.get(`SELECT id FROM ${type.table} WHERE group_id = ? AND client_request_id = ?`, [m.group_id, clientRequestId]);
          return { id: existing.id, created: false };
        }
        const after = {};
        for (const f of type.fields) if (values[f.column] !== undefined) after[f.key] = values[f.column];
        await audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'created', recordType: typeKey, recordId: inserted.id, details: { values: after } });
        return { id: inserted.id, created: true };
      });
      res.status(result.created ? 201 : 200).json({ record: mapRecord(type, await loadRecord(db, typeKey, m.group_id, result.id)) });
    }));

    // ---- Update (optimistic concurrency via `version`) ---------------------
    router.patch(`${base}/:id`, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      assertCan(m, 'write');
      const id = parseId(req.params.id);
      const version = req.body?.version;
      if (!Number.isSafeInteger(version)) throw badRequest('version is required to save changes.');
      const { values, errors } = validateRecord(type, req.body, { partial: true });
      if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);

      await db.tx(async (db) => {
        const row = await loadRecord(db, typeKey, m.group_id, id);
        assertEditable(row, typeKey);
        if (row.version !== version) {
          throw conflict('Someone else changed this record while you were editing. Reload to see the latest version.', { currentVersion: row.version });
        }
        if (typeKey === 'suggested_purchase' && values.purchase_status !== undefined) {
          if (row.expense_id && values.purchase_status !== 'purchased') {
            throw conflict('This suggestion is linked to an expense. Unlink the expense before changing its status.');
          }
          if (values.purchase_status === 'approved' && row.purchase_status !== 'approved' && !can(m.role, 'approveSuggestion')) {
            throw forbidden('Only approvers can mark a suggestion as Approved.');
          }
        }
        const changes = {};
        for (const f of type.fields) {
          if (values[f.column] !== undefined && values[f.column] !== row[f.column]) {
            changes[f.key] = { old: row[f.column], new: values[f.column] };
          }
        }
        const changedCols = type.fields.filter((f) => changes[f.key]).map((f) => f.column);
        if (!changedCols.length) return;
        const r = await db.run(`UPDATE ${type.table} SET ${changedCols.map((c) => `${c} = ?`).join(', ')},
                                  updated_by = ?, updated_at = ?, version = version + 1
                                WHERE id = ? AND group_id = ? AND version = ?`,
        [...changedCols.map((c) => values[c]), req.user.id, nowIso(), id, m.group_id, version]);
        if (!r.changes) throw conflict('Someone else changed this record while you were editing. Reload to see the latest version.');
        await audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'updated', recordType: typeKey, recordId: id, details: { changes } });
      });
      res.json({ record: mapRecord(type, await loadRecord(db, typeKey, m.group_id, id)) });
    }));

    // ---- Deletion request --------------------------------------------------
    router.post(`${base}/:id/deletion-requests`, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      assertCan(m, 'requestDeletion');
      const id = parseId(req.params.id);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason) throw badRequest('Please give a reason for deleting.', { reason: 'A reason is required.' });
      if (reason.length > 1000) throw badRequest('Reason is too long.', { reason: 'At most 1000 characters.' });
      const requestId = await db.tx(async (db) => {
        const row = await loadRecord(db, typeKey, m.group_id, id);
        if (row.status === 'archived') throw conflict('This record has already been archived.');
        if (row.pending_deletion_id) throw conflict('A deletion request for this record is already pending.');
        const newId = await db.insert(`INSERT INTO deletion_requests (group_id, record_type, record_id, reason, requested_by, requested_at)
                                       VALUES (?, ?, ?, ?, ?, ?)`, [m.group_id, typeKey, id, reason, req.user.id, nowIso()]);
        await audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'deletion_requested', recordType: typeKey, recordId: id, details: { requestId: newId, reason } });
        return newId;
      });
      res.status(201).json({ deletionRequest: { id: requestId, status: 'pending' } });
    }));

    // ---- Attachments -------------------------------------------------------
    router.post(`${base}/:id/attachments`, uploadMiddleware, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      assertCan(m, 'write');
      const id = parseId(req.params.id);
      const files = req.files || [];
      if (!files.length) throw badRequest('Choose at least one file to upload.');
      const replacesId = req.body?.replacesId ? parseId(req.body.replacesId, 'attachment') : null;
      if (replacesId && files.length !== 1) throw badRequest('Replace one file at a time.');

      const checked = files.map((f) => ({ file: f, ...validateUpload(f) }));
      const invalid = checked.filter((c) => c.error);
      if (invalid.length) throw badRequest(invalid.map((c) => c.error).join(' '), { files: invalid.map((c) => c.error) });

      // Check access before storing anything.
      assertEditable(await loadRecord(db, typeKey, m.group_id, id), typeKey);

      const saved = [];
      try {
        for (const c of checked) saved.push({ ...c, ...(await fileStore.save(c.file.buffer, c.mime)) });
        const created = await db.tx(async (db) => {
          const row = await loadRecord(db, typeKey, m.group_id, id);
          assertEditable(row, typeKey);
          const now = nowIso();
          if (replacesId) {
            const old = await db.get(`SELECT id FROM attachments WHERE id = ? AND record_type = ? AND record_id = ? AND removed_at IS NULL`, [replacesId, typeKey, id]);
            if (!old) throw notFound('The attachment to replace was not found.');
            await db.run('UPDATE attachments SET removed_at = ?, removed_by = ? WHERE id = ?', [now, req.user.id, replacesId]);
          }
          const out = [];
          for (const s of saved) {
            const aid = await db.insert(`INSERT INTO attachments (group_id, record_type, record_id, original_name, storage_name, mime_type,
                                           size_bytes, sha256, uploaded_by, uploaded_at, replaces_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [m.group_id, typeKey, id, s.displayName, s.storageName, s.mime, s.file.size, s.sha256, req.user.id, now, replacesId]);
            await audit(db, {
              groupId: m.group_id, actorId: req.user.id, action: replacesId ? 'attachment_replaced' : 'attachment_added',
              recordType: typeKey, recordId: id,
              details: { attachmentId: aid, name: s.displayName, mimeType: s.mime, sizeBytes: s.file.size, ...(replacesId ? { replacesId } : {}) },
            });
            out.push({ id: aid, name: s.displayName, mimeType: s.mime, sizeBytes: s.file.size });
          }
          return out;
        });
        res.status(201).json({ attachments: created });
      } catch (err) {
        for (const s of saved) await fileStore.discard(s.storageName);
        throw err;
      }
    }));

    // Removal is a soft delete: the file and its history are kept.
    router.post(`${base}/:id/attachments/:aid/remove`, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      assertCan(m, 'write');
      const id = parseId(req.params.id);
      const aid = parseId(req.params.aid, 'attachment');
      await db.tx(async (db) => {
        assertEditable(await loadRecord(db, typeKey, m.group_id, id), typeKey);
        const a = await db.get(`SELECT id, original_name FROM attachments WHERE id = ? AND group_id = ? AND record_type = ? AND record_id = ? AND removed_at IS NULL`,
          [aid, m.group_id, typeKey, id]);
        if (!a) throw notFound('Attachment not found.');
        await db.run('UPDATE attachments SET removed_at = ?, removed_by = ? WHERE id = ?', [nowIso(), req.user.id, aid]);
        await audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'attachment_removed', recordType: typeKey, recordId: id, details: { attachmentId: aid, name: a.original_name } });
      });
      res.json({ ok: true });
    }));

    router.get(`${base}/:id/attachments/:aid/link`, wrap(async (req, res) => {
      const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
      const id = parseId(req.params.id);
      const aid = parseId(req.params.aid, 'attachment');
      await loadRecord(db, typeKey, m.group_id, id);
      const a = await db.get('SELECT id FROM attachments WHERE id = ? AND group_id = ? AND record_type = ? AND record_id = ?', [aid, m.group_id, typeKey, id]);
      if (!a) throw notFound('Attachment not found.');
      const token = fileStore.createDownloadToken(aid, req.user.id);
      res.json({ url: `/files/${token}`, expiresInSeconds: config.downloadLinkTtlSeconds });
    }));
  }

  // ---- Suggested purchase <-> expense linking ------------------------------
  const sType = RECORD_TYPES.suggested_purchase;
  const eType = RECORD_TYPES.expense;

  router.post(`/groups/:gid/${sType.path}/:id/link-expense`, wrap(async (req, res) => {
    const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'write');
    const id = parseId(req.params.id);
    const version = req.body?.version;
    if (!Number.isSafeInteger(version)) throw badRequest('version is required.');

    let newExpense = null;
    if (req.body?.createExpense) {
      const { values, errors } = validateRecord(eType, req.body.createExpense, { partial: false });
      if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);
      newExpense = values;
    } else if (req.body?.expenseId === undefined) {
      throw badRequest('Provide expenseId or createExpense.');
    }

    const expenseId = await db.tx(async (db) => {
      const s = await loadRecord(db, 'suggested_purchase', m.group_id, id);
      assertEditable(s, 'suggested_purchase');
      if (s.version !== version) throw conflict('Someone else changed this suggestion. Reload and try again.');
      if (s.expense_id) throw conflict('This suggestion is already linked to an expense.');
      if (s.purchase_status === 'cancelled') throw conflict('Cancelled suggestions cannot be marked as purchased. Change the status first.');
      const now = nowIso();
      let eid;
      if (newExpense) {
        const cols = [...Object.keys(newExpense), 'group_id', 'created_by', 'created_at', 'updated_by', 'updated_at'];
        eid = await db.insert(`INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          [...Object.values(newExpense), m.group_id, req.user.id, now, req.user.id, now]);
        const after = {};
        for (const f of eType.fields) if (newExpense[f.column] !== undefined) after[f.key] = newExpense[f.column];
        await audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'created', recordType: 'expense', recordId: eid, details: { values: after, fromSuggestionId: id } });
      } else {
        eid = parseId(req.body.expenseId, 'expense');
        const e = await loadRecord(db, 'expense', m.group_id, eid);
        if (e.status !== 'active') throw conflict('Only active expenses can be linked.');
        if (await db.get('SELECT id FROM suggested_purchases WHERE expense_id = ?', [eid])) {
          throw conflict('That expense is already linked to another suggestion.');
        }
      }
      await db.run(`UPDATE suggested_purchases SET purchase_status = 'purchased', expense_id = ?, updated_by = ?, updated_at = ?, version = version + 1
                    WHERE id = ? AND version = ?`, [eid, req.user.id, now, id, version]);
      await audit(db, {
        groupId: m.group_id, actorId: req.user.id, action: 'linked_expense', recordType: 'suggested_purchase', recordId: id,
        details: s.purchase_status === 'purchased'
          ? { expenseId: eid }
          : { expenseId: eid, changes: { purchaseStatus: { old: s.purchase_status, new: 'purchased' } } },
      });
      await audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'linked_suggestion', recordType: 'expense', recordId: eid, details: { suggestionId: id } });
      return eid;
    });
    res.json({ record: mapRecord(sType, await loadRecord(db, 'suggested_purchase', m.group_id, id)), expenseId });
  }));

  // Checklist tick. Checking marks the item done (purchased); unchecking restores
  // the status it had before it was checked, taken from the audit history.
  router.post(`/groups/:gid/${sType.path}/:id/done`, wrap(async (req, res) => {
    const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'write');
    const id = parseId(req.params.id);
    const { version, done } = req.body || {};
    if (!Number.isSafeInteger(version)) throw badRequest('version is required.');
    if (typeof done !== 'boolean') throw badRequest('done must be true or false.');
    await db.tx(async (db) => {
      const s = await loadRecord(db, 'suggested_purchase', m.group_id, id);
      assertEditable(s, 'suggested_purchase');
      if (s.version !== version) throw conflict('Someone else changed this item. Reload and try again.', { currentVersion: s.version });
      const isDone = s.purchase_status === 'purchased';
      if (done === isDone) return;
      let next = 'purchased';
      if (!done) {
        if (s.expense_id) throw conflict('This item is linked to an expense. Unlink the expense before unchecking it.');
        const prev = await db.get(`SELECT details::jsonb #>> '{changes,purchaseStatus,old}' AS old FROM audit_log
                                   WHERE record_type = 'suggested_purchase' AND record_id = ?
                                     AND details::jsonb #>> '{changes,purchaseStatus,new}' = 'purchased'
                                   ORDER BY id DESC LIMIT 1`, [id]);
        next = prev?.old && prev.old !== 'purchased' ? prev.old : 'suggested';
      }
      await db.run(`UPDATE suggested_purchases SET purchase_status = ?, updated_by = ?, updated_at = ?, version = version + 1
                    WHERE id = ? AND version = ?`, [next, req.user.id, nowIso(), id, version]);
      await audit(db, {
        groupId: m.group_id, actorId: req.user.id, action: done ? 'checked' : 'unchecked', recordType: 'suggested_purchase', recordId: id,
        details: { changes: { purchaseStatus: { old: s.purchase_status, new: next } } },
      });
    });
    res.json({ record: mapRecord(sType, await loadRecord(db, 'suggested_purchase', m.group_id, id)) });
  }));

  router.post(`/groups/:gid/${sType.path}/:id/unlink-expense`, wrap(async (req, res) => {
    const m = await loadMembership(db, parseId(req.params.gid, 'group'), req.user.id);
    assertCan(m, 'write');
    const id = parseId(req.params.id);
    const version = req.body?.version;
    if (!Number.isSafeInteger(version)) throw badRequest('version is required.');
    await db.tx(async (db) => {
      const s = await loadRecord(db, 'suggested_purchase', m.group_id, id);
      assertEditable(s, 'suggested_purchase');
      if (s.version !== version) throw conflict('Someone else changed this suggestion. Reload and try again.');
      if (!s.expense_id) throw conflict('This suggestion is not linked to an expense.');
      // The item stays checked off; only the link to the expense is removed.
      await db.run(`UPDATE suggested_purchases SET expense_id = NULL, updated_by = ?, updated_at = ?, version = version + 1
                    WHERE id = ?`, [req.user.id, nowIso(), id]);
      await audit(db, {
        groupId: m.group_id, actorId: req.user.id, action: 'unlinked_expense', recordType: 'suggested_purchase', recordId: id,
        details: { expenseId: s.expense_id },
      });
      await audit(db, { groupId: m.group_id, actorId: req.user.id, action: 'unlinked_suggestion', recordType: 'expense', recordId: s.expense_id, details: { suggestionId: id } });
    });
    res.json({ record: mapRecord(sType, await loadRecord(db, 'suggested_purchase', m.group_id, id)) });
  }));

  return router;
}

module.exports = { recordsRouter, loadRecord };
