/* ═══════════════════════════════════════════════════════
   ExpenseIQ — app.js
   All behaviour wired to the revised index.html structure.

   Sections:
     1. State & constants
     2. DOM references
     3. Local-storage helpers
     4. Utility helpers
     5. Toast
     6. Modal (replaces window.confirm)
     7. Mobile sidebar toggle
     8. Sidebar scroll-spy nav
     9. Budget metrics & progress bar
    10. Inline budget editing
    11. Form validation
    12. Expense form (add / update)
    13. Receipt parser (regex engine)
    14. Expense table rendering
    15. Table event delegation (edit / delete)
    16. History controls (search / filter / sort)
    17. Clear-all
    18. Bootstrap
   ═══════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════
   1. STATE & CONSTANTS
══════════════════════════════════════════ */

const LS_EXPENSES = 'iq_expenses_v2';
const LS_BUDGET   = 'iq_budget_v2';

/** @type {Expense[]} */
let expenses  = [];
let budget    = 0;
let editingId = null;   // null = "add" mode; string = "edit" mode

/**
 * @typedef {{ id:string, amount:number, category:string,
 *             date:string, description:string, createdAt:number }} Expense
 */

/* ══════════════════════════════════════════
   2. DOM REFERENCES
══════════════════════════════════════════ */

const get = id => document.getElementById(id);

// ── Sidebar / mobile ──
const sidebar         = get('sidebar');
const sidebarOverlay  = get('sidebarOverlay');
const menuToggle      = get('menuToggle');

// ── Metrics ──
const budgetDisplay   = get('budgetDisplay');
const totalSpentEl    = get('totalSpent');
const remainingEl     = get('remaining');
const txCountEl       = get('txCount');
const remainingCard   = get('remainingCard');
const progressFill    = get('progressFill');
const progressTrack   = get('progressTrack');
const progressPct     = get('progressPercent');

// ── Budget edit ──
const editBudgetBtn   = get('editBudgetBtn');
const budgetInput     = get('budgetInput');

// ── Expense form ──
const expenseForm     = get('expenseForm');
const amountInput     = get('amount');
const categoryInput   = get('category');
const dateInput       = get('date');
const descInput       = get('description');
const submitLabel     = get('submitLabel');
const resetFormBtn    = get('resetFormBtn');

// ── Field errors ──
const amountError     = get('amountError');
const categoryError   = get('categoryError');
const dateError       = get('dateError');

// ── Receipt parser ──
const receiptText     = get('receiptText');
const parseReceiptBtn = get('parseReceiptBtn');
const clearReceiptBtn = get('clearReceiptBtn');
const parseResult     = get('parseResult');
const parsedFields    = get('parsedFields');
const parseError      = get('parseError');

// ── History ──
const expenseTableBody = get('expenseTableBody');
const expenseTable     = get('expenseTable');
const emptyState       = get('emptyState');
const searchInput      = get('searchInput');
const filterCategory   = get('filterCategory');
const sortBy           = get('sortBy');
const clearAllBtn      = get('clearAllBtn');

// ── Modal ──
const modalBackdrop   = get('modalBackdrop');
const modalBody       = get('modalBody');
const modalCancelBtn  = get('modalCancelBtn');
const modalConfirmBtn = get('modalConfirmBtn');

// ── Toast ──
const toastEl = get('toast');

/* ══════════════════════════════════════════
   3. LOCAL-STORAGE HELPERS
══════════════════════════════════════════ */

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_EXPENSES);
    expenses = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(expenses)) expenses = [];
  } catch {
    expenses = [];
  }
  try {
    const b = localStorage.getItem(LS_BUDGET);
    budget = b !== null ? parseFloat(b) : 0;
    if (isNaN(budget)) budget = 0;
  } catch {
    budget = 0;
  }
}

function saveExpenses() {
  try {
    localStorage.setItem(LS_EXPENSES, JSON.stringify(expenses));
  } catch {
    showToast('Storage full — expense not saved.', 'error');
  }
}

function saveBudget() {
  localStorage.setItem(LS_BUDGET, String(budget));
}

