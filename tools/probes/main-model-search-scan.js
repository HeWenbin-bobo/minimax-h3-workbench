// 扫描中转全部模型：谁自带联网搜索（发时事问题看是否拒绝 + 是否接受 web_search 工具形态）
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
    const list = await (await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })).json();
    const ids = (list.data || []).map((m) => m.id);
    out.total = ids.length;

    // 时事问题：自带联网的模型会给具体新闻/日期；不带的会自述"无法联网"
    const probeMsgs = [{ role: "user", content: "请说出今天一个真实发生的新闻事件（含具体日期）。如果你没有联网能力，直接回答：无联网。" }];
    const rejects = [];
    for (const id of ids) {
      const entry = { id };
      // 1) 内置 OpenAI 联网工具形态（500 = 明确不支持）
      try {
        const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: id, max_tokens: 10, messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search" }] }) });
        const t = await r.text();
        entry.builtinTool = r.ok ? "accepted" : (t.includes("unsupported type") ? "rejected" : `HTTP ${r.status}`);
      } catch (e) { entry.builtinTool = "network"; }
      // 2) 时事试探（识别自述无联网的模型）
      try {
        const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: id, max_tokens: 60, messages: probeMsgs }) });
        const j = await r.json().catch(() => ({}));
        const text = j.choices?.[0]?.message?.content || "";
        entry.claimsNoNet = /无联网|无法联网|没有.*联网|无法获取实时|没有实时|知识.*截止/.test(text);
        entry.probeSnippet = text.slice(0, 60).replace(/\s+/g, " ");
      } catch (e) { entry.claimsNoNet = "network"; }
      out.models.push(entry);
    }
  } catch (e) { out.fatal = e.message; }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
