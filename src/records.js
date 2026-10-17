'use strict';

const { parseAmount } = require('../public/js/money');

/**
 * Field kinds:
 *   text  – trimmed string, `max` length; empty -> null when optional
 *   money – decimal string/number parsed exactly into integer minor units
 *   date  – calendar date YYYY-MM-DD (no time zone; it is a day, not an instant)
 *   url   – http(s) URL
 *   enum  – one of `values`
 */
const RECORD_TYPES = {
  budget_entry: {
    table: 'budget_entries',
    path: 'budget-entries',
    label: 'Budget entry',
    titleField: 'source',
    amountField: 'amountMinor',
    fields: [
      { key: 'source', column: 'source', kind: 'text', required: true, max: 200, label: 'Source' },
      { key: 'amountMinor', input: 'amount', column: 'amount_minor', kind: 'money', required: true, label: 'Amount' },
      { key: 'receivedDate', column: 'received_date', kind: 'date', required: true, label: 'Received date' },
      { key: 'description', column: 'description', kind: 'text', max: 2000, label: 'Description' },
    ],
    search: ['source', 'description'],
    sorts: { date: 'received_date', amount: 'amount_minor', name: 'source', created: 'created_at', updated: 'updated_at' },
    dateColumn: 'received_date',
  },
  expense: {
    table: 'expenses',
    path: 'expenses',
    label: 'Expense',
    titleField: 'title',
    amountField: 'amountMinor',
    fields: [
      { key: 'title', column: 'title', kind: 'text', required: true, max: 200, label: 'Title' },
      { key: 'amountMinor', input: 'amount', column: 'amount_minor', kind: 'money', required: true, label: 'Amount' },
      { key: 'expenseDate', column: 'expense_date', kind: 'date', required: true, label: 'Expense date' },
      { key: 'category', column: 'category', kind: 'text', max: 60, label: 'Category' },
      { key: 'description', column: 'description', kind: 'text', max: 2000, label: 'Description' },
    ],
    search: ['title', 'description', 'category'],
    sorts: { date: 'expense_date', amount: 'amount_minor', name: 'title', created: 'created_at', updated: 'updated_at' },
    dateColumn: 'expense_date',
    filters: { category: 'category' },
  },
  suggested_purchase: {
    table: 'suggested_purchases',
    path: 'suggestions',
    label: 'Suggested purchase',
    titleField: 'itemName',
    amountField: 'expectedPriceMinor',
    fields: [
      { key: 'itemName', column: 'item_name', kind: 'text', required: true, max: 200, label: 'Item' },
      { key: 'expectedPriceMinor', input: 'expectedPrice', column: 'expected_price_minor', kind: 'money', required: true, label: 'Expected price' },
      { key: 'targetDate', column: 'target_date', kind: 'date', label: 'Target date' },
      { key: 'productUrl', column: 'product_url', kind: 'url', label: 'Product URL' },
      { key: 'notes', column: 'notes', kind: 'text', max: 2000, label: 'Notes' },
      // "purchased" is only reachable through linking an expense.
      { key: 'purchaseStatus', column: 'purchase_status', kind: 'enum', values: ['suggested', 'approved', 'planned', 'cancelled'], label: 'Status', createDefault: 'suggested' },
    ],
    search: ['item_name', 'notes'],
    sorts: { date: 'target_date', amount: 'expected_price_minor', name: 'item_name', created: 'created_at', updated: 'updated_at' },
    dateColumn: 'target_date',
    filters: { purchaseStatus: 'purchase_status' },
    extraColumns: { expense_id: 'expenseId' },
  },
};

const ACTIVE_SUGGESTION_STATUSES = ['suggested', 'approved', 'planned'];

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function validateField(field, raw) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (empty) {
    if (field.required) return { error: `${field.label} is required.` };
    return { value: null };
  }
  switch (field.kind) {
    case 'text': {
      if (typeof raw !== 'string') return { error: `${field.label} must be text.` };
      const v = raw.trim();
      if (v.length > field.max) return { error: `${field.label} must be at most ${field.max} characters.` };
      return { value: v };
    }
    case 'money': {
      const r = parseAmount(raw);
      return r.ok ? { value: r.value } : { error: r.error };
    }
    case 'date':
      return isValidDate(raw) ? { value: raw } : { error: `${field.label} must be a valid date (YYYY-MM-DD).` };
    case 'url': {
      if (typeof raw !== 'string' || raw.length > 2000) return { error: `${field.label} is not a valid URL.` };
      try {
        const u = new URL(raw.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `${field.label} must start with http:// or https://.` };
        return { value: u.toString() };
      } catch {
        return { error: `${field.label} is not a valid URL.` };
      }
    }
    case 'enum':
      return field.values.includes(raw) ? { value: raw } : { error: `${field.label} must be one of ${field.values.join(', ')}.` };
    default:
      throw new Error(`Unknown field kind ${field.kind}`);
  }
}

/**
 * Validates a request body. For create (partial=false) every field is
 * considered; for update only the supplied keys are. Returns
 * { values: {column: value}, errors: {key: message} }.
 */
function validateRecord(type, body, { partial }) {
  const values = {};
  const errors = {};
  for (const field of type.fields) {
    const inputKey = field.input || field.key;
    const supplied = body && Object.prototype.hasOwnProperty.call(body, inputKey);
    if (partial && !supplied) continue;
    let raw = supplied ? body[inputKey] : undefined;
    if (!partial && !supplied && field.createDefault) raw = field.createDefault;
    const r = validateField(field, raw);
    if (r.error) errors[inputKey] = r.error;
    else values[field.column] = r.value;
  }
  return { values, errors };
}

/** Maps a DB row to the API shape. */
function mapRecord(type, row) {
  const out = { id: row.id, groupId: row.group_id };
  for (const f of type.fields) out[f.key] = row[f.column];
  if (type.extraColumns) for (const [col, key] of Object.entries(type.extraColumns)) out[key] = row[col];
  Object.assign(out, {
    status: row.status,
    version: row.version,
    createdBy: { id: row.created_by, name: row.created_by_name },
    createdAt: row.created_at,
    updatedBy: { id: row.updated_by, name: row.updated_by_name },
    updatedAt: row.updated_at,
    archivedBy: row.archived_by ? { id: row.archived_by, name: row.archived_by_name } : null,
    archivedAt: row.archived_at,
    pendingDeletion: row.pending_deletion_id
      ? { id: row.pending_deletion_id, requestedBy: row.pending_deletion_requested_by }
      : null,
    attachmentCount: row.attachment_count ?? undefined,
  });
  return out;
}

module.exports = { RECORD_TYPES, ACTIVE_SUGGESTION_STATUSES, validateRecord, mapRecord, isValidDate };
