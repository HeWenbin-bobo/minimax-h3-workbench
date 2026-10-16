// 探测中转是否自带搜索端点（若有，比浏览器抓取/第三方搜索 API 都干净）
const { app, safeStorage } = require("electron");
const path = require("node:path"); const fs = require("node:fs");
app.setPath("userData", process.env.REAL_USER_DATA);
app.whenReady().then(async () => {
  const out = {};
  const secrets = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "secrets.json"), "utf8"));
  const key = safeStorage.decryptString(Buffer.from(secrets.llmApiKey, "base64"));
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const tryReq = async (label, url, init) => {
    try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); const t = await r.text(); out[label] = { status: r.status, body: t.slice(0, 200) }; }
    catch (e) { out[label] = { err: e.message, cause: e.cause && (e.cause.code || e.cause.message) }; }
  };
  for (const p of ["/v1/search", "/search", "/v1/web_search", "/v1/websearch", "/v1/tools/search"]) {
    await tryReq("POST " + p, "https://<relay-host>" + p, { method: "POST", headers: H, body: JSON.stringify({ query: "test", q: "test", count: 3 }) });
  }
  await tryReq("GET /v1/search?q=", "https://<relay-host>/v1/search?q=test", { headers: H });
  // 顺带看 models 里有没有搜索类模型
  const r = await fetch("https://<relay-host>/v1/models", { headers: H });
  const ids = (await r.json()).data.map((m) => m.id);
  out.searchishModels = ids.filter((id) => /search|sonar|perplex|web/i.test(id));
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
