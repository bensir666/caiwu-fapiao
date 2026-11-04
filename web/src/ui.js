export const ST_CLASS = { 草稿: 'c-mut', 待终审: 'c-warn', 已生效: 'c-good', 已驳回: 'c-bad', 已作废: 'c-mut' };
export const INV_CLASS = { 已入账: 'c-good', 待处理: 'c-warn', 已退回: 'c-bad' };
export const BUCKETS = ['0–30 天', '31–60 天', '61–90 天', '90 天以上'];
export function ageChip(oldest, owe) {
  if (!(owe > 0.004)) return owe < -0.004 ? { cls: 'c-acc', text: '多开' } : { cls: 'c-good', text: '已结清' };
  if (oldest > 90) return { cls: 'c-bad', text: `最早 ${oldest} 天` };
  if (oldest > 30) return { cls: 'c-warn', text: `最早 ${oldest} 天` };
  return { cls: 'c-mut', text: `最早 ${oldest ?? 0} 天` };
}
export const RATES = [0.13, 0.09, 0.06, 0.05, 0.03, 0.01, 0];
