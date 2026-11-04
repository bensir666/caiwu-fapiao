import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInvoice } from '../src/classify.js';

const BUYERS = { '91110000BUYEREC01': { name: '电商公司', board: '电商' }, '91110000BUYERFA01': { name: '工厂公司', board: '工厂' } };
const ENTITIES = {
  '91330000SELLER0001': [{ id: 1, name: '华茂', boards: ['工厂'] }],
  '91330000SELLER0002': [{ id: 2, name: '甲', boards: ['电商'] }, { id: 3, name: '乙', boards: ['电商'] }],
};
const ctx = (owe = {}) => ({
  invoiceExists: (n) => n === '11111111111111111111',
  buyerByTax: (t) => BUYERS[t] || null,
  suppliersForEntity: (t) => ENTITIES[t] || null,
  owe: (sid, b) => owe[`${sid}|${b}`] || 0,
});
const inv = (o = {}) => ({ number: '26332000000000000001', net: 100, tax: 13, total: 113, seller_tax_id: '91330000SELLER0001', buyer_tax_id: '91110000BUYERFA01', ...o });

test('single entity books directly', () => {
  const c = classifyInvoice(inv(), ctx());
  assert.equal(c.status, '已入账');
  assert.equal(c.supplier_id, 1);
  assert.equal(c.board, '工厂');
  assert.equal(c.moved, 0);
});

test('duplicate, incomplete, inconsistent amounts', () => {
  assert.equal(classifyInvoice(inv({ number: '11111111111111111111' }), ctx()).status, '重复');
  assert.equal(classifyInvoice(inv({ number: '' }), ctx()).pending_reason, '信息不完整');
  assert.equal(classifyInvoice(inv({ total: null }), ctx()).pending_reason, '信息不完整');
  assert.equal(classifyInvoice(inv({ total: 120 }), ctx()).pending_reason, '金额需核对');
});

test('unknown buyer or seller goes to pending', () => {
  assert.equal(classifyInvoice(inv({ buyer_tax_id: 'X' }), ctx()).pending_reason, '购买方不是我方');
  assert.equal(classifyInvoice(inv({ seller_tax_id: 'X' }), ctx()).pending_reason, '开票主体未登记');
});

test('invoice to the other board moves to the supplier only board', () => {
  const c = classifyInvoice(inv({ buyer_tax_id: '91110000BUYEREC01' }), ctx());
  assert.equal(c.status, '已入账');
  assert.equal(c.board, '工厂');
  assert.equal(c.moved, 1);
});

test('shared entity: picks the only supplier with outstanding, else pending', () => {
  const base = inv({ seller_tax_id: '91330000SELLER0002', buyer_tax_id: '91110000BUYEREC01' });
  const one = classifyInvoice(base, ctx({ '3|电商': 500 }));
  assert.equal(one.status, '已入账');
  assert.equal(one.supplier_id, 3);
  const both = classifyInvoice(base, ctx({ '2|电商': 1, '3|电商': 500 }));
  assert.equal(both.pending_reason, '共用主体需分配');
  assert.deepEqual(both.candidates, [2, 3]);
  const none = classifyInvoice(base, ctx());
  assert.deepEqual(none.candidates, [2, 3]);
});

test('red invoice links the original number from the remark', () => {
  const c = classifyInvoice(inv({ net: -100, tax: -13, total: -113, remark: '被红冲蓝字数电发票号码：26332000000000000009' }), ctx());
  assert.equal(c.status, '已入账');
  assert.equal(c.red_of, '26332000000000000009');
});
