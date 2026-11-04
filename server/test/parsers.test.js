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

// Layouts copied from real 数电 PDFs (names and numbers replaced): vertical 备注 label, "开票人" footer,
// discount lines with negative amounts, and spaces after "¥".
test('real-world layout: e-commerce platform invoice with discount line', () => {
  const text = [
    '发票号码: 26117000001000000001',
    '电子发票(普通发票) 开票日期: 2026年09月09日',
    '购 销',
    '买 名 称 : 测试（东莞）医疗技术有限公司 售 名 称 : 北京某某信息技术有限公司',
    '方 方',
    '统一社会信用代码 / 纳税人识别号 : 91441900MA00TEST1D 统一社会信用代码 / 纳税人识别号 : 91110302000000000R',
    '项目名称 规格型号 单位 数 量 单 价 金 额 税率 /征收率 税 额',
    '*其他机械设备*电器电子产品及配件 颗 1 4468.14 4468.14 13% 580.86',
    '*其他机械设备*电器电子产品及配件 -137.58 13% -17.89',
    '合 计 ¥4330.56 ¥562.97',
    '价税合计(大写) 肆仟捌佰玖拾叁圆伍角叁分 (小写) ¥4893.53',
    '订单号:3615470000000000 SN/IMEI:ABC123',
    '备', '注',
    '开票人: 张三',
  ].join('\n');
  const f = parseInvoiceText(text);
  assert.equal(f.number, '26117000001000000001');
  assert.equal(f.issue_date, '2026-09-09');
  assert.equal(f.type, '数电普票');
  assert.equal(f.buyer_name, '测试（东莞）医疗技术有限公司');
  assert.equal(f.buyer_tax_id, '91441900MA00TEST1D');
  assert.equal(f.seller_name, '北京某某信息技术有限公司');
  assert.equal(f.seller_tax_id, '91110302000000000R');
  assert.deepEqual([f.net, f.tax, f.total], [4330.56, 562.97, 4893.53]);
  assert.equal(f.rate, 0.13);
  assert.equal(f.remark, '订单号:3615470000000000 SN/IMEI:ABC123');
});

test('real-world layout: full-width colons and spaced currency', () => {
  const text = [
    '电子发票（普通发票） 发票号码： 26444000000000000002',
    '开票日期： 2026年10月23日',
    '购 名称： 测试医疗科技（佛山）有限公司 销 名称： 广州市某某科技有限公司',
    '买 售', '方 方',
    '信 统一社会信用代码/纳税人识别号： 91440605MA00TEST6F 信 统一社会信用代码/纳税人识别号： 91441900MA00TEST7G',
    '*计算机网络设备*串口服 igc2370 套 6 525.073746312684 3150.44 13% 409.56',
    '合 计 ¥ 3150.44 ¥ 409.56',
    '价税合计（大写） 叁仟伍佰陆拾圆整 （小写） ¥ 3560.00',
    '支付渠道:其他; 交易单号:C000TEST',
    '备', '注',
    '开票人： 李四',
  ].join('\n');
  const f = parseInvoiceText(text);
  assert.equal(f.number, '26444000000000000002');
  assert.equal(f.issue_date, '2026-10-23');
  assert.equal(f.buyer_tax_id, '91440605MA00TEST6F');
  assert.equal(f.seller_name, '广州市某某科技有限公司');
  assert.deepEqual([f.net, f.tax, f.total], [3150.44, 409.56, 3560]);
  assert.equal(f.remark, '支付渠道:其他; 交易单号:C000TEST');
});
