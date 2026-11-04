import { XMLParser } from 'fast-xml-parser';
import { r2 } from './money.js';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,，¥￥\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const normDate = (s) => {
  if (!s) return null;
  const m = String(s).match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const typeOf = (text) => (/专用发票|专票/.test(text || '') ? '数电专票' : '数电普票');

/** Fill in whichever of net/tax/total is missing and normalise signs. */
function finishAmounts(o) {
  let { net, tax, total } = o;
  if (total == null && net != null && tax != null) total = r2(net + tax);
  if (net == null && total != null && tax != null) net = r2(total - tax);
  if (tax == null && total != null && net != null) tax = r2(total - net);
  o.net = net; o.tax = tax; o.total = total;
  if (o.rate == null && net && tax != null) o.rate = Math.round((tax / net) * 100) / 100;
  return o;
}

/**
 * 数电发票 XML. The national schema nests fields under EInvoice/EInvoiceData; we do not rely on exact paths,
 * we flatten every leaf element and pick the first match from known tag names (upper and lower camel case,
 * plus the older pinyin-initial names some tools export).
 */
export function parseInvoiceXml(xmlText) {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, removeNSPrefix: true, trimValues: true });
  const tree = parser.parse(xmlText);
  const leaves = new Map();
  const put = (k, v) => { k = k.toLowerCase(); if (!leaves.has(k)) leaves.set(k, v); };
  // carry "seller"/"buyer" context down so generic tags like Name / IdNum are told apart
  const walk = (node, key, ctx) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, key, ctx)); return; }
    if (typeof node !== 'object') { put(key, String(node)); if (ctx) put(`${ctx}:${key}`, String(node)); return; }
    for (const [k, v] of Object.entries(node)) {
      const c = /seller|xsf/i.test(k) ? 'seller' : /buyer|gmf/i.test(k) ? 'buyer' : ctx;
      walk(v, k, c);
    }
  };
  walk(tree, '', '');
  const pick = (...keys) => {
    for (const k of keys) { const v = leaves.get(k.toLowerCase()); if (v != null && v !== '') return v; }
    return null;
  };
  const out = finishAmounts({
    number: pick('InvoiceNumber', 'EIid', 'Fphm', 'FPHM'),
    issue_date: normDate(pick('IssueTime', 'IssuTime', 'RequestTime', 'Kprq', 'KPRQ')),
    seller_name: pick('seller:SellerName', 'SellerName', 'seller:Name', 'Xsfmc', 'XSFMC'),
    seller_tax_id: pick('seller:SellerIdNum', 'SellerIdNum', 'SellerTaxID', 'seller:IdNum', 'Xsfnsrsbh', 'XSFNSRSBH'),
    buyer_name: pick('buyer:BuyerName', 'BuyerName', 'buyer:Name', 'Gmfmc', 'GMFMC'),
    buyer_tax_id: pick('buyer:BuyerIdNum', 'BuyerIdNum', 'BuyerTaxID', 'buyer:IdNum', 'Gmfnsrsbh', 'GMFNSRSBH'),
    net: num(pick('TotalAmWithoutTax', 'TotalAmount', 'Hjje', 'HJJE')),
    tax: num(pick('TotalTaxAm', 'TotalTax', 'Hjse', 'HJSE')),
    total: num(pick('TotalTax-includedAmount', 'TotalTaxIncludedAmount', 'AmountWithTax', 'Jshj', 'JSHJ')),
    rate: num(pick('TaxRate', 'Slv', 'SLV')),
    remark: pick('Remark', 'Bz', 'BZ'),
  });
  out.type = typeOf(`${pick('InvoiceType', 'LabelName', 'Fplxdm', 'InvoiceTypeName') || ''} ${xmlText.slice(0, 4000)}`);
  if (out.rate != null && out.rate > 1) out.rate = r2(out.rate / 100);
  return out;
}

/** Group pdf.js text items into reading-order lines. */
function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' '));
}