/* ══════════════════════════════════════════
   4. UTILITY HELPERS
══════════════════════════════════════════ */

/** Pseudo-unique ID — good enough for client-only storage */
function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Format number as USD, tabular numerals */
function fmt$(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
}

/** ISO date string → "Sep 24, 2026" */
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return isNaN(dt) ? '—'
    : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Today as YYYY-MM-DD */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

/** Minimal HTML escape to prevent XSS in innerHTML */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════
   5. TOAST
══════════════════════════════════════════ */

let _toastTimer = null;

/**
 * @param {string} msg
 * @param {'success'|'error'|'warn'|''} type
 * @param {number} [ms=3000]
 */
function showToast(msg, type = '', ms = 3000) {
  clearTimeout(_toastTimer);
  toastEl.textContent = msg;
  toastEl.className = `toast toast-${type} show`;
  _toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ══════════════════════════════════════════
   6. MODAL (replaces window.confirm)
══════════════════════════════════════════ */

let _modalResolve = null;

/**
 * Show a modal and return a Promise<boolean>.
 * true = confirmed, false = cancelled.
 * @param {string} message
 */
function showModal(message) {
  return new Promise(resolve => {
    _modalResolve = resolve;
    modalBody.textContent = message;
    modalBackdrop.classList.remove('hidden');
    modalBackdrop.setAttribute('aria-hidden', 'false');
    // Focus the cancel button by default (safer default)
    modalCancelBtn.focus();
  });
}

function closeModal(result) {
  modalBackdrop.classList.add('hidden');
  modalBackdrop.setAttribute('aria-hidden', 'true');
  if (_modalResolve) {
    _modalResolve(result);
    _modalResolve = null;
  }
}

function initModal() {
  modalCancelBtn.addEventListener('click', () => closeModal(false));
  modalConfirmBtn.addEventListener('click', () => closeModal(true));

  // Close on backdrop click
  modalBackdrop.addEventListener('click', e => {
    if (e.target === modalBackdrop) closeModal(false);
  });

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modalBackdrop.classList.contains('hidden')) {
      closeModal(false);
    }
  });
}

/* ══════════════════════════════════════════
   7. MOBILE SIDEBAR TOGGLE
══════════════════════════════════════════ */

function initMobileSidebar() {
  menuToggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    menuToggle.classList.toggle('open', isOpen);
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    sidebarOverlay.classList.toggle('visible', isOpen);
    sidebarOverlay.setAttribute('aria-hidden', String(!isOpen));
  });

  sidebarOverlay.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  sidebar.classList.remove('open');
  menuToggle.classList.remove('open');
  menuToggle.setAttribute('aria-expanded', 'false');
  sidebarOverlay.classList.remove('visible');
  sidebarOverlay.setAttribute('aria-hidden', 'true');
}

/* ══════════════════════════════════════════
   8. SIDEBAR SCROLL-SPY NAV
   Uses IntersectionObserver to highlight the
   nav item whose section is most visible.
══════════════════════════════════════════ */

function initScrollSpy() {
  const SECTION_IDS = [
    'section-dashboard',
    'section-add',
    'section-parser',
    'section-history',
  ];

  const navItems = document.querySelectorAll('.nav-item[data-section]');

  function setActive(sectionId) {
    navItems.forEach(item => {
      const isActive = item.dataset.section === sectionId;
      item.classList.toggle('active', isActive);
      item.setAttribute('aria-current', isActive ? 'location' : 'false');
    });
  }

  // Wire nav clicks — smooth scroll + close mobile sidebar
  navItems.forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const target = document.getElementById(item.dataset.section);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.focus({ preventScroll: true });
      }
      closeMobileSidebar();
    });
  });

  // IntersectionObserver — track which section is in view
  const visibilityMap = new Map(SECTION_IDS.map(id => [id, 0]));

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      visibilityMap.set(entry.target.id, entry.intersectionRatio);
    });
    // The most-visible section wins
    let topId = null, topRatio = -1;
    for (const [id, ratio] of visibilityMap) {
      if (ratio > topRatio) { topRatio = ratio; topId = id; }
    }
    if (topId) setActive(topId);
  }, {
    threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
  });

  SECTION_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });

  // Set initial active state
  setActive('section-dashboard');
}

