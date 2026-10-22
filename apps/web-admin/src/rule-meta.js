/**
 * 规则字段元数据：把规则 JSON 里的英文 key 变成运营能看懂的中文名字 + 单位。
 *
 * 设计要点
 * - 只在「展示层」做换算提示（¥ / % / ×），提交时仍传数据库里的原始值（金额单位=分，比例=0~1 小数），
 *   避免前端换算引入四舍五入误差。
 * - 金额、比例用**显式清单**判定，不靠 key 里是否含 rate/money 之类的字符串猜，
 *   猜错的代价是运营把「0.006」看成「0.6%」并照样保存。
 * - precision 按数值真实小数位计算：settlement.withdraw_fee_rate = 0.006 必须保留 3 位，
 *   固定 2 位会把它悄悄改成 0.01。
 */

/** 字段中文名（未收录的字段回落到原始 key，并在旁边以小字显示 key） */
export const FIELD_LABELS = {
  // 通用（等级表 / 阶梯表 / 各类阈值共用）
  level: "等级", name: "名称", min: "下限", max: "上限",
  weight: "派单权重（×）", commission: "平台抽佣比例", rate: "提成比例", enabled: "是否启用",
  fee: "加急费（分）",

  // 派单 / 打卡 / 加急
  max_radius_km: "派单半径（公里）", push_batch: "每批推送人数",
  grab_confirm_timeout_hours: "抢单确认时限（小时）",
  distance_factor_min: "距离系数下限（×）", urgent_boost: "加急放大系数（×）",
  max_distance_m: "打卡最大距离（米）",

  // 结算
  freeze_days: "冻结天数（T+N 结算）", min_withdraw: "最低提现金额（分）",
  withdraw_fee_rate: "提现手续费比例", free_cancel_hours: "免费取消时限（小时）",
  cancel_penalty_rate: "违约扣款比例",

  // 代理 / 业务员
  fee_share_rate: "代理分成（占服务费比例）", mgmt_rate: "管理费比例",
  settle_period: "结算周期", bill_day: "出账日（每月几号）",
  register: "注册奖励（分）", lead: "有效线索奖励（分）", newbie_first: "新客户首单奖励（分）",
  daily_champ: "日榜冠军奖励（分）", weekly_champ: "周榜冠军奖励（分）",
  deal_tiers: "成交提成阶梯",
  monthly_gmv_target: "月成交额目标（分）", monthly_orders_target: "月订单数目标",
  active_sales_target: "活跃业务员数目标", pass_score: "考核通过分",

  // 平台
  city: "城市", compliance_notice: "合规提示语", service_fee_note: "服务费说明",

  // 家长信用 / 教员成长
  order_completed: "完成订单加分", review_given: "提交评价加分", monthly_no_cancel: "当月零取消加分",
  cancel_within_4h: "4 小时内取消扣分", no_show: "爽约扣分", malicious_review: "恶意评价扣分",
  restrict_below: "限制下单的分数线",
  per_lesson: "每完成一节课成长值", good_review_base: "好评基础成长值", bad_review_base: "差评基础成长值",
  violation: "违规扣减", private_deal_ban: "禁止私下交易",
  fake_checkin: "虚假打卡", private_deal: "私下交易",

  // 评价计分
  lesson_points: "完成课时得分", good_base: "好评基础分", bad_base: "差评基础分",
  good_threshold: "好评阈值（星）", bad_threshold: "差评阈值（星）",
  window_hours: "评价有效期（小时）",
  positive_tags: "好评标签", negative_tags: "差评标签",

  // 消息提醒
  lesson_remind_minutes: "上课提醒提前量（分钟）", remind_on_checkin: "打卡后是否提醒",
  remind_confirm_days: "确认完成提醒（天）",

  // 风控
  high_cancel_count: "高频取消阈值（次）", brush_same_device: "同设备刷单阈值（次）",
  checkin_fail_block: "打卡异常是否拦截", register_per_device_day: "单设备每日注册上限",
  register_per_ip_hour: "单 IP 每小时注册上限", order_per_parent_day: "单家长每日下单上限",
  login_fail_limit: "登录失败锁定次数", login_lock_minutes: "锁定分钟数",

  // 运营字典
  stages: "学段", subjects: "科目",

  // 权限矩阵
  "order.price": "订单改价", "order.close": "强制关闭订单",
  "refund.review": "退款审批", "withdraw.review": "提现审核",
};

/** 金额字段：数据库里以「分」为单位，表单旁标注 ¥ 便于核对 */
export const MONEY_FIELDS = new Set([
  "fee", "min_withdraw", "register", "lead", "newbie_first",
  "daily_champ", "weekly_champ", "monthly_gmv_target",
]);

/** 比例字段：0~1 的小数，表单旁标注百分比 */
export const RATE_FIELDS = new Set([
  "commission", "rate", "withdraw_fee_rate", "cancel_penalty_rate",
  "fee_share_rate", "mgmt_rate",
]);