export async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= Math.min(doc.numPages, 3); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    lines.push(...itemsToLines(tc.items));
  }
  await doc.destroy();
  return lines.join('\n');
}

/**
 * The remark box sits between the total line and the issuer ("开票人"). Its label is printed vertically
 * (备 / 注 on separate lines), so drop those label tokens instead of anchoring on them.
 */
function remarkOf(flat, totalM) {
  const start = totalM ? totalM.index + totalM[0].length : flat.search(/备\s*注/);
  if (start < 0) return null;
  let seg = flat.slice(start);
  const end = seg.search(/开\s*票\s*人/);
  if (end >= 0) seg = seg.slice(0, end);
  seg = seg.replace(/(^|\s)备\s*注(?=\s|[:：]|$)/g, ' ').replace(/(^|\s)[备注](?=\s|$)/g, ' ')
    .replace(/^[\s:：]+/, '').replace(/\s+/g, ' ').trim();
  return seg ? seg.slice(0, 500) : null;
}

/**
 * 数电发票 PDF text. Buyer appears before seller in reading order on the standard layout; `knownBuyerTax`
 * lets us swap them if a tool exported the columns the other way round.
 */
export function parseInvoiceText(text, knownBuyerTax = () => false) {
  const t = text.replace(/　/g, ' ');
  const flat = t.replace(/\s+/g, ' ');
  const m1 = (re) => { const m = flat.match(re); return m ? m[1] : null; };
  const taxIds = [...flat.matchAll(/(?:统一社会信用代码\s*\/?\s*纳税人识别号|纳税人识别号|统一社会信用代码)\s*[:：]?\s*([0-9A-Z]{15,20})/g)].map((m) => m[1]);
  const names = [...flat.matchAll(/名\s*称\s*[:：]\s*([^\s:：]{2,60}?)(?=\s|统一|纳税|$)/g)].map((m) => m[1]);
  let buyer = { name: names[0] || null, tax: taxIds[0] || null };
  let seller = { name: names[1] || null, tax: taxIds[1] || null };
  if (seller.tax && knownBuyerTax(seller.tax) && !knownBuyerTax(buyer.tax)) [buyer, seller] = [seller, buyer];

  const totalM = flat.match(/[（(]\s*小\s*写\s*[）)]\s*[¥￥]?\s*(-?[\d,]+\.\d{2})/);
  const sumM = flat.match(/合\s*计\s*[¥￥]?\s*(-?[\d,]+\.\d{2})\s*[¥￥]?\s*(-?[\d,]+\.\d{2})/);
  const rateM = flat.match(/(\d{1,2})\s*%/);
  const out = finishAmounts({
    number: m1(/发票号码\s*[:：]?\s*(\d{20}|\d{8})/),
    issue_date: normDate(m1(/开票日期\s*[:：]?\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2})/)?.replace(/\s/g, '')),
    seller_name: seller.name, seller_tax_id: seller.tax,
    buyer_name: buyer.name, buyer_tax_id: buyer.tax,
    net: sumM ? num(sumM[1]) : null,
    tax: sumM ? num(sumM[2]) : null,
    total: totalM ? num(totalM[1]) : null,
    rate: rateM ? Number(rateM[1]) / 100 : null,
    remark: remarkOf(flat, totalM),
  });
  out.type = typeOf(flat.slice(0, 400));
  return out;
}

export async function parseInvoiceFile(buffer, filename, knownBuyerTax) {
  const lower = (filename || '').toLowerCase();
  const head = buffer.subarray(0, 5).toString('latin1');
  if (lower.endsWith('.xml') || head.startsWith('<?xml') || head.startsWith('<')) {
    return { source: 'xml', fields: parseInvoiceXml(buffer.toString('utf8')) };
  }
  if (lower.endsWith('.pdf') || head === '%PDF-') {
    const text = await pdfText(buffer);
    return { source: 'pdf', fields: parseInvoiceText(text, knownBuyerTax), text };
  }
  return { source: 'other', fields: null };
}
