/**
 * 浏览器渲染抓取：复用应用自带的 Chromium（Electron 内置）加载页面并取回 HTML，
 * 用于纯 HTTP 抓不到的场景（需要 JS 渲染 / 反爬拦截）。**不引入 Playwright/Selenium**——
 * 那会额外拖 130–170MB 浏览器二进制，而本应用已经有一个 Chromium 了。
 *
 * 实现在隐藏窗口里加载目标页再读 DOM，等价于"用应用自己的浏览器打开并复制源码"。
 * 需要更低层的控制（拦截请求、改 UA、走原生 CDP 域）时，可在此基础上接
 * `webContents.debugger`（Electron 暴露的原始 CDP），无需新增依赖。
 */
import { lookup } from "node:dns/promises";
import { BrowserWindow, session } from "electron";
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from "../backends/resultUrl";
import { sliceSafe } from "../../shared/text";

// 专用分区：渲染搜索页不与应用主窗口共享 Cookie/存储，避免互相污染。
const PARTITION = "persist:h3-browser-fetch";
const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * text 模式在 `dom-ready` 之后再等多久就收工。
 *
 * 为什么不全等 `did-finish-load`：那要等**所有子资源**（广告、统计、追踪像素、大图），
 * 任何一个挂住就白等到 45 秒超时。实测（文档案例真机）：6 次 `open_page` 有 2 次
 * 卡满 45 秒——而我们要的只是 `body.innerText`。
 *
 * 1.5 秒是给"客户端渲染出正文"留的窗口：多数页面的首屏内容在 DOMContentLoaded 后
 * 一两秒内就位；再长的页面本来也该用 web_search 或换个更轻的来源。
 */
const TEXT_MODE_SETTLE_MS = 1_500;

/**
 * 隐藏窗口加载的是**任意外部页面**（`open_page` 的 URL 由模型给出，`web_search` 抓的是公开搜索结果页），
 * 必须按不可信内容处理。
 *
 * 实测默认行为（probe browserfetch-hardening）：不装 handler 时，
 * 页面里的 `window.open()` 会**真的创建新窗口**（该窗口不受 renderOnce 的 finally 管，
 * 抓取结束也不会关），`Notification.requestPermission()` 直接返回 granted。
 * 前者可用来做弹窗骚扰/钓鱼，后者能拿到系统通知权限。
 *
 * 加固原则：这个窗口只用来**读 DOM**，任何主动能力（新窗口、权限）都不需要。
 */
function harden(win: BrowserWindow, ses: Electron.Session): void {
  hardenWindow(win);
  hardenSession(ses);
}

/** 窗口自身的限制（不动 session）。产物自检复用默认 session，不能改它的全局权限策略。 */
function hardenWindow(win: BrowserWindow): void {
  // 不允许页面开新窗口。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** session 级限制：权限一律拒绝。只装在专用分区上，别作用到应用默认 session。 */
function hardenSession(ses: Electron.Session): void {
  // 权限一律拒绝（通知、地理位置、媒体、剪贴板、USB/串口…）。
  // Electron 要求 request 与 check 两个 handler 都实现：多数 Web API 先 check 再 request，
  // 只实现其一会漏（electron.d.ts 对 setPermissionCheckHandler 有明确说明）。
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  installNavigationDnsGuard(ses);
}

/**
 * 主框架导航的 **DNS 解析校验**（SSRF 第三跳）。
 *
 * `will-redirect` / `will-navigate` 是同步事件，只能比字面 hostname；而
 * `127.0.0.1.nip.io` / `localtest.me` 这类**通配 DNS** 把内网 IP 编进域名，
 * 字面完全正常、解析后落到回环地址（实测 probe-ssrf-nipio 读回了本机服务内容）。
 * 302 跳过去同样成立——同步守卫拦不住。
 *
 * `webRequest.onBeforeRequest` 的回调是**异步**的，可以在这里做 DNS 再决定是否取消。
 * 只校验 `mainFrame`：子资源（图片/字体）跳到内网读不回内容，逐条解析会把每个页面
 * 拖慢几百毫秒。按 host 缓存 60 秒，避免同一页面重复解析。
 *
 * 同一个 session 只保留一个 handler（Electron 的 `onBeforeRequest` 是单监听器语义，
 * 重复注册即覆盖），所以这里不需要去重标志；handler 本身无窗口状态，覆盖是安全的。
 */
function installNavigationDnsGuard(
  ses: Electron.Session,
  /** 注入 DNS 解析（默认带 60 秒缓存）。单测用它锁定行为，不必联网。 */
  resolver: (host: string) => Promise<Array<{ address: string }>> = cachedLookup
): void {
  ses.webRequest.onBeforeRequest(async (details, callback) => {
    if (details.resourceType !== "mainFrame") { callback({}); return; }
    let protocol = "";
    try { protocol = new URL(details.url).protocol; } catch { callback({ cancel: true }); return; }
    // 内部 scheme 与 data/blob（预览页）不过网络，放行。
    if (!protocol.startsWith("http")) { callback({}); return; }
    try {
      await assertPublicHttpUrlResolved(details.url, resolver);
      callback({});
    } catch {
      callback({ cancel: true });
    }
  });
}

/** DNS 结果缓存（60 秒）。只缓存成功结果——失败要重新解析，不能缓存成"永久不可达"。 */
const dnsCache = new Map<string, { at: number; addresses: Array<{ address: string }> }>();
const DNS_CACHE_MS = 60_000;
async function cachedLookup(host: string): Promise<Array<{ address: string }>> {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_CACHE_MS) return hit.addresses;
  const addresses = await lookup(host, { all: true });
  dnsCache.set(host, { at: Date.now(), addresses });
  return addresses;
}

