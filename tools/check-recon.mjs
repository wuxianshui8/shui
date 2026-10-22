// ============================================================
// 渠道对账（A2 最后一步的骨架）
//
//   做什么：把「渠道对账单」与「我方 payments 流水」逐笔比对，输出四类差异并给出退出码：
//     ① missingInOurs  渠道有、我方无 → 漏记（钱到了账没记）
//     ② missingInBill  我方有、渠道无 → 虚假/未到账（账有记录但钱没到）
//     ③ amountMismatch 金额不一致（分）
//     ④ statusMismatch 状态不一致（如渠道已退款、我方仍 success）
//
//   三种用法：
//     node tools/check-recon.mjs --self-test
//         自检：内置一份「已知 4 类差异」的账单与流水，必须全部被抓到（否则退出码 1）。
//         不需要数据库、不需要商户号，可直接进 CI。
//     node tools/check-recon.mjs --bill backups/bill-20261022.csv
//         与库内真实流水对账（复用 db-backup 的 MYSQL_MODE=docker|host 探测）。
//     node tools/check-recon.mjs --download --date 20261022
//         从渠道下载对账单：**未实现**（需要真实商户号 + APIv3 证书），会明确失败而不是静默成功。
//
//   退出码：0 无差异（或自检通过）；1 有差异/用法错误/依赖缺失；2 渠道下载未实现。
// ============================================================
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY = path.join(ROOT, "deploy");
const DOCKER = process.env.DOCKER_BIN || "docker";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

/* ---------------- 对账核心（纯函数，便于自检） ---------------- */

/** 统一成「分」的整数：带小数点视为「元」→ ×100；纯整数视为「分」原样返回 */
export function toCents(v) {
  if (v == null) return NaN;
  const s = String(v).trim().replace(/,/g, "").replace(/[¥￥元\s]/g, "");
  if (!s) return NaN;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return s.includes(".") ? Math.round(n * 100) : Math.round(n);
}

const normStatus = (s) => String(s || "").trim().toUpperCase();
const SAME = (mine, theirs) => normStatus(mine) === normStatus(theirs);

/**
 * 比对两份流水。
 * @param ours  [{type, outTradeNo, tradeNo, amountCents, status}]
 * @param bill  [{type, outTradeNo, tradeNo, amountCents, status}]
 * @returns {{ok:boolean, diffs:{missingInOurs:any[],missingInBill:any[],amountMismatch:any[],statusMismatch:any[]}}}
 */
export function reconcile(ours, bill) {
  const key = (r) => String(r.type || "pay").toLowerCase() + ":" + String(r.outTradeNo || "");
  const om = new Map(ours.map((r) => [key(r), r]));
  const bm = new Map(bill.map((r) => [key(r), r]));

  const missingInOurs = [];
  const missingInBill = [];
  const amountMismatch = [];
  const statusMismatch = [];

  for (const [k, b] of bm) {
    const o = om.get(k);
    if (!o) {
      missingInOurs.push(b);
      continue;
    }
    if (Number(o.amountCents) !== Number(b.amountCents)) {
      amountMismatch.push({ key: k, ours: o.amountCents, bill: b.amountCents });
    }
    if (!SAME(o.status, b.status)) {
      statusMismatch.push({ key: k, ours: o.status, bill: b.status });
    }
  }
  for (const [k, o] of om) if (!bm.has(k)) missingInBill.push(o);

  const ok = !missingInOurs.length && !missingInBill.length && !amountMismatch.length && !statusMismatch.length;
  return { ok, diffs: { missingInOurs, missingInBill, amountMismatch, statusMismatch } };
}

/** 解析渠道账单 CSV（支持中文/英文表头；金额列若为「元」会换算成分） */
export function parseBillCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error("账单为空");
  const head = lines[0].split(",").map((s) => s.trim());
  const find = (...names) => head.findIndex((h) => names.includes(h));
  const iType = find("类型", "type", "交易类型");
  const iOut = find("商户单号", "out_trade_no", "订单号");
  const iTrade = find("渠道单号", "transaction_id", "微信订单号", "refund_id");
  const iAmount = find("金额", "amount", "退款金额", "订单金额");
  const iStatus = find("状态", "status", "交易状态", "退款状态");
  if (iOut < 0 || iAmount < 0) throw new Error("账单缺少「商户单号」或「金额」列");
  return lines.slice(1).map((line, idx) => {
    const c = line.split(",").map((s) => s.trim());
    const type = iType >= 0 && c[iType] ? (/退|refund/i.test(c[iType]) ? "refund" : "pay") : "pay";
    return {
      type,
      outTradeNo: c[iOut],
      tradeNo: iTrade >= 0 ? c[iTrade] : "",
      amountCents: toCents(c[iAmount]),
      status: iStatus >= 0 ? c[iStatus] : "SUCCESS",
      raw: line,
      line: idx + 2,
    };
  });
}

