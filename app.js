/* ─────────────────────────────────────────────────────
   Smart Expense Tracker — app.js
   Features:
     • Expense CRUD with local storage persistence
     • Receipt text parsing via regular expressions
     • Dynamic budget metrics & progress bar
     • Search, filter, sort on expense history
     • Inline budget editing
     • Toast notifications & form validation
   ───────────────────────────────────────────────────── */

'use strict';

/* ══════════════════════════════════════════
   CONSTANTS & STATE
══════════════════════════════════════════ */

const LS_KEY_EXPENSES = 'set_expenses';
const LS_KEY_BUDGET   = 'set_budget';

/** @type {{ id:string, amount:number, category:string, date:string, description:string, createdAt:number }[]} */
let expenses = [];
let budget   = 0;
let editingId = null;   // ID of the expense currently being edited

/* ══════════════════════════════════════════
   DOM REFERENCES
══════════════════════════════════════════ */

const $ = id => document.getElementById(id);

// Metrics
const budgetDisplay  = $('budgetDisplay');
const totalSpentEl   = $('totalSpent');
const remainingEl    = $('remaining');
const txCountEl      = $('txCount');
const remainingCard  = $('remainingCard');
const progressFill   = $('progressFill');
const progressPct    = $('progressPercent');

// Budget edit
const editBudgetBtn  = $('editBudgetBtn');
const budgetInput    = $('budgetInput');

// Expense form
const expenseForm    = $('expenseForm');
const amountInput    = $('amount');
const categoryInput  = $('category');
const dateInput      = $('date');
const descInput      = $('description');
const submitBtn      = $('submitBtn');
const submitLabel    = $('submitLabel');
const resetFormBtn   = $('resetFormBtn');

// Field errors
const amountError    = $('amountError');
const categoryError  = $('categoryError');
const dateError      = $('dateError');

// Receipt parser
const receiptText    = $('receiptText');
const parseReceiptBtn= $('parseReceiptBtn');
const clearReceiptBtn= $('clearReceiptBtn');
const parseResult    = $('parseResult');
const parsedFields   = $('parsedFields');
const parseError     = $('parseError');

// History
const expenseTableBody = $('expenseTableBody');
const emptyState       = $('emptyState');
const expenseTable     = $('expenseTable');
const searchInput      = $('searchInput');
const filterCategory   = $('filterCategory');
const sortBy           = $('sortBy');
const clearAllBtn      = $('clearAllBtn');

// Toast
const toastEl = $('toast');

/* ══════════════════════════════════════════
   LOCAL STORAGE HELPERS
══════════════════════════════════════════ */

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY_EXPENSES);
    expenses = raw ? JSON.parse(raw) : [];
  } catch {
    expenses = [];
  }
  try {
    const b = localStorage.getItem(LS_KEY_BUDGET);
    budget = b ? parseFloat(b) : 0;
  } catch {
    budget = 0;
  }
}

function saveExpenses() {
  localStorage.setItem(LS_KEY_EXPENSES, JSON.stringify(expenses));
}

function saveBudget() {
  localStorage.setItem(LS_KEY_BUDGET, String(budget));
}

/* ══════════════════════════════════════════
   UTILITY HELPERS
══════════════════════════════════════════ */

/** Generate a simple unique ID */
function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Format a number as USD currency */
function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format an ISO date string (YYYY-MM-DD) to a human-readable short date.
 * Returns "Invalid Date" gracefully on bad input.
 */
function formatDate(isoStr) {
  if (!isoStr) return '—';
  const [y, m, d] = isoStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Return today's date as YYYY-MM-DD */
function todayISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Clamp a value between min and max */
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/* ══════════════════════════════════════════
   TOAST NOTIFICATIONS
══════════════════════════════════════════ */

let toastTimer = null;

/**
 * Show a toast message.
 * @param {string} msg
 * @param {'success'|'error'|'warning'|''} type
 * @param {number} duration  ms to display (default 3000)
 */
function showToast(msg, type = '', duration = 3000) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className   = `toast ${type} show`;
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, duration);
}