/** 仅测试用：直接装守卫并注入解析器（产品路径由 renderOnce → harden 调用）。 */
export const installNavigationDnsGuardForTest = installNavigationDnsGuard;

// 隐藏窗口是重资源：串行执行，避免并发开一堆窗口把内存打满。
let chain: Promise<void> = Promise.resolve();

/** 用隐藏窗口加载 url 并返回渲染后的 HTML。串行执行；超时/加载失败/取消会抛中文错误。 */
export function renderHtml(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  return enqueue(() => renderOnce(url, timeoutMs, "html", signal), signal);
}

/**
 * 用隐藏窗口加载 url 并返回**可见文本**（`document.body.innerText`）。
 *
 * 为什么不复用 `renderHtml` 的整页 HTML：实测（probe openpage-text-vs-html）
 * 一个 120081 字符的页面里，正文只有 35 字符——其余全是内联 script/style。
 * `open_page` 把结果截到 8 万字符后，关键事实（示例里的价格）**已被脚本挤掉**，
 * 模型拿到一堆代码噪声还信心十足地作答。真实站点（Bing 结果页、文档站）比例相近。
 *
 * 搜索解析（parseBing/parseSogou）必须看 HTML 结构，所以两条路分开、各取所需。
 */
export function renderPageText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  return enqueue(() => renderOnce(url, timeoutMs, "text", signal), signal);
}

/**
 * 串行队列。
 *
 * **排队期间就要能取消**：隐藏窗口一次只跑一个（前一个最长可达 45 秒），
 * 用户在排队时点「停止」如果只在出队后才检查，就要干等前一个渲染跑完——
 * 停止按钮看起来毫无反应（与本轮修的"open_page 漏传 signal"同一体验）。
 * 所以入队时先看一眼、出队后再看一眼，两侧都抛 AbortError。
 */
function enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const abortError = () => new DOMException("渲染已取消", "AbortError");
  if (signal?.aborted) return Promise.reject(abortError());
  const task = chain.then(() => {
    if (signal?.aborted) throw abortError();
    return operation();
  });
  // 队列本身不能被单次失败污染，否则后续调用全部连坐失败。
  chain = task.then(() => undefined, () => undefined);
  return task;
}

