'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, toInputString, format } = require('../public/js/money');

test('parses decimal strings exactly into minor units', () => {
  const cases = { '12': 1200, '12.5': 1250, '12,50': 1250, '0.01': 1, '1 234,56': 123456, '1,500': 150000, '1,234.50': 123450, '1,000,000': 100000000, '12,000.5': 1200050, '0.1': 10, '0.29': 29, '1000000000': 100000000000 };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(parseAmount(input), { ok: true, value: expected }, input);
  }
  // Classic float traps stay exact.
  assert.equal(parseAmount('1.15').value, 115);
  assert.equal(parseAmount('4.35').value, 435);
  assert.equal(parseAmount(19.99).value, 1999);
});

test('rejects invalid, zero, negative, too precise and too large amounts', () => {
  for (const input of ['', '   ', 'abc', '1,2345', '12,34,567', '-5', '0', '0.00', '1.234', '1e5', '12.3.4', '1000000000.01', null, undefined, {}, NaN, Infinity]) {
    assert.equal(parseAmount(input).ok, false, String(input));
  }
});

test('formats minor units for inputs and display', () => {
  assert.equal(toInputString(123456), '1234.56');
  assert.equal(toInputString(5), '0.05');
  assert.equal(toInputString(-250), '-2.50');
  assert.equal(format(123456, 'PHP'), '₱1,234.56'); // default locale en-PH
  assert.match(format(123456, 'SEK', 'sv-SE'), /1\s234,56\s*kr/);
  assert.equal(format(1999, 'USD', 'en-US'), '$19.99');
});
