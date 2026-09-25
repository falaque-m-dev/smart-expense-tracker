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
const LS_THEME    = 'iq_theme';       /* 'light' | 'dark' */
const LS_CURRENCY = 'iq_currency';    /* 'USD' | 'EUR' | 'GBP' | 'INR' */

/** @type {Expense[]} */
let expenses  = [];
let budget    = 0;
let editingId = null;   // null = "add" mode; string = "edit" mode
let currentCurrency = 'USD';
let exchangeRates   = { USD: 1 }; // Base rates with USD = 1
let ratesFetchTime  = 0;          // Last successful fetch timestamp

/**
 * @typedef {{ id:string, amount:number, category:string,
 *             date:string, description:string,
 *             paymentMethod:string, createdAt:number }} Expense
 */

/** Canonical payment method options — single source of truth */
const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Net Banking', 'Other'];

/** Currency symbols */
const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
};

/** Offline fallback rates (approximate, for when API is unreachable) */
const FALLBACK_RATES = {
  USD: 1,
  EUR: 0.85,
  GBP: 0.73,
  INR: 83.15,
};

/* ══════════════════════════════════════════
   2. DOM REFERENCES
══════════════════════════════════════════ */

const get = id => document.getElementById(id);

// ── Sidebar / mobile ──
const sidebar         = get('sidebar');
const sidebarOverlay  = get('sidebarOverlay');
const menuToggle      = get('menuToggle');
const themeToggleBtn  = get('themeToggleBtn');
const themeToggleLbl  = get('themeToggleLabel');

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
const expenseForm       = get('expenseForm');
const amountInput       = get('amount');
const categoryInput     = get('category');
const paymentMethodInput= get('paymentMethod');
const dateInput         = get('date');
const descInput         = get('description');
const submitLabel       = get('submitLabel');
const resetFormBtn      = get('resetFormBtn');

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
const expenseTableBody  = get('expenseTableBody');
const expenseTable      = get('expenseTable');
const emptyState        = get('emptyState');
const searchInput       = get('searchInput');
const filterCategory    = get('filterCategory');
const filterPayment     = get('filterPayment');
const sortBy            = get('sortBy');
const clearAllBtn       = get('clearAllBtn');

// ── Modal ──
const modalBackdrop   = get('modalBackdrop');
const modalBody       = get('modalBody');
const modalCancelBtn  = get('modalCancelBtn');
const modalConfirmBtn = get('modalConfirmBtn');

// ── Export & Backup ──
const exportCsvBtn    = get('exportCsvBtn');
const exportPdfBtn    = get('exportPdfBtn');
const backupJsonBtn   = get('backupJsonBtn');
const restoreJsonBtn  = get('restoreJsonBtn');
const restoreJsonInput= get('restoreJsonInput');

// ── Currency ──
const currencySelect     = get('currencySelect');
const currencyStatus     = get('currencyStatus');
const currencyStatusIndicator = get('currencyStatusIndicator');
const currencyStatusText = get('currencyStatusText');
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
  try {
    const c = localStorage.getItem(LS_CURRENCY);
    currentCurrency = (c === 'USD' || c === 'EUR' || c === 'GBP' || c === 'INR') ? c : 'USD';
  } catch {
    currentCurrency = 'USD';
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

function saveCurrency() {
  localStorage.setItem(LS_CURRENCY, currentCurrency);
}

/* ══════════════════════════════════════════
   4. UTILITY HELPERS
══════════════════════════════════════════ */

/** Pseudo-unique ID — good enough for client-only storage */
function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Format number as currency using the current display currency */
function fmt$(n) {
  const convertedAmount = convertCurrency(n, 'USD', currentCurrency);
  const symbol = CURRENCY_SYMBOLS[currentCurrency] || currentCurrency;
  
  return new Intl.NumberFormat('en-US', {
    style: 'currency', 
    currency: currentCurrency,
    minimumFractionDigits: currentCurrency === 'INR' ? 0 : 2,
    maximumFractionDigits: currentCurrency === 'INR' ? 0 : 2,
  }).format(convertedAmount);
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

/** Convert amount from one currency to another using current exchange rates */
function convertCurrency(amount, fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return amount;
  
  // Convert from -> USD -> to
  const usdAmount = fromCurrency === 'USD' ? amount : amount / (exchangeRates[fromCurrency] || 1);
  const convertedAmount = toCurrency === 'USD' ? usdAmount : usdAmount * (exchangeRates[toCurrency] || 1);
  
  return convertedAmount;
}

/** Get today's date as YYYY-MM-DD for cache keys */
function getCacheDate() {
  return todayISO();
}

/** Check if exchange rates need refreshing (older than 1 hour) */
function shouldRefreshRates() {
  return Date.now() - ratesFetchTime > 60 * 60 * 1000; // 1 hour
}

/** Fetch exchange rates from Frankfurter API */
async function fetchExchangeRates() {
  const cacheKey = `fx_rates_${getCacheDate()}`;
  
  // Try cached rates first
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached && !shouldRefreshRates()) {
      const parsed = JSON.parse(cached);
      exchangeRates = parsed.rates;
      ratesFetchTime = parsed.timestamp;
      updateCurrencyStatus('live');
      return true;
    }
  } catch {
    // Cache miss or parse error, continue to API
  }
  
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,INR');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    exchangeRates = { USD: 1, ...data.rates };
    ratesFetchTime = Date.now();
    
    // Cache the result
    const cacheData = {
      rates: exchangeRates,
      timestamp: ratesFetchTime,
    };
    sessionStorage.setItem(cacheKey, JSON.stringify(cacheData));
    
    updateCurrencyStatus('live');
    return true;
  } catch (error) {
    console.warn('Exchange rate fetch failed:', error.message);
    
    // Fall back to cached rates (any date)
    const cachedKeys = Object.keys(sessionStorage).filter(key => key.startsWith('fx_rates_'));
    if (cachedKeys.length > 0) {
      try {
        const latestCache = cachedKeys.sort().pop();
        const cached = JSON.parse(sessionStorage.getItem(latestCache));
        exchangeRates = cached.rates;
        ratesFetchTime = cached.timestamp;
        updateCurrencyStatus('cached');
        return true;
      } catch {
        // Cache parse failed, use fallback
      }
    }
    
    // Use offline fallback rates
    exchangeRates = { ...FALLBACK_RATES };
    ratesFetchTime = 0;
    updateCurrencyStatus('offline');
    return false;
  }
}