async function renderOnce(url: string, timeoutMs: number, mode: "html" | "text", signal?: AbortSignal): Promise<string> {
  const ses = session.fromPartition(PARTITION);
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      partition: PARTITION,
      // 加载的是外部页面：不给 Node、不开同源隔离，只当普通网页读 DOM。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 后台渲染，不参与后台节流。
      backgroundThrottling: false
    }
  });
  harden(win, ses);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`浏览器渲染超时（${timeoutMs / 1000} 秒）`)), timeoutMs);
      /** text 模式的软截止计时器（dom-ready 之后启动）。 */
      let softTimer: NodeJS.Timeout | undefined;
      const done = (error?: Error) => {
        clearTimeout(timer);
        if (softTimer) clearTimeout(softTimer);
        win.webContents.removeListener("did-finish-load", onLoad);
        win.webContents.removeListener("dom-ready", onDomReady);
        win.webContents.removeListener("did-fail-load", onFail);
        win.webContents.removeListener("will-redirect", onRedirect);
        win.webContents.removeListener("will-navigate", onNavigate);
        signal?.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      };
      const onLoad = () => done();
      /**
       * **text 模式不等全部子资源**（实测：文档案例 6 次 open_page 有 2 次卡满 45 秒超时）。
       *
       * `did-finish-load` 要等主框架**连同所有子资源**（广告、统计、图片、追踪像素）完成；
       * 其中任何一个挂住，整次抓取就白等到超时——而我们只要 `body.innerText`。
       * 所以 dom-ready 之后再静置一小段时间（给 JS 渲染留机会），先到先得。
       *
       * `html` 模式**保持等 did-finish-load**：搜索解析（parseBing/parseSogou）依赖完整 DOM 结构，
       * 提前取会拿到没渲染完的结果页。
       */
      const onDomReady = () => {
        if (mode !== "text") return;
        softTimer = setTimeout(() => done(), TEXT_MODE_SETTLE_MS);
      };
      // 只认**主框架**失败。子框架（iframe）加载失败不该连坐整页——真实网页（搜索结果页、
      // 开放平台文档）几乎都内嵌第三方 iframe（广告/统计/播放器），它们失败是常态。
      // 旧实现不看 isMainFrame，任何一个子框架报错就 reject 整个 renderHtml：
      // 主框架明明加载好了，却报"浏览器加载失败"（实测 probe-render-subframe 复现）。
      // 注意用 on 而非 once：子框架失败不落定，若用 once 会被第一个子框架事件消耗掉，
      // 之后真·主框架失败就漏判了。done() 里统一 removeListener。
      const onFail = (_event: unknown, code: number, description: string, _url: string, isMainFrame: boolean) =>
        isMainFrame ? done(new Error(`浏览器加载失败：${description}（${code}）`)) : undefined;
      /**
       * 重定向/后续导航守卫（SSRF 的第二跳）。
       *
       * `assertPublicHttpUrl` 只校验**首个** URL，而 Chromium 会自动跟随 3xx。
       * 实测（probe openpage-redirect-ssrf）：公网入口 302 到 `http://127.0.0.1:<port>/object_info`
       * 后，内网内容被完整读回。搜索抓取（Bing/搜狗）虽然目标是固定的公网域名，
       * 但结果页本身也可能被劫持后跳内网，所以这道闸门对两条链路都必要。
       *
       * 两个关键细节：
       * ① **主框架才 reject**。子框架（广告/统计/播放器）跳到内网只需阻止加载；
       *    让它连坐整次渲染就重演了 `did-fail-load` 那个坑（正常页面误报失败）。
       * ② **内部 scheme 放行**。`about:blank` 是 iframe 初始化与部分跳转的常态，
       *    `chrome-error:` 是子资源失败页——都读不到内网资源，拦了只会误伤。
       */
      const guardNavigation = (event: { preventDefault: () => void }, target: string, isMainFrame: boolean): void => {
        let protocol = "";
        try { protocol = new URL(target).protocol; } catch { /* 非法 URL 走下面的拒绝分支 */ }
        if (protocol === "about:" || protocol === "chrome-error:" || protocol === "devtools:") return;
        try {
          assertPublicHttpUrl(target);
        } catch (error) {
          event.preventDefault();
          // 子框架跳内网：静默阻止即可，页面其余部分照常渲染。
          if (!isMainFrame) return;
          done(error instanceof Error ? error : new Error("该地址指向内网，已拒绝访问。"));
        }
      };
      // 新版事件把 URL / isMainFrame 放在 details 里（位置参数已标记 deprecated）。
      const onRedirect = (details: Electron.Event<Electron.WebContentsWillRedirectEventParams>) =>
        guardNavigation(details, details.url, details.isMainFrame);
      const onNavigate = (details: Electron.Event<Electron.WebContentsWillNavigateEventParams>) =>
        guardNavigation(details, details.url, details.isMainFrame);
      win.webContents.once("did-finish-load", onLoad);
      // text 模式的软截止：dom-ready 后静置一小段就收工，不等全部子资源（见 TEXT_MODE_SETTLE_MS）。
      win.webContents.on("dom-ready", onDomReady);
      win.webContents.on("did-fail-load", onFail);
      win.webContents.on("will-redirect", onRedirect);
      win.webContents.on("will-navigate", onNavigate);
      // 取消信号：用户点「停止」时立刻结束渲染并销毁隐藏窗口。
      // 不接这个的话，浏览器渲染最长要跑满 timeoutMs（25–45 秒），
      // 停止按钮看起来毫无反应（搜索链路尤其明显）。
      const onAbort = () => done(new DOMException("渲染已取消", "AbortError"));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      // 失败会走 did-fail-load，这里吞掉 loadURL 自身的 rejection，避免未处理拒绝告警。
      void win.loadURL(url).catch(() => undefined);
    });
    // 按调用方需要取两种视图：搜索解析要 HTML 结构，open_page 要可读正文。
    // `open_page` 用 HTML 的实测后果见 renderPageText 的注释（正文被脚本挤掉）。
    const expression = mode === "text"
      ? "document.body ? document.body.innerText : ''"
      : "document.documentElement.outerHTML";
    return (await win.webContents.executeJavaScript(expression, true)) as string;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** 应用退出时清理专用分区缓存。 */
