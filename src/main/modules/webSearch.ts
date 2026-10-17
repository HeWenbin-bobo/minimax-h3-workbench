import { describeError } from "../../shared/errors";

/**
 * 联网搜索：优先走用户配置的第三方搜索 API；未配置时回落到免 key 直抓公开结果页。
 * 实测（2026-10-12）：Bing 稳定返回可解析结果（标题+链接+摘要）；搜狗只给标题+相对链接（摘要常空），
 * 故按可用性排序、前者有结果就不打扰后者。免 key 直抓依赖对端 HTML 结构，属"尽力而为"：
 * 解析不到就换下一个源，全失败才抛错（错误里提示可去配置搜索 API 换稳定结果）。
 */
export interface WebSearchOptions {
  /** 第三方搜索 API 根地址（兼容博查/Tavily 转接：POST {base}/search 返回 results 数组）。留空则免 key 直抓。 */
  apiBaseUrl?: string;
  apiKey?: string;
  /**
   * 浏览器渲染抓取（依赖注入，由主进程传入复用 Electron 自带 Chromium 的实现）。
   * 纯 HTTP 抓取全部失败时用它做最后回退——不在这里直接 import electron，模块才能被单测覆盖。
   */
  renderHtml?: (url: string) => Promise<string>;
  /**
   * 「浏览器搜索」模式（游乐场的可选联网项）：只允许应用自带 Chromium 渲染抓取，
   * 明确跳过第三方 API 与 HTTP 直抓。实测 HTTP 直抓 Bing 会间歇性返回降级 SERP
   * （查 iPhone 价格却返回无关结果），该模式用真浏览器保证结果质量，代价是稍慢。
   */
  browserOnly?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_RESULTS = 6;
// 带浏览器 UA：部分搜索源对无 UA/爬虫 UA 直接返回反爬页。
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 搜索并返回给模型阅读的参考段落（格式与既有实现一致：[n] 标题\n链接\n摘要）。 */
export async function searchWeb(query: string, options: WebSearchOptions, signal?: AbortSignal): Promise<string> {
  const failures: string[] = [];
  const base = (options.apiBaseUrl || "").replace(/\/+$/, "");
  // 「浏览器搜索」模式：明确只走应用自带 Chromium 渲染，跳过 API 与 HTTP 直抓
  // （语义是用户点名"用浏览器搜"，而不是"随便什么方式搜到就行"）。
  if (!options.browserOnly && base) return formatResults(await searchViaApi(base, options.apiKey, query, signal));
  // 免 key 路径：**浏览器渲染优先**。实测同一查询下，纯 fetch 拿到的 Bing 页面常是降级 SERP
  // （查"iPhone 18 Pro 1TB 京东自营 价格"却返回 Apple 官网/百科等泛化结果，0/6 相关），
  // 而真浏览器渲染稳定拿到正确结果（京东商品页，6/6 相关）。旧实现把 HTTP 放在前面且
  // "非空即成功"，于是准确的渲染结果永远轮不到执行——这正是智能体"查不到价格"的根因。
  if (options.renderHtml) {
    for (const [name, parse, url] of [
      ["Bing", parseBing, bingSearchUrl(query)],
      ["搜狗", parseSogou, sogouSearchUrl(query)]
    ] as const) {
      try {
        const results = parse(await options.renderHtml(url)).slice(0, MAX_RESULTS);
        if (results.length > 0) return formatResults(results);
        failures.push(`${name}（浏览器渲染）未返回结果`);
      } catch (error) {
        failures.push(`${name}（浏览器渲染）：${describeError(error, "渲染失败")}`);
      }
    }
  }
  // 渲染不可用（未注入 / 全部失败）时退到纯 HTTP：更快，但结果质量可能降级。
  // browserOnly 模式不退——用户点名浏览器搜索，宁可直接报错也不给降级结果。
  if (options.browserOnly) {
    throw new Error(`浏览器搜索未取到结果（${failures.join("；")}）。可在「连接设置 → 联网搜索」配置搜索 API 获得稳定结果。`);
  }
  const sources: Array<[string, (q: string, s?: AbortSignal) => Promise<SearchResult[]>]> = [
    ["Bing", scrapeBing],
    ["搜狗", scrapeSogou]
  ];
  for (const [name, scrape] of sources) {
    try {
      const results = await scrape(query, signal);
      if (results.length > 0) return formatResults(results);
      failures.push(`${name} 未返回结果`);
    } catch (error) {
      failures.push(`${name}：${describeError(error, "抓取失败")}`);
    }
  }
  throw new Error(`免 key 搜索未取到结果（${failures.join("；")}）。可在「连接设置 → 联网搜索」配置搜索 API 获得稳定结果。`);
}

function bingSearchUrl(query: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
}

function sogouSearchUrl(query: string): string {
  return `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
}

/** 用户取消/超时都要能打断：把调用方 signal 与本次超时合并。 */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function searchViaApi(base: string, apiKey: string | undefined, query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ query, count: MAX_RESULTS }),
    signal: requestSignal(signal, 20_000)
  });
  if (!response.ok) throw new Error(`搜索请求失败：${response.status}`);
  const payload = (await response.json().catch(() => ({}))) as {
    results?: Array<{ name?: string; title?: string; url?: string; snippet?: string; content?: string }>;
  };
  return (payload.results ?? []).map((item) => ({
    title: item.title || item.name || "",
    url: item.url || "",
    snippet: item.snippet || item.content || ""
  }));
}

async function scrapeBing(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    signal: requestSignal(signal, 20_000)
  });
  if (!response.ok) throw new Error(`Bing 返回 ${response.status}`);
  return parseBing(await response.text()).slice(0, MAX_RESULTS);
}

async function scrapeSogou(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    signal: requestSignal(signal, 20_000)
  });
  if (!response.ok) throw new Error(`搜狗返回 ${response.status}`);
  return parseSogou(await response.text()).slice(0, MAX_RESULTS);
}

/**
 * 解析 Bing 结果页：每条是 `<li class="b_algo …"><h2><a href>标题</a></h2>…<p>摘要</p>…</li>`。
 *
 * class 匹配必须宽容：Bing 实际输出常用**复合 class**（`b_algo b_algoBorder`）或单引号，
 * 死认 `class="b_algo"` 会一条都解析不出来（实测 probe-bing-class：复合/单引号两种都 0 条）。
 * 导出以便单测。
 */
export function parseBing(html: string): SearchResult[] {
  const items: SearchResult[] = [];
  const block = /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>[\s\S]*?<h2><a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(html)) !== null && items.length < MAX_RESULTS) {
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(match[3]);
    items.push({ url: match[1], title: stripHtml(match[2]), snippet: snippet ? stripHtml(snippet[1]).slice(0, 200) : "" });
  }
  return items;
}

/**
 * 解析搜狗结果页：`<h3 class="vr-title"><a href="…">标题</a></h3>`；链接常是 /link?url=… 相对形式。
 *
 * 与 parseBing 同理：class 必须宽容匹配（复合 class / 单引号 / 前置属性），
 * 死认 `class="vr-title"` 在真实页面上会一条都解析不出（实测 probe-sogou：3/4 结构失败）。
 */
export function parseSogou(html: string): SearchResult[] {
  const items: SearchResult[] = [];
  const block = /<h3[^>]*class=["'][^"']*\bvr-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(html)) !== null && items.length < MAX_RESULTS) {
    const anchor = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/.exec(match[1]);
    if (!anchor) continue;
    const href = anchor[1];
    items.push({
      url: href.startsWith("/") ? `https://www.sogou.com${href}` : href,
      title: stripHtml(anchor[2]),
      snippet: ""
    });
  }
  return items;
}

/** 去标签 + 解常见实体（搜索结果标题/摘要里 &ensp; 等很常见）。 */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&ensp;|&emsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function formatResults(results: SearchResult[]): string {
  return results
    .filter((item) => item.title || item.url)
    .map((item, index) => `[${index + 1}] ${item.title}\n${item.url}\n${item.snippet}`)
    .join("\n\n");
}
