import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseInvoiceXml, parseInvoiceText, parseInvoiceFile } from '../src/parsers.js';

const xml = fs.readFileSync(new URL('./fixtures/sample-invoice.xml', import.meta.url), 'utf8');

test('数电 XML', () => {
  const f = parseInvoiceXml(xml);
  assert.equal(f.number, '26332000000123456789');
  assert.equal(f.issue_date, '2026-10-28');
  assert.equal(f.seller_name, '浙江华茂塑化有限公司');
  assert.equal(f.seller_tax_id, '91330421MA28B6XK2P');
  assert.equal(f.buyer_name, '深圳某某工厂有限公司');
  assert.equal(f.buyer_tax_id, '91440300MA5FTEST01');
  assert.equal(f.net, 40000);
  assert.equal(f.tax, 5200);
  assert.equal(f.total, 45200);
  assert.equal(f.rate, 0.13);
  assert.equal(f.type, '数电专票');
});

test('数电 PDF text layout', () => {
  const text = [
    '电子发票（增值税专用发票）',
    '发票号码：26332000000123456789',
    '开票日期：2026年10月28日',
    '购 名称：深圳某某工厂有限公司 销 名称：浙江华茂塑化有限公司',
    '买 统一社会信用代码/纳税人识别号：91440300MA5FTEST01 售 统一社会信用代码/纳税人识别号：91330421MA28B6XK2P',
    '*塑料*PP颗粒 吨 10 4000 40000.00 13% 5200.00',
    '合 计 ¥40000.00 ¥5200.00',
    '价税合计（大写） 肆万伍仟贰佰圆整 （小写）¥45200.00',
    '备 注 10月对账',
  ].join('\n');
  const f = parseInvoiceText(text);
  assert.equal(f.number, '26332000000123456789');
  assert.equal(f.issue_date, '2026-10-28');
  assert.equal(f.buyer_name, '深圳某某工厂有限公司');
  assert.equal(f.seller_tax_id, '91330421MA28B6XK2P');
  assert.equal(f.net, 40000);
  assert.equal(f.tax, 5200);
  assert.equal(f.total, 45200);
  assert.equal(f.rate, 0.13);
  assert.equal(f.type, '数电专票');
});

test('PDF text with columns swapped is fixed by known buyer tax id', () => {
  const text = '发票号码：26332000000123456789 名称：浙江华茂塑化有限公司 纳税人识别号：91330421MA28B6XK2P 名称：深圳某某工厂有限公司 纳税人识别号：91440300MA5FTEST01 合计 ¥100.00 ¥13.00 （小写）¥113.00';
  const f = parseInvoiceText(text, (t) => t === '91440300MA5FTEST01');
  assert.equal(f.buyer_tax_id, '91440300MA5FTEST01');
  assert.equal(f.seller_name, '浙江华茂塑化有限公司');
});

test('parseInvoiceFile picks XML by content', async () => {
  const r = await parseInvoiceFile(Buffer.from(xml), 'whatever.bin');
  assert.equal(r.source, 'xml');
  const o = await parseInvoiceFile(Buffer.from([0xff, 0xd8, 0xff]), 'a.jpg');
  assert.equal(o.source, 'other');
});

test('数电 PDF file end to end (pdf.js text extraction)', async () => {
  const buf = fs.readFileSync(new URL('./fixtures/sample-invoice.pdf', import.meta.url));
  const r = await parseInvoiceFile(buf, '发票.pdf');
  assert.equal(r.source, 'pdf');
  assert.equal(r.fields.number, '26332000000123456789');
  assert.equal(r.fields.seller_tax_id, '91330421MA28B6XK2P');
  assert.equal(r.fields.buyer_tax_id, '91440300MA5FTEST01');
  assert.equal(r.fields.total, 45200);
  assert.equal(r.fields.remark, '10月对账');
});
