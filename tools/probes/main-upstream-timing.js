// 上游时序探针：内容 chunk 到达 vs 响应体真正结束（判断 15s 空档是上游行为还是客户端等待）
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

app.setPath("userData", process.env.REAL_USER_DATA);
const OUT = process.env.PROBE_OUT;
const out = {};

app.whenReady().then(async () => {
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    const base = "https://<relay-host>/v1";

    const t0 = Date.now();
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "只回复两个字：你好" }], stream: true })
    });
    out.tHeaders = Date.now() - t0;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let lastContentAt = null, doneMarkerAt = null, streamEndAt = null, text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { streamEndAt = Date.now() - t0; break; }
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const d = s.slice(5).trim();
        if (d === "[DONE]") { doneMarkerAt = Date.now() - t0; continue; }
        try { const j = JSON.parse(d); const c = j.choices?.[0]?.delta?.content; if (c) { text += c; lastContentAt = Date.now() - t0; } } catch {}
      }
    }
    out.lastContentAt = lastContentAt;
    out.doneMarkerAt = doneMarkerAt;
    out.streamEndAt = streamEndAt;
    out.text = text;
    out.gapContentToEnd = streamEndAt != null && lastContentAt != null ? streamEndAt - lastContentAt : null;

    const t1 = Date.now();
    const toolRes = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "北京现在天气怎么样？用工具查。" }],
        stream: false,
        tools: [{ type: "function", function: { name: "get_weather", description: "查询天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
        tool_choice: "auto"
      })
    });
    out.toolStatus = toolRes.status;
    const tj = await toolRes.json().catch(() => ({}));
    out.toolFinishReason = tj.choices?.[0]?.finish_reason;
    out.toolCalls = JSON.stringify(tj.choices?.[0]?.message?.tool_calls || null).slice(0, 400);
    out.toolMs = Date.now() - t1;
  } catch (e) { out.fatal = e.message; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
