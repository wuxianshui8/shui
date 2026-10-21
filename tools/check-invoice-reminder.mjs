// P4 定向校验：发票申请与受理（需求 4.1.6）、上课前提醒（4.1.5）、账号注销（第 8 章）
// 对应 e2e §17/§18 的核心断言；因 e2e 串行执行，§17/§18 需先通过 §9–§16（业务员/代理/规则/风控/后台）
const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
async function api(method, path, { token, body, idem } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (idem) headers["X-Idem-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}
async function login(phone) {
  const r = await api("POST", "/api/auth/login-password", { body: { phone, password: PW } });
  if (r.status !== 200) throw new Error("登录失败 " + phone + " " + r.text);
  return r.body.data.token;
}
async function registerParent(phone) {
  const sc = await api("POST", "/api/auth/send-code", { body: { phone } });
  if (sc.status !== 200) throw new Error("验证码下发失败 " + sc.text);
  const li = await api("POST", "/api/auth/login", { body: { phone, code: sc.body.data.devCode } });
  if (li.status !== 200) throw new Error("验证码登录失败 " + li.text);
  return li.body.data;
}

(async () => {
  console.log("P4 定向校验：发票 / 上课提醒 / 账号注销");
  console.log("目标服务：" + BASE);
  const parentToken = await login("13900000301");
  const teacherToken = await login("13900000201");
  const adminToken = await login("13900000001");

  const address = (await api("GET", "/api/addresses", { token: parentToken })).body.data[0];
  const teacherId = 4;
  const teacherDetail = (await api("GET", "/api/parent/teachers/" + teacherId + "?lat=" + address.lat + "&lng=" + address.lng, { token: parentToken })).body.data;
  const serviceId = teacherDetail.services[0].id;

  /** 下单一笔已支付订单，返回 order */
  async function paidOrder(token, minutesAhead, remark) {
    const lessonTime = new Date(Date.now() + minutesAhead * 60000).toISOString();
    const o = await api("POST", "/api/orders/from-service", { token, body: { serviceId, lessonTime, remark } });
    if (o.status !== 200) throw new Error("下单失败 " + o.text);
    const id = o.body.data.id;
    const p = await api("POST", "/api/orders/" + id + "/pay", { token, idem: "inv-pay-" + id });
    if (p.status !== 200) throw new Error("支付失败 " + p.text);
    return p.body.data;
  }

  const order1 = await paidOrder(parentToken, 24 * 60, "发票校验①");
  const order2 = await paidOrder(parentToken, 25 * 60, "发票校验②");

  /* ---------- 17. 发票 ---------- */
  const w1 = (await api("GET", "/api/wallet", { token: parentToken })).body.data;
  assert(Array.isArray(w1.invoiceable) && Array.isArray(w1.invoices), "钱包返回可开票订单与我的申请（可开票 " + w1.invoiceable.length + " 单）");
  assert(w1.invoiceable.some((o) => o.id === order1.id), "已支付订单进入可开票列表（" + order1.orderNo + "）");

  const inv = await api("POST", "/api/invoices", {
    token: parentToken, body: { orderId: order1.id, titleType: "personal", title: "家长·周女士", email: "zhou@example.com" },
  });
  assert(inv.status === 200 && inv.body.data.status === "pending", "提交开票申请成功（单号 " + inv.body.data?.invoice_no + "，金额 ¥" + (inv.body.data?.amount / 100).toFixed(2) + "）");
  assert(inv.body.data.amount === order1.amount + order1.urgentFee, "开票金额 = 订单实付（含加急费）");
  const invId = inv.body.data.id;

  const dup = await api("POST", "/api/invoices", { token: parentToken, body: { orderId: order1.id, titleType: "personal", title: "重复申请" } });
  assert(dup.status === 400, "同一订单重复申请开票被拒绝（400）");

  const noTax = await api("POST", "/api/invoices", { token: parentToken, body: { orderId: order2.id, titleType: "company", title: "某某教育科技有限公司" } });
  assert(noTax.status === 400, "企业抬头缺纳税人识别号被拒绝（400）");

  // 越权：另一位家长的订单
  const other = await registerParent("13900000777");
  await api("POST", "/api/addresses", { token: other.token, body: { contact: "李先生", phone: "13900000777", address: "杭州市西湖区文三路 100 号", lat: address.lat, lng: address.lng, isDefault: true } });
  const otherOrder = await paidOrder(other.token, 26 * 60, "他人订单");
  const cross = await api("POST", "/api/invoices", { token: parentToken, body: { orderId: otherOrder.id, titleType: "personal", title: "越权测试" } });
  assert(cross.status === 403, "为他人订单申请开票被拒绝（403）");

  const fin = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data;
  assert(fin.summary.invoicePending >= 1 && fin.invoices.some((i) => i.id === invId), "后台财务看到待受理发票 " + fin.summary.invoicePending + " 件");

  const issued = await api("POST", "/api/admin/invoices/" + invId + "/review", {
    token: adminToken, body: { approve: true, invoiceUrl: "https://example.com/fp/demo.pdf" },
  });
  assert(issued.status === 200 && issued.body.data.status === "issued" && !!issued.body.data.invoice_url, "财务受理开票成功并回写电子发票地址");
  const reopen = await api("POST", "/api/admin/invoices/" + invId + "/review", { token: adminToken, body: { approve: true } });
  assert(reopen.status === 400, "已受理的申请不可重复受理（400）");

  const w2 = (await api("GET", "/api/wallet", { token: parentToken })).body.data;
  assert(w2.invoices.some((i) => i.id === invId && i.status === "issued"), "家长端同步显示「已开票」");
  assert(!w2.invoiceable.some((o) => o.id === order1.id), "已开票订单从可开票列表移除");

  const inv2 = await api("POST", "/api/invoices", { token: parentToken, body: { orderId: order2.id, titleType: "personal", title: "周女士" } });
  const noReason = await api("POST", "/api/admin/invoices/" + inv2.body.data.id + "/review", { token: adminToken, body: { approve: false } });
  assert(noReason.status === 400, "驳回缺少原因被拒绝（400）");
  const rejected = await api("POST", "/api/admin/invoices/" + inv2.body.data.id + "/review", {
    token: adminToken, body: { approve: false, rejectReason: "抬头需与实名一致" },
  });
  assert(rejected.status === 200 && rejected.body.data.status === "rejected" && rejected.body.data.reject_reason === "抬头需与实名一致", "财务驳回并回写原因");
  const reapply = await api("POST", "/api/invoices", { token: parentToken, body: { orderId: order2.id, titleType: "personal", title: "周女士（已更正）" } });
  assert(reapply.status === 200, "被驳回后可对同一订单重新申请（部分唯一索引生效）");

  /* ---------- 18. 上课前提醒 ---------- */
  const remindOrder = await paidOrder(parentToken, 55, "上课提醒校验");
  const run1 = await api("POST", "/api/admin/reminders/run", { token: adminToken });
  assert(run1.status === 200 && run1.body.data.reminded >= 1, "开课 55 分钟前触发上课提醒（本次推送 " + run1.body.data?.reminded + " 单）");
  assert(run1.body.data.remindMinutes > 0, "提醒阈值取自规则配置（默认提前 " + run1.body.data?.remindMinutes + " 分钟）");
  const run2 = await api("POST", "/api/admin/reminders/run", { token: adminToken });
  assert(run2.body.data.reminded === 0, "重复触发不重复推送（remind_sent 抢占式置位）");
  assert(!!remindOrder.id, "提醒订单已创建（" + remindOrder.orderNo + "）");

  /* ---------- 18. 账号注销 ---------- */
  const teacherDeact = await api("POST", "/api/auth/deactivate", { token: teacherToken });
  assert(teacherDeact.status === 400 && teacherDeact.body.code === "HAS_ACTIVE_ORDER", "有未完结订单时禁止注销（" + teacherDeact.body?.message + "）");

  const fresh = await registerParent("13900000788");
  const before = await api("GET", "/api/auth/me", { token: fresh.token });
  assert(before.status === 200, "新账号登录成功（uid " + before.body.data.user.id + "）");
  const deact = await api("POST", "/api/auth/deactivate", { token: fresh.token });
  assert(deact.status === 200 && deact.body.data.ok === true, "无未完结订单的账号可自助注销");
  const after = await api("GET", "/api/auth/me", { token: fresh.token });
  assert([401, 403].includes(after.status), "注销后令牌立即失效（" + after.status + "）");

  console.log("\n=================================================");
  console.log("P4 定向校验：通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail) { console.log("失败项：" + failures.join(" / ")); process.exit(1); }
  console.log("全部通过 ✅");
  console.log("=================================================");
})().catch((e) => { console.error("[异常]", e.message); process.exit(1); });