export async function clearBrowserFetchCache(): Promise<void> {
  await session.fromPartition(PARTITION).clearCache().catch(() => undefined);
}

/** 产物自检结果。字段刻意保持"事实"，不含判断——判断留给模型。 */
export interface HtmlProbeResult {
  /** 主框架是否加载完成（false 时 consoleErrors 里会有加载失败原因）。 */
  loaded: boolean;
  title: string;
  /** 控制台 error/warning（含未捕获异常、CSP 拦截、WebGL 报错）。已去重并截断。 */
  consoleErrors: string[];
  /**
   * 去重后的**真实**条数（可能远大于 `consoleErrors.length`）。
   *
   * 为什么要单独报：数组被 `MAX_LOGS` 截到 12 条，而报告写的是"共 N 条"——
   * 一个循环报错 40 次的页面会被说成"共 12 条"，模型以为已经掌握全部问题，
   * 改完 12 条就宣布"自检通过"，用户打开还是报错。静默少给比多给更误导。
   */
  consoleErrorTotal?: number;
  /**
   * 画布实际状态：**缓冲区**尺寸（`width/height` 属性）、**布局**尺寸（CSS 像素）
   * 与是否真的拿到了 WebGL 上下文。
   *
   * 为什么两个尺寸都要（实测真机）：模型连续 5 次修改都提示"画面是空的"，
   * 它在回复里自己怀疑「canvas 尺寸为 0 导致 clientWidth=0」，但**无从验证**——
   * 之前只报 `c.width/c.height`（缓冲区，通常有值），看不到 CSS 布局为 0 这种情况。
   * 而"缓冲区正常、布局为 0"正是 WebGL 页面零报错全白的头号成因（画布没有可见面积）。
   */
  canvases: Array<{
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    /**
     * 画布拿到了哪种上下文。
     *
     * **不能只报 boolean webgl**（实测真机）：一个真实产物用的是
     * `getContext("2d", { alpha: false })`（纯 2D Canvas），旧字段 `webgl=false`
     * 被渲染成"未取到 WebGL/2D 上下文"——把"用的是 2D"说成"没有上下文"，
     * 模型据此去查一个根本不存在的问题。
     */
    context: "webgl" | "2d" | "none";
  }>;
  /** 渲染后的可见文本长度（0 通常意味着脚本没跑起来或页面是纯 canvas）。 */
  textLength: number;
  /** 元素总数。与 textLength 一起用于判断"页面是不是空的"。 */
  elementCount: number;
  /**
   * 画面采样：把窗口截一张图，统计"主色占比"与平均亮度。
   *
   * **为什么需要**：只报"控制台没报错"会**假通过**——一个 WebGL 页面完全可以
   * 一条错都不报、但什么都没画出来（清屏成背景色、画布尺寸为 0、整个场景被裁掉）。
   * 这时说"自检通过"比不说更糟：模型会据此告诉用户"已验证"，用户打开却是白屏。
   * 实测（probe-capture）：纯色页主色占比 100%、空白画布页 97.7%，能稳定区分。
   *
   * 拿不到截图时为 undefined（不影响其余结论）。
   */
  pixel?: { dominant: number; brightness: number; sampled: number };
  /**
   * 两帧之间的**变化比例**（0–1）。0 表示两次截图完全一样。
   *
   * **为什么需要**（实测真机）：模型连续 5 次改都判定"画面是空的"，
   * 但它无法区分两种完全不同的情况：
   * ① 渲染循环没跑起来 → 画面永远静止；
   * ② 页面本来就是静止的（静态图、首帧还没动）。
   * 抓两帧比一比就能定性：空白 + 零变化 = 几乎确定是循环没转。
   *
   * 拿不到截图时为 undefined。
   */
  motion?: number;
}

/** 单条日志的截断长度：着色器编译错误可能一次吐几千字符，全量回灌只会把上下文烧掉。 */
const MAX_LOG_CHARS = 400;
const MAX_LOGS = 12;

/**
 * 控制台消息 → 给模型看的一行。返回 undefined 表示"这条不用报"。
 *
 * 两条过滤都是实测踩出来的（probe-inspect-real，用一个故意写错的页面跑）：
 * ① **Electron 自己的安全警告**（「Insecure Content-Security-Policy」）在每个页面都会打一条。
 *    不滤掉的话，再干净的产物也会被报成"有警告"，模型会为一条与它无关的框架提示反复改代码。
 * ② 着色器 `getShaderInfoLog` 末尾常带 NUL（实测 "…syntax error\n\u0000"），
 *    直接回传会在报告里留下一行空白。控制字符清掉，换行保留（多行报错要看得懂）。
 */