/* ══════════════════════════════════════════
   BUDGET METRICS & PROGRESS BAR
══════════════════════════════════════════ */

function calcTotals() {
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const remaining = budget - total;
  const pct = budget > 0 ? clamp((total / budget) * 100, 0, 100) : 0;

  // Update text
  budgetDisplay.textContent = formatCurrency(budget);
  totalSpentEl.textContent  = formatCurrency(total);
  remainingEl.textContent   = formatCurrency(remaining);
  txCountEl.textContent     = expenses.length;

  // Remaining card state
  if (budget > 0 && remaining < 0) {
    remainingCard.classList.add('over-budget');
    remainingEl.textContent = `${formatCurrency(remaining)} over!`;
  } else {
    remainingCard.classList.remove('over-budget');
  }

  // Progress bar
  progressFill.style.width = `${pct}%`;
  progressPct.textContent  = `${Math.round(pct)}%`;
  progressFill.classList.remove('warning', 'over');
  if (pct >= 100) {
    progressFill.classList.add('over');
  } else if (pct >= 75) {
    progressFill.classList.add('warning');
  }
}

/* ══════════════════════════════════════════
   INLINE BUDGET EDITING
══════════════════════════════════════════ */

function initBudgetEdit() {
  editBudgetBtn.addEventListener('click', () => {
    budgetInput.value = budget || '';
    budgetInput.classList.remove('hidden');
    budgetInput.focus();
    budgetInput.select();
  });

  budgetInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') commitBudget();
    if (e.key === 'Escape') {
      budgetInput.classList.add('hidden');
    }
  });

  budgetInput.addEventListener('blur', commitBudget);
}

function commitBudget() {
  const val = parseFloat(budgetInput.value);
  if (!isNaN(val) && val >= 0) {
    budget = val;
    saveBudget();
    calcTotals();
    showToast(`Budget set to ${formatCurrency(budget)}`, 'success');
  }
  budgetInput.classList.add('hidden');
}

/* ══════════════════════════════════════════
   FORM VALIDATION
══════════════════════════════════════════ */

function clearValidation() {
  [amountInput, categoryInput, dateInput].forEach(el => el.classList.remove('invalid'));
  amountError.textContent = categoryError.textContent = dateError.textContent = '';
}

/** Validate form fields. Returns true if valid. */
function validateForm() {
  clearValidation();
  let valid = true;

  const amt = parseFloat(amountInput.value);
  if (isNaN(amt) || amt <= 0) {
    amountInput.classList.add('invalid');
    amountError.textContent = 'Enter a valid amount greater than 0.';
    valid = false;
  }

  if (!categoryInput.value) {
    categoryInput.classList.add('invalid');
    categoryError.textContent = 'Please select a category.';
    valid = false;
  }

  if (!dateInput.value) {
    dateInput.classList.add('invalid');
    dateError.textContent = 'Please pick a date.';
    valid = false;
  }

  return valid;
}

/* ══════════════════════════════════════════
   EXPENSE FORM SUBMISSION (ADD / EDIT)
══════════════════════════════════════════ */

function initExpenseForm() {
  // Default date to today
  dateInput.value = todayISO();

  expenseForm.addEventListener('submit', e => {
    e.preventDefault();
    if (!validateForm()) return;

    const entry = {
      id:          editingId || uid(),
      amount:      parseFloat(parseFloat(amountInput.value).toFixed(2)),
      category:    categoryInput.value,
      date:        dateInput.value,
      description: descInput.value.trim(),
      createdAt:   editingId
                     ? (expenses.find(x => x.id === editingId)?.createdAt ?? Date.now())
                     : Date.now(),
    };

    if (editingId) {
      const idx = expenses.findIndex(x => x.id === editingId);
      if (idx !== -1) expenses[idx] = entry;
      editingId = null;
      submitLabel.textContent = 'Add Expense';
      showToast('Expense updated.', 'success');
    } else {
      expenses.unshift(entry);
      showToast(`${formatCurrency(entry.amount)} added to ${entry.category}.`, 'success');
    }

    saveExpenses();
    calcTotals();
    renderTable();
    resetForm();
  });

  resetFormBtn.addEventListener('click', () => {
    editingId = null;
    submitLabel.textContent = 'Add Expense';
    resetForm();
  });
}