/* ---------------- 我方流水（按 MYSQL_MODE 探测） ---------------- */

function detectMode() {
  if (process.env.MYSQL_MODE) return process.env.MYSQL_MODE;
  const ps = spawnSync(DOCKER, ["compose", "-f", path.join(DEPLOY, "docker-compose.yml"), "ps", "--status", "running", "mysql"], { encoding: "utf8" });
  return ps.status === 0 && /mysql/i.test(ps.stdout || "") ? "docker" : "host";
}

function queryOurs() {
  const sql =
    "SELECT p.`type` AS type, o.`order_no` AS outTradeNo, p.`trade_no` AS tradeNo, p.`amount` AS amountCents, p.`status` AS status " +
    "FROM `payments` p LEFT JOIN `orders` o ON o.`id` = p.`order_id` WHERE p.`status` IN ('success','pending') ORDER BY p.`id`";
  const mode = detectMode();
  let r;
  if (mode === "docker") {
    r = spawnSync(DOCKER, ["compose", "-f", path.join(DEPLOY, "docker-compose.yml"), "exec", "-T", "mysql", "mysql", "-uroot", "-N", "-B", "-e", sql, process.env.MYSQL_DATABASE || "jiajiao"], {
      encoding: "utf8",
    });
  } else {
    const bin = path.join(ROOT, "tools", "mysql-8.4.0-winx64", "bin", "mysql.exe");
    if (!fs.existsSync(bin)) throw new Error("找不到本机 mysql.exe，建议 MYSQL_MODE=docker");
    r = spawnSync(bin, ["-h", "127.0.0.1", "-P", process.env.MYSQL_PORT || "3307", "-uroot", "--skip-password", "-N", "-B", "-e", sql, process.env.MYSQL_DATABASE || "jiajiao"], {
      encoding: "utf8",
    });
  }
  if (r.status !== 0) throw new Error("查询我方流水失败：" + String(r.stderr || "").slice(0, 300));
  return String(r.stdout || "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const [type, outTradeNo, tradeNo, amountCents, status] = l.split("\t");
      return { type, outTradeNo, tradeNo, amountCents: Number(amountCents), status };
    });
}

/* ---------------- 输出 ---------------- */

function report(label, ours, bill, res) {
  console.log("对账：" + label);
  console.log("  · 我方流水 " + ours.length + " 条 / 渠道账单 " + bill.length + " 条");
  const d = res.diffs;
  const total = d.missingInOurs.length + d.missingInBill.length + d.amountMismatch.length + d.statusMismatch.length;
  if (!total) {
    console.log("  ✓ 双方逐笔一致（差异 0）");
    return;
  }
  if (d.missingInOurs.length) {
    console.log("  ✗ 渠道有、我方无（漏记）" + d.missingInOurs.length + " 条：");
    for (const x of d.missingInOurs) console.log("    - " + x.type + " " + x.outTradeNo + " " + x.amountCents + " 分（账单第 " + (x.line || "?") + " 行）");
  }
  if (d.missingInBill.length) {
    console.log("  ✗ 我方有、渠道无（未到账/虚假）" + d.missingInBill.length + " 条：");
    for (const x of d.missingInBill) console.log("    - " + x.type + " " + x.outTradeNo + " " + x.amountCents + " 分");
  }
  if (d.amountMismatch.length) {
    console.log("  ✗ 金额不一致" + d.amountMismatch.length + " 条：");
    for (const x of d.amountMismatch) console.log("    - " + x.key + "：我方 " + x.ours + " 分 / 渠道 " + x.bill + " 分");
  }
  if (d.statusMismatch.length) {
    console.log("  ✗ 状态不一致" + d.statusMismatch.length + " 条：");
    for (const x of d.statusMismatch) console.log("    - " + x.key + "：我方 " + x.ours + " / 渠道 " + x.bill);
  }
  console.log("  合计差异 " + total + " 条");
}

/* ---------------- 自检 ---------------- */

