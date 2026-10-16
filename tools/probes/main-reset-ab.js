// 根因对照实验：智能体(带 tools) vs 普通对话(不带 tools) 的流式连接重置率
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = { withTools: [], withoutTools: [], nonstreamWithTools: [] };
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
    const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
    const base = "https://<relay-host>/v1";
    const model = "glm-5.3-flash";
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    const tools = [{ type: "function", function: { name: "generate_video", description: "为用户生成 AI 视频", parameters: { type: "object", properties: { prompt: { type: "string" }, duration: { type: "number" }, count: { type: "number" } }, required: ["prompt"] } } }];
    const msgs = [{ role: "user", content: "只回复两个字：你好" }];

    const runStream = async (label, useTools) => {
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST", headers: H,
          body: JSON.stringify({ model, messages: msgs, stream: true, max_tokens: 30, ...(useTools ? { tools } : {}) }),
          signal: AbortSignal.timeout(60000)
        });
        if (!r.ok) return { ok: false, status: r.status, ms: Date.now() - t0 };
        const reader = r.body.getReader(); let n = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
        return { ok: true, bytes: n, ms: Date.now() - t0 };
      } catch (e) { return { ok: false, err: e.message, cause: e.cause && (e.cause.code || e.cause.message), ms: Date.now() - t0 }; }
    };
    const runNonstream = async () => {
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model, messages: msgs, max_tokens: 30, tools }) });
        const j = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, hasTool: Boolean(j.choices?.[0]?.message?.tool_calls), ms: Date.now() - t0 };
      } catch (e) { return { ok: false, err: e.message, cause: e.cause && (e.cause.code || e.cause.message), ms: Date.now() - t0 }; }
    };

    for (let i = 0; i < 8; i++) out.withTools.push(await runStream("with", true));
    for (let i = 0; i < 8; i++) out.withoutTools.push(await runStream("without", false));
    for (let i = 0; i < 5; i++) out.nonstreamWithTools.push(await runNonstream());

    const rate = (a) => `${a.filter((x) => !x.ok).length}/${a.length} 失败`;
    out.summary = {
      withTools: rate(out.withTools), withoutTools: rate(out.withoutTools), nonstreamWithTools: rate(out.nonstreamWithTools),
      withToolsErrors: out.withTools.filter((x) => !x.ok).map((x) => x.cause || x.err || x.status),
      withoutToolsErrors: out.withoutTools.filter((x) => !x.ok).map((x) => x.cause || x.err || x.status)
    };
  } catch (e) { out.fatal = e.message; }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
