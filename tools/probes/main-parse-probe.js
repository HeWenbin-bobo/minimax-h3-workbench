// 验证 Bing/搜狗结果页解析：抽取标题/链接/摘要，判断免 key 抓取是否真的可用
const { app } = require("electron");
const fs = require("node:fs");
app.whenReady().then(async () => {
  const out = {};
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const get = async (url) => {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, html: await r.text() };
  };
  const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#\d+;/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

  // Bing: <li class="b_algo"><h2><a href="URL">TITLE</a></h2>...<p>SNIPPET</p>
  const parseBing = (html) => {
    const items = [];
    const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 6) {
      const rest = m[3];
      const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(rest);
      items.push({ url: m[1], title: strip(m[2]), snippet: snip ? strip(snip[1]).slice(0, 200) : "" });
    }
    return items;
  };
  // 搜狗: <h3 class="vr-title"><a href="/link?url=...">TITLE</a></h3> ... <div class="text-layout">SNIPPET</div>
  const parseSogou = (html) => {
    const items = [];
    const re = /<h3 class="vr-title"[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3 class="vr-title"|<\/body>)/g;
    let m;
    while ((m = re.exec(html)) && items.length < 6) {
      const a = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(m[1]);
      const snip = /<div class="(?:text-layout|fz-mid|space-txt)"[^>]*>([\s\S]*?)<\/div>/.exec(m[2]);
      if (!a) continue;
      items.push({ url: a[1], title: strip(a[2]), snippet: snip ? strip(snip[1]).slice(0, 200) : "" });
    }
    return items;
  };

  try {
    const q = encodeURIComponent("今天的科技新闻");
    const b = await get(`https://www.bing.com/search?q=${q}&setlang=zh-CN`);
    out.bing = { status: b.status, items: parseBing(b.html).length, sample: parseBing(b.html).slice(0, 3) };
  } catch (e) { out.bing = { err: e.message }; }
  try {
    const q = encodeURIComponent("今天的科技新闻");
    const s = await get(`https://www.sogou.com/web?query=${q}`);
    out.sogou = { status: s.status, items: parseSogou(s.html).length, sample: parseSogou(s.html).slice(0, 3) };
  } catch (e) { out.sogou = { err: e.message }; }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
  app.exit(0);
});
