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

// 专用分区：渲染搜索页不与应用主窗口共享 Cookie/存储，避免互相污染。
const PARTITION = "persist:h3-browser-fetch";
const DEFAULT_TIMEOUT_MS = 25_000;

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
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`浏览器渲染超时（${timeoutMs / 1000} 秒）`)), timeoutMs);
      const done = (error?: Error) => {
        clearTimeout(timer);
        win.webContents.removeListener("did-finish-load", onLoad);
        win.webContents.removeListener("did-fail-load", onFail);
        error ? reject(error) : resolve();
      };
      const onLoad = () => done();
      const onFail = (_event: unknown, code: number, description: string) => done(new Error(`浏览器加载失败：${description}（${code}）`));
      win.webContents.once("did-finish-load", onLoad);
      win.webContents.once("did-fail-load", onFail);
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