/* ══════════════════════════════════════════
   9. BUDGET METRICS & PROGRESS BAR
══════════════════════════════════════════ */

function calcTotals() {
  const total     = expenses.reduce((s, e) => s + e.amount, 0);
  const remaining = budget - total;
  const pct       = budget > 0 ? clamp((total / budget) * 100, 0, 100) : 0;

  budgetDisplay.textContent = fmt$(budget);
  totalSpentEl.textContent  = fmt$(total);
  remainingEl.textContent   = fmt$(Math.abs(remaining));
  txCountEl.textContent     = String(expenses.length);

  // Over-budget state on remaining card
  if (budget > 0 && remaining < 0) {
    remainingCard.classList.add('over-budget');
    remainingEl.textContent = `-${fmt$(Math.abs(remaining))}`;
  } else {
    remainingCard.classList.remove('over-budget');
  }

  // Progress bar
  progressFill.style.width = `${pct}%`;
  progressPct.textContent  = `${Math.round(pct)}%`;
  progressTrack.setAttribute('aria-valuenow', String(Math.round(pct)));

  progressFill.classList.remove('warn', 'over');
  if (pct >= 100) {
    progressFill.classList.add('over');
  } else if (pct >= 75) {
    progressFill.classList.add('warn');
  }
}

/* ══════════════════════════════════════════
   10. INLINE BUDGET EDITING
══════════════════════════════════════════ */

function initBudgetEdit() {
  editBudgetBtn.addEventListener('click', () => {
    budgetInput.value = budget > 0 ? budget.toFixed(2) : '';
    budgetInput.classList.remove('hidden');
    requestAnimationFrame(() => {
      budgetInput.focus();
      budgetInput.select();
    });
  });

  budgetInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commitBudget(); }
    if (e.key === 'Escape') { budgetInput.classList.add('hidden'); }
  });

  // Commit on blur but guard against immediate re-blur after click
  budgetInput.addEventListener('blur', () => {
    setTimeout(commitBudget, 100);
  });
}

function commitBudget() {
  if (budgetInput.classList.contains('hidden')) return;
  const val = parseFloat(budgetInput.value);
  if (!isNaN(val) && val >= 0) {
    budget = Math.round(val * 100) / 100;   // round to cents
    saveBudget();
    calcTotals();
    showToast(`Budget set to ${fmt$(budget)}`, 'success');
  }
  budgetInput.classList.add('hidden');
}

/* ══════════════════════════════════════════
   11. FORM VALIDATION
══════════════════════════════════════════ */

function clearValidation() {
  [amountInput, categoryInput, dateInput].forEach(el => {
    el.classList.remove('invalid');
  });
  amountError.textContent = '';
  categoryError.textContent = '';
  dateError.textContent = '';
}

/** Returns true when all required fields pass. */
function validateForm() {
  clearValidation();
  let ok = true;

  const amt = parseFloat(amountInput.value);
  if (!amountInput.value || isNaN(amt) || amt <= 0) {
    amountInput.classList.add('invalid');
    amountError.textContent = 'Enter an amount greater than zero.';
    ok = false;
  }

  if (!categoryInput.value) {
    categoryInput.classList.add('invalid');
    categoryError.textContent = 'Select a category.';
    ok = false;
  }

  if (!dateInput.value) {
    dateInput.classList.add('invalid');
    dateError.textContent = 'Pick a date.';
    ok = false;
  }

  // Focus the first invalid field
  if (!ok) {
    const first = expenseForm.querySelector('.invalid');
    if (first) first.focus();
  }

  return ok;
}

/* ══════════════════════════════════════════
   12. EXPENSE FORM — ADD / UPDATE
══════════════════════════════════════════ */

