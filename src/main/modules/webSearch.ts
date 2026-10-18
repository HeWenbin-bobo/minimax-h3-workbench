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
   * 带 `signal`：用户点「停止」时要能立刻中断渲染（浏览器渲染最长 25 秒）。
   */
  renderHtml?: (url: string, signal?: AbortSignal) => Promise<string>;
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
        const results = parse(await options.renderHtml(url, signal)).slice(0, MAX_RESULTS);
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
    // 未注入渲染回调时 `failures` 是空的，旧文案会拼成「浏览器搜索未取到结果（）」——
    // 括号里什么都没有，用户看不出是"没配置"还是"网页打不开"。
    const reason = failures.length > 0 ? `（${failures.join("；")}）` : "（浏览器渲染不可用）";
    throw new Error(`浏览器搜索未取到结果${reason}。可在「连接设置 → 联网搜索」配置搜索 API 获得稳定结果。`);
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
    results?: unknown;
  };
  // `results` 必须是数组：第三方搜索 API 的兼容实现质量参差，返回 `{results:{...}}` 或字符串
  // 都不罕见。不判的话 `(...).map is not a function` 会以英文技术错误透到界面，
  // 而且整条搜索链路直接失败（本可当作"无结果"继续走降级）。
  const items = Array.isArray(payload.results) ? payload.results : [];
  return items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      title: str(item.title) || str(item.name),
      url: str(item.url),
      snippet: str(item.snippet) || str(item.content)
    }))
    // **必须自己截断**：请求体里虽然带了 `count: MAX_RESULTS`，但第三方兼容实现
    // 未必遵守（有的固定返回 20/50 条）。而其余三条路径（浏览器渲染 ×2、免 key 抓取 ×2）
    // 都做了 slice——漏掉这一条时，结果会被全量拼进 system prompt，
    // 白白占用上下文预算、还可能把模型引向一堆低相关结果。
    .slice(0, MAX_RESULTS);
}

/** 取字符串字段；非字符串一律当空（避免把数字/对象塞进标题后渲染出 "[object Object]"）。 */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
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
 * 单条结果块的最大跨度（开标签结束 → 闭合标签之间的字符数）。
 *
 * 真实结构里一条结果的正文不会超过这个量级。实测（probe-blocksize7，本机直连：
 * 查询「iPhone 价格」）Bing 前 10 条 `b_algo` 实测跨度为 1093–2951 字符，
 * 搜狗标题块更短。4000 留了约 35% 余量：既容得下真实结果，又能把"注入一整页"
 * 这种一眼假的块挡在外面。
 */
const MAX_BLOCK_SCAN = 4_000;

/**
 * 按「开标签 + 闭合标签」切出成对的内容块，**单次线性扫描**。
 *
 * 为什么不用一个跨标签的正则：`<li class="b_algo">` 反复出现且永不闭合时，
 * 正则会从**每个**起始位置各扫一遍到串尾，复杂度 O(n²)——实测 2 万个完整前缀
 * 直接跑满 15 秒（probe-regex-dos2），主进程整窗无响应。加了跨距上限也没用，
 * 因为代价来自"起始位置的数量 × 每次的扫描长度"，正则引擎不会跳过已试过的位置。
 *
 * 这里先一次性收集所有闭合位置，再顺着开标签向前配对，整体 O(n)；
 * 单块内容再用**有界**正则解析（块本身已 ≤ MAX_BLOCK_SCAN）。
 *
 * @param openTag `"<li"` / `"<h3"` 这类开标签前缀（用来做 indexOf 定位）
 * @param isTarget 判断这个开标签是不是我们要的那种（检查 class）
 * @param closeTag 对应的闭合标签
 */
function collectBlocks(
  html: string,
  openTag: string,
  isTarget: (openTagText: string) => boolean,
  closeTag: string
): string[] {
  const closes: number[] = [];
  for (let at = html.indexOf(closeTag); at >= 0; at = html.indexOf(closeTag, at + closeTag.length)) closes.push(at);
  const blocks: string[] = [];
  let cursor = 0;
  let closeIndex = 0;
  while (cursor < html.length) {
    const open = html.indexOf(openTag, cursor);
    if (open < 0) break;
    const tagEnd = html.indexOf(">", open);
    if (tagEnd < 0) break;
    while (closeIndex < closes.length && closes[closeIndex] < tagEnd) closeIndex += 1;
    const close = closes[closeIndex];
    // 非目标标签（`<link>`、其它 class 的 li）或跨度过大：跳过这个开标签继续找。
    if (!isTarget(html.slice(open, tagEnd + 1)) || close === undefined || close - tagEnd > MAX_BLOCK_SCAN) {
      cursor = tagEnd + 1;
      continue;
    }
    blocks.push(html.slice(tagEnd + 1, close));
    closeIndex += 1;
    cursor = close + closeTag.length;
  }
  return blocks;
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
  // `<h2>` 也必须宽容匹配：Bing 的结果标题常带属性（`<h2 class="b_title">`），
  // 死认裸 `<h2>` 会一条都解析不出来——而这条链路的失败是**静默**的
  // （上层只看到"未返回结果"，接着换搜狗或报"未取到结果"）。
  const blocks = collectBlocks(
    html,
    "<li",
    (tag) => /^<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["']/i.test(tag),
    "</li>"
  );
  for (const block of blocks) {
    if (items.length >= MAX_RESULTS) break;
    // 块已被 collectBlocks 限长，这里的正则只在这段内跑，不会跨到全文。
    const heading = /<h2[^>]*><a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a><\/h2>/.exec(block);
    if (!heading) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    // href 同样要补全：Bing 的真实结果里常出现 `/ck/a?…` 这类**站点相对**跳转链接，
    // 原样交给模型后 `open_page` 拿到的是没有协议的字符串（`z.string().url()` 直接拒），
    // 用户点开也无从下手。与 `parseSogou` 共用同一个 `resolveHref`。
    items.push({
      url: resolveHref(heading[1], "https://www.bing.com"),
      title: stripHtml(heading[2]),
      snippet: snippet ? stripHtml(snippet[1]).slice(0, 200) : ""
    });
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
  const blocks = collectBlocks(
    html,
    "<h3",
    (tag) => /^<h3\b[^>]*class=["'][^"']*\bvr-title\b[^"']*["']/i.test(tag),
    "</h3>"
  );
  for (const block of blocks) {
    if (items.length >= MAX_RESULTS) break;
    const anchor = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!anchor) continue;
    items.push({
      url: resolveHref(anchor[1], "https://www.sogou.com"),
      title: stripHtml(anchor[2]),
      snippet: ""
    });
  }
  return items;
}

/**
 * 把结果页里的 href 补成绝对 URL。
 *
 * 三种形态都要认（真实结果页都会出现）：
 * - 绝对地址 `https://x`：原样返回；
 * - **协议相对** `//x/y`：补 `https:`——**不能**按"以 / 开头"直接拼域名，
 *   否则会变成 `https://www.sogou.com//x/y`（一个不存在的路径，用户点开 404）；
 * - 站点相对 `/link?url=…`：与 base 拼接。
 */
function resolveHref(href: string, base: string): string {
  const value = href.trim();
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${base}${value}`;
  return value;
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