export function formatConsoleLine(level: unknown, message: unknown, lineNumber?: unknown): string | undefined {
  if (typeof message !== "string" || !message) return undefined;
  if (level !== "error" && level !== "warning") return undefined;
  if (message.includes("Electron Security Warning")) return undefined;
  const cleaned = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  // **行号必须带上**（实测真机）：模型拿到报错却不知道在哪一行，只能把 2100 行的文件
  // 分 5 次读完再逐段比对（那一轮光读文件就吃掉 5 步，最终仍打满 20 步）。
  // Chromium 早就把行号给了我们，之前丢掉了。
  const where = typeof lineNumber === "number" && lineNumber > 0 ? `（第 ${lineNumber} 行）` : "";
  // **截断必须留痕**（实测缺口）：着色器编译错误一次能吐几千字符，截到 400 字是对的，
  // 但原样切掉末尾会让模型以为报错就这么多——它据此判断"这个错看起来不严重"，
  // 或把半截的错误信息当成完整原文去搜索。加个尾巴成本为零。
  const body = cleaned.trim();
  const shown = body.length > MAX_LOG_CHARS ? `${sliceSafe(body, MAX_LOG_CHARS)}…（已截断）` : body;
  return `${level === "warning" ? "警告" : "错误"}${where}：${shown}`;
}

/** 加载后额外等待的时长：让 requestAnimationFrame / 首帧初始化跑完，否则 canvas 采样必然为空。 */
const PROBE_SETTLE_MS = 1_200;

/**
 * 两次截图之间隔多久。太短会被单帧抖动骗到，太长会让自检明显变慢。
 * 500ms ≈ 30 帧（60fps），足够让"循环在转"的运动显现，也不会让整次自检多等一秒以上。
 */
const MOTION_GAP_MS = 500;

/**
 * **产物自检**：用应用自带的 Chromium 真的把刚生成的 HTML 跑一遍，把控制台报错交回给模型。
 *
 * 为什么需要（实测，probe-video-intent 真机跑「鹈鹕骑自行车 3D 页面」）：模型写出了 53KB 的
 * 手写 WebGL 页面，然后如实说"我没有在浏览器里运行过这个文件，如果控制台报着色器编译错误请告诉我"。
 * 这不是它在推卸责任——**应用里确实没有任何让它验证自己产物的手段**：`open_page` 只接受公网
 * http(s)，且取的是 innerText，根本不会暴露脚本错误。Codex 的循环是"写 → 跑 → 看错误 → 修"，
 * 缺了"跑"这一环，模型只能瞎猜，用户拿到的第一版就是个没验证过的黑盒。
 *
 * 加载的是 **`h3preview:` 协议 URL**，与右侧预览面板同源同 CSP——自检看到的限制就是用户看到的限制。
 *
 * 已知差异（有意接受）：预览面板的 iframe 带 `sandbox="allow-scripts"`（不透明源），
 * 而这里是没有 sandbox 属性的顶层文档，`localStorage` 在自检里可用、在预览里会抛。
 * 生成型页面极少用存储；真踩到时模型会在预览面板里被用户反馈。
 */
