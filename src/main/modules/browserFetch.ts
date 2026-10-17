/**
 * 浏览器渲染抓取：复用应用自带的 Chromium（Electron 内置）加载页面并取回 HTML，
 * 用于纯 HTTP 抓不到的场景（需要 JS 渲染 / 反爬拦截）。**不引入 Playwright/Selenium**——
 * 那会额外拖 130–170MB 浏览器二进制，而本应用已经有一个 Chromium 了。
 *
 * 实现在隐藏窗口里加载目标页再读 DOM，等价于"用应用自己的浏览器打开并复制源码"。
 * 需要更低层的控制（拦截请求、改 UA、走原生 CDP 域）时，可在此基础上接
 * `webContents.debugger`（Electron 暴露的原始 CDP），无需新增依赖。
 */
import { BrowserWindow, session } from "electron";
import { assertPublicHttpUrl } from "../backends/resultUrl";

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
  // 不允许页面开新窗口。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // 权限一律拒绝（通知、地理位置、媒体、剪贴板、USB/串口…）。
  // Electron 要求 request 与 check 两个 handler 都实现：多数 Web API 先 check 再 request，
  // 只实现其一会漏（electron.d.ts 对 setPermissionCheckHandler 有明确说明）。
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

// 隐藏窗口是重资源：串行执行，避免并发开一堆窗口把内存打满。
let chain: Promise<void> = Promise.resolve();

/** 用隐藏窗口加载 url 并返回渲染后的 HTML。串行执行；超时/加载失败会抛中文错误。 */
export function renderHtml(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const task = chain.then(() => renderOnce(url, timeoutMs));
  // 队列本身不能被单次失败污染，否则后续调用全部连坐失败。
  chain = task.then(() => undefined, () => undefined);
  return task;
}

async function renderOnce(url: string, timeoutMs: number): Promise<string> {
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
       */
      const guardNavigation = (target: string): boolean => {
        try {
          assertPublicHttpUrl(target);
          return true;
        } catch (error) {
          done(error instanceof Error ? error : new Error("该地址指向内网，已拒绝访问。"));
          return false;
        }
      };
      const onRedirect = (event: { preventDefault: () => void }, target: string) => {
        if (!guardNavigation(target)) event.preventDefault();
      };
      const onNavigate = (event: { preventDefault: () => void }, target: string) => {
        if (!guardNavigation(target)) event.preventDefault();
      };
      win.webContents.once("did-finish-load", onLoad);
      win.webContents.on("did-fail-load", onFail);
      win.webContents.on("will-redirect", onRedirect);
      win.webContents.on("will-navigate", onNavigate);
      // 失败会走 did-fail-load，这里吞掉 loadURL 自身的 rejection，避免未处理拒绝告警。
      void win.loadURL(url).catch(() => undefined);
    });
    return (await win.webContents.executeJavaScript("document.documentElement.outerHTML", true)) as string;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** 应用退出时清理专用分区缓存。 */
export async function clearBrowserFetchCache(): Promise<void> {
  await session.fromPartition(PARTITION).clearCache().catch(() => undefined);
}
