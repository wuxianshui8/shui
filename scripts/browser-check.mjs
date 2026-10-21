// ============================================================
// 浏览器端验收（需求 7.3 UI/UX、9.3 兼容验收与安全验收）
//   1. 多尺寸屏幕下页面无横向溢出（样式错乱检测）
//   2. 存储型 XSS 载荷在页面中按文本渲染（未被执行）
// 做法：在本机启动 headless Edge/Chrome 加载一个同源探针页，
//       探针用 iframe 逐个尺寸加载真实页面并读回布局数据。
// 用法：先启动服务，再 node scripts/browser-check.mjs
// ============================================================
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://localhost:4173";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(ROOT, "web", "_browser-check.html");
const PROBE_URL = BASE + "/_browser-check.html";

const CANDIDATES = [
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error("未找到 Edge / Chrome，可用 BROWSER_PATH 环境变量指定可执行文件路径");
  process.exit(1);
}

// 注意：载荷不能直接包含 </script>，否则会提前闭合探针自身的脚本标签
const PAYLOAD = '<img src=x onerror="window.__xss=1"><scr' + 'ipt>window.__xss2=1</scr' + 'ipt>';
// 序列化后需把 </ 转成 <\/ ，否则仍会提前闭合探针自身的 <script> 标签
const PAYLOAD_JSON = JSON.stringify(PAYLOAD).split("</").join("<\\/");

const probeHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>probe</title>
<style>body{margin:0;font:12px monospace}iframe{border:0}</style></head><body>
<pre id="out">PENDING</pre>
<script>
window.__errs = [];
window.onerror = function (m, s, l, c) {
  window.__errs.push(m + " @" + l + ":" + c);
  var el = document.getElementById("out");
  if (el) el.textContent = "BOOT_ERROR " + window.__errs.join(" | ");
};
</script>
<script type="module">
const OUT = document.getElementById("out");
OUT.textContent = "BOOT";
const lines = [];
const log = (o) => { lines.push(JSON.stringify(o)); OUT.textContent = lines.join("\\n"); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

function loadFrame(url, width, height) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.style.cssText = "width:" + width + "px;height:" + height + "px";
    f.src = url;
    document.body.appendChild(f);
    let settled = false;
    const done = () => { if (settled) return; settled = true; setTimeout(() => resolve(f), 900); };
    f.onload = done;
    setTimeout(done, 6000);
  });
}

