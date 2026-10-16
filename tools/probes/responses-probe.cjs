// 一次性探针：MiniMax / 当前中转 是否支持 OpenAI Responses API（Codex 的唯一 wire_api）。
// 用克隆的 userData + safeStorage 解密真实 Key，Key 只在进程内使用，绝不打印。
// 运行： node_modules/electron/dist/electron.exe _scratch/probes/responses-probe.cjs
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.join(process.env.APPDATA, "minimax-h3-workbench");
const clone = fs.mkdtempSync(path.join(os.tmpdir(), "h3-probe-"));
for (const f of ["secrets.json", "settings.json", "Local State"]) {
  try { fs.copyFileSync(path.join(REAL, f), path.join(clone, f)); } catch {}
}
app.setPath("userData", clone);

/** 只报告结构，不报告内容——防止 Key / 上游回显泄漏到日志。 */
function shape(body) {
  const s = String(body || "");
  return { len: s.length, head: s.replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>").slice(0, 300) };
}

async function probe(label, url, key, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    });
    const text = await res.text();
    const out = { label, status: res.status, ...shape(text) };
    // 404/405 = 端点不存在（不支持）；200/400/422 = 端点存在（只是参数没传对）
    out.verdict = res.status === 404 || res.status === 405 ? "ENDPOINT ABSENT"
      : res.status === 401 || res.status === 403 ? "AUTH FAILED (endpoint may exist)"
      : res.status < 500 ? "ENDPOINT EXISTS" : "SERVER ERROR";
    console.log(JSON.stringify(out, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ label, status: "network-error", error: String(e.message).slice(0, 200) }, null, 1));
  }
}

app.whenReady().then(async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(clone, "secrets.json"), "utf8"));
  const settings = JSON.parse(fs.readFileSync(path.join(clone, "settings.json"), "utf8"));
  const key = raw.llmApiKey ? safeStorage.decryptString(Buffer.from(raw.llmApiKey, "base64")) : "";
  console.log(JSON.stringify({
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    keyDecrypted: key.length > 0,
    keyLen: key.length,
    relayBaseUrl: settings.llm && settings.llm.baseUrl,
    relayModel: settings.llm && settings.llm.model
  }, null, 1));

  const base = String((settings.llm && settings.llm.baseUrl) || "").replace(/\/$/, "");
  const model = (settings.llm && settings.llm.model) || "glm-5.3";
  // 1) Codex 实际会打的端点：POST {base}/responses
  await probe("relay /responses", base + "/responses", key,
    { model, input: [{ role: "user", content: [{ type: "input_text", text: "say ok" }] }], stream: false });
  // 2) 对照组：确认这把 Key 本身有效
  await probe("relay /chat/completions", base + "/chat/completions", key,
    { model, messages: [{ role: "user", content: "say ok" }], max_tokens: 8 });
  // 3) MiniMax 官方（用户原始疑问）
  await probe("minimax /v1/responses", "https://api.minimaxi.com/v1/responses", key,
    { model: "MiniMax-M3", input: [{ role: "user", content: [{ type: "input_text", text: "say ok" }] }], stream: false });

  app.exit(0);
});
