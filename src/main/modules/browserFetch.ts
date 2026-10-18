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
      const done = (error?: Error) => {
        clearTimeout(timer);
        win.webContents.removeListener("did-finish-load", onLoad);
        win.webContents.removeListener("did-fail-load", onFail);
        win.webContents.removeListener("will-redirect", onRedirect);
        win.webContents.removeListener("will-navigate", onNavigate);
        signal?.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      };
      const onLoad = () => done();
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
  /** 画布实际状态：尺寸 + 是否真的拿到了 WebGL 上下文。 */
  canvases: Array<{ width: number; height: number; webgl: boolean }>;
  /** 渲染后的可见文本长度（0 通常意味着脚本没跑起来或页面是纯 canvas）。 */
  textLength: number;
  /** 元素总数。与 textLength 一起用于判断"页面是不是空的"。 */
  elementCount: number;
}

/** 单条日志的截断长度：着色器编译错误可能一次吐几千字符，全量回灌只会把上下文烧掉。 */
const MAX_LOG_CHARS = 400;
const MAX_LOGS = 12;

/** 加载后额外等待的时长：让 requestAnimationFrame / 首帧初始化跑完，否则 canvas 采样必然为空。 */
const PROBE_SETTLE_MS = 1_200;

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
  // 新版 Electron 把参数合进了第一个 Event 对象（位置参数已 deprecated），两种都读。
  win.webContents.on("console-message", (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
    const level = (event as unknown as { level?: string }).level;
    const message = (event as unknown as { message?: string }).message;
    if (!message || (level !== "error" && level !== "warning")) return;
    if (logs.length >= MAX_LOGS) return;
    const line = `${level === "warning" ? "警告" : "错误"}：${sliceSafe(message, MAX_LOG_CHARS)}`;
    // 同一个错误常被逐帧重复打印（rAF 里报错一次就是 60 条），去重后才看得见别的问题。
    if (!logs.includes(line)) logs.push(line);
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
      return { loaded: false, title: "", consoleErrors: logs, canvases: [], textLength: 0, elementCount: 0 };
    }
    // 等首帧：WebGL 页面在 load 时往往还没建好上下文，立刻采样会得到"没有画布"的假结论。
    await new Promise((resolve) => setTimeout(resolve, PROBE_SETTLE_MS));
    const snapshot = (await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true)) as {
      title: string; textLength: number; elementCount: number;
      canvases: Array<{ width: number; height: number; webgl: boolean }>;
    };
    return { loaded: true, consoleErrors: logs, ...snapshot };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 页面内采样脚本。**必须全部包在 try 里**：采样跑在页面自己的 JS 环境里，
 * 产物有机会覆写 `document.querySelectorAll` 之类的内建方法，抛错会让整个自检变成"未知失败"。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const canvases = safe(() => Array.from(document.querySelectorAll("canvas")).slice(0, 8).map((c) => ({
    width: c.width,
    height: c.height,
    // 已经拿到 2d 上下文的画布再要 webgl 会返回 null —— 那不是错误，只是类型不同。
    webgl: safe(() => {
      if (c.getContext("2d")) return false;
      return Boolean(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
    }, false)
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
  if (result.canvases.length > 0) {
    const described = result.canvases.map((c, i) => `#${i + 1} ${c.width}×${c.height}${c.webgl ? "（WebGL 上下文正常）" : "（未取到 WebGL/2D 上下文）"}`).join("，");
    lines.push(`画布：${described}。`);
  } else if (result.textLength === 0) {
    lines.push("页面既没有画布、也没有可见文本——脚本很可能压根没跑起来。");
  }
  if (result.consoleErrors.length > 0) {
    lines.push(`运行时报错（共 ${result.consoleErrors.length} 条，已去重）：`);
    for (const entry of result.consoleErrors) lines.push(`- ${entry}`);
    lines.push("请针对这些报错修改后重新生成，并在回复里说明修了什么。");
  } else {
    lines.push("控制台没有任何 error/warning。可以据此如实告诉用户页面已实际运行且未报错；但不要声称看过画面效果——你拿到的是运行状态，不是截图。");
  }
  return lines.join("\n");
}
