import { r2 } from './money.js';

/**
 * Decide where a parsed invoice goes. Pure: all lookups come from `ctx`.
 *
 * inv: {number, net, tax, total, seller_tax_id, buyer_tax_id, remark}
 * ctx: {
 *   invoiceExists(number) -> bool
 *   buyerByTax(taxId) -> {name, board} | null
 *   suppliersForEntity(taxId) -> [{id, name, boards: [board]}] | null (null = entity not registered)
 *   owe(supplierId, board) -> number
 * }
 * Returns {status: '已入账'|'待处理'|'重复', supplier_id, board, moved, pending_reason, candidates, red, steps}
 */
export function classifyInvoice(inv, ctx) {
  const steps = [];
  const out = { status: '已入账', supplier_id: null, board: null, moved: 0, pending_reason: null, candidates: null, red_of: null, steps };
  const pend = (reason) => { out.status = '待处理'; out.pending_reason = reason; return out; };

  if (!inv.number || !/^\d{8,20}$/.test(String(inv.number))) {
    steps.push(['no', '发票号码缺失或格式不对']);
    return pend('信息不完整');
  }
  if (ctx.invoiceExists(String(inv.number))) {
    steps.push(['no', `发票号码 ${inv.number} 已存在，重复上传`]);
    out.status = '重复';
    return out;
  }
  const amt = (v) => (v == null || v === '' ? NaN : Number(v));
  const net = amt(inv.net), tax = amt(inv.tax), total = amt(inv.total);
  if (![net, tax, total].every(Number.isFinite)) {
    steps.push(['no', '金额缺失']);
    return pend('信息不完整');
  }
  if (Math.abs(r2(net + tax) - r2(total)) > 0.011) {
    steps.push(['no', `金额不自洽：${net} + ${tax} ≠ ${total}`]);
    return pend('金额需核对');
  }
  steps.push(['ok', `金额自洽：不含税 ${net.toFixed(2)} + 税额 ${tax.toFixed(2)} = ${total.toFixed(2)}`]);

  if (total < 0) {
    const m = String(inv.remark || '').match(/(\d{20})/);
    out.red_of = m ? m[1] : null;
    steps.push(['ok', `红字发票，冲减已开票额${out.red_of ? `（对应蓝字发票 ${out.red_of}）` : ''}`]);
  }

  const buyer = ctx.buyerByTax(inv.buyer_tax_id);
  if (!buyer) {
    steps.push(['no', `购买方税号 ${inv.buyer_tax_id || '（空）'} 不是我方受票主体`]);
    return pend('购买方不是我方');
  }
  out.board = buyer.board;
  steps.push(['ok', `购买方「${buyer.name}」属于${buyer.board}板块`]);

  const sups = ctx.suppliersForEntity(inv.seller_tax_id);
  if (!sups || sups.length === 0) {
    steps.push(['q', `销售方税号 ${inv.seller_tax_id || '（空）'} 未登记为开票主体`]);
    return pend('开票主体未登记');
  }
  if (sups.length === 1) {
    const s = sups[0];
    out.supplier_id = s.id;
    steps.push(['ok', `税号命中开票主体，归属「${s.name}」`]);
    if (!s.boards.includes(out.board) && s.boards.length === 1) {
      steps.push(['q', `「${s.name}」只在${s.boards[0]}板块供货，自动改归${s.boards[0]}（跨板块核销）`]);
      out.board = s.boards[0];
      out.moved = 1;
    }
    return out;
  }
  const owing = sups.filter((s) => s.boards.includes(out.board) && ctx.owe(s.id, out.board) > 0.004);
  if (owing.length === 1) {
    out.supplier_id = owing[0].id;
    steps.push(['ok', `开票主体由 ${sups.map((s) => s.name).join('、')} 共用，只有「${owing[0].name}」在${out.board}有欠票，自动归属`]);
    return out;
  }
  out.candidates = (owing.length ? owing : sups).map((s) => s.id);
  steps.push(['q', `开票主体由 ${sups.map((s) => s.name).join('、')} 共用，需要财务分配`]);
  return pend('共用主体需分配');
}