function initExpenseForm() {
  dateInput.value = todayISO();

  expenseForm.addEventListener('submit', e => {
    e.preventDefault();
    if (!validateForm()) return;

    const entry = {
      id:          editingId ?? uid(),
      amount:      Math.round(parseFloat(amountInput.value) * 100) / 100,
      category:    categoryInput.value,
      date:        dateInput.value,
      description: descInput.value.trim().slice(0, 120),
      createdAt:   editingId
                     ? (expenses.find(x => x.id === editingId)?.createdAt ?? Date.now())
                     : Date.now(),
    };

    if (editingId) {
      const idx = expenses.findIndex(x => x.id === editingId);
      if (idx !== -1) expenses[idx] = entry;
      showToast('Expense updated.', 'success');
    } else {
      expenses.unshift(entry);
      showToast(`${fmt$(entry.amount)} added — ${entry.category}`, 'success');
    }

    editingId = null;
    submitLabel.textContent = 'Add Expense';

    saveExpenses();
    calcTotals();
    renderTable();
    resetForm();
  });

  // Cancel / reset button
  resetFormBtn.addEventListener('click', cancelEdit);
}

function cancelEdit() {
  editingId = null;
  submitLabel.textContent = 'Add Expense';
  resetFormBtn.textContent = 'Cancel';
  resetForm();
}

function resetForm() {
  amountInput.value   = '';
  categoryInput.value = '';
  dateInput.value     = todayISO();
  descInput.value     = '';
  clearValidation();
}

/* ══════════════════════════════════════════
   13. RECEIPT PARSER — REGEX ENGINE
   Extracts vendor, total, date from raw text.
══════════════════════════════════════════ */

/**
 * @param {string} text  Raw receipt text
 * @returns {{ vendor:string|null, amount:number|null, date:string|null }}
 */
function parseReceipt(text) {
  const out = { vendor: null, amount: null, date: null };

  /* ── Amount ─────────────────────────────────────────
     Try progressively looser patterns. Stop on first hit.   */
  const amountPatterns = [
    // "TOTAL: $47.93" / "grand total $1,234.56" / "amount due $0.99"
    /(?:grand\s+)?(?:total(?:\s+(?:due|paid|amount))?|amount\s+(?:due|paid)|balance\s+due)\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    // "SUBTOTAL  $47.93"
    /subtotal\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    // Lone "$47.93" on its own line
    /^\s*\$\s*([\d,]+\.\d{2})\s*$/m,
    // Last dollar-prefixed amount anywhere (most-common fallback)
    /\$\s*([\d,]+\.\d{2})/g,
  ];

  for (const pat of amountPatterns) {
    if (pat.global) {
      // Global pattern — take the final match (usually the largest / last subtotal)
      const all = [...text.matchAll(pat)];
      if (all.length) {
        out.amount = parseFloat(all[all.length - 1][1].replace(/,/g, ''));
        break;
      }
    } else {
      const m = text.match(pat);
      if (m) {
        out.amount = parseFloat(m[1].replace(/,/g, ''));
        break;
      }
    }
  }

  /* ── Date ───────────────────────────────────────────
     Ordered from most-specific to least-specific.           */
  const MONTHS = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  };

  const datePatterns = [
    // ISO 2026-09-24
    {
      re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
      parse: m => `${m[1]}-${m[2]}-${m[3]}`,
    },
    // US  09/24/2026  or  09-24-2026
    {
      re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/,
      parse: m => `${m[3]}-${pad2(m[1])}-${pad2(m[2])}`,
    },
    // Short year  09/24/26
    {
      re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/,
      parse: m => `20${m[3]}-${pad2(m[1])}-${pad2(m[2])}`,
    },
    // "Sep 24, 2026" / "September 24 2026"
    {
      re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
      parse: m => {
        const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
        return `${m[3]}-${pad2(mo)}-${pad2(m[2])}`;
      },
    },
    // "24 Sep 2026"
    {
      re: /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/i,
      parse: m => {
        const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
        return `${m[3]}-${pad2(mo)}-${pad2(m[1])}`;
      },
    },
  ];

  for (const { re, parse } of datePatterns) {
    const m = text.match(re);
    if (!m) continue;
    const iso = parse(m);
    const dt  = new Date(iso);
    if (!isNaN(dt.getTime())) { out.date = iso; break; }
  }

  /* ── Vendor ─────────────────────────────────────────
     Heuristic: first non-empty, non-label, non-numeric line */
  const skipRe = /^(date|time|total|amount|subtotal|tax|tip|change|cash|card|ref|receipt|order|item|qty|price|phone|address|tel|www|http|thank|store|cashier|#)/i;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (
      line.length >= 2 &&
      !skipRe.test(line) &&
      !/^\d/.test(line) &&
      !/^\$/.test(line) &&
      !/^[-=*#_]{2,}$/.test(line) &&
      !/\d{1,2}[\/\-]\d{1,2}/.test(line)
    ) {
      const cleaned = line.replace(/[*_=\-]{2,}/g, '').trim();
      if (cleaned.length >= 2) { out.vendor = cleaned; break; }
    }
  }

  return out;
}