export function probeHtmlArtifact(url: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<HtmlProbeResult> {
  return enqueue(() => probeOnce(url, timeoutMs, signal), signal);
}

async function probeOnce(url: string, timeoutMs: number, signal?: AbortSignal): Promise<HtmlProbeResult> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  // 只拦"页面自己开新窗口"。**不能**装 session 级权限拦截：自检加载预览协议走的是
  // 应用默认 session，把全局权限改成一律拒绝会波及主窗口。
  hardenWindow(win);
  const logs: string[] = [];
  /** 去重后的真实条数（不受 MAX_LOGS 限制）。报告里的"共 N 条"必须用它。 */
  let logTotal = 0;
  // 新版 Electron 把参数合进了第一个 Event 对象（位置参数已 deprecated），两种都读。
  win.webContents.on("console-message", (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
    const level = (event as unknown as { level?: string }).level;
    const message = (event as unknown as { message?: string }).message;
    // 行号也传下去：模型据此能直接跳到出错那一段，而不是把整个文件分段读完。
    const lineNumber = (event as unknown as { lineNumber?: number }).lineNumber;
    const line = formatConsoleLine(level, message, lineNumber);
    if (!line || logs.includes(line)) return;
    // **先计数再判断是否入数组**：只增不减才能反映"到底报了多少条"。
    logTotal += 1;
    if (logs.length < MAX_LOGS) logs.push(line);
  });
  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const onAbort = () => finish(false);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        win.webContents.removeListener("did-finish-load", onLoad);
        win.webContents.removeListener("did-fail-load", onFail);
        signal?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onLoad = () => finish(true);
      // 只认主框架失败：子框架（iframe）失败是常态，不该把整页判成"没跑起来"。
      const onFail = (_e: unknown, code: number, description: string, _u: string, isMainFrame: boolean) => {
        if (isMainFrame) { logs.unshift(`页面加载失败：${description}（${code}）`); finish(false); }
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      win.webContents.once("did-finish-load", onLoad);
      win.webContents.on("did-fail-load", onFail);
      void win.loadURL(url).catch(() => undefined);
    });
    if (signal?.aborted) throw new DOMException("自检已取消", "AbortError");
    if (!loaded) {
      return { loaded: false, title: "", consoleErrors: logs, consoleErrorTotal: logTotal, canvases: [], textLength: 0, elementCount: 0 };
    }
    // 等首帧：WebGL 页面在 load 时往往还没建好上下文，立刻采样会得到"没有画布"的假结论。
    await new Promise((resolve) => setTimeout(resolve, PROBE_SETTLE_MS));
    const snapshot = (await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true)) as {
      title: string; textLength: number; elementCount: number;
      canvases: Array<{ width: number; height: number; clientWidth: number; clientHeight: number; context: "webgl" | "2d" | "none" }>;
    };
    // 截图采样：失败不能连坐整次自检（拿不到只是少一条证据，不该让工具报错）。
    const pixel = await samplePixels(win);
    // 两帧比对：空白 + 零变化 ≈ 渲染循环压根没转（与"本来就是静止画面"区分开）。
    // 只在**画面是纯色**时多付这一帧的代价——正常页面不需要这条证据。
    let motion: number | undefined;
    if (pixel && pixel.dominant >= 0.97) {
      await new Promise((resolve) => setTimeout(resolve, MOTION_GAP_MS));
      motion = await sampleMotion(win, pixel);
    }
    return {
      loaded: true, consoleErrors: logs, consoleErrorTotal: logTotal, ...snapshot,
      ...(pixel ? { pixel } : {}),
      ...(motion === undefined ? {} : { motion })
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 截一张图，统计主色占比与平均亮度——用来发现"没报错但什么都没画"。
 *
 * 稀疏采样（每 37 个像素取一个）足够判断"整屏是不是一个颜色"，全量扫 100 万像素
 * 只会让自检多花几十毫秒却得不到更多信息。
 * 主色按每个通道取高 3 位分桶，避免抗锯齿产生的微小明暗差把同一种颜色拆成几百桶。
 */
async function samplePixels(win: BrowserWindow): Promise<{ dominant: number; brightness: number; sampled: number; signature: number[] } | undefined> {
  try {
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return undefined;
    const bitmap = image.toBitmap(); // BGRA
    const buckets = new Map<number, number>();
    // 逐采样点的颜色桶序列：既是"主色占比"的统计来源，也是两帧比对的指纹。
    const signature: number[] = [];
    let sum = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 4 * 37) {
      const b = bitmap[i];
      const g = bitmap[i + 1];
      const r = bitmap[i + 2];
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      signature.push(key);
      sum += (r + g + b) / 3;
    }
    const sampled = signature.length;
    if (sampled === 0) return undefined;
    let top = 0;
    for (const count of buckets.values()) if (count > top) top = count;
    return { dominant: top / sampled, brightness: sum / sampled, sampled, signature };
  } catch {
    return undefined;
  }
}

/**
 * 再抓一帧，与第一帧的签名比对，返回"变了的采样点比例"（0–1）。
 *
 * 用途：区分「渲染循环没转」和「页面本来就是静止画面」——
 * 空白 + 零变化 = 几乎确定循环没跑起来，模型据此直接查初始化，不用继续猜。
 */
async function sampleMotion(win: BrowserWindow, first: { signature: number[] }): Promise<number | undefined> {
  const second = await samplePixels(win);
  if (!second) return undefined;
  // 画布尺寸可能在这一瞬间变化（resize），长度对不上就比前 N 个，避免误判成"全变了"。
  const n = Math.min(first.signature.length, second.signature.length);
  if (n === 0) return undefined;
  let changed = 0;
  for (let i = 0; i < n; i += 1) if (first.signature[i] !== second.signature[i]) changed += 1;
  return changed / n;
}

