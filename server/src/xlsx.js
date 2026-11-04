import ExcelJS from 'exceljs';

/** Plain value of an exceljs cell (formulas give their cached result, rich text its plain text). */
export function cellVal(cell) {
  let v = cell?.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) v = v.result;
    else if (v.richText) v = v.richText.map((t) => t.text).join('');
    else if ('text' in v) v = v.text;
    else if (v.error) return null;
  }
  return typeof v === 'string' ? v.trim() : v;
}

export async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

/** Rows of a sheet as objects keyed by the header row (row 1 unless given). */
export function sheetRows(ws, headerRow = 1) {
  const headers = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: true }, (c, i) => { headers[i] = String(cellVal(c) ?? '').trim(); });
  const out = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const o = {};
    let any = false;
    headers.forEach((h, i) => { if (!h) return; const v = cellVal(row.getCell(i)); if (v !== null && v !== '') any = true; o[h] = v; });
    if (any) out.push({ _row: r, ...o });
  }
  return out;
}

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
const INPUT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

/** A simple table workbook: [{name, columns:[{header,key,width,numFmt}], rows:[{}], note}] */
export async function tableWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 14, style: { font: { name: 'Arial' }, numFmt: c.numFmt } }));
    ws.getRow(1).eachCell((c) => { c.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL; });
    for (const r of s.rows || []) ws.addRow(r);
    if (s.input) {
      for (let r = 2; r <= Math.max(ws.rowCount, s.inputRows || 50); r++) {
        s.columns.forEach((_, i) => { ws.getRow(r).getCell(i + 1).fill = INPUT_FILL; });
      }
    }
    if (s.note && s.input) {
      // keep notes off input sheets, or they would be read back as data
      const ns = wb.addWorksheet('填写说明');
      ns.getColumn(1).width = 100;
      const n = ns.getCell('A1');
      n.value = s.note; n.alignment = { wrapText: true, vertical: 'top' }; n.font = { name: 'Arial' };
    } else if (s.note) {
      const n = ws.getRow(ws.rowCount + 2).getCell(1);
      n.value = s.note; n.font = { name: 'Arial', italic: true, color: { argb: 'FF808080' } };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const MASTER_COLUMNS = [
  { header: '供应商名称', key: 'supplier', width: 18 },
  { header: '供应板块', key: 'boards', width: 12 },
  { header: '默认税率', key: 'rate', width: 10 },
  { header: '另付税费', key: 'tax_cost', width: 10 },
  { header: '跟单员用户名', key: 'owner', width: 14 },
  { header: '开票主体全称', key: 'entity', width: 30 },
  { header: '开票主体税号', key: 'tax_id', width: 24 },
  { header: '电商期初欠票', key: 'open_ec', width: 14, numFmt: '#,##0.00' },
  { header: '工厂期初欠票', key: 'open_fac', width: 14, numFmt: '#,##0.00' },
];

export async function masterTemplate() {
  return tableWorkbook([{
    name: '供应商资料', columns: MASTER_COLUMNS, input: true, inputRows: 60,
    rows: [{ supplier: '示例：华茂塑化', boards: '工厂', rate: 0.13, tax_cost: '是', owner: 'wanglei', entity: '浙江华茂塑化有限公司', tax_id: '91330421MA28B6XK2P', open_ec: 0, open_fac: 45200 }],
    note: '每个开票主体一行；同一供应商有多个主体就写多行，供应商的其他列以第一行为准。供应板块填 电商 / 工厂 / 电商+工厂；税率填 0.13 或 13%；期初欠票按含税金额。以「示例：」开头的行会被跳过。',
  }]);
}
