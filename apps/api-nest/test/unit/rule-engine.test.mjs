// 单元测试：rules/rule-engine.service.ts（推送优先级系数 / 等级映射 / 5.4 分账守恒）
// 规则配置用 stub 注入，不连数据库
process.env.AUTH_SECRET = "unit-test-secret-0123456789abcdef";

import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleEngineService } from "../../dist/rules/rule-engine.service.js";
import { haversineKm } from "../../dist/common/geo.js";

const CFG = {
  dispatch: { max_radius_km: 10, distance_factor_min: 0.05, urgent_boost: 1.2 },
  teacher_levels: [
    { level: 1, min: 0, max: 59 },
    { level: 2, min: 60, max: 79 },
    { level: 3, min: 80, max: 100 },
  ],
  parent_credit: [
    { level: 0, min: 0, max: 49 },
    { level: 3, min: 50, max: 100 },
  ],
};
const rules = { get: async (k) => CFG[k] };
const engine = new RuleEngineService(rules);

/* ---------------- 距离与系数 ---------------- */

test("haversineKm：与 common/geo 同一公式（同一结果）", () => {
  const a = engine.haversineKm(30.2741, 120.1551, 31.2304, 121.4737);
  const b = haversineKm(30.2741, 120.1551, 31.2304, 121.4737);
  assert.equal(a, b);
  assert.ok(a > 160 && a < 170);
});

test("distanceFactor：距离越近系数越高，超半径掉到下限", () => {
  assert.equal(engine.distanceFactor(0, 10), 1);
  assert.equal(engine.distanceFactor(5, 10), 0.5);
  assert.equal(engine.distanceFactor(9.99, 10), 0.05, "低于下限时取下限，不出现 0");
  assert.equal(engine.distanceFactor(10, 10), 0.05, "恰好等于最大半径视为超出");
  assert.equal(engine.distanceFactor(120, 10), 0.05);
});

test("distanceFactor：距离缺失按下限处理；下限可覆盖", () => {
  assert.equal(engine.distanceFactor(null, 10), 0.05);
  assert.equal(engine.distanceFactor(undefined, 10, 0.2), 0.2);
  assert.equal(engine.distanceFactor(5, 10, 0.4), 0.5, "正常值不受下限影响");
});

test("dispatchPriority：距离系数 × 等级权重 × 响应系数", async () => {
  assert.equal(await engine.dispatchPriority({ distanceKm: 5, levelWeight: 2, responseFactor: 1 }), 1);
  assert.equal(await engine.dispatchPriority({ distanceKm: 5, levelWeight: 2, responseFactor: 1.5 }), 1.5);
  assert.equal(await engine.dispatchPriority({ distanceKm: 0, levelWeight: 3, responseFactor: 1 }), 3);
});

test("dispatchPriority：响应系数缺省按 1；加急单放大倍数", async () => {
  assert.equal(await engine.dispatchPriority({ distanceKm: 5, levelWeight: 2, responseFactor: 0 }), 1, "0 视为未传");
  assert.equal(await engine.dispatchPriority({ distanceKm: 5, levelWeight: 2, responseFactor: 1, urgent: true }), 1.2);
  assert.equal(await engine.dispatchPriority({ distanceKm: 100, levelWeight: 3, responseFactor: 1 }), 0.15, "超半径仍可派单，但系数最低");
});

/* ---------------- 等级映射 ---------------- */

test("levelByScore：区间命中", async () => {
  assert.equal((await engine.levelByScore(0)).level, 1);
  assert.equal((await engine.levelByScore(59)).level, 1);
  assert.equal((await engine.levelByScore(60)).level, 2);
  assert.equal((await engine.levelByScore(79.9)).level, 3, "79.9 已越过 L2 上限（79）→ 回落最高档");
  assert.equal((await engine.levelByScore(100)).level, 3);
});

test("levelByScore：超出最高档回落最高档", async () => {
  assert.equal((await engine.levelByScore(120)).level, 3);
});

test("creditByScore：区间命中与兜底", async () => {
  assert.equal((await engine.creditByScore(0)).level, 0);
  assert.equal((await engine.creditByScore(49)).level, 0);
  assert.equal((await engine.creditByScore(50)).level, 3);
  assert.equal((await engine.creditByScore(120)).level, 0, "超上限回落最低档");
});

