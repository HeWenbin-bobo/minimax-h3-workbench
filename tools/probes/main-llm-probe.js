// 独立 Electron 主进程探针：解密 llmKey → 直接打上游 → 结果写文件（密钥绝不落盘/打印）
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// 必须在 whenReady 之前设置，safeStorage 的 DPAPI 密钥存在 userData/Local State 里
app.setPath("userData", process.env.REAL_USER_DATA);

const BASE_URL = process.env.PROBE_BASE_URL;
const MODEL = process.env.PROBE_MODEL;
const PATH_OVERRIDE = process.env.PROBE_PATH;
const OUT = process.env.PROBE_OUT;
const out = {};

app.whenReady().then(async () => {
  const log = async () => fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    out.keyLength = key.length;
    out.keyPrefix = key.slice(0, 3) + "***";

    const chatPath = PATH_OVERRIDE || "/chat/completions";
    const url = BASE_URL.replace(/\/+$/, "") + chatPath;
    out.url = url;

    // 1) 流式对话
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "只回复两个字：你好" }], stream: true })
      });
      out.streamStatus = res.status;
      out.streamCT = res.headers.get("content-type");
      const text = await res.text();
      out.streamBodyHead = text.slice(0, 800);
      out.streamBodyLength = text.length;
    } catch (e) { out.streamError = e.message + " | cause=" + JSON.stringify(e.cause && (e.cause.code || e.cause.message)); }

    // 2) 非流式
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "只回复两个字：你好" }], stream: false })
      });
      out.nonstreamStatus = res.status;
      out.nonstreamBody = (await res.text()).slice(0, 800);
    } catch (e) { out.nonstreamError = e.message + " | cause=" + JSON.stringify(e.cause && (e.cause.code || e.cause.message)); }

    // 3) /models
    try {
      const res = await fetch(BASE_URL.replace(/\/+$/, "") + "/models", { headers: { Authorization: `Bearer ${key}` } });
      out.modelsStatus = res.status;
      const body = await res.text();
      out.modelsCount = (() => { try { return (JSON.parse(body).data || []).length; } catch { return "parse-fail"; } })();
      out.modelsHead = body.slice(0, 300);
    } catch (e) { out.modelsError = e.message + " | cause=" + JSON.stringify(e.cause && (e.cause.code || e.cause.message)); }

    // 4) MiniMax 官方域名端点推断验证（不实际请求，只看解析结果）
    out.resolvedPathForMinimax = /api\.minimax\.io/i.test("https://api.minimax.io/v1") ? "/text/chatcompletion_v2" : "/chat/completions";
    out.resolvedPathForRelay = /api\.minimax\.io/i.test(BASE_URL) ? "/text/chatcompletion_v2" : "/chat/completions";
  } catch (e) {
    out.fatal = e.message;
  }
  await log();
  app.exit(0);
});
