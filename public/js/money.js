// Shared by the browser (window.Money) and the server (require).
// Money is always handled as integer minor units (öre / cents); the decimal
// string a user types is parsed exactly, never through floating point.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Money = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CURRENCIES = ['PHP', 'USD', 'EUR', 'SEK', 'GBP', 'NOK', 'DKK'];
  const DEFAULT_CURRENCY = 'PHP';
  const DEFAULT_LOCALE = 'en-PH';
  const MINOR_DIGITS = 2; // all supported currencies use 2 decimals
  const MAX_MINOR = 100000000000; // 1 000 000 000.00

  /**
   * Parses "1,234.50", "1234.5", "1 500", "99" into minor units.
   * A comma followed by groups of exactly three digits is a thousands
   * separator ("1,500" = 1500); otherwise a comma is a decimal mark ("12,50").
   * Returns { ok: true, value } or { ok: false, error }.
   */
  function parseAmount(input) {
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return { ok: false, error: 'Enter a valid amount.' };
      input = String(input);
    }
    if (typeof input !== 'string') return { ok: false, error: 'Enter an amount.' };
    let cleaned = input.trim().replace(/\s/g, ''); // \s includes NBSP and narrow NBSP
    if (cleaned === '') return { ok: false, error: 'Enter an amount.' };
    if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(cleaned)) cleaned = cleaned.replace(/,/g, '');
    const m = /^(\d+)(?:[.,](\d*))?$/.exec(cleaned);
    if (!m) return { ok: false, error: 'Use digits with an optional decimal part, e.g. 149.50.' };
    const whole = m[1].replace(/^0+(?=\d)/, '');
    const frac = m[2] || '';
    if (frac.length > MINOR_DIGITS) {
      return { ok: false, error: `Use at most ${MINOR_DIGITS} decimals.` };
    }
    if (whole.length > 12) return { ok: false, error: 'Amount is too large.' };
    const value = Number(whole) * 10 ** MINOR_DIGITS + Number(frac.padEnd(MINOR_DIGITS, '0'));
    if (value <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
    if (value > MAX_MINOR) return { ok: false, error: 'Amount is too large.' };
    return { ok: true, value };
  }

  /** Minor units -> plain decimal string for form inputs, e.g. 12345 -> "123.45". */
  function toInputString(minor) {
    const sign = minor < 0 ? '-' : '';
    const abs = Math.abs(minor);
    const whole = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, '0');
    return `${sign}${whole}.${frac}`;
  }

  /** Minor units -> localized currency string, e.g. "₱1,234.50". */
  function format(minor, currency, locale = DEFAULT_LOCALE) {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
    // Integer division keeps exactness; only the final display uses a float.
    return fmt.format(minor / 100);
  }

  return { CURRENCIES, DEFAULT_CURRENCY, DEFAULT_LOCALE, MAX_MINOR, parseAmount, toInputString, format };
});
