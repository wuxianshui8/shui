// 移动端登录态 + 「动作前登录」公共逻辑（P55）
//
// 产品口径：家长端首页 / 发布需求页对游客开放（未登录也能看到表单），
// 只有点「发布需求 / 立即预约 / 订单 / 消息」这类需要身份的动作时才跳登录页；
// 登录页支持 ?next= 回跳，配合 saveDraft/takeDraft 让「填写 → 登录 → 自动继续发布」不断链。

export const HOME = {
  parent: "/pages/parent/index",
  teacher: "/pages/teacher/index",
  sales: "/pages/sales/index",
  agent: "/pages/agent/index",
};

const DRAFT_KEY = "pendingDemand";

export function token() {
  return uni.getStorageSync("token") || "";
}

export function isLogin() {
  return !!token();
}

export function currentUser() {
  return uni.getStorageSync("user") || {};
}

export function saveSession(data) {
  uni.setStorageSync("token", data.token);
  uni.setStorageSync("user", data.user || {});
}

export function clearSession() {
  uni.removeStorageSync("token");
  uni.removeStorageSync("user");
  uni.removeStorageSync(DRAFT_KEY);
}

/** 跳登录页；next 为登录成功后要回来的页面（不带则按角色首页跳） */
export function goLogin(next) {
  const url = "/pages/login/index" + (next ? "?next=" + encodeURIComponent(next) : "");
  uni.navigateTo({ url });
}

/**
 * 统一请求：code=0 时 resolve(data)，否则 reject(Error{status})。
 * 不在这里自动跳登录——什么时候弹登录由业务动作决定（游客浏览不该被打断）。
 */
export function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const header = { "Content-Type": "application/json" };
    if (token()) header.Authorization = "Bearer " + token();
    uni.request({
      url: "/api" + path,
      method,
      data: body || {},
      header,
      success: (res) => {
        const payload = res.data || {};
        if (res.statusCode === 200 && payload.code === 0) resolve(payload.data);
        else reject(Object.assign(new Error(payload.message || "请求失败 " + res.statusCode), { status: res.statusCode }));
      },
      fail: (e) => reject(new Error((e && e.errMsg) || "网络异常")),
    });
  });
}

/** 游客填好的需求先落盘：登录回来后由发布页自动继续提交 */
export function saveDraft(body) {
  uni.setStorageSync(DRAFT_KEY, body);
}

export function takeDraft() {
  const d = uni.getStorageSync(DRAFT_KEY);
  if (d) uni.removeStorageSync(DRAFT_KEY);
  return d || null;
}
