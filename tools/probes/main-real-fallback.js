// 端到端验证：构建产物里的 searchWeb 在"未配置搜索 API"时真能回落抓 Bing
const { app } = require("electron");
const fs = require("node:fs");
app.whenReady().then(async () => {
  const out = {};
  const { searchWeb } = require("F:/MinimaxH3/repo/dist-electron/main/modules/webSearch.js");
  try {
    const t0 = Date.now();
    const text = await searchWeb("今天的科技新闻", {}, AbortSignal.timeout(30000));
    out.ok = true;
    out.ms = Date.now() - t0;
    out.length = text.length;
    out.head = text.slice(0, 400);
    out.resultCount = (text.match(/^\[\d+\]/gm) || []).length;
  } catch (e) { out.ok = false; out.error = e.message; }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