(async () => {
  try {
    const phone = new URLSearchParams(location.search).get("phone") || "13900000301";
    const auth = await api("POST", "/api/auth/login-password", { phone, password: "a123456" });
    if (!auth.data) throw new Error("登录失败");
    localStorage.setItem("jj_token", auth.data.token);
    localStorage.setItem("jj_user", JSON.stringify(auth.data.user));
    const ptoken = auth.data.token;

    // 造一条带 XSS 载荷的需求，供渲染检测
    const dm = await api("POST", "/api/demands", {
      stage: "小学", subject: "数学", address: "西湖区文三路 128 号",
      lat: 30.262, lng: 120.133, budget: 10000, remark: ${PAYLOAD_JSON},
    }, ptoken);
    const demandId = dm.data && dm.data.id;

    const adminAuth = await api("POST", "/api/auth/login-password", { phone: "13900000001", password: "a123456" });
    const atoken = adminAuth.data.token;

    const cases = [];
    for (const p of ["/parent", "/teacher", "/sales", "/agent"]) {
      for (const w of [360, 414, 768]) cases.push({ url: p, width: w, height: 900 });
    }
    for (const w of [1024, 1440]) cases.push({ url: "/admin", width: w, height: 900 });
    if (demandId) cases.push({ url: "/parent#/demand/" + demandId, width: 414, height: 900, xss: true, token: ptoken });
    cases.push({ url: "/admin#/risk", width: 1440, height: 900, xss: true, token: atoken });

    for (const c of cases) {
      if (c.token) {
        localStorage.setItem("jj_token", c.token);
        localStorage.setItem("jj_user", JSON.stringify(c.token === ptoken ? auth.data.user : adminAuth.data.user));
      } else {
        localStorage.setItem("jj_token", ptoken);
        localStorage.setItem("jj_user", JSON.stringify(auth.data.user));
      }
      const f = await loadFrame(c.url, c.width, c.height);
      try {
        const doc = f.contentDocument;
        const de = doc.documentElement;
        const overflow = de.scrollWidth - de.clientWidth;
        const row = { url: c.url, width: c.width, overflow, ok: overflow <= 2 };
        if (c.xss) {
          const flag1 = f.contentWindow.__xss === 1;
          const flag2 = f.contentWindow.__xss2 === 1;
          const imgs = doc.querySelectorAll('img[src="x"]').length;
          const scripts = Array.from(doc.querySelectorAll("script")).filter((s) => (s.textContent || "").includes("__xss2")).length;
          const shownAsText = (doc.body.textContent || "").includes("<img src=x onerror=");
          row.xss = { executed: flag1 || flag2, injectedImg: imgs, injectedScript: scripts, shownAsText };
          row.ok = row.ok && !flag1 && !flag2 && imgs === 0 && scripts === 0;
        }
        log(row);
      } catch (e) {
        log({ url: c.url, width: c.width, overflow: -1, ok: false, error: String(e && e.message) });
      }
      f.remove();
      await wait(120);
    }
    log({ done: true });
  } catch (e) {
    log({ fatal: String((e && e.message) || e) });
  }
})();
</script></body></html>`;

fs.writeFileSync(PROBE, probeHtml, "utf8");

const runner = path.join(ROOT, "data", "_browser-profile");
const args = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-sandbox",
  "--user-data-dir=" + runner,
  "--virtual-time-budget=120000",
  "--dump-dom",
  PROBE_URL + "?phone=" + encodeURIComponent(process.env.CHECK_PHONE || "13900000301"),
];

function run() {
  return new Promise((resolve, reject) => {
    execFile(browser, args, { maxBuffer: 32 * 1024 * 1024, timeout: 180000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(stdout || "");
    });
  });
}

const cleanup = () => {
  if (process.env.KEEP_PROBE === "1") return;
  try { fs.unlinkSync(PROBE); } catch { /* ignore */ }
};

(async () => {
  console.log("浏览器端验收（需求 7.3 / 9.3）");
  console.log("浏览器：" + browser);
  console.log("服务：" + BASE + "\n");

  let dom = "";
  try {
    dom = await run();
  } catch (e) {
    cleanup();
    console.error("浏览器执行失败：" + e.message);
    process.exit(1);
  }
  cleanup();

  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!m) {
    console.error("未取得探针输出");
    process.exit(1);
  }
  const rows = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);

  if (rows.some((r) => r.fatal)) {
    console.error("探针执行异常：" + rows.find((r) => r.fatal).fatal);
    process.exit(1);
  }

  const layout = rows.filter((r) => !r.done && !r.xss);
  const xss = rows.filter((r) => r.xss);
  const pad = (s, n) => String(s).padEnd(n);

  console.log(pad("页面", 26) + pad("视口宽度", 12) + pad("横向溢出(px)", 16) + "结果");
  console.log("-".repeat(66));
  for (const r of layout) {
    console.log(pad(r.url, 26) + pad(r.width + "px", 12) + pad(r.overflow, 16) + (r.ok ? "PASS" : "FAIL"));
  }

  console.log("\nXSS 渲染校验");
  console.log("-".repeat(66));
  for (const r of xss) {
    const x = r.xss;
    console.log(
      pad(r.url, 26) +
      "执行=" + (x.executed ? "是" : "否") +
      " 注入img=" + x.injectedImg +
      " 注入script=" + x.injectedScript +
      " 按文本展示=" + (x.shownAsText ? "是" : "否") +
      " → " + (r.ok ? "PASS" : "FAIL")
    );
  }

  const bad = [...layout, ...xss].filter((r) => !r.ok);
  console.log("\n合计 " + (layout.length + xss.length) + " 项，未通过 " + bad.length + " 项");
  console.log(
    bad.length
      ? "未通过：" + bad.map((b) => b.url + "@" + b.width + "px").join("，")
      : "多尺寸无横向溢出，XSS 载荷全部按文本渲染未被执行 ✅"
  );
  if (bad.length) process.exitCode = 1;
})();
