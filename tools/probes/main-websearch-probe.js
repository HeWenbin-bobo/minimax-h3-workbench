// 探测 glm-5.3-flash 是否自带联网搜索：模型元数据 + 三种内置联网参数形态的真实响应
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = {};
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    const base = "https://<relay-host>/v1";
    const model = "glm-5.3-flash";
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    const post = async (url, body) => {
      const t0 = Date.now();
      try {
        const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
        const text = await r.text();
        return { ms: Date.now() - t0, status: r.status, body: text.slice(0, 700) };
      } catch (e) { return { ms: Date.now() - t0, error: e.message, cause: e.cause && (e.cause.code || e.cause.message) }; }
    };

    // 1) 模型元数据（看是否声明能力/端点类型）
    try {
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json();
      out.modelEntry = (j.data || []).find((m) => m.id === model) || null;
      out.modelIdsSample = (j.data || []).slice(0, 6).map((m) => m.id);
    } catch (e) { out.modelsError = e.message; }

    const msgs = [{ role: "user", content: "今天有什么重要的科技新闻？请给出具体日期并列出 3 条。" }];

    out.webSearchOptions = await post(`${base}/chat/completions`, { model, messages: msgs, web_search_options: {} });
    out.openaiWebSearchTool = await post(`${base}/chat/completions`, { model, messages: msgs, tools: [{ type: "web_search" }] });
    out.anthropicServerTool = await post(`${base}/messages`, { model, max_tokens: 400, messages: msgs, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] });
    out.baseline = await post(`${base}/chat/completions`, { model, messages: msgs });
  } catch (e) { out.fatal = e.message; }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
