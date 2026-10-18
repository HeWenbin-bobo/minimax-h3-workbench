import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBing, parseSogou, searchWeb } from "./webSearch";

afterEach(() => vi.unstubAllGlobals());

// 真实结果页片段的精简版（保留解析依赖的结构与类名）。
const bingHtml = `
<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://news.cctv.com/tech/">科技新闻_央视网&ensp;(cctv.com)</a></h2><div><p>央视网科技频道以全球视角呈现最新科技资讯。</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/a">今日十大科技新闻</a></h2><p>6月27日，某公司正式推出预览版。</p></li>
</ol></body></html>`;

const sogouHtml = `
<html><body>
<h3 class="vr-title"><a href="/link?url=abc123">科技时事要闻</a></h3>
<h3 class="vr-title"><a href="https://www.kj.cn/x">快科技</a></h3>
</body></html>`;

describe("parseBing", () => {
  it("抽出标题/链接/摘要，并解掉 &ensp; 与内嵌标签", () => {
    const items = parseBing(bingHtml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      url: "https://news.cctv.com/tech/",
      title: "科技新闻_央视网 (cctv.com)",
      snippet: "央视网科技频道以全球视角呈现最新科技资讯。"
    });
    expect(items[1].url).toBe("https://example.com/a");
  });

  it("结构不符时返回空数组（不抛错，交给上层换源）", () => {
    expect(parseBing("<html><body>没有结果</body></html>")).toEqual([]);
  });
});

describe("parseSogou", () => {
  it("抽出标题并补全相对链接；摘要缺失时留空", () => {
    const items = parseSogou(sogouHtml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ url: "https://www.sogou.com/link?url=abc123", title: "科技时事要闻", snippet: "" });
    expect(items[1].url).toBe("https://www.kj.cn/x");
  });

  // 协议相对链接（//host/path）真实存在。旧实现按"以 / 开头"拼域名，
  // 会得到 https://www.sogou.com//host/path —— 不存在的路径，用户点开 404。
  it("协议相对链接补 https:，而不是拼到搜狗域名后面", () => {
    const items = parseSogou(`<h3 class="vr-title"><a href="//example.com/a?b=1">标题</a></h3>`);
    expect(items[0].url).toBe("https://example.com/a?b=1");
  });
});