/* ---------------- 5.4 分账 ---------------- */

test("calcSplit：无代理无业务员时平台拿走全部服务费", async () => {
  const s = await engine.calcSplit({ amount: 10000, commissionRate: 0.06 });
  assert.deepEqual(s, { serviceFee: 600, teacherIncome: 9400, agentShare: 0, salesCommission: 0, platformRevenue: 600 });
});

test("calcSplit：常规单（代理 30% 服务费 + 业务员 3% 成交额）", async () => {
  // 服务费 600；代理 600×0.3=180；业务员 10000×0.03=300；平台 600-180-300=120
  const s = await engine.calcSplit({ amount: 10000, commissionRate: 0.06, feeShareRate: 0.3, salesRate: 0.03 });
  assert.deepEqual(s, { serviceFee: 600, teacherIncome: 9400, agentShare: 180, salesCommission: 300, platformRevenue: 120 });
});

test("calcSplit：管理费率计入代理分成", async () => {
  // 代理 600×0.2=120 + 10000×0.01=100 → 220；业务员 100 → 平台 600-220-100=280
  const s = await engine.calcSplit({ amount: 10000, commissionRate: 0.06, feeShareRate: 0.2, mgmtRate: 0.01, salesRate: 0.01 });
  assert.equal(s.agentShare, 220);
  assert.equal(s.salesCommission, 100);
  assert.equal(s.platformRevenue, 280);
});

test("calcSplit：分成超额时按「代理→业务员」顺序截断，平台收入不为负", async () => {
  // 代理 180 + 业务员 500 = 680 > 服务费 600 → 业务员被截断到 420，平台 0
  const s = await engine.calcSplit({ amount: 10000, commissionRate: 0.06, feeShareRate: 0.3, salesRate: 0.05 });
  assert.equal(s.agentShare, 180);
  assert.equal(s.salesCommission, 420);
  assert.equal(s.platformRevenue, 0);
  assert.equal(s.agentShare + s.salesCommission + s.platformRevenue, s.serviceFee);
});

test("calcSplit：代理分成吃满服务费时业务员为 0", async () => {
  const s = await engine.calcSplit({ amount: 10000, commissionRate: 0.06, mgmtRate: 1 });
  assert.equal(s.agentShare, 600);
  assert.equal(s.salesCommission, 0);
  assert.equal(s.platformRevenue, 0);
});

test("calcSplit：负费率不产生负分成（截断到 0）", async () => {
  const s = await engine.calcSplit({ amount: 10000, commissionRate: 0.06, feeShareRate: -1, salesRate: -0.05 });
  assert.equal(s.agentShare, 0);
  assert.equal(s.salesCommission, 0);
  assert.equal(s.platformRevenue, 600);
});

test("calcSplit：任意组合都满足两条恒等式且全部为整数分、非负", async () => {
  const amounts = [1, 99, 100, 3600, 10000, 19900, 123457];
  const rates = [0, 0.01, 0.06, 0.1, 0.15, 0.5, 1];
  let checked = 0;
  for (const amount of amounts) {
    for (const commissionRate of rates) {
      for (const feeShareRate of [0, 0.3, 0.8, 1]) {
        for (const salesRate of [0, 0.03, 0.1, 0.5]) {
          const s = await engine.calcSplit({ amount, commissionRate, feeShareRate, salesRate });
          const tag = JSON.stringify({ amount, commissionRate, feeShareRate, salesRate });
          assert.equal(s.serviceFee, Math.round(amount * commissionRate), tag);
          assert.equal(s.teacherIncome + s.serviceFee, amount, "教员实收 + 服务费 = 成交额 " + tag);
          assert.equal(s.agentShare + s.salesCommission + s.platformRevenue, s.serviceFee, "分成守恒 " + tag);
          for (const v of [s.serviceFee, s.teacherIncome, s.agentShare, s.salesCommission, s.platformRevenue]) {
            assert.ok(Number.isInteger(v), "非整数分 " + tag + " → " + v);
            assert.ok(v >= 0, "出现负值 " + tag + " → " + v);
          }
          checked++;
        }
      }
    }
  }
  assert.equal(checked, amounts.length * rates.length * 4 * 4, "组合数应为 784");
});
