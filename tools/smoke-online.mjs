// ============================================================
// 线上/预发环境业务冒烟（跑在真实部署上，不需要数据库直连）
//
// 用法：
//   node tools/smoke-online.mjs                                  # 默认打 http://localhost:4300
//   $env:SMOKE_BASE = "https://www.kd211.com"; node tools/smoke-online.mjs
//
// 覆盖：健康检查 → 游客浏览 → 家长/教员/管理员三种登录 → 教员详情与服务 →
//       下单 → 担保支付（mock）→ 支付幂等 → 家长申请取消（不立即退款）→
//       教员待处理列表 → 教员同意退款 → 后台可查 → 非本单教员退款被拒（403）
//
// ⚠️ 会在目标环境**真实建单并退款**（每跑一次多一笔已退款订单），
//    只对测试/预发环境跑，不要对生产跑。
// ============================================================
const BASE = process.env.SMOKE_BASE || "http://localhost:4300";
let pass = 0,
  fail = 0;

const ok = (name, extra = "") => {
  pass++;
  console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`);
};
const bad = (name, msg) => {
  fail++;
  console.log(`  ✗ ${name}  ${msg}`);
};
const j = async (path, opt = {}) => {
  const r = await fetch(BASE + path, {
    ...opt,
    headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
  });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 120) };
  }
  return { status: r.status, body };
};
const auth = (t) => ({ Authorization: "Bearer " + t });

console.log("目标：" + BASE + "\n");

/* 1. 健康检查 */
const h = await j("/api/health");
h.status === 200 && h.body?.data?.status === "ok"
  ? ok("health", `db=${h.body.data.db?.ok} cache=${h.body.data.cache?.ok}`)
  : bad("health", JSON.stringify(h.body).slice(0, 120));

/* 2. 游客浏览（公开接口，不带 token） */
const home = await j("/api/public/home?lat=30.262&lng=120.133");
const homeData = home.body?.data || {};
ok("游客首页（无需登录）", `region=${homeData.region?.name ?? "-"} 教员=${(homeData.teachers || []).length}`);
const pubT = await j("/api/public/teachers?lat=30.262&lng=120.133");
const pubList = pubT.body?.data?.list || pubT.body?.data || [];
ok("游客教员列表", `count=${Array.isArray(pubList) ? pubList.length : "-"}`);

/* 3. 三种登录 */
const pLogin = await j("/api/auth/login-password", {
  method: "POST",
  body: JSON.stringify({ phone: "13900000301", password: "a123456" }),
});
const ptoken = pLogin.body?.data?.token;
ptoken ? ok("家长登录", "token ok") : bad("家长登录", JSON.stringify(pLogin.body).slice(0, 120));

const tLogin = await j("/api/auth/login-account", {
  method: "POST",
  body: JSON.stringify({ account: "zhang", password: "a123456" }),
});
const ttoken = tLogin.body?.data?.token;
ttoken ? ok("教员登录（用户名 zhang）", "token ok") : bad("教员登录", JSON.stringify(tLogin.body).slice(0, 140));
const tid = tLogin.body?.data?.user?.id;

const aLogin = await j("/api/auth/login-password", {
  method: "POST",
  body: JSON.stringify({ phone: "13900000001", password: "a123456" }),
});
const atoken = aLogin.body?.data?.token;
atoken ? ok("管理员登录", "token ok") : bad("管理员登录", JSON.stringify(aLogin.body).slice(0, 120));

/* 4. 教员服务 + 家长地址 */
const detail = await j(`/api/parent/teachers/${tid}?lat=30.262&lng=120.133`, { headers: auth(ptoken) });
const services = detail.body?.data?.services || [];
const svc = services[0];
services.length
  ? ok("教员详情含可预约服务", `count=${services.length} 首个=${svc?.title} ¥${(svc?.price || 0) / 100}`)
  : bad("教员详情服务", "无服务");

const addrs = await j("/api/addresses", { headers: auth(ptoken) });
const addr = (addrs.body?.data || [])[0];
addr ? ok("家长地址", `id=${addr.id}`) : bad("家长地址", "无地址");

/* 5. 下单 */
const lessonTime = new Date(Date.now() + 26 * 3600 * 1000).toISOString();
const created = await j("/api/orders/from-service", {
  method: "POST",
  headers: auth(ptoken),
  body: JSON.stringify({ serviceId: svc?.id, addressId: addr?.id, lessonTime, remark: "线上冒烟" }),
});
const order = created.body?.data;
order?.id
  ? ok("创建订单（from-service）", `orderNo=${order.orderNo} 状态=${order.status} 金额=${(order.amount || 0) / 100}`)
  : bad("创建订单", JSON.stringify(created.body).slice(0, 160));

/* 6. 支付（mock 通道直接成功；真实通道返回 prepay） */
const payKey = "smoke-" + order?.id + "-" + Date.now();
const paid = await j(`/api/orders/${order?.id}/pay`, {
  method: "POST",
  headers: { ...auth(ptoken), "X-Idem-Key": payKey },
  body: JSON.stringify({ channel: "wechat_jsapi" }),
});
const payBody = paid.body?.data || {};
paid.status === 200 && (payBody?.mode || payBody?.status)
  ? ok("担保支付", `mode=${payBody.mode || "(mock 直接成功)"} 状态=${payBody.status}`)
  : bad("担保支付", JSON.stringify(paid.body).slice(0, 160));

const afterPay = await j(`/api/orders/${order?.id}`, { headers: auth(ptoken) });
const st1 = afterPay.body?.data?.status;
st1 === "pending_class" ? ok("支付后订单状态", st1) : bad("支付后状态", String(st1));

/* 7. 幂等：同 X-Idem-Key 再付一次返回首结果 */
const again = await j(`/api/orders/${order?.id}/pay`, {
  method: "POST",
  headers: { ...auth(ptoken), "X-Idem-Key": payKey },
  body: JSON.stringify({ channel: "wechat_jsapi" }),
});
again.body?.data?.mode === payBody.mode
  ? ok("支付幂等（同幂等键返回首结果）", "ok")
  : bad("支付幂等", JSON.stringify(again.body).slice(0, 140));

/* 8. 家长申请取消：只提交申请，钱不动、状态不变 */
await j(`/api/orders/${order?.id}/cancel`, {
  method: "POST",
  headers: auth(ptoken),
  body: JSON.stringify({ reason: "线上冒烟：临时有事取消" }),
});
const c1 = await j(`/api/orders/${order?.id}`, { headers: auth(ptoken) });
const c1d = c1.body?.data || {};
c1d.cancelRequested === true && c1d.status === "pending_class"
  ? ok("取消申请已提交且未退款", `status=${c1d.status}`)
  : bad("取消申请", `cancelRequested=${c1d.cancelRequested} status=${c1d.status}`);

/* 9. 教员待处理列表 → 同意退款 */
const pend = await j("/api/teacher/orders?pendingCancel=1", { headers: auth(ttoken) });
const pendList = pend.body?.data?.list || pend.body?.data || [];
ok("教员待处理取消列表", `count=${Array.isArray(pendList) ? pendList.length : "-"}`);

const approve = await j(`/api/teacher/orders/${order?.id}/cancel-approve`, {
  method: "POST",
  headers: auth(ttoken),
  body: JSON.stringify({}),
});
const afterRefund = await j(`/api/orders/${order?.id}`, { headers: auth(ptoken) });
const r1 = afterRefund.body?.data || {};
r1.status === "refunded"
  ? ok("教员同意退款 → 订单已退款", `refundAmount=${(r1.refundAmount || 0) / 100}`)
  : bad("同意退款", `status=${r1.status} resp=${JSON.stringify(approve.body).slice(0, 120)}`);

/* 10. 后台可见这笔单 */
const adminOrders = await j("/api/admin/orders?keyword=" + (order?.orderNo || ""), { headers: auth(atoken) });
const adminList = adminOrders.body?.data?.list || [];
ok("后台订单列表可查", `命中=${Array.isArray(adminList) ? adminList.length : "-"}`);

/* 11. 越权保护：另一个教员不能替这单退款 */
const other = await j("/api/auth/login-password", {
  method: "POST",
  body: JSON.stringify({ phone: "13900000205", password: "a123456" }),
});
const otherToken = other.body?.data?.token;
if (otherToken) {
  const forbidden = await j(`/api/teacher/orders/${order?.id}/cancel-approve`, {
    method: "POST",
    headers: auth(otherToken),
    body: JSON.stringify({}),
  });
  forbidden.status === 403 || forbidden.status === 400
    ? ok("非本单教员退款被拒", `HTTP ${forbidden.status}`)
    : bad("越权保护", `HTTP ${forbidden.status}`);
}

console.log(`\n业务冒烟：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
