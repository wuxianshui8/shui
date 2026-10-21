/** 统一成功响应（与既有前端契约一致） */
export const ok = (data: unknown = null) => ({ code: 0, message: "ok", data });
export const nowIso = () => new Date().toISOString();