function initReceiptParser() {
  parseReceiptBtn.addEventListener('click', runParser);
  clearReceiptBtn.addEventListener('click', clearParser);

  // Allow Ctrl+Enter to trigger parse
  receiptText.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runParser();
  });
}

function runParser() {
  const text = receiptText.value.trim();

  // Reset state
  parseResult.classList.add('hidden');
  parseError.classList.add('hidden');
  parsedFields.innerHTML = '';

  if (!text) {
    parseError.textContent = 'Paste some receipt text first.';
    parseError.classList.remove('hidden');
    return;
  }

  const parsed = parseReceipt(text);

  if (parsed.amount === null && !parsed.date && !parsed.vendor) {
    parseError.textContent =
      'No recognisable fields found. Make sure the receipt includes a total amount and/or a date.';
    parseError.classList.remove('hidden');
    return;
  }

  // Pre-fill the form
  if (parsed.amount !== null) amountInput.value = parsed.amount.toFixed(2);
  if (parsed.date)            dateInput.value   = parsed.date;
  if (parsed.vendor)          descInput.value   = parsed.vendor;

  // Show summary using <dl> structure
  const rows = [
    { label: 'Vendor', value: parsed.vendor  ?? 'Not detected' },
    { label: 'Amount', value: parsed.amount !== null ? fmt$(parsed.amount) : 'Not detected' },
    { label: 'Date',   value: parsed.date    ? fmtDate(parsed.date) : 'Not detected' },
  ];

  parsedFields.innerHTML = rows.map(r => `
    <div class="parsed-field">
      <dt>${esc(r.label)}</dt>
      <dd>${esc(r.value)}</dd>
    </div>`
  ).join('');

  parseResult.classList.remove('hidden');

  // Scroll form into view and confirm
  document.getElementById('section-add')
    .scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('Receipt parsed — review and submit.', 'success');
}

function clearParser() {
  receiptText.value = '';
  parseResult.classList.add('hidden');
  parseError.classList.add('hidden');
  parsedFields.innerHTML = '';
}

/* ══════════════════════════════════════════
   14. EXPENSE TABLE RENDERING
══════════════════════════════════════════ */

/** Per-category colour dot CSS class */
const CAT_DOT = {
  'Food & Dining': 'cat-food',
  'Transport':     'cat-transport',
  'Shopping':      'cat-shopping',
  'Entertainment': 'cat-entertain',
  'Health':        'cat-health',
  'Utilities':     'cat-utilities',
  'Housing':       'cat-housing',
  'Education':     'cat-education',
  'Travel':        'cat-travel',
  'Other':         'cat-other',
};

