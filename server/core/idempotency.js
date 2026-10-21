// 幂等控制：支付回调、提现、分账等资金接口必须幂等
import { get, run } from "./db.js";
import { nowIso } from "./ids.js";

export async function withIdempotency(key, scope, fn, ctx) {
  const cached = get("SELECT response FROM idempotency WHERE key = ?", key);
  if (cached) {
    const { status, body } = JSON.parse(cached.response);
    ctx.res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    ctx.res.end(body);
    return;
  }
  // 先占位，防止并发穿透
  run(
    "INSERT OR IGNORE INTO idempotency (key, scope, response, created_at) VALUES (?, ?, ?, ?)",
    key,
    scope,
    "",
    nowIso()
  );
  const res = ctx.res;
  const origWriteHead = res.writeHead.bind(res);
  const origEnd = res.end.bind(res);
  let status = 200;
  let headers = { "Content-Type": "application/json; charset=utf-8" };

  res.writeHead = (s, h) => {
    status = s;
    if (h) headers = h;
    return res;
  };
  res.end = (chunk, ...rest) => {
    const body = typeof chunk === "string" ? chunk : String(chunk ?? "");
    try {
      run("UPDATE idempotency SET response = ? WHERE key = ?", JSON.stringify({ status, body }), key);
    } catch {
      /* ignore */
    }
    origWriteHead(status, headers);
    return origEnd(body, ...rest);
  };
  return fn();
}