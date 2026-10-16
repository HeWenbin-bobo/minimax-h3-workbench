// 逐块记录上游 SSE 到达时刻：判断 finish_reason / [DONE] / 连接关闭分别在何时到达
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = [];
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    const t0 = Date.now();
    const res = await fetch("https://<relay-host>/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "只回复两个字：你好" }], stream: true })
    });
    out.push({ t: Date.now() - t0, ev: "headers", status: res.status, ct: res.headers.get("content-type") });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { out.push({ t: Date.now() - t0, ev: "BODY_END" }); break; }
      const raw = dec.decode(value, { stream: true });
      n++;
      out.push({ t: Date.now() - t0, ev: `read#${n}`, bytes: value.length, raw: raw.replace(/\s+/g, " ").slice(0, 300) });
    }
  } catch (e) { out.push({ ev: "error", message: e.message }); }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
