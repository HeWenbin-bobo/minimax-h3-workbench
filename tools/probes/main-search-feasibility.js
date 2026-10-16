// 检验"软件自己搜索"的可行路径：免 key 搜索引擎 HTML 结果页能否直接抓取
const { app } = require("electron");
const fs = require("node:fs");
app.whenReady().then(async () => {
  const out = {};
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const probe = async (label, url, opts = {}) => {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,..." }, signal: AbortSignal.timeout(15000), ...opts });
      const t = await r.text();
      out[label] = {
        status: r.status, len: t.length,
        looksBlocked: /captcha|verify you are human|robot|人机验证|安全验证/i.test(t),
        hasResultMarkers: /result__a|b_algo|<h3|result-link|data-sokoban/i.test(t),
        head: t.slice(0, 150).replace(/\s+/g, " ")
      };
    } catch (e) { out[label] = { err: e.message, cause: e.cause && (e.cause.code || e.cause.message) }; }
  };
  await probe("duckduckgo_html", "https://html.duckduckgo.com/html/?q=%E4%BB%8A%E6%97%A5%E7%A7%91%E6%8A%80%E6%96%B0%E9%97%BB");
  await probe("duckduckgo_lite", "https://lite.duckduckgo.com/lite/?q=test");
  await probe("bing", "https://www.bing.com/search?q=%E4%BB%8A%E6%97%A5%E7%A7%91%E6%8A%80%E6%96%B0%E9%97%BB");
  await probe("baidu", "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%A7%91%E6%8A%80%E6%96%B0%E9%97%BB");
  await probe("sogou", "https://www.sogou.com/web?query=test");
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
