'use strict';

const { ACTIVE_SUGGESTION_STATUSES } = require('./records');
const { groupActivity } = require('./audit');

/**
 * Financial rules (all computed from persisted rows, never from client input):
 *  - Budget received  = sum of non-archived budget entries.
 *  - Expenses         = sum of non-archived expenses.
 *  - Records with a *pending* deletion request still count until approved.
 *  - Available balance = budget received - expenses (may be negative).
 *  - Utilization       = expenses / budget received, null when budget is 0.
 *  - Suggested purchases never affect the totals above. The estimate covers
 *    Suggested/Approved/Planned only; once Purchased, the linked expense is
 *    what counts, so nothing is counted twice.
 */
function computeTotals(db, groupId) {
  const budget = db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s, COUNT(*) AS n FROM budget_entries WHERE group_id = ? AND status = 'active'`).get(groupId);
  const expenses = db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s, COUNT(*) AS n FROM expenses WHERE group_id = ? AND status = 'active'`).get(groupId);
  const placeholders = ACTIVE_SUGGESTION_STATUSES.map(() => '?').join(', ');
  const suggestions = db.prepare(`SELECT COALESCE(SUM(expected_price_minor), 0) AS s, COUNT(*) AS n FROM suggested_purchases
                                  WHERE group_id = ? AND status = 'active' AND purchase_status IN (${placeholders})`).get(groupId, ...ACTIVE_SUGGESTION_STATUSES);
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM deletion_requests WHERE group_id = ? AND status = 'pending'`).get(groupId);
  const pendingExpense = db.prepare(`SELECT COALESCE(SUM(e.amount_minor), 0) AS s FROM deletion_requests d JOIN expenses e ON e.id = d.record_id
                                     WHERE d.group_id = ? AND d.status = 'pending' AND d.record_type = 'expense'`).get(groupId);
  const pendingBudget = db.prepare(`SELECT COALESCE(SUM(b.amount_minor), 0) AS s FROM deletion_requests d JOIN budget_entries b ON b.id = d.record_id
                                    WHERE d.group_id = ? AND d.status = 'pending' AND d.record_type = 'budget_entry'`).get(groupId);

  const balance = budget.s - expenses.s;
  return {
    budgetTotalMinor: budget.s,
    budgetCount: budget.n,
    expenseTotalMinor: expenses.s,
    expenseCount: expenses.n,
    balanceMinor: balance,
    // One decimal place, computed with integers to avoid float drift.
    utilizationPercent: budget.s > 0 ? Math.round((expenses.s * 1000) / budget.s) / 10 : null,
    pendingDeletionCount: pending.n,
    pendingDeletionExpenseMinor: pendingExpense.s,
    pendingDeletionBudgetMinor: pendingBudget.s,
    suggestionEstimateMinor: suggestions.s,
    suggestionCount: suggestions.n,
  };
}

function dashboard(db, membership, userId) {
  const totals = computeTotals(db, membership.group_id);
  const myOpenRequests = db.prepare(`SELECT COUNT(*) AS n FROM deletion_requests WHERE group_id = ? AND status = 'pending' AND requested_by = ?`)
    .get(membership.group_id, userId).n;
  const awaitingMyDecision = ['approver', 'admin'].includes(membership.role)
    ? db.prepare(`SELECT COUNT(*) AS n FROM deletion_requests WHERE group_id = ? AND status = 'pending' AND requested_by <> ?`).get(membership.group_id, userId).n
    : 0;
  const recentDecisions = db.prepare(`SELECT id, message, link, created_at AS createdAt, read_at AS readAt FROM notifications
                                      WHERE user_id = ? AND group_id = ? ORDER BY id DESC LIMIT 5`).all(userId, membership.group_id);
  return {
    currency: membership.currency,
    ...totals,
    myOpenRequests,
    awaitingMyDecision,
    recentDecisions,
    recentActivity: groupActivity(db, membership.group_id, { limit: 10 }),
  };
}

module.exports = { computeTotals, dashboard };