function selfTest() {
  const ours = [
    { type: "pay", outTradeNo: "JJ-A", tradeNo: "T-A", amountCents: 10000, status: "success" },
    { type: "pay", outTradeNo: "JJ-B", tradeNo: "T-B", amountCents: 20000, status: "success" },
    { type: "pay", outTradeNo: "JJ-C", tradeNo: "T-C", amountCents: 30000, status: "success" },
    { type: "refund", outTradeNo: "JJ-D", tradeNo: "R-D", amountCents: 4000, status: "success" },
  ];
  const bill = [
    { type: "pay", outTradeNo: "JJ-A", tradeNo: "T-A", amountCents: 10000, status: "SUCCESS" },
    { type: "pay", outTradeNo: "JJ-B", tradeNo: "T-B", amountCents: 19000, status: "SUCCESS" }, // 金额不一致
    { type: "pay", outTradeNo: "JJ-E", tradeNo: "T-E", amountCents: 50000, status: "SUCCESS" }, // 漏记
    { type: "refund", outTradeNo: "JJ-D", tradeNo: "R-D", amountCents: 4000, status: "REFUND" }, // 状态不一致
  ];
  const res = reconcile(ours, bill);
  report("自检（内置样本）", ours, bill, res);

  const got = {
    missingInOurs: res.diffs.missingInOurs.length,
    missingInBill: res.diffs.missingInBill.length,
    amountMismatch: res.diffs.amountMismatch.length,
    statusMismatch: res.diffs.statusMismatch.length,
  };
  const expect = { missingInOurs: 1, missingInBill: 1, amountMismatch: 1, statusMismatch: 1 };
  const problems = [];
  for (const k of Object.keys(expect)) {
    if (got[k] !== expect[k]) problems.push(k + " 期望 " + expect[k] + " 条，实际 " + got[k] + " 条");
  }
  // 反向：完全一致的样本必须判为无差异（防止「永远报差异」的假实现）
  const same = reconcile(ours, ours.map((r) => ({ ...r, status: r.status.toUpperCase() })));
  if (!same.ok) problems.push("完全一致的两份数据被判为有差异（假阳性）");

  // CSV 解析：元 → 分、中文表头、类型识别
  const csv = "类型,商户单号,渠道单号,金额,状态\n交易,JJ-A,T-A,100.00,SUCCESS\n退款,JJ-D,R-D,40.00,SUCCESS\n";
  const parsed = parseBillCsv(csv);
  if (parsed.length !== 2) problems.push("CSV 解析行数错误：" + parsed.length);
  if (parsed[0].amountCents !== 10000) problems.push("CSV 金额换算错误：" + parsed[0].amountCents);
  if (parsed[1].type !== "refund") problems.push("CSV 类型识别错误：" + parsed[1].type);

  if (problems.length) {
    console.log("\n✗ 对账自检失败：");
    for (const p of problems) console.log("  - " + p);
    process.exit(1);
  }
  console.log("\n✓ 对账自检通过（4 类差异全部命中；一致样本无误报；CSV 金额与类型解析正确）");
  process.exit(0);
}

/* ---------------- 主流程 ---------------- */

if (flag("--download")) {
  const date = opt("--date", "<未指定>");
  console.log("✗ 渠道对账单下载未实现：需要真实商户号 + APIv3 证书（WECHAT_PAY_* 全量配置），当前环境不具备。");
  console.log("  已实现的替代路径：把渠道后台导出的 CSV 放到 backups/ 后执行");
  console.log("    node tools/check-recon.mjs --bill backups/bill-" + date + ".csv");
  process.exit(2);
}

if (flag("--self-test")) {
  selfTest();
}

const billPath = opt("--bill", process.env.RECON_BILL);
if (!billPath) {
  console.log("用法：");
  console.log("  node tools/check-recon.mjs --self-test");
  console.log("  node tools/check-recon.mjs --bill <账单.csv>");
  console.log("  node tools/check-recon.mjs --download --date 20261022   （未实现，会明确失败）");
  process.exit(1);
}
if (!fs.existsSync(billPath)) {
  console.log("✗ 账单文件不存在：" + billPath);
  process.exit(1);
}

let bill;
try {
  bill = parseBillCsv(fs.readFileSync(billPath, "utf8"));
} catch (e) {
  console.log("✗ 账单解析失败：" + e.message);
  process.exit(1);
}
// 防空检查：两边任意一侧为 0 行，说明取数或解析出了问题，不能算「对账通过」
if (!bill.length) {
  console.log("✗ 账单 0 行（空检查比不检查更糟，直接判失败）");
  process.exit(1);
}

let ours;
try {
  ours = queryOurs();
} catch (e) {
  console.log("✗ " + e.message);
  process.exit(1);
}
if (!ours.length) {
  console.log("✗ 我方流水 0 行（数据库连错或库为空，直接判失败）");
  process.exit(1);
}

const res = reconcile(ours, bill);
report(path.relative(ROOT, path.resolve(billPath)), ours, bill, res);
process.exit(res.ok ? 0 : 1);
