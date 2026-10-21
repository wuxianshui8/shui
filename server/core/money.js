// 金额工具：全链路以「分」为整数单位，禁止浮点运算
export function toCents(yuan) {
  return Math.round(Number(yuan) * 100);
}
export function toYuan(cents) {
  return Number((Number(cents) / 100).toFixed(2));
}
export function fmt(cents) {
  return (Number(cents) / 100).toFixed(2);
}
/** 按比例切分金额，四舍五入到分 */
export function applyRate(cents, rate) {
  return Math.round(Number(cents) * Number(rate));
}
export function parseAmount(input, field = "金额") {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) {
    const e = new Error(field + "不合法");
    e.status = 400;
    e.code = "BAD_AMOUNT";
    throw e;
  }
  return Math.round(n);
}