/**
 * 页面内采样脚本。**必须全部包在 try 里**：采样跑在页面自己的 JS 环境里，
 * 产物有机会覆写 `document.querySelectorAll` 之类的内建方法，抛错会让整个自检变成"未知失败"。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const canvases = safe(() => Array.from(document.querySelectorAll("canvas")).slice(0, 8).map((c) => ({
    // 缓冲区尺寸（绘制分辨率）——通常由 width/height 属性决定，几乎总是有值。
    width: c.width,
    height: c.height,
    // **布局尺寸（CSS 像素）**：这两个才是"用户到底看不看得见"的关键。
    // 缓冲区 800×600 但 clientWidth=0 时，画布完全不占面积 → 屏幕上一片空白，
    // 而且**没有任何报错**。实测真机里模型连续 5 次改都改不掉这个空白，
    // 它自己怀疑"clientWidth=0"，但当时自检没报这个数字，它无从验证。
    clientWidth: safe(() => Math.round(c.getBoundingClientRect().width), 0),
    clientHeight: safe(() => Math.round(c.getBoundingClientRect().height), 0),
    // 画布拿到了哪种上下文。**必须区分 webgl / 2d / none**（实测真机）：
    // 一个真实产物用的是 getContext("2d", { alpha: false })（纯 2D Canvas），
    // 旧字段只报 webgl=false，渲染成"未取到 WebGL/2D 上下文"——
    // 把"用的是 2D"说成"没有上下文"，模型据此去查一个根本不存在的问题。
    // 注意顺序：已经拿过 2d 的 canvas 再要 webgl 会返回 null，反之亦然，
    // 所以只问一次，问到哪个算哪个。
    context: safe(() => {
      if (c.getContext("2d")) return "2d";
      if (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl")) return "webgl";
      return "none";
    }, "none")
  })), []);
  return {
    title: safe(() => document.title || "", ""),
    textLength: safe(() => (document.body ? (document.body.innerText || "").trim().length : 0), 0),
    elementCount: safe(() => document.getElementsByTagName("*").length, 0),
    canvases
  };
})()`;

/**
 * 把自检结果整理成给模型看的文本。
 *
 * 措辞刻意保持"事实陈述 + 下一步动作"，不含"已通过/优秀"这类判断——模型需要知道**具体哪里错**，
 * 而不是一句笼统的结论。纯函数，单测可直接锁。
 */
