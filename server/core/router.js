// 轻量路由：支持 :param 动态段、鉴权、角色白名单、幂等键
import { Err, readJson } from "./http.js";
import { verifyToken, loadUser } from "./auth.js";
import { withIdempotency } from "./idempotency.js";

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const regexSrc = pattern
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        if (seg === "*") {
          keys.push("wildcard");
          return "(.*)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, regex: new RegExp("^" + regexSrc + "/?$"), keys, handler, opts });
    return this;
  }
  get(p, h, o) { return this.add("GET", p, h, o); }
  post(p, h, o) { return this.add("POST", p, h, o); }
  put(p, h, o) { return this.add("PUT", p, h, o); }
  patch(p, h, o) { return this.add("PATCH", p, h, o); }
  del(p, h, o) { return this.add("DELETE", p, h, o); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return null;
  }

  async handle(req, res, url) {
    const hit = this.match(req.method, url.pathname);
    if (!hit) return null;
    const { route, params } = hit;
    const ctx = {
      req,
      res,
      params,
      query: Object.fromEntries(url.searchParams.entries()),
      ip: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim(),
      user: null,
      token: null,
      body: {},
    };

    if (route.opts.auth !== false) {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token) throw Err.unauthorized();
      const payload = verifyToken(token);
      if (!payload) throw Err.unauthorized("登录状态已失效，请重新登录");
      const user = loadUser(payload.uid);
      if (!user) throw Err.unauthorized("账号不存在");
      if (user.status === "disabled") throw Err.forbidden("账号已被禁用，请联系平台客服");
      ctx.user = user;
      ctx.token = payload;
      const roles = route.opts.roles;
      if (roles && !roles.includes(user.role)) throw Err.forbidden();
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      ctx.body = await readJson(req);
    }

    const idemKey = req.headers["x-idem-key"];
    if (route.opts.idem && idemKey) {
      await withIdempotency(idemKey, url.pathname, async () => route.handler(ctx), ctx);
      return true;
    }
    await route.handler(ctx);
    return true;
  }
}