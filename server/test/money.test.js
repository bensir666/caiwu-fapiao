import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAmount, computeLedger, bucketOf, r2 } from '../src/money.js';

test('splitAmount 含税 / 不含税', () => {
  assert.deepEqual(splitAmount(11300, 0.13, '含税'), { net: 10000, tax: 1300, gross: 11300 });
  assert.deepEqual(splitAmount(10000, 0.13, '不含税'), { net: 10000, tax: 1300, gross: 11300 });
  assert.deepEqual(splitAmount(100, 0.01, '含税'), { net: 99.01, tax: 0.99, gross: 100 });
});

test('r2 rounds to cents', () => {
  assert.equal(r2(1.005), 1.01);
  assert.equal(r2(0.1 + 0.2), 0.3);
});

test('bucketOf edges', () => {
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91].map(bucketOf), [0, 0, 1, 1, 2, 2, 3]);
});

test('computeLedger: FIFO, unpaid part is the newest', () => {
  const items = [
    { date: '2026-01-01', amount: 1000 }, // opening, 307 days old
    { date: '2026-09-01', amount: 2000 }, // 64 days
    { date: '2026-10-20', amount: 3000 }, // 15 days
  ];
  const l = computeLedger(items, 2500, '2026-11-04');
  assert.equal(l.should, 6000);
  assert.equal(l.done, 2500);
  assert.equal(l.owe, 3500);
  // 2500 paid clears the opening 1000 and 1500 of September; 500 of September + 3000 of October remain
  assert.deepEqual(l.buckets, [3000, 0, 500, 0]);
  assert.equal(l.oldest, 64);
});

test('computeLedger: negative adjustment and over-invoicing', () => {
  const items = [{ date: '2026-10-01', amount: 1000 }, { date: '2026-10-10', amount: -200 }];
  const l = computeLedger(items, 0, '2026-11-04');
  assert.equal(l.owe, 800);
  assert.deepEqual(l.buckets, [0, 800, 0, 0]);
  const over = computeLedger(items, 900, '2026-11-04');
  assert.equal(over.owe, -100);
  assert.deepEqual(over.buckets, [0, 0, 0, 0]);
  assert.equal(over.oldest, null);
});
