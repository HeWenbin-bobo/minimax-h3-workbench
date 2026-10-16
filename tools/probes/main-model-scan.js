// 扫描中转全部模型：是否支持 tools（智能体前提）；顺带测内置联网工具是否被接受
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = { models: [] };
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    const base = "https://<relay-host>/v1";
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    const ids = (await r.json()).data.map((m) => m.id);
    out.total = ids.length;

    for (const model of ids) {
      const entry = { model };
      // A) 支持 tools 吗？max_tokens 压到 40 控费，强制不触发工具的问法
      try {
        const t0 = Date.now();
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST", headers: H,
          body: JSON.stringify({
            model, max_tokens: 40,
            messages: [{ role: "user", content: "回复：好" }],
            tools: [{ type: "function", function: { name: "noop", description: "什么都不做", parameters: { type: "object", properties: {} } } }]
          })
        });
        const text = await res.text();
        entry.toolsMs = Date.now() - t0;
        if (res.ok) {
          const j = JSON.parse(text);
          const msg = j.choices?.[0]?.message;
          entry.tools = "ok";
          entry.toolCalled = Boolean(msg?.tool_calls?.length);
          entry.reply = (msg?.content || "").slice(0, 30);
        } else {
          entry.tools = `HTTP ${res.status}`;
          entry.err = text.slice(0, 120);
        }
      } catch (e) { entry.tools = "network"; entry.err = e.message.slice(0, 80); }

      // B) 接受内置联网工具吗？（仅对支持 tools 的模型测，省请求）
      if (entry.tools === "ok") {
        try {
          const res2 = await fetch(`${base}/chat/completions`, {
            method: "POST", headers: H,
            body: JSON.stringify({ model, max_tokens: 30, messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search" }] })
          });
          entry.builtinSearch = res2.ok ? "accepted" : `HTTP ${res2.status}`;
        } catch (e) { entry.builtinSearch = "network"; }
      }
      out.models.push(entry);
    }
  } catch (e) { out.fatal = e.message; }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