/** Update currency status indicator */
function updateCurrencyStatus(status) {
  currencyStatus.className = 'currency-status';
  
  switch (status) {
    case 'live':
      currencyStatusText.textContent = 'Live rates';
      break;
    case 'cached':
      currencyStatus.classList.add('warning');
      currencyStatusText.textContent = 'Cached rates';
      break;
    case 'offline':
      currencyStatus.classList.add('error');
      currencyStatusText.textContent = 'Offline rates';
      break;
  }
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
   7. THEME ENGINE
   REQ-1 / Task 1

   - Reads saved preference from localStorage (key: iq_theme).
   - Falls back to prefers-color-scheme when no preference saved.
   - Sets data-theme on <html> — CSS variables switch via that attr.
   - Persists choice on every toggle.
   - Dispatches a custom 'themechange' event so future modules
     (e.g. Chart.js) can re-resolve colour tokens.
══════════════════════════════════════════ */

function resolveInitialTheme() {
  const saved = localStorage.getItem(LS_THEME);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);

  // Update button label and aria-label
  const toLabel  = theme === 'dark' ? 'Light mode' : 'Dark mode';
  const ariaDesc = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  if (themeToggleLbl) themeToggleLbl.textContent = toLabel;
  if (themeToggleBtn) themeToggleBtn.setAttribute('aria-label', ariaDesc);

  // Notify other modules
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

function initTheme() {
  // 1. Apply on load — before any render so no flicker
  const initial = resolveInitialTheme();
  applyTheme(initial);

  // 2. Wire toggle button
  if (!themeToggleBtn) return;
  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') ?? 'dark';
    const next    = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(LS_THEME, next);
    showToast(`Switched to ${next} mode`, 'success', 2000);
  });
}

/* ══════════════════════════════════════════
   8. MOBILE SIDEBAR TOGGLE
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
    'section-export',
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
      id:            editingId ?? uid(),
      amount:        Math.round(parseFloat(amountInput.value) * 100) / 100,
      category:      categoryInput.value,
      paymentMethod: paymentMethodInput.value || 'Other',
      date:          dateInput.value,
      description:   descInput.value.trim().slice(0, 120),
      createdAt:     editingId
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

  // Cancel / reset button - just handles form state, modal closing handled elsewhere
  resetFormBtn.addEventListener('click', cancelEdit);
}

function cancelEdit() {
  editingId = null;
  submitLabel.textContent = 'Add Expense';
  resetFormBtn.textContent = 'Cancel';
  resetForm();
}

function resetForm() {
  amountInput.value          = '';
  categoryInput.value        = '';
  paymentMethodInput.value   = '';
  dateInput.value            = todayISO();
  descInput.value            = '';
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
  const pm  = filterPayment.value;
  const ord = sortBy.value;

  let list = expenses.filter(e => {
    if (cat && e.category !== cat) return false;
    if (pm  && (e.paymentMethod || 'Other') !== pm) return false;
    if (!q) return true;
    return (
      e.category.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      (e.paymentMethod || '').toLowerCase().includes(q) ||
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

/** Payment method icon map (inline SVG paths kept short) */
const PM_ICON = {
  'Cash':        '💵',
  'UPI':         '📲',
  'Card':        '💳',
  'Net Banking': '🏦',
  'Other':       '🔹',
};

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
    const pm       = e.paymentMethod || 'Other';
    const pmIcon   = PM_ICON[pm] ?? PM_ICON['Other'];
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
        <td>
          <span class="pm-badge" title="${esc(pm)}">
            <span aria-hidden="true">${pmIcon}</span>
            <span class="pm-label">${esc(pm)}</span>
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
  amountInput.value          = ex.amount.toFixed(2);
  categoryInput.value        = ex.category;
  paymentMethodInput.value   = ex.paymentMethod || '';
  dateInput.value            = ex.date;
  descInput.value            = ex.description;

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
  filterPayment.addEventListener('change', renderTable);
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
   16. CURRENCY SYSTEM  (Task 5)
