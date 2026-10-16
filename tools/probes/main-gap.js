// 对比不同长度回答的「内容结束 → finish_reason」空档，判断是否为固定中转开销
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = [];
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    for (const prompt of ["只回复两个字：你好", "用一句话介绍北京。", "写一段约 300 字的产品介绍，主题是智能音箱。"]) {
      const t0 = Date.now();
      const res = await fetch("https://<relay-host>/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: prompt }], stream: true })
      });
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let lastContent = null, finishAt = null, endAt = null, text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { endAt = Date.now() - t0; break; }
        for (const line of dec.decode(value, { stream: true }).split("\n")) {
          const s = line.trim(); if (!s.startsWith("data:")) continue;
          const d = s.slice(5).trim(); if (d === "[DONE]") continue;
          try { const j = JSON.parse(d);
            const c = j.choices?.[0]?.delta?.content; if (c) { text += c; lastContent = Date.now() - t0; }
            if (j.choices?.[0]?.finish_reason) finishAt = Date.now() - t0;
          } catch {}
        }
      }
      out.push({ prompt: prompt.slice(0, 14), chars: text.length, firstByteToLastContent: lastContent, finishAt, endAt, gap: finishAt && lastContent ? finishAt - lastContent : null });
    }
  } catch (e) { out.push({ fatal: e.message }); }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