describe("searchWeb", () => {
  it("配置了搜索 API 时优先用它，不碰免 key 抓取", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toBe("https://search.test/search");
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://x", snippet: "S" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await searchWeb("查询", { apiBaseUrl: "https://search.test", apiKey: "k" });
    expect(text).toContain("[1] T");
    expect(text).toContain("https://x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 未配置搜索 API 时回落到免 key 直抓：这是本次新增链路。
  it("未配置搜索 API 时回落抓取 Bing 并返回可读结果", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("bing.com")) return new Response(bingHtml, { status: 200 });
      throw new Error(`不该请求：${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await searchWeb("今日科技新闻", {});
    expect(text).toContain("[1] 科技新闻_央视网 (cctv.com)");
    expect(text).toContain("https://news.cctv.com/tech/");
    expect(fetchMock).toHaveBeenCalledTimes(1); // Bing 有结果就不再打搜狗
  });

  it("Bing 无结果时自动换搜狗", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url.includes("sogou.com") ? "sogou" : "bing");
      return new Response(url.includes("sogou.com") ? sogouHtml : "<html>空</html>", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await searchWeb("查询", {});
    expect(seen).toEqual(["bing", "sogou"]);
    expect(text).toContain("科技时事要闻");
  });

  // 根因回归：实测纯 fetch 拿到的 Bing 页面常是"降级 SERP"——查 iPhone 价格却返回 Apple 官网/百科
  // 这类泛化结果（0/6 相关），而浏览器渲染稳定拿到正确结果（京东商品页，6/6 相关）。
  // 旧顺序把 HTTP 放前面且"非空即成功"，导致准确的渲染结果永远轮不到执行 → 智能体"查不到价格"。
  it("注入 renderHtml 时，浏览器渲染优先于 HTTP 抓取", async () => {
    const fetchMock = vi.fn(async () => new Response(bingHtml, { status: 200 })); // HTTP 也能返回结果
    vi.stubGlobal("fetch", fetchMock);
    const renderCalls: string[] = [];
    const text = await searchWeb("京东 iPhone 价格", {
      renderHtml: async (url: string) => { renderCalls.push(url); return bingHtml; }
    });
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]).toContain("bing.com");
    expect(fetchMock).not.toHaveBeenCalled(); // 渲染成功就不该再退回 HTTP
    expect(text).toContain("科技新闻_央视网 (cctv.com)");
  });

  it("浏览器渲染全部失败时才退回 HTTP 抓取", async () => {
    const fetchMock = vi.fn(async () => new Response(sogouHtml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const text = await searchWeb("查询", {
      renderHtml: async () => { throw new Error("渲染不可用"); }
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(text).toContain("科技时事要闻");
  });

  // 「浏览器搜索」可选联网项：只允许 Chromium 渲染，明确跳过 API 与 HTTP 直抓。
  it("browserOnly 时跳过已配置的搜索 API，只用浏览器渲染", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("browserOnly 不该走 HTTP/API"); });
    vi.stubGlobal("fetch", fetchMock);
    const renderUrls: string[] = [];
    const text = await searchWeb("查询", {
      apiBaseUrl: "https://search.test",
      apiKey: "k",
      renderHtml: async (url: string) => { renderUrls.push(url); return bingHtml; },
      browserOnly: true
    });
    expect(renderUrls).toHaveLength(1);
    expect(renderUrls[0]).toContain("bing.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain("科技新闻_央视网 (cctv.com)");
  });

  it("browserOnly 且渲染失败时报错，不给降级 HTTP 结果", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bingHtml, { status: 200 })));
    await expect(searchWeb("查询", { renderHtml: async () => { throw new Error("渲染挂了"); }, browserOnly: true }))
      .rejects.toThrow(/浏览器搜索未取到结果/);
  });

  it("全部来源失败时抛中文错误并指引配置搜索 API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 403 })));
    await expect(searchWeb("查询", {})).rejects.toThrow(/免 key 搜索未取到结果[\s\S]*配置搜索 API/);
  });
});

// 回归：Bing 实际输出常用**复合 class**（b_algo b_algoBorder）或单引号。
// 死认 `class="b_algo"` 会一条都解析不出来（实测 probe-bing-class：两种都 0 条）。
describe("parseBing class 匹配稳健性", () => {
  const wrap = (li: string) => `<ol>${li}</ol>`;
  const mk = (liOpen: string, hrefQuote = '"') =>
    wrap(`<li ${liOpen}><h2><a href=${hrefQuote}https://x.com${hrefQuote}>标题</a></h2><p>摘要</p></li>`);

  it("精确 class", () => {
    expect(parseBing(mk('class="b_algo"'))).toHaveLength(1);
  });
  it("复合 class（b_algo b_algoBorder）", () => {
    expect(parseBing(mk('class="b_algo b_algoBorder"'))).toHaveLength(1);
  });
  it("class 前带其它属性", () => {
    expect(parseBing(mk('data-idx="1" class="b_algo"'))).toHaveLength(1);
  });
  it("单引号 class 与 href", () => {
    expect(parseBing(mk("class='b_algo'", "'"))).toHaveLength(1);
  });
  it("b_algoExtra 这类近似名不误匹配", () => {
    expect(parseBing(mk('class="b_algoxy"'))).toHaveLength(0);
  });

  // Bing 的结果标题常带属性（`<h2 class="b_title">`）。死认裸 `<h2>` 会一条都解析不出，
  // 而失败是**静默**的：上层只看到"未返回结果"，接着换搜狗或直接报"未取到结果"。
  // 结果页 HTML 来自网络（可能被劫持/注入）。两个 block 正则都用惰性跨距，
  // 没有上限时是 O(n²)：2 万个不闭合的起始标记会把主进程卡住近一秒
  // （实测 probe-regex-dos：parseBing 930ms / parseSogou 702ms，正常 700KB 结果页 1ms）。
  it("大量不闭合起始标记时快速返回（不退化成正则回溯）", () => {
    const started = Date.now();
    const bing = parseBing(`<li class="b_algo">`.repeat(20_000) + "x".repeat(200_000));
    const sogou = parseSogou(`<h3 class="vr-title">`.repeat(20_000) + "x".repeat(200_000));
    expect(bing).toHaveLength(0);
    expect(sogou).toHaveLength(0);
    // 上限放宽到 1 秒只是防"退化"；正常实现应在几十毫秒内返回。
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // 上限不能误杀真实结果：Bing 的条目里常内联若干 `<link rel=stylesheet>`，
  // 但正文（标题+摘要）只有几百字符。3000 字符的块必须照常解析；
  // 超过 4000 的视为"不是一条结果"跳过（那是注入/陷阱页的特征）。
  it("块内 3000 字符仍正常解析，超长块被跳过", () => {
    const pad = "填充".repeat(1500); // 3000 字符
    const ok = `<ol><li class="b_algo"><h2><a href="https://x.com">标题</a></h2><p>${pad}</p></li></ol>`;
    expect(parseBing(ok)).toHaveLength(1);

    const tooLong = `<ol><li class="b_algo"><h2><a href="https://x.com">标题</a></h2><p>${pad}${pad}</p></li></ol>`;
    expect(parseBing(tooLong)).toHaveLength(0);
  });

  it("h2 带属性时仍能解析", () => {
    const html = `<ol><li class="b_algo"><h2 class="b_title"><a href="https://x.com">标题</a></h2><p>摘要</p></li></ol>`;
    const items = parseBing(html);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://x.com");
    expect(items[0].title).toBe("标题");
  });
});

// 第三方搜索 API 的兼容实现质量参差：results 不是数组时会抛英文 TypeError，
// 而且整条链路直接失败（本可当作"无结果"继续）。
describe("searchWeb API 响应形状容错", () => {
  it("results 是对象/字符串/null 时按无结果处理，不抛错", async () => {
    for (const bad of [{}, "oops", null, 42]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: bad }), { status: 200 })));
      const text = await searchWeb("查询", { apiBaseUrl: "https://search.test", apiKey: "k" });
      expect(text, JSON.stringify(bad)).toBe("");
    }
  });

  it("数组里的非对象元素被跳过，其余正常返回", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ results: [null, "x", { title: "T", url: "https://x", snippet: "S" }] }),
      { status: 200 }
    )));
    const text = await searchWeb("查询", { apiBaseUrl: "https://search.test", apiKey: "k" });
    expect(text).toContain("[1] T");
  });

  it("非字符串字段不会渲染成 [object Object]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ results: [{ title: { a: 1 }, url: 42, snippet: ["x"] }] }),
      { status: 200 }
    )));
    const text = await searchWeb("查询", { apiBaseUrl: "https://search.test", apiKey: "k" });
    expect(text).not.toContain("[object Object]");
  });
});