export function formatProbeReport(result: HtmlProbeResult): string {
  if (!result.loaded) {
    const reason = result.consoleErrors[0] || "页面未能加载完成";
    return `自检失败：页面没能加载起来（${reason}）。请检查 HTML 结构是否完整、是否有语法错误，改完重新生成后再自检一次。`;
  }
  const lines: string[] = [`自检结果：页面已在本机 Chromium 中真实运行（标题「${result.title || "无"}」，${result.elementCount} 个元素，可见文本 ${result.textLength} 字）。`];
  // 整屏接近一种颜色 = 大概率什么都没画出来（清屏成背景色 / 画布尺寸为 0 / 场景被裁掉）。
  // 这一条必须**先于**"控制台没报错"说出来，否则模型会把"无报错"当成"画面正常"。
  const flatScreen = Boolean(result.pixel && result.pixel.dominant >= 0.97 && result.elementCount > 1);
  if (result.canvases.length > 0) {
    const described = result.canvases.map((c, i) => {
      // **布局尺寸必须单独报**：缓冲区 800×600、`clientWidth=0` 时画布不占面积，
      // 屏幕一片空白且零报错——实测真机里模型卡在这个现象上改不动的正是这一类。
      const layout = c.clientWidth === 0 || c.clientHeight === 0
        ? `**布局尺寸为 0（clientWidth=${c.clientWidth}, clientHeight=${c.clientHeight}）——画布不占面积，屏幕上必然看不见**`
        : `布局 ${c.clientWidth}×${c.clientHeight}`;
      // 缓冲区停在 HTML 规范的默认值 300×150、而布局大得多 → 脚本多半**没跑到设置绘制分辨率
      // 那一步就崩了**（先设 width/height 再初始化渲染，是这类页面的常规写法）。
      // 实测真机：模型自己推断出"画布仍是 300×150，说明 resize() 执行前就崩溃了"，
      // 但那花了它好几步；这个信号本来就在我们手上。
      const defaultBuffer = c.width === 300 && c.height === 150 && (c.clientWidth > 400 || c.clientHeight > 300);
      const bufferHint = defaultBuffer && flatScreen
        ? "（缓冲区仍是 HTML 默认值 300×150，而布局大得多——脚本多半在设置绘制分辨率之前就中断了）"
        : "";
      const contextLabel = c.context === "webgl"
        ? "（WebGL 上下文正常）"
        : c.context === "2d"
          ? "（2D Canvas 上下文正常）"
          : "（**未取到任何绘制上下文**——这通常意味着渲染初始化没能完成）";
      return `#${i + 1} 缓冲区 ${c.width}×${c.height}${bufferHint}，${layout}${contextLabel}`;
    }).join("，");
    lines.push(`画布：${described}。`);
  } else if (result.textLength === 0) {
    lines.push("页面既没有画布、也没有可见文本——脚本很可能压根没跑起来。");
  }
  if (flatScreen) {
    lines.push(`画面采样：整屏约有 ${Math.round((result.pixel as NonNullable<HtmlProbeResult["pixel"]>).dominant * 100)}% 是同一种颜色（平均亮度 ${Math.round((result.pixel as NonNullable<HtmlProbeResult["pixel"]>).brightness)}）。**这通常意味着页面上什么都没画出来**——画面被某个纯色元素盖满、画布尺寸为 0、或渲染循环根本没跑起来。请检查布局与首帧渲染。`);
    // 两帧比对：把"循环有没有在转"这条定性结论直接给出来。
    // 模型分不清"循环没启动"和"页面本来就静止"，只能反复改代码试（真机连改 5 次）。
    if (typeof result.motion === "number") {
      const percent = Math.round(result.motion * 100);
      lines.push(result.motion < 0.01
        ? `画面变化：间隔 ${MOTION_GAP_MS}ms 的两帧**几乎完全相同**（变化 ${percent}%）。渲染循环很可能**根本没有在跑**——请检查 requestAnimationFrame 是否启动、初始化是否在绘制前就抛错/提前 return。`
        : `画面变化：间隔 ${MOTION_GAP_MS}ms 的两帧有 ${percent}% 的像素不同——渲染循环**确实在运行**。那么空白更可能是画到了看不见的地方（尺寸/裁剪/相机矩阵），而不是没在画。`);
    }
  }
  if (result.consoleErrors.length > 0) {
    // **"共 N 条"必须用真实总数**：数组被 `MAX_LOGS` 截过，
    // 一个循环报错 40 次的页面若说成"共 12 条"，模型会以为已经看到全部，
    // 改完这 12 条就宣布通过——用户打开还是报错。
    const total = Math.max(result.consoleErrorTotal ?? result.consoleErrors.length, result.consoleErrors.length);
    const shown = result.consoleErrors.length;
    const head = total > shown
      ? `运行时报错（去重后共 ${total} 条，下面只列出前 ${shown} 条——同一类错误往往成片出现，修掉根因后重新自检看剩余）：`
      : `运行时报错（共 ${total} 条，已去重）：`;
    lines.push(head);
    for (const entry of result.consoleErrors) lines.push(`- ${entry}`);
    lines.push("请针对这些报错修改后重新生成，并在回复里说明修了什么。");
  } else if (flatScreen) {
    lines.push("控制台没有 error/warning，但上面的画面采样说明屏幕是空的——**不要**据此告诉用户页面正常。");
  } else if (result.canvases.length === 0 && result.textLength === 0) {
    // **既没有画布也没有文本**：这是"脚本压根没跑起来"的最强信号，
    // 不能落进"未报错 = 通过"那一支（实测：3 个元素、0 字文本、无画布，
    // 报告却在说"画面也不是纯色"，而截图采样其实没拿到——`pixel` 是 undefined，
    // 那句"不是纯色"无据可依）。摘要也会跟着说"自检通过"。
    lines.push("控制台没有 error/warning，但页面既没有画布也没有可见文本——**这不等于正常**：多半是脚本没跑起来、或内容没渲染出来。请检查 <script> 是否执行（初始化是否提前 return / 抛错后被吞）、内容是否依赖了不允许的外链资源。");
  } else if (!result.pixel) {
    // 拿不到截图采样时**不能替它下结论**（说"画面不是纯色"是没有证据的判断）。
    lines.push("控制台没有任何 error/warning；本次**未能取得画面采样**（截图失败），所以无法判断画面是否为空——不要据此告诉用户页面正常，也不要声称看过画面效果。");
  } else if (result.pixel.dominant >= 0.97) {
    // 采样**确实是纯色**，但 `flatScreen` 因为元素太少（≤1）没敢下"什么都没画出来"的结论。
    // 这时候**不能**说"画面也不是纯色"——那是与证据相反的事实错误。
    // 元素极少通常意味着页面结构本身就不完整，纯色这件事仍然要如实报出来。
    lines.push(`画面采样：整屏约有 ${Math.round(result.pixel.dominant * 100)}% 是同一种颜色，但这个页面只有 ${result.elementCount} 个元素——**不能据此确认画面正常**（页面结构可能不完整）。请检查 HTML 是否完整、内容是否真的渲染到了页面上。`);
  } else {
    lines.push("控制台没有任何 error/warning，画面也不是纯色。可以据此如实告诉用户页面已实际运行且未报错；但不要声称看过画面效果——你拿到的是运行状态，不是截图。");
  }
  return lines.join("\n");
}