function resetForm() {
  amountInput.value   = '';
  categoryInput.value = '';
  dateInput.value     = todayISO();
  descInput.value     = '';
  clearValidation();
}

/* ══════════════════════════════════════════
   RECEIPT PARSER (REGEX ENGINE)
══════════════════════════════════════════ */

/**
 * Attempt to extract vendor, total, and date from raw receipt text.
 *
 * Regex patterns cover common receipt formats:
 *   - Total lines:  "TOTAL $47.93", "Total: 47.93", "Amount Due: $12.00"
 *   - Date lines:   "Date: 09/15/2026", "2026-09-15", "Sep 15, 2026"
 *   - Vendor:       First non-empty, non-numeric line (best-effort heuristic)
 *
 * @param {string} text  Raw receipt text
 * @returns {{ vendor:string|null, amount:number|null, date:string|null, rawDate:string|null }}
 */
function parseReceipt(text) {
  const result = { vendor: null, amount: null, date: null, rawDate: null };

  // ── 1. Extract total/amount ──────────────────────────────────────
  const totalPatterns = [
    // "TOTAL $47.93" / "Total: 47.93" / "Total Due: $12.00"
    /(?:total\s*(?:due|amount|paid|:)?|amount\s*(?:due|paid|:)?|subtotal\s*:?|grand\s*total\s*:?)\s*\$?\s*([\d,]+\.\d{2})/i,
    // "AMOUNT: $12.00"
    /amount\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    // Standalone currency at end of line: "  $47.93"
    /^\s*\$\s*([\d,]+\.\d{2})\s*$/m,
    // Last dollar amount in the text (fallback)
    /\$\s*([\d,]+\.\d{2})/gi,
  ];

  for (const pattern of totalPatterns) {
    const match = text.match(pattern);
    if (match) {
      // Use the last match for the global fallback pattern to grab the final total
      if (pattern.flags.includes('g')) {
        const all = [...text.matchAll(pattern)];
        if (all.length) {
          result.amount = parseFloat(all[all.length - 1][1].replace(',', ''));
          break;
        }
      } else {
        result.amount = parseFloat(match[1].replace(',', ''));
        break;
      }
    }
  }

  // ── 2. Extract date ──────────────────────────────────────────────
  const datePatterns = [
    // ISO: 2026-09-15
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, fn: m => `${m[1]}-${m[2]}-${m[3]}` },
    // US: 09/15/2026 or 09-15-2026
    { re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/, fn: m => `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}` },
    // Short year: 09/15/26
    { re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/, fn: m => `20${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}` },
    // Verbose: Sep 15, 2026 / September 15 2026
    {
      re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
      fn: m => {
        const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
        const mo = months[m[1].slice(0,3).toLowerCase()];
        return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
      }
    },
    // DD Month YYYY: 15 Sep 2026
    {
      re: /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/i,
      fn: m => {
        const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
        const mo = months[m[2].slice(0,3).toLowerCase()];
        return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      }
    },
  ];

  for (const { re, fn } of datePatterns) {
    const m = text.match(re);
    if (m) {
      result.rawDate = m[0];
      result.date = fn(m);
      // Validate the constructed date
      const dt = new Date(result.date);
      if (isNaN(dt.getTime())) { result.date = null; result.rawDate = null; }
      else break;
    }
  }

  // ── 3. Extract vendor (heuristic) ───────────────────────────────
  // Look for a line that looks like a store/vendor name:
  // - Not purely numeric
  // - Not a label line (e.g. "Date:", "Total:")
  // - Not too short
  const labelRe = /^(date|total|amount|subtotal|tax|tip|cashier|ref|receipt|thank|order|item|qty|price|phone|address|www|http)/i;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (
      line.length >= 3 &&
      !labelRe.test(line) &&
      !/^\d/.test(line) &&           // doesn't start with digit
      !/^\$/.test(line) &&           // doesn't start with $
      !/^[-=*#]+$/.test(line) &&     // not a separator line
      !/\d{2}[\/\-]\d{2}/.test(line) // not a date-looking line
    ) {
      result.vendor = line.replace(/[*_=\-]{2,}/g, '').trim();
      if (result.vendor.length >= 2) break;
    }
  }

  return result;
}