/** 倍数字段：可以大于 1，只提示 ×N，不做 0~1 校验 */
export const MULTIPLIER_FIELDS = new Set(["weight", "urgent_boost", "distance_factor_min"]);

/** 角色代码（权限矩阵的枚举值） */
export const ROLE_CODES = ["admin", "agent", "sales", "teacher", "parent"];
const ROLE_LABELS = {
  admin: "平台管理员", agent: "区域代理", sales: "业务员", teacher: "教员", parent: "家长",
};

export const fieldLabel = (key) => FIELD_LABELS[key] || "";
export const isMoney = (key) => MONEY_FIELDS.has(key);
export const isRate = (key) => RATE_FIELDS.has(key);
export const isMultiplier = (key) => MULTIPLIER_FIELDS.has(key);
export const roleLabel = (code) => ROLE_LABELS[code] || code;

export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const isPrimitiveArray = (v) =>
  Array.isArray(v) && v.every((x) => x === null || typeof x !== "object");
export const isObjectArray = (v) => Array.isArray(v) && v.some((x) => isObject(x));

/** 权限矩阵：整列都是已知角色代码时才用勾选，避免运营手打错角色名 */
export const isRoleList = (v) =>
  isPrimitiveArray(v) && v.length > 0 && v.every((x) => ROLE_CODES.includes(x));

/** 真实小数位（0~4 位），0.006 => 3；固定 2 位会把 0.006 改成 0.01 */
export function precisionOf(v) {
  const s = String(v ?? 0);
  const dot = s.indexOf(".");
  if (dot < 0 || s.includes("e") || s.includes("E")) return 0;
  return Math.min(4, s.length - dot - 1);
}
export const stepOf = (v) => (precisionOf(v) ? Number((10 ** -precisionOf(v)).toFixed(4)) : 1);

/** 数字下方的人话提示：¥20.00 / 6.0% / ×2.20；普通整数返回空串 */
export function numberHint(key, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (isMoney(key)) return "¥ " + (n / 100).toFixed(2);
  if (isRate(key)) return "= " + (n * 100).toFixed(2).replace(/\.?0+$/, "") + "%";
  if (isMultiplier(key)) return "× " + n.toFixed(2);
  return "";
}

/** 金额不允许负数（奖励/额度/单价），其余字段（信用分、成长分）必须允许 */
export const minOf = (key) => (isMoney(key) ? 0 : undefined);

/**
 * 保存前的兜底校验：服务端没有强 schema，运营填错会直接影响分账/派单。
 * 只拦「填错必然出事」的情况，不做过度限制（否则改不动规则）。
 */
export function validateRuleValue(value) {
  const errs = [];
  const walkNumber = (key, v, trail) => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errs.push("「" + (fieldLabel(key) || trail) + "」必须是数字");
      return;
    }
    if (isMoney(key) && v < 0) errs.push("「" + (fieldLabel(key) || trail) + "」金额不能为负数");
    if (isRate(key) && (v < 0 || v > 1)) {
      errs.push("「" + (fieldLabel(key) || trail) + "」比例请填 0~1 的小数（0.15 表示 15%）");
    }
  };
  const checkObject = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const trail = prefix ? prefix + " · " + k : k;
      if (typeof v === "number") walkNumber(k, v, trail);
      else if (isObject(v)) checkObject(v, trail);
      else if (isPrimitiveArray(v)) {
        if (v.some((x) => String(x ?? "").trim() === "")) errs.push("「" + (fieldLabel(k) || trail) + "」不能有空项");
        if (new Set(v).size !== v.length) errs.push("「" + (fieldLabel(k) || trail) + "」有重复项");
        if (!v.length) errs.push("「" + (fieldLabel(k) || trail) + "」至少要保留 1 项");
      } else if (isObjectArray(v)) {
        if (!v.length) errs.push("「" + (fieldLabel(k) || trail) + "」至少需要一行");
        v.forEach((row, i) => {
          for (const [ck, cv] of Object.entries(row || {})) {
            if (typeof cv === "number") walkNumber(ck, cv, "第 " + (i + 1) + " 行 " + (fieldLabel(ck) || ck));
            if (typeof cv === "string" && String(cv).trim() === "" && ck !== "name") {
              errs.push("第 " + (i + 1) + " 行「" + (fieldLabel(ck) || ck) + "」不能为空");
            }
          }
        });
      }
    }
  };

  if (isObjectArray(value)) {
    if (!value.length) errs.push("该规则至少需要一行");
    value.forEach((row, i) => {
      for (const [ck, cv] of Object.entries(row || {})) {
        if (typeof cv === "number") walkNumber(ck, cv, "第 " + (i + 1) + " 行 " + (fieldLabel(ck) || ck));
      }
    });
  } else if (isObject(value)) {
    checkObject(value, "");
  } else if (isPrimitiveArray(value)) {
    if (!value.length) errs.push("该规则至少要保留 1 项");
  } else {
    errs.push("该规则的数据结构无法识别");
  }
  return errs;
}
