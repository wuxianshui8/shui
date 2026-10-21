// HTTP 基础层：统一响应封装、错误模型、请求体解析
export class ApiError extends Error {
  constructor(code, message, status = 400, extra = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const Err = {
  bad: (m = "参数错误") => new ApiError("BAD_REQUEST", m, 400),
  unauthorized: (m = "请先登录") => new ApiError("UNAUTHORIZED", m, 401),
  forbidden: (m = "无权访问该资源") => new ApiError("FORBIDDEN", m, 403),
  notFound: (m = "资源不存在") => new ApiError("NOT_FOUND", m, 404),
  conflict: (m = "操作冲突，请刷新后重试") => new ApiError("CONFLICT", m, 409),
  biz: (code, m, extra) => new ApiError(code, m, 400, extra),
};

export function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

export function ok(res, data = null, extra = {}) {
  sendJson(res, 200, { code: 0, message: "ok", data, ...extra });
}

export function fail(res, err) {
  if (res.headersSent || res.writableEnded) {
    console.error("[late-error]", err && err.message);
    return;
  }
  const status = err instanceof ApiError ? err.status : 500;
  const payload = {
    code: err instanceof ApiError ? err.code : "INTERNAL_ERROR",
    message: err instanceof ApiError ? err.message : "服务器内部错误",
    data: err instanceof ApiError ? err.extra : null,
  };
  if (!(err instanceof ApiError)) console.error("[500]", err);
  sendJson(res, status, payload);
}

export function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Err.bad("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Err.bad("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}