function initReceiptParser() {
  parseReceiptBtn.addEventListener('click', () => {
    const text = receiptText.value.trim();
    parseResult.classList.add('hidden');
    parseError.classList.add('hidden');
    parsedFields.innerHTML = '';

    if (!text) {
      parseError.textContent = 'Please paste some receipt text first.';
      parseError.classList.remove('hidden');
      return;
    }

    const parsed = parseReceipt(text);

    // Check we got at least one useful field
    if (!parsed.amount && !parsed.date && !parsed.vendor) {
      parseError.textContent =
        'Could not extract any fields from this text. ' +
        'Make sure your receipt includes a total amount and/or a date.';
      parseError.classList.remove('hidden');
      return;
    }

    // ── Fill the expense form ──
    if (parsed.amount !== null) {
      amountInput.value = parsed.amount.toFixed(2);
    }
    if (parsed.date) {
      dateInput.value = parsed.date;
    }
    if (parsed.vendor) {
      descInput.value = parsed.vendor;
    }

    // ── Show parsed field summary ──
    const fields = [
      { key: 'Vendor',  val: parsed.vendor  || 'Not detected' },
      { key: 'Amount',  val: parsed.amount !== null ? formatCurrency(parsed.amount) : 'Not detected' },
      { key: 'Date',    val: parsed.date     ? formatDate(parsed.date) : 'Not detected' },
    ];

    parsedFields.innerHTML = fields.map(f => `
      <div class="parsed-field">
        <span class="parsed-field-key">${f.key}</span>
        <span class="parsed-field-val">${escapeHtml(f.val)}</span>
      </div>`
    ).join('');

    parseResult.classList.remove('hidden');

    // Scroll to form
    document.getElementById('add-expense').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Receipt parsed — review the form and submit.', 'success');
  });

  clearReceiptBtn.addEventListener('click', () => {
    receiptText.value = '';
    parseResult.classList.add('hidden');
    parseError.classList.add('hidden');
    parsedFields.innerHTML = '';
  });
}

/* ══════════════════════════════════════════
   EXPENSE TABLE RENDERING
══════════════════════════════════════════ */