function getFiltered() {
  const q   = searchInput.value.trim().toLowerCase();
  const cat = filterCategory.value;
  const ord = sortBy.value;

  let list = expenses.filter(e => {
    if (cat && e.category !== cat) return false;
    if (!q) return true;
    return (
      e.category.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      fmtDate(e.date).toLowerCase().includes(q) ||
      fmt$(e.amount).includes(q)
    );
  });

  list = [...list].sort((a, b) => {
    switch (ord) {
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
  const list = getFiltered();

  if (list.length === 0) {
    expenseTable.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  expenseTable.classList.remove('hidden');
  emptyState.classList.add('hidden');

  expenseTableBody.innerHTML = list.map((e, i) => {
    const dotClass = CAT_DOT[e.category] ?? 'cat-other';
    const isNew    = i === 0 && editingId === null;
    return `
      <tr class="${isNew ? 'new-row' : ''}" data-id="${esc(e.id)}">
        <td class="td-date">${esc(fmtDate(e.date))}</td>
        <td class="td-desc" title="${esc(e.description || '—')}">${esc(e.description || '—')}</td>
        <td>
          <span class="category-badge">
            <span class="category-dot ${dotClass}" aria-hidden="true"></span>
            ${esc(e.category)}
          </span>
        </td>
        <td class="td-amount">${esc(fmt$(e.amount))}</td>
        <td class="td-actions">
          <div class="row-actions">
            <button class="btn-row btn-row-edit"
              data-id="${esc(e.id)}"
              aria-label="Edit ${esc(e.category)} expense of ${esc(fmt$(e.amount))}">
              Edit
            </button>
            <button class="btn-row btn-row-delete"
              data-id="${esc(e.id)}"
              aria-label="Delete ${esc(e.category)} expense of ${esc(fmt$(e.amount))}">
              Delete
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════
   15. TABLE EVENT DELEGATION
══════════════════════════════════════════ */

function initTableEvents() {
  expenseTableBody.addEventListener('click', e => {
    const editBtn   = e.target.closest('.btn-row-edit');
    const deleteBtn = e.target.closest('.btn-row-delete');

    if (editBtn)   startEdit(editBtn.dataset.id);
    if (deleteBtn) deleteExpense(deleteBtn.dataset.id);
  });
}

function startEdit(id) {
  const ex = expenses.find(e => e.id === id);
  if (!ex) return;

  editingId = id;
  amountInput.value   = ex.amount.toFixed(2);
  categoryInput.value = ex.category;
  dateInput.value     = ex.date;
  descInput.value     = ex.description;

  submitLabel.textContent  = 'Update Expense';
  resetFormBtn.textContent = 'Cancel edit';
  clearValidation();

  document.getElementById('section-add')
    .scrollIntoView({ behavior: 'smooth', block: 'start' });
  requestAnimationFrame(() => amountInput.focus());
}

async function deleteExpense(id) {
  const ex = expenses.find(e => e.id === id);
  if (!ex) return;

  const confirmed = await showModal(
    `Delete the ${ex.category} expense of ${fmt$(ex.amount)} on ${fmtDate(ex.date)}? This cannot be undone.`
  );
  if (!confirmed) return;

  expenses = expenses.filter(e => e.id !== id);

  // Cancel any in-progress edit of this row
  if (editingId === id) cancelEdit();

  saveExpenses();
  calcTotals();
  renderTable();
  showToast(`Deleted ${fmt$(ex.amount)} — ${ex.category}`, 'warn');
}

/* ══════════════════════════════════════════
   16. HISTORY CONTROLS
══════════════════════════════════════════ */

function initHistoryControls() {
  searchInput.addEventListener('input', renderTable);
  filterCategory.addEventListener('change', renderTable);
  sortBy.addEventListener('change', renderTable);
}

/* ══════════════════════════════════════════
   17. CLEAR ALL
══════════════════════════════════════════ */

function initClearAll() {
  clearAllBtn.addEventListener('click', async () => {
    if (expenses.length === 0) {
      showToast('Nothing to clear.', '');
      return;
    }

    const confirmed = await showModal(
      `This will permanently delete all ${expenses.length} expense${expenses.length !== 1 ? 's' : ''}. This cannot be undone.`
    );
    if (!confirmed) return;

    expenses = [];
    cancelEdit();
    saveExpenses();
    calcTotals();
    renderTable();
    showToast('All expenses cleared.', 'warn');
  });
}

/* ══════════════════════════════════════════
   18. BOOTSTRAP
══════════════════════════════════════════ */

function init() {
  loadFromStorage();

  // Wire all interactions
  initModal();
  initMobileSidebar();
  initScrollSpy();
  initBudgetEdit();
  initExpenseForm();
  initReceiptParser();
  initTableEvents();
  initHistoryControls();
  initClearAll();

  // Initial render
  calcTotals();
  renderTable();
}

document.addEventListener('DOMContentLoaded', init);
