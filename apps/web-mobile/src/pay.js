// 支付唤起（P69）：把「下单返回什么」和「怎么唤起」收在一处，两个支付入口共用。
//
// 后端有两种返回：
//  1) mock 通道（PAY_PROVIDER=mock，当前线上）：POST /orders/:id/pay 直接完成支付，
//     返回**订单视图**（没有 mode 字段）→ 前端不需要唤起，直接刷新订单即可。
//  2) 真实通道（微信支付 v3）：返回 `{mode:"prepay", orderId, amount, prepayId, params}`，
//     params = {appId,timeStamp,nonceStr,package,signType,paySign} →
//     小程序用 `uni.requestPayment`、微信内 H5 用 `WeixinJSBridge.getBrandWCPayRequest` 唤起收银台，
//     支付结果由渠道**异步回调**确认，所以唤起成功后还要轮询订单状态。
//
// 注意：真实通道的「微信外 H5 支付（MWEB/h5_url）」后端尚未实现（需要在商户平台单独开通），
// 这里不假装支持——非微信环境直接给出明确提示，而不是让用户点了个没反应的按钮。

import { request, token as authToken } from "./auth.js";

/** 幂等键：同一订单重复点击不会重复扣款（后端 payments.idem_key 唯一索引兜底） */
export function idemKey(orderId) {
  return "m-pay-" + orderId + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

/** 发起支付：返回 {mode:"paid", order} 或 {mode:"prepay", params} */
export async function payOrder(orderId) {
  const r = await request("POST", "/orders/" + orderId + "/pay", {}, { "X-Idem-Key": idemKey(orderId) });
  if (r && r.mode === "prepay") {
    return { mode: "prepay", orderId: Number(r.orderId || orderId), amount: r.amount, params: r.params || {} };
  }
  // mock 通道：后端已直接入账，返回的就是订单视图
  return { mode: "paid", order: r };
}

/** 是否在微信内置浏览器里（H5 支付必须在微信内） */
export function inWechat() {
  if (typeof navigator === "undefined" || !navigator.userAgent) return false;
  return /MicroMessenger/i.test(navigator.userAgent);
}

/**
 * 唤起收银台：
 *  - 小程序：uni.requestPayment（provider=wxpay）
 *  - 微信内 H5：WeixinJSBridge.invoke('getBrandWCPayRequest')
 *  - 其它环境：抛 PAY_NEEDS_WECHAT（后端也没有 MWEB 通道，不糊弄用户）
 * resolve = 用户已完成支付动作（最终以服务端回调为准）；reject = 取消 / 失败 / 环境不支持
 */
export function invokePay(params) {
  return new Promise((resolve, reject) => {
    const p = params || {};
    // #ifdef MP-WEIXIN
    uni.requestPayment({
      provider: "wxpay",
      timeStamp: String(p.timeStamp || ""),
      nonceStr: p.nonceStr,
      package: p.package,
      signType: p.signType || "RSA",
      paySign: p.paySign,
      success: () => resolve({ channel: "miniprogram" }),
      fail: (e) => {
        const msg = String((e && e.errMsg) || "");
        if (/cancel/i.test(msg)) reject(Object.assign(new Error("已取消支付"), { code: "PAY_CANCELLED" }));
        else reject(Object.assign(new Error("支付失败：" + (msg || "未知原因")), { code: "PAY_FAILED" }));
      },
    });
    return;
    // #endif

    // #ifdef H5
    if (!inWechat()) {
      return reject(Object.assign(new Error("请在微信中打开后再支付"), { code: "PAY_NEEDS_WECHAT" }));
    }
    const bridge = typeof window !== "undefined" ? window.WeixinJSBridge : null;
    const run = () => {
      window.WeixinJSBridge.invoke(
        "getBrandWCPayRequest",
        {
          appId: p.appId,
          timeStamp: String(p.timeStamp || ""),
          nonceStr: p.nonceStr,
          package: p.package,
          signType: p.signType || "RSA",
          paySign: p.paySign,
        },
        (res) => {
          const msg = String((res && res.err_msg) || "");
          if (msg.indexOf(":ok") > -1) resolve({ channel: "h5" });
          else if (msg.indexOf(":cancel") > -1) reject(Object.assign(new Error("已取消支付"), { code: "PAY_CANCELLED" }));
          else reject(Object.assign(new Error("支付失败：" + msg), { code: "PAY_FAILED" }));
        },
      );
    };
    if (bridge) run();
    else if (typeof document !== "undefined" && document.addEventListener) {
      // 微信内首次调用时 bridge 可能还没注入，等 WeixinJSBridgeReady
      document.addEventListener("WeixinJSBridgeReady", run, false);
    } else {
      reject(Object.assign(new Error("当前环境不支持微信支付"), { code: "PAY_UNSUPPORTED" }));
    }
    return;
    // #endif

    // 其它平台（App/支付宝小程序等）：本工程只产出 H5 与微信小程序
    reject(Object.assign(new Error("当前环境不支持微信支付"), { code: "PAY_UNSUPPORTED" }));
  });
}

/**
 * 等支付结果落地：渠道回调和「订单转待上课」之间有几秒延迟，
 * 轮询 GET /orders/:id 直到状态离开 awaiting_payment（默认最多 20s）。
 * 超时不算失败——回调和客户端网络都可能慢，交给页面提示「刷新查看」。
 */
export async function waitPaid(orderId, { timeoutMs = 20000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const o = await request("GET", "/orders/" + orderId).catch(() => null);
    if (o && o.status && o.status !== "awaiting_payment") return o;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export { authToken };