/** Category emoji map */
const CATEGORY_ICONS = {
  'Food & Dining':  '🍔',
  'Transport':      '🚗',
  'Shopping':       '🛍',
  'Entertainment':  '🎬',
  'Health':         '💊',
  'Utilities':      '💡',
  'Housing':        '🏠',
  'Education':      '📚',
  'Travel':         '✈️',
  'Other':          '📦',
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getFilteredSorted() {
  const query    = searchInput.value.trim().toLowerCase();
  const catFilter = filterCategory.value;
  const sort     = sortBy.value;

  let list = expenses.filter(e => {
    const matchCat  = !catFilter || e.category === catFilter;
    const matchSearch = !query || [
      e.description, e.category, formatCurrency(e.amount), formatDate(e.date)
    ].some(s => s.toLowerCase().includes(query));
    return matchCat && matchSearch;
  });

  list = [...list].sort((a, b) => {
    switch (sort) {
      case 'date-desc':   return b.date.localeCompare(a.date) || b.createdAt - a.createdAt;
      case 'date-asc':    return a.date.localeCompare(b.date) || a.createdAt - b.createdAt;
      case 'amount-desc': return b.amount - a.amount;
      case 'amount-asc':  return a.amount - b.amount;
      default:            return 0;
    }
  });

  return list;
}

function renderTable() {
  const list = getFilteredSorted();

  if (list.length === 0) {
    expenseTable.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  expenseTable.classList.remove('hidden');
  emptyState.classList.add('hidden');

  expenseTableBody.innerHTML = list.map((e, i) => `
    <tr class="${i === 0 && !editingId ? 'new-row' : ''}" data-id="${escapeHtml(e.id)}">
      <td>${escapeHtml(formatDate(e.date))}</td>
      <td class="desc-cell" title="${escapeHtml(e.description || '—')}">
        ${escapeHtml(e.description || '—')}
      </td>
      <td>
        <span class="category-badge">
          ${CATEGORY_ICONS[e.category] || '📦'} ${escapeHtml(e.category)}
        </span>
      </td>
      <td class="amount-cell">${escapeHtml(formatCurrency(e.amount))}</td>
      <td>
        <div class="row-actions">
          <button class="btn-edit-row"   data-id="${escapeHtml(e.id)}">✏️ Edit</button>
          <button class="btn-delete"     data-id="${escapeHtml(e.id)}">🗑 Delete</button>
        </div>
      </td>
    </tr>`
  ).join('');
}

/* ══════════════════════════════════════════
   TABLE EVENT DELEGATION (Edit / Delete)
══════════════════════════════════════════ */

function initTableEvents() {
  expenseTableBody.addEventListener('click', e => {
    const editBtn   = e.target.closest('.btn-edit-row');
    const deleteBtn = e.target.closest('.btn-delete');

    if (editBtn) {
      const id = editBtn.dataset.id;
      startEditExpense(id);
    }

    if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      deleteExpense(id);
    }
  });
}

function startEditExpense(id) {
  const expense = expenses.find(e => e.id === id);
  if (!expense) return;

  editingId = id;
  amountInput.value   = expense.amount.toFixed(2);
  categoryInput.value = expense.category;
  dateInput.value     = expense.date;
  descInput.value     = expense.description;
  submitLabel.textContent = 'Update Expense';
  clearValidation();

  document.getElementById('add-expense').scrollIntoView({ behavior: 'smooth', block: 'start' });
  amountInput.focus();
}

function deleteExpense(id) {
  const expense = expenses.find(e => e.id === id);
  if (!expense) return;

  expenses = expenses.filter(e => e.id !== id);

  // If we were editing this one, cancel the edit
  if (editingId === id) {
    editingId = null;
    submitLabel.textContent = 'Add Expense';
    resetForm();
  }

  saveExpenses();
  calcTotals();
  renderTable();
  showToast(`Deleted ${formatCurrency(expense.amount)} — ${expense.category}.`, 'warning');
}

/* ══════════════════════════════════════════
   CLEAR ALL
══════════════════════════════════════════ */

function initClearAll() {
  clearAllBtn.addEventListener('click', () => {
    if (expenses.length === 0) {
      showToast('No expenses to clear.', '');
      return;
    }
    // Simple confirm dialog; no external libraries
    if (!window.confirm(`Delete all ${expenses.length} expense(s)? This cannot be undone.`)) return;

    expenses = [];
    editingId = null;
    submitLabel.textContent = 'Add Expense';
    resetForm();
    saveExpenses();
    calcTotals();
    renderTable();
    showToast('All expenses cleared.', 'warning');
  });
}

/* ══════════════════════════════════════════
   SEARCH / FILTER / SORT LISTENERS
══════════════════════════════════════════ */

function initHistoryControls() {
  searchInput.addEventListener('input', renderTable);
  filterCategory.addEventListener('change', renderTable);
  sortBy.addEventListener('change', renderTable);
}

/* ══════════════════════════════════════════
   SIDEBAR NAV ACTIVE STATE
══════════════════════════════════════════ */

function initSidebarNav() {
  const sections = ['dashboard', 'add-expense', 'receipt-parser', 'history'];
  const navItems = document.querySelectorAll('.nav-item');

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        navItems.forEach(item => {
          const href = item.getAttribute('href');
          item.classList.toggle('active', href === `#${id}`);
        });
      }
    });
  }, { threshold: 0.4 });

  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });
}

/* ══════════════════════════════════════════
   BOOTSTRAP
══════════════════════════════════════════ */

function init() {
  loadFromStorage();
  calcTotals();
  renderTable();
  initBudgetEdit();
  initExpenseForm();
  initReceiptParser();
  initTableEvents();
  initClearAll();
  initHistoryControls();
  initSidebarNav();
}

document.addEventListener('DOMContentLoaded', init);