══════════════════════════════════════════ */

async function initCurrency() {
  // Set initial currency from localStorage
  currencySelect.value = currentCurrency;
  
  // Fetch exchange rates
  await fetchExchangeRates();
  
  // Wire currency selector
  currencySelect.addEventListener('change', async () => {
    currentCurrency = currencySelect.value;
    saveCurrency();
    
    // Re-render all amounts with new currency
    calcTotals();
    renderTable();
    
    showToast(`Switched to ${currentCurrency}`, 'success', 2000);
  });
}

/* ══════════════════════════════════════════
   17. EXPORT & BACKUP  (Task 4)
══════════════════════════════════════════ */

/** Trigger a browser download for any Blob */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Clean up after the browser has queued the download
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 100);
}

/** YYYY-MM-DD stamp used in all filenames */
function exportDateStamp() {
  return todayISO(); // already returns YYYY-MM-DD
}

/* ── CSV ──────────────────────────────────────────────── */
function exportToCSV() {
  const list = getFiltered();
  if (list.length === 0) {
    showToast('No expenses to export.', 'warn');
    return;
  }

  const header = ['Date', 'Description', 'Category', 'Payment Method', 'Amount', 'Currency'];

  const rows = list.map(e => [
    e.date,
    e.description || '',
    e.category,
    e.paymentMethod || 'Other',
    e.amount.toFixed(2),
    'USD',
  ]);

  // RFC 4180 — quote fields containing commas, quotes, or newlines
  const escape = val => {
    const s = String(val);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const csv = [header, ...rows]
    .map(row => row.map(escape).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `expenses-${exportDateStamp()}.csv`);
  showToast(`Exported ${list.length} expense${list.length !== 1 ? 's' : ''} to CSV.`, 'success');
}

/* ── PDF ──────────────────────────────────────────────── */
async function exportToPDF() {
  const list = getFiltered();
  if (list.length === 0) {
    showToast('No expenses to export.', 'warn');
    return;
  }

  // Guard: html2pdf must be available (loaded via CDN script tag)
  if (typeof html2pdf === 'undefined') {
    showToast('PDF library not loaded yet — try again in a moment.', 'error');
    return;
  }

  exportPdfBtn.disabled = true;
  exportPdfBtn.textContent = 'Generating…';

  // Build totals for the summary block
  const total     = expenses.reduce((s, e) => s + e.amount, 0);
  const remaining = budget - total;

  // Construct the hidden render target content
  const target = get('pdf-export-target');
  target.innerHTML = `
    <div style="font-family:system-ui,sans-serif;font-size:13px;color:#0f172a;padding:8px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;border-bottom:2px solid #0d9488;padding-bottom:12px;">
        <div style="width:36px;height:36px;background:#0d9488;border-radius:8px;display:flex;align-items:center;justify-content:center;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="5" width="20" height="14" rx="2" stroke="#fff" stroke-width="1.8"/>
            <path d="M2 10h20" stroke="#fff" stroke-width="1.8"/>
            <circle cx="7" cy="15" r="1.2" fill="#fff"/>
          </svg>
        </div>
        <div>
          <h1 style="margin:0;font-size:20px;font-weight:700;color:#0f172a;">ExpenseIQ</h1>
          <p style="margin:0;font-size:11px;color:#475569;">Expense Report — Exported ${fmtDate(exportDateStamp())}</p>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;">
        <div style="background:#f1f5f9;border-radius:8px;padding:12px;">
          <p style="margin:0 0 4px;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.05em;">Budget</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:#0f172a;">${fmt$(budget)}</p>
        </div>
        <div style="background:#f1f5f9;border-radius:8px;padding:12px;">
          <p style="margin:0 0 4px;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.05em;">Total Spent</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:#dc2626;">${fmt$(total)}</p>
        </div>
        <div style="background:#f1f5f9;border-radius:8px;padding:12px;">
          <p style="margin:0 0 4px;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.05em;">Remaining</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:${remaining >= 0 ? '#059669' : '#dc2626'};">${remaining >= 0 ? fmt$(remaining) : '-' + fmt$(Math.abs(remaining))}</p>
        </div>
      </div>

      <h2 style="font-size:13px;font-weight:600;color:#0f172a;margin:0 0 10px;text-transform:uppercase;letter-spacing:.05em;">
        Expenses (${list.length} record${list.length !== 1 ? 's' : ''})
      </h2>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:7px 10px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;">Date</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;">Description</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;">Category</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;">Payment</th>
            <th style="padding:7px 10px;text-align:right;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((e, i) => `
            <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'}">
              <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;color:#475569;">${esc(fmtDate(e.date))}</td>
              <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;color:#0f172a;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.description || '—')}</td>
              <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;color:#475569;">${esc(e.category)}</td>
              <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;color:#475569;">${esc(e.paymentMethod || 'Other')}</td>
              <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:500;color:#0f172a;">${esc(fmt$(e.amount))}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr style="background:#f1f5f9;">
            <td colspan="4" style="padding:8px 10px;font-weight:600;color:#0f172a;">Total</td>
            <td style="padding:8px 10px;text-align:right;font-weight:700;color:#0d9488;">${fmt$(list.reduce((s, e) => s + e.amount, 0))}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  const options = {
    margin:     10,
    filename:   `expenses-${exportDateStamp()}.pdf`,
    image:      { type: 'jpeg', quality: 0.95 },
    html2canvas:{ scale: 2, useCORS: true },
    jsPDF:      { unit: 'mm', format: 'a4', orientation: 'portrait' },
  };

  try {
    await html2pdf().set(options).from(target).save();
    showToast('PDF exported successfully.', 'success');
  } catch (err) {
    console.error('PDF export failed:', err);
    showToast('PDF export failed — check the console.', 'error');
  } finally {
    // Always clean up the render target and re-enable the button
    target.innerHTML = '';
    exportPdfBtn.disabled = false;
    exportPdfBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
      <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M3 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg> Export PDF`;
  }
}

/* ── JSON Backup ──────────────────────────────────────── */
function backupJSON() {
  if (expenses.length === 0) {
    showToast('No expenses to back up.', 'warn');
    return;
  }

  const payload = JSON.stringify(expenses, null, 2);
  const blob    = new Blob([payload], { type: 'application/json' });
  triggerDownload(blob, `expenses-${exportDateStamp()}.json`);
  showToast(`Backed up ${expenses.length} expense${expenses.length !== 1 ? 's' : ''} to JSON.`, 'success');
}

/* ── JSON Restore ─────────────────────────────────────── */
function restoreJSON(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async e => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      showToast('Invalid JSON file — could not parse.', 'error');
      return;
    }

    if (!Array.isArray(parsed)) {
      showToast('Invalid backup format — expected a JSON array.', 'error');
      return;
    }

    // Validate each entry has the minimum required fields
    const valid = parsed.filter(item =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.id === 'string' &&
      typeof item.amount === 'number' &&
      typeof item.category === 'string' &&
      typeof item.date === 'string'
    );

    if (valid.length === 0) {
      showToast('No valid expense records found in the backup.', 'error');
      return;
    }

    const confirmed = await showModal(
      `This will replace your current ${expenses.length} expense${expenses.length !== 1 ? 's' : ''} with ${valid.length} record${valid.length !== 1 ? 's' : ''} from the backup. This cannot be undone.`
    );
    if (!confirmed) return;

    expenses = valid;
    saveExpenses();
    calcTotals();
    renderTable();
    showToast(`Restored ${valid.length} expense${valid.length !== 1 ? 's' : ''} from backup.`, 'success');
  };

  reader.onerror = () => showToast('Failed to read the file.', 'error');
  reader.readAsText(file);
}

function initExport() {
  exportCsvBtn.addEventListener('click', exportToCSV);
  exportPdfBtn.addEventListener('click', exportToPDF);
  backupJsonBtn.addEventListener('click', backupJSON);

  restoreJsonBtn.addEventListener('click', () => {
    restoreJsonInput.value = '';   // reset so same file can be re-selected
    restoreJsonInput.click();
  });

  restoreJsonInput.addEventListener('change', () => {
    const file = restoreJsonInput.files[0];
    if (file) restoreJSON(file);
  });
}

/* ══════════════════════════════════════════
   18. BOOTSTRAP
══════════════════════════════════════════ */

function init() {
  loadFromStorage();

  // ── Task 1: Theme engine — must run before any render ──
  initTheme();

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
  initExport();     // Task 4

  // Initial render
  calcTotals();
  renderTable();
}

document.addEventListener('DOMContentLoaded', init);
