// 假设验证：连接池 keep-alive 连接在中转侧闲置后被关闭，复用时触发 ECONNRESET。
// 做法：同一 fetch(undici) 池连续发请求，中间插入不同时长的空闲，看何时开始 reset。
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = { gaps: [] };
  const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
  const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
  const url = "https://<relay-host>/v1/chat/completions";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const once = async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(40000) });
      await r.text();
      return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
    } catch (e) { return { ok: false, err: e.cause && (e.cause.code || e.cause.message) || e.message, ms: Date.now() - t0 }; }
  };
  // 先热身建立连接，再按不同空闲时长复用
  await once();
  for (const gapMs of [0, 3000, 6000, 10000, 20000, 35000, 60000]) {
    await new Promise((r) => setTimeout(r, gapMs));
    const r = await once();
    out.gaps.push({ gapMs, ...r });
    console.log(`空闲 ${gapMs}ms 后复用 -> ${r.ok ? "OK " + r.ms + "ms" : "FAIL " + r.err}`);
  }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
