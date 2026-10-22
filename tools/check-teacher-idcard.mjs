// ============================================================
// 入驻证件上传 + 身份证识别门禁（P46）
//   覆盖：图片上传（只收图片/限大小）→ 落盘可访问 → 识别预览 → 姓名不一致被拒 →
//         修正后通过 → 落库 id_card_verified=1 + 正反面 URL → 审核列表能看到证件图
//   依赖：由 tools/gate-p6.mjs 起好 MySQL / Redis 与演示数据（同一套库）
//   用法：E2E_SCRIPT=tools/check-teacher-idcard.mjs node tools/gate-p6.mjs
// ============================================================
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const ROOT = process.env.GATE_ROOT || "D:/shui";
const APP = path.join(ROOT, "apps", "api-nest");
const PORT = Number(process.env.IDCARD_GATE_PORT || 4392);
const BASE = "http://127.0.0.1:" + PORT;

/** 1×1 PNG（合法图片头，体积 68 字节），避免用假数据骗过 MIME 白名单 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const dataUrl = (buf) => "data:image/png;base64," + buf.toString("base64");

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("  ✓ " + name + (detail ? "  —  " + detail : ""));
  } else {
    fails.push(name + (detail ? "  —  " + detail : ""));
    console.log("  ✗ " + name + (detail ? "  —  " + detail : ""));
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port: p }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.setTimeout(800, () => {
      s.destroy();
      res(false);
    });
  });
async function waitPort(p, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await portOpen(p)) return true;
    await sleep(400);
  }
  return false;
}

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, text };
}

async function login(phone, password = "a123456") {
  const r = await api("POST", "/api/auth/login-password", { body: { phone, password } });
  if (!r.body?.data?.token) throw new Error("登录失败：" + phone + " " + r.text.slice(0, 160));
  return r.body.data.token;
}

const children = [];
function stopAll() {
  for (const p of children) {
    try {
      process.kill(-p.pid);
    } catch {
      try {
        p.kill("SIGKILL");
      } catch {}
    }
  }
}

(async () => {
  try {
    if (await portOpen(PORT)) throw new Error("端口 " + PORT + " 已被占用，先停掉占用进程");
    console.log("== 启动被测服务（OCR_PROVIDER=mock）==");
    const app = spawn(process.execPath, ["dist/main.js"], {
      cwd: APP,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PORT: String(PORT), OCR_PROVIDER: "mock", JOBS_ENABLED: "0" },
    });
    children.push(app);
    if (!(await waitPort(PORT))) throw new Error("服务未在预期时间内就绪");

    const parentToken = await login("13900000301");
    // 用一个「未入驻、非在职」的演示账号，避免撞上种子里的张老师（已 approved）
    const phone = "13900000302";
    let teacherToken;
    try {
      teacherToken = await login(phone);
    } catch {
      // 该手机号不存在时用管理员新建一个家长账号走入驻（家长可提交入驻申请）
      const adminToken = await login("13900000001");
      const created = await api("POST", "/api/admin/users", {
        token: adminToken,
        body: { phone, nickname: "证件门禁测试教员", role: "parent" },
      });
      if (created.status >= 400) throw new Error("准备测试账号失败：" + created.text.slice(0, 160));
      teacherToken = await login(phone);
    }

    /* ---------- 1. 上传接口的安全口径 ---------- */
    const badType = await api("POST", "/api/upload", {
      token: teacherToken,
      body: { filename: "a.txt", dataUrl: "data:text/plain;base64,SGVsbG8=" },
    });
    ok("非图片被拒（只收 PNG/JPG/WEBP）", badType.status >= 400, `${badType.status} ${badType.body?.message || ""}`);

    const badPayload = await api("POST", "/api/upload", { token: teacherToken, body: { filename: "x.png", dataUrl: "notadataurl" } });
    ok("非 dataURL 载荷被拒", badPayload.status >= 400, `${badPayload.status}`);

    const big = Buffer.concat([PNG_1PX, Buffer.alloc(2.2 * 1024 * 1024, 0)]);
    const tooBig = await api("POST", "/api/upload", { token: teacherToken, body: { filename: "big.png", dataUrl: dataUrl(big) } });
    ok("超过 2MB 被拒", tooBig.status >= 400, `${tooBig.status} ${tooBig.body?.code || tooBig.body?.message || ""}`);

    const anon = await api("POST", "/api/upload", { body: { filename: "a.png", dataUrl: dataUrl(PNG_1PX) } });
    ok("未登录不能上传", anon.status === 401 || anon.status === 403, `${anon.status}`);

    /* ---------- 2. 上传成功 + 静态可访问 ---------- */
    // 文件名带「姓名_身份证号」：mock 识别靠它解析（真实通道忽略文件名）
    const front = await api("POST", "/api/upload", { token: teacherToken, body: { filename: "门禁张_330106199001011234.png", dataUrl: dataUrl(PNG_1PX) } });
    const frontUrl = front.body?.data?.url;
    ok("身份证人像面上传成功", front.status === 200 && /^\/uploads\/.+\.png$/.test(String(frontUrl)), String(frontUrl));

    const imgRes = await fetch(BASE + frontUrl);
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());
    ok("图片可通过 /uploads 直接访问且内容一致", imgRes.status === 200 && imgBuf.equals(PNG_1PX), `${imgRes.status} ${imgBuf.length}B ${imgRes.headers.get("content-type")}`);

    const back = await api("POST", "/api/upload", { token: teacherToken, body: { filename: "门禁张_反.png", dataUrl: dataUrl(PNG_1PX) } });
    const backUrl = back.body?.data?.url;
    ok("身份证国徽面上传成功", back.status === 200 && !!backUrl, String(backUrl));

    const traversal = await api("POST", "/api/teacher/ocr-idcard", { token: teacherToken, body: { url: "/uploads/../../package.json" } });
    ok("识别接口拒绝目录穿越路径", traversal.status >= 400, `${traversal.status} ${traversal.body?.message || ""}`);

    /* ---------- 3. 识别预览：姓名/号码比对 ---------- */
    const ocrMismatch = await api("POST", "/api/teacher/ocr-idcard", {
      token: teacherToken,
      body: { url: frontUrl, realName: "李四", idCard: "330106199001011234" },
    });
    ok("识别出姓名与号码（脱敏回显）", ocrMismatch.body?.data?.recognized === true && ocrMismatch.body?.data?.name === "门禁张",
      `${ocrMismatch.body?.data?.name} ${ocrMismatch.body?.data?.idCardMasked}`);
    ok("姓名不一致时给出明确提示", ocrMismatch.body?.data?.match?.ok === false && /姓名/.test(ocrMismatch.body?.data?.message || ""),
      ocrMismatch.body?.data?.message);

    const ocrMatch = await api("POST", "/api/teacher/ocr-idcard", {
      token: teacherToken,
      body: { url: frontUrl, realName: "门禁张", idCard: "330106199001011234" },
    });
    ok("姓名与号码一致时通过", ocrMatch.body?.data?.match?.ok === true, ocrMatch.body?.data?.message);

    /* ---------- 4. 提交入驻：不一致必须被拒 ---------- */
    const applyBody = {
      identityType: "student", realName: "门禁张", idCard: "330106199001011234",
      subjects: "数学", stages: "初中", hourlyPrice: 20000, serviceRadiusKm: 5,
      idCardFrontUrl: frontUrl, idCardBackUrl: backUrl, lat: 30.261, lng: 120.132,
    };
    const wrongName = await api("POST", "/api/teacher/apply", { token: teacherToken, body: { ...applyBody, realName: "王五" } });
    ok("姓名与证件不一致被拒（ID_CARD_MISMATCH）",
      wrongName.status >= 400 && (wrongName.body?.code === "ID_CARD_MISMATCH" || /姓名/.test(wrongName.body?.message || "")),
      `${wrongName.status} ${wrongName.body?.code || ""} ${wrongName.body?.message || ""}`);

    const wrongNo = await api("POST", "/api/teacher/apply", { token: teacherToken, body: { ...applyBody, idCard: "330106199002022345" } });
    ok("身份证号与证件不一致被拒", wrongNo.status >= 400, `${wrongNo.status} ${wrongNo.body?.code || ""}`);

    const unrecognized = await api("POST", "/api/upload", { token: teacherToken, body: { filename: "no-hint.png", dataUrl: dataUrl(PNG_1PX) } });
    const unrec = await api("POST", "/api/teacher/apply", {
      token: teacherToken, body: { ...applyBody, idCardFrontUrl: unrecognized.body.data.url },
    });
    ok("证件识别不出时被拒（不静默放过）", unrec.status >= 400 && unrec.body?.code === "ID_CARD_UNRECOGNIZED",
      `${unrec.status} ${unrec.body?.code || ""}`);

    /* ---------- 5. 正常提交：落库 + verified ---------- */
    const okApply = await api("POST", "/api/teacher/apply", { token: teacherToken, body: applyBody });
    ok("证件信息一致时提交成功", okApply.status === 200 && okApply.body?.data?.idCardVerified === true, `${okApply.status}`);

    const profile = await api("GET", "/api/teacher/profile", { token: teacherToken });
    const pf = profile.body?.data?.profile || {};
    ok("落库：正反面图片地址已保存", pf.idCardFrontUrl === frontUrl && pf.idCardBackUrl === backUrl,
      `${pf.idCardFrontUrl} / ${pf.idCardBackUrl}`);
    ok("落库：识别姓名 = 填写的真实姓名", pf.idCardName === "门禁张", String(pf.idCardName));
    ok("落库：idCardVerified = true", pf.idCardVerified === true, String(pf.idCardVerified));

    /* ---------- 6. 审核端能看到证件图与校验标记 ---------- */
    const adminToken = await login("13900000001");
    const audits = await api("GET", "/api/admin/teachers/pending", { token: adminToken });
    const rows = audits.body?.data?.list || audits.body?.data || [];
    const row = rows.find((x) => x.realName === "门禁张");
    ok("审核列表能看到该申请", !!row, row ? `userId=${row.id}` : JSON.stringify(rows).slice(0, 120));
    ok("审核列表带出证件图与 verified 标记", !!row && row.idCardFrontUrl === frontUrl && row.idCardVerified === true,
      row ? `${row.idCardFrontUrl} verified=${row.idCardVerified}` : "-");

    console.log("\n=================================================");
    console.log("测试结果：通过 " + pass + " 项，失败 " + fails.length + " 项");
    if (fails.length) {
      console.log("失败项：");
      for (const f of fails) console.log("  - " + f);
    } else {
      console.log("全部验收用例通过 ✅");
    }
    console.log("=================================================");
    stopAll();
    process.exit(fails.length ? 1 : 0);
  } catch (err) {
    console.error("门禁执行失败：" + (err?.message || err));
    stopAll();
    process.exit(1);
  }
})();
