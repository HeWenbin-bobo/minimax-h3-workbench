import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readFile, stat, writeFile, unlink, mkdir, rm, realpath, open, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  shell,
  type IpcMainInvokeEvent
} from "electron";
import { AdapterRegistry } from "./backends/adapterRegistry";
import { mediaMime, parseByteRange } from "./modules/mediaRange";
import { RESOURCE_LINKS } from "../shared/resourceLinks";
import { describeError, isNetworkError } from "../shared/errors";
import type { ApiResponse, AppSettings, BackendKind, ChatMessage, GenerationRequest, LlmArtifactEvent, LlmDoneEvent, LlmPlanEvent, LlmQuestionEvent, LlmStreamEvent, LlmTasksEvent, LlmToolEvent, SecretName } from "../shared/types";
import { downloadAndInstall, onDownloadProgress } from "./modules/autoUpdater";
import { GenerationOrchestrator } from "./modules/generationOrchestrator";
import { checkLocalModels } from "./modules/localModels";
import { LlmService, chatAgent, type AgentQuestion, type AgentRunResult } from "./modules/llmService";
import { SettingsStore } from "./modules/settingsStore";
import { inspectEnvironment } from "./modules/systemInspector";
import { TaskStore } from "./modules/taskStore";
import { checkForUpdates, checkFrameworkUpdate } from "./modules/updateChecker";
import { renderHtml, renderPageText, clearBrowserFetchCache, probeHtmlArtifact, formatProbeReport } from "./modules/browserFetch";
import { searchWeb } from "./modules/webSearch";
import { buildAgentMemoryHint } from "./modules/agentMemory";
import { buildSections, diffWorldState, injectWorldState, type WorldStateSnapshot } from "./modules/worldState";
import { QuestionBridge } from "./modules/questionBridge";
import { artifactSessionDirName, pickLatestVersion } from "./modules/artifactDir";
import { applyExactEdit, sliceWithLineNumbers } from "./modules/artifactEdit";
import { PREVIEW_CSP } from "./modules/previewCsp";
import { resolveWithinRoot } from "./modules/safePath";
import { assertPublicHttpUrlResolved } from "./backends/resultUrl";
import { normalizeHistory } from "./modules/historyNormalize";
import { freezeTurn } from "./modules/stepSnapshot";
import { CONTENT_FILTER_GUIDANCE, contentFilterNotice, isContentFilterError, retryDelayMs, retryNotice } from "./modules/errorRecovery";
import { buildSystemPrompt } from "../shared/agentPrompt";
import { parseCsvRows as parseCsvRowsShared } from "../shared/csv";
import {
  activeContextTokens,
  advanceWindow,
  createContextWindowState,
  looksLikeContextOverflow,
  markWindowExceeded,
  recordBaseline,
  shouldCompact,
  type ContextSample,
  type ContextWindowState
} from "./modules/contextBudget";
import { buildCompactedHistory, summarizeHistory } from "./modules/compaction";
import { withPlanMode } from "../shared/planMode";
import { contextWindowFor } from "../shared/modelWindows";
import { sliceSafe } from "../shared/text";

/**
 * 每个会话的上下文预算状态（按 sessionId 隔离，对齐 Codex 的 per-thread window）。
 * 只存内存：压缩后的历史是可由原始 messages 重算的派生数据，落盘会变成脏状态
 * （CLAUDE.md「端点/路径类配置不存入设置」同一条纪律）。
 */
interface SessionContextBudget {
  window: ContextWindowState;
  /** 最近一次服务端 usage 样本 + 当时的消息条数，用于锚定真实 token 量。 */
  sample?: ContextSample;
  /** 上一次压缩产出的消息列表，及其对应的**原始 messages 条数**（续接游标）。 */
  compacted?: ChatMessage[];
  compactedThrough?: number;
}

/**
 * 主进程兜底：未处理的 Promise rejection 只记录，不让进程退出。
 *
 * 为什么需要：Node 15+ 对未处理 rejection 的默认行为是**终止进程**。
 * 本应用有大量"后台异步"路径（任务池、定时器、事件回调、工具循环的重试），
 * 一次漏写 `.catch()` 就会让软件凭空消失、且什么都不留下——本轮已实测修过
 * 三起同类（abort 回调、SSE 超时、runPool）。
 *
 * 为什么**不**兜 `uncaughtException`：未处理的 rejection 通常只是"某个调用忘了接"
 * （进程状态本身完好，继续跑是安全的）；而 uncaughtException 往往意味着状态已不一致，
 * 强行吞掉只会把崩溃推迟到一个更难复现的地方。
 */
process.on("unhandledRejection", (reason) => {
  console.error("[main] 未处理的 Promise rejection（已忽略，进程继续运行）：", describeError(reason, "未知错误"));
});

protocol.registerSchemesAsPrivileged([
  { scheme: "h3media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  // 产物预览专用协议。存在的理由（实测确认）：srcdoc / blob: / data: 加载的 iframe 会
  // **继承宿主的 CSP**，而宿主是 script-src 'self'（无 unsafe-inline）→ 预览页里的内联
  // <script> 被浏览器拦掉，游戏/小工具脚本根本不运行（用户报"预览时不能直接玩"就是这个）。
  // 按 CSP 规范，**URL 加载的文档用自己的策略**、不继承创建者——故改为协议 URL 加载。
  { scheme: "h3preview", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let mainWindow: BrowserWindow | undefined;
let adapters: AdapterRegistry | undefined;
let settingsCache: AppSettings | undefined; // 模块级：h3media/showItem 白名单与 registerIpc 共享

/**
 * 单实例锁：双击两次快捷方式时，第二个进程必须退出并把窗口带到前台。
 *
 * 不加会**真实损坏数据**：两个进程共享同一个 userData，各自持有内存态任务列表、
 * 各自 atomicWrite 同一个 `tasks.json` / `settings.json` / `secrets.json`。
 * SettingsStore/TaskStore 的串行队列只在**进程内**有效，跨进程完全挡不住
 * （实测 probe-double-instance：两个实例都能起来、同一 userData 并发写）。
 * E2E 用 H3_USER_DATA 传独立目录，且这里允许显式豁免，故不影响测试。
 */
const singleInstanceLock = process.env.H3_ALLOW_MULTI_INSTANCE === "1" ? true : app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  // E2E/多实例隔离：H3_USER_DATA 指定独立 userData 目录（settings/secrets/tasks 全随隔离）。
  if (process.env.H3_USER_DATA) app.setPath("userData", path.resolve(process.env.H3_USER_DATA));
  const settingsStore = new SettingsStore();
  void settingsStore.get().then((s) => { settingsCache = s; });

  adapters = new AdapterRegistry(settingsStore);
  const orchestrator = new GenerationOrchestrator(
    new TaskStore(),
    adapters,
    (task) => {
      // 与 sendToWindow 同一理由：窗口销毁后 send 会抛 "Object has been destroyed"。
      const target = mainWindow;
      if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
      target.webContents.send("task:update", task);
    }
  );
  await orchestrator.initialize();
  // h3media 只允许读取输出目录内的生成结果，防止渲染进程借协议读任意本地文件。
  const allowedMediaRoot = async () => path.resolve((settingsCache ?? await settingsStore.get()).outputDirectory);

  protocol.handle("h3media", async (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath || !path.isAbsolute(requestedPath)) return new Response("Invalid media path", { status: 400 });
    // 先解析符号链接再判白名单：只比对 path.resolve 的结果挡不住"目录内放一个软链指向外部"。
    const resolved = await resolveWithinRoot(await allowedMediaRoot(), requestedPath);
    // 用户改过输出目录后，历史结果仍留在原目录——按任务记录放行，否则整个历史都变成打不开的死链。
    if (!resolved && !knownOutputPaths(orchestrator).has(normalizeForCompare(requestedPath))) {
      return new Response("Path outside output directory", { status: 403 });
    }
    const filePath = resolved ?? path.resolve(requestedPath);
    // **必须自己实现 Range**：`net.fetch(file://…)` 不支持 Range——实测带
    // `Range: bytes=100-199` 仍返回 200、整个文件，且没有 Content-Range/Accept-Ranges。
    // 后果是视频拖动进度条完全失效（浏览器拿不到 206，只能重新从头加载）。
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return new Response("Not a file", { status: 404 });
      const size = info.size;
      const range = parseByteRange(request.headers.get("range"), size);
      if (range === "invalid") {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` }
        });
      }
      const headers = {
        "Content-Type": mediaMime(filePath),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      };
      // Response 只接受 **Web** ReadableStream；Node 的 createReadStream 必须过 `Readable.toWeb`
      // （直接强转会在运行时抛 "object.stream is not a function"）。
      if (!range) {
        // 无 Range：整文件。用流而不是 readFile——一个 2K/30 秒的成片可能上百 MB，
        // 一次性读进内存会让主进程明显卡顿。
        return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
          status: 200,
          headers: { ...headers, "Content-Length": String(size) }
        });
      }
      const { start, end } = range;
      return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`
        }
      });
    } catch {
      // 文件在任务记录里但已被用户删除：明确 404，让 <video> 显示加载失败而不是挂住。
      return new Response("Media not found", { status: 404 });
    }
  });

  // 产物预览协议：只服务 userData/artifacts/ 内的 HTML 文件。
  //
  // 为什么不用 srcDoc（实测确认的根因）：srcdoc / blob: / data: 加载的 iframe 会**继承宿主 CSP**，
  // 宿主是 script-src 'self'（无 unsafe-inline）→ 预览页里的内联 <script> 被浏览器拦掉，
  // 游戏/小工具脚本根本不运行（用户报"预览时不能直接玩"就是这个）。按 CSP 规范，
  // **URL 加载的文档用自己的策略**，故改走本协议；宿主 CSP 保持严格、预览仍是 sandbox 不透明源。
  const artifactRoot = () => path.join(app.getPath("userData"), "artifacts");
  protocol.handle("h3preview", async (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath || !path.isAbsolute(requestedPath)) return new Response("Invalid preview path", { status: 400 });
    // 符号链接安全的白名单校验：realpath 后比对，软链指向外部一律拒绝。
    const resolved = await resolveWithinRoot(artifactRoot(), requestedPath);
    if (!resolved) return new Response("Path outside artifacts directory", { status: 403 });
    // 只服务 HTML：预览 iframe 仅用于 html 产物，限制扩展名把暴露面压到最小。
    if (!/\.html?$/i.test(resolved)) return new Response("Only HTML preview is served", { status: 403 });
    try {
      const body = await readFile(resolved, "utf8");
      // CSP 由**响应头**下发（权威，内容无法构造影响），不注入 <meta>。
      // 内联脚本照跑（否则游戏动不了），但网络出口全封——产物由模型生成，按不可信内容对待。
      // nosniff：避免响应体内 content-type 被当成别的类型解释。
      return new Response(body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": PREVIEW_CSP,
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch {
      return new Response("Preview file not found", { status: 404 });
    }
  });

  // 回收站过期清理：删除超过 7 天的任务，连同输出文件一并清除。
  // 删文件的口径与 tasks:purge 一致：信任根是「当前输出目录 + 用户配置过的历史输出目录」，
  // 且逐个做 realpath 包含性校验（见 deleteRoots / unlinkIfInside）。
  //
  // **必须接住 rejection**：`purgeTasks` 内部 `await store.save(...)` 在磁盘满/只读时会抛
  // （save 刻意把写盘失败交给调用方），而这里是启动流程里的 fire-and-forget——
  // 裸 `void promise` 会变成未处理 rejection。虽然全局兜底会记日志不退出，
  // 但清理失败应当被记录下来，而不是混进"某个调用忘了接"的噪声里。
  void orchestrator.purgeExpired(async (filePath) => {
    const settings = await settingsStore.get();
    await unlinkIfInside(deleteRoots(settings), filePath);
  }).catch((error) => {
    console.error("[tasks] 回收站过期清理失败：", error instanceof Error ? error.message : error);
  });
  registerIpc(settingsStore, adapters, orchestrator);
  mainWindow = createWindow();
  await loadApp(mainWindow);

  const screenshotPath = process.env.H3_SCREENSHOT_PATH;
  if (screenshotPath) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const screenshotPage = process.env.H3_SCREENSHOT_PAGE;
    if (screenshotPage) {
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('[data-page="${screenshotPage.replace(/[^a-z-]/g, "")}"]')?.click()`
      );
    }
    if (process.env.H3_SCREENSHOT_ACTION === "detect") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('.hero .primary')?.click()`
      );
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const detectionFinished = await mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.runtime-estimate'))`
        );
        if (detectionFinished) break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, process.env.H3_SCREENSHOT_ACTION === "detect" ? 1_500 : 1800));
    await writeFile(screenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    app.quit();
  }
}).catch((error) => {
  // **启动失败必须让人看见**。
  //
  // 这个 async 回调里有若干可能真实失败的步骤：`orchestrator.initialize()` 读 tasks.json、
  // `settingsStore.get()`、创建窗口、`loadApp` 加载渲染产物。任何一步抛错都会让
  // 整个启动流程停在中途——没有窗口、没有日志窗口、没有任何界面，
  // 用户双击快捷方式看到的是"什么都没发生"（进程还活着，因为 unhandledRejection
  // 被兜住了，所以连崩溃提示都没有）。这正是最难排查的一类故障。
  //
  // 这里用系统对话框把原因与可执行的下一步直接摆出来，然后退出进程：
  // 留在半初始化状态比退出更糟（协议 handler / IPC 可能只注册了一半）。
  const message = describeError(error, "未知错误");
  console.error("[main] 启动失败：", message);
  dialog.showErrorBox(
    "MiniMax H3 工作台启动失败",
    `${message}\n\n可尝试：\n· 检查磁盘剩余空间与应用目录权限\n· 删除用户数据目录下的 settings.json / tasks.json 后重试（会重置设置）\n· 若反复出现，请附带本提示的完整内容反馈`
  );
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    void loadApp(mainWindow);
  }
});

app.on("before-quit", () => { adapters?.close(); void clearBrowserFetchCache(); });

function createWindow(): BrowserWindow {
  // 首帧底色跟随系统深浅色。主题选择存在渲染端 localStorage（主进程读不到），
  // 而默认值是「跟随系统」——用 nativeTheme 做首帧底色，深色用户不会先看到一块白。
  // 用户如果强制选了浅色/深色，渲染端加载后会覆盖，最多闪一帧同系统色的背景（远好于白闪）。
  const dark = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // 与 styles.css 的 `--canvas` 一致（浅色 #f7f8fa / 深色 #0f1114）。
    backgroundColor: dark ? "#0f1114" : "#f7f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // 页面内 `target="_blank"` / window.open：**一律不在应用内开新窗口**，
  // 但聊天里渲染的 Markdown 链接正是这个形态（markdown.tsx 的 <a target="_blank">）。
  // 无差别 deny 会让"点链接"彻底没反应——用户以为应用坏了。
  // 因此：只把 https 链接交给系统浏览器（与 shell:openExternal 同一道协议限制），其余一律拒绝。
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      // 必须 catch 到链末：`shell.openExternal` 在系统没有注册 https 处理器时会 reject，
      // 而这里没有调用方能接住 —— 裸 `void promise` 会变成未处理的 rejection。
      if (new URL(url).protocol === "https:") void shell.openExternal(url).catch(() => undefined);
    } catch {
      // 非法 URL：什么都不做，等同于 deny。
    }
    return { action: "deny" };
  });
  // 导航守卫：**只允许留在应用自己的页面**。
  //
  // 不能只比 origin：file:// 文档的 origin 全是 "null"，`null !== null` 为 false，
  // 于是 file:// → file:// 的任意本地文件导航会被放行（实测 probe-navigate-file：
  // 主窗口被导航到 C:/Windows/win.ini）。开发模式（VITE_DEV_SERVER_URL）下则放行同源。
  const isAllowedUrl = (target: string): boolean => {
    try {
      const next = new URL(target);
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      if (devUrl) {
        const dev = new URL(devUrl);
        if (next.origin === dev.origin) return true;
      }
      // 生产：只允许应用自身的 dist/index.html（file: 协议且路径一致）。
      if (next.protocol !== "file:") return false;
      const appUrl = new URL(pathToFileURL(path.join(__dirname, "../../dist/index.html")).toString());
      return decodeURIComponent(next.pathname).toLowerCase() === decodeURIComponent(appUrl.pathname).toLowerCase();
    } catch {
      return false;
    }
  };
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  });
  return window;
}

async function loadApp(window: BrowserWindow): Promise<void> {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(path.join(__dirname, "../../dist/index.html"));
}

function registerIpc(
  settingsStore: SettingsStore,
  registry: AdapterRegistry,
  orchestrator: GenerationOrchestrator
): void {
  // 智能体视频工具的兜底参数（具体 prompt/时长/数量由模型经工具入参给定）。
  // backend 在回调里按用户当前设置的 defaultBackend 填——不能写死（写死 rb 会让没买瞬映卡密的用户必然失败）。
  const initialAgentVideoRequest: Omit<GenerationRequest, "backend"> = {
    mode: "text",
    prompt: "",
    duration: 4,
    ratio: "16:9",
    resolution: "768P",
    width: 1280,
    height: 720,
    count: 1,
    baseSeed: 1
  };
  const backendKindLabel = (kind: BackendKind) => kind === "local" ? "本机 ComfyUI" : kind === "ssh" ? "SSH 远程显卡" : kind === "rb" ? "瞬映 RB" : "MiniMax H3";
  /**
   * 按后端约束夹取时长（智能体工具用）。
   *
   * 工具 schema 写的是 4–15 秒，但 RB 的 reference/tail_frame 只收 4/6/8，
   * 而 `validateRequest` 会直接拒绝其它值。智能体不传 preset（默认 reference），
   * 所以模型给 10 秒时会**建不出任务**——工具报错后模型常常换个说法重试同一时长，
   * 用户看到的是"一直失败"。
   * 夹到最近的合法值（10 → 8）比直接失败有用得多，且返回文案会如实复述实际时长。
   */
  const clampDurationForBackend = (kind: BackendKind, raw: number): number => {
    const value = Math.max(4, Math.min(15, Math.round(raw || 4)));
    if (kind !== "rb") return value;
    return [4, 6, 8].reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best), 4);
  };
  // 游乐场 LLM：按会话各建一个服务实例，互不干扰；流式分块经 llm:chunk 推送（带 sessionId），结束经 llm:done 推送。
  // 早期是单例 + 全局并发守卫，导致"一个会话在回复时其它会话完全不能发消息"；改为按会话隔离后天然支持并发。
  let llm: LlmService | undefined; // 共享实例：仅用于 llm:test / llm:models 这类无状态探测
  const sessionServices = new Map<string, LlmService>();
  /**
   * 会话实例的配置代次。`invalidateLlmSessions()` 会 +1。
   *
   * 光靠 `busy` 判断复不复用是不够的：正在回复的实例被保留下来后，
   * 那一轮结束时它仍留在表里——下一次发消息会**直接复用它**，
   * 用的还是改动前的 model / baseUrl / Key，用户改完设置发现"没生效"。
   * 带上代次后，陈旧实例在释放时不再被复用（`serviceForSession` 按代次重建）。
   */
  let serviceGeneration = 0;
  const sessionServicesGeneration = new Map<string, number>();
  const sessionAborters = new Map<string, AbortController>();
  /** 上下文预算：按会话隔离；随会话生命周期管理（见 llm:chat 与 llm:abort）。 */
  const sessionBudgets = new Map<string, SessionContextBudget>();
  const budgetFor = (sessionId: string): SessionContextBudget => {
    const existing = sessionBudgets.get(sessionId);
    if (existing) return existing;
    const created: SessionContextBudget = { window: createContextWindowState() };
    sessionBudgets.set(sessionId, created);
    return created;
  };
  /**
   * world state 快照：按会话隔离，只存内存。
   * 它只用于**节流正文刷新**（时间同天 / 余量同档时保持 system 前缀稳定），不决定要不要注入。
   * 重启后丢快照不是 bug——下一轮一律按"新正文"渲染，最多多花一次 token。
   */
  const sessionWorldState = new Map<string, WorldStateSnapshot>();
  /**
   * 交互提问桥：工具循环挂起等渲染端回答（`request_user_input`）。
   * 必须带超时——没有超时的话用户关窗走开会让该会话的取消器永久占着，
   * 那条会话从此再也发不出消息（同会话并发守卫一直拒绝）。
   */
  const questionBridge = new QuestionBridge();
  const rebuildLlm = async (): Promise<LlmService> => {
    const settings = await settingsStore.get();
    llm = new LlmService({
      baseUrl: settings.llm.baseUrl,
      apiKey: await settingsStore.getSecret("llmApiKey"),
      model: settings.llm.model,
      systemPrompt: settings.llm.systemPrompt,
      searchBaseUrl: settings.searchApi.baseUrl || undefined,
      searchApiKey: await settingsStore.getSecret("searchApiKey"),
      // 适配签名：`renderHtml(url, timeoutMs, signal)`，而 options 期望 `(url, signal)`。
      // 直接传 renderHtml 会把 signal 当成 timeoutMs（超时值变成对象 → 立即超时）。
      searchRenderHtml: (url, signal) => renderHtml(url, undefined, signal)
    });
    return llm;
  };
  // 会话级服务实例：同一会话内复用（LlmService.busy 只挡"同一会话"的并发），Key/地址变更后由 invalidate 清理重建。
  const serviceForSession = async (sessionId: string): Promise<LlmService> => {
    const existing = sessionServices.get(sessionId);
    // 只复用**同一代次**的实例：配置改过之后，旧实例即便还在（那一轮还没结束）
    // 也不能拿来发新消息，否则改动对用户就是"没生效"。
    if (existing && sessionServicesGeneration.get(sessionId) === serviceGeneration) return existing;
    const settings = await settingsStore.get();
    const service = new LlmService({
      baseUrl: settings.llm.baseUrl,
      apiKey: await settingsStore.getSecret("llmApiKey"),
      model: settings.llm.model,
      systemPrompt: settings.llm.systemPrompt,
      searchBaseUrl: settings.searchApi.baseUrl || undefined,
      searchApiKey: await settingsStore.getSecret("searchApiKey"),
      searchRenderHtml: (url, signal) => renderHtml(url, undefined, signal)
    });
    sessionServices.set(sessionId, service);
    sessionServicesGeneration.set(sessionId, serviceGeneration);
    return service;
  };
  const invalidateLlmSessions = () => {
    llm = undefined;
    // 代次 +1：让下面保留下来的"在途实例"在下一次发消息时**不再被复用**。
    // 只靠 `busy` 判断会留下隐患——那一轮结束后实例还在表里，下一次直接拿到旧配置
    // （model / baseUrl / Key 都是改之前的），用户改完设置发现"没生效"。
    serviceGeneration += 1;
    // **正在跑的会话实例不能丢**：普通对话的「停止」走的是 `sessionServices.get(id)?.abort()`
    // （`sessionAborters` 只覆盖智能体路径）。用户在回复过程中去「连接设置」点一次保存
    // 就会触发这里——`clear()` 之后那个实例再也找不回来，点「停止」毫无反应，
    // 只能等这一轮自己结束（长回答可达数分钟）。
    // 正在进行的实例保留到本轮结束（其 `.finally` 会自行清理），其余的照常丢弃。
    for (const [sessionId, service] of sessionServices) {
      if (!service.busy) {
        sessionServices.delete(sessionId);
        sessionServicesGeneration.delete(sessionId);
      }
    }
    // 换模型/换上游后，旧窗口的大小与基线全部作废——下一次对话从零重新锚定。
    sessionBudgets.clear();
    // world state 同理：换了模型就是换了一个"没见过这些环境事实"的对话方，必须重注入一遍。
    sessionWorldState.clear();
  };
  // 统一的窗口推送。**必须判 isDestroyed**：`mainWindow?.webContents.send(...)`
  // 在窗口销毁后仍会走到 webContents 上并抛 "Object has been destroyed"
  //（实测 probe-destroyed-window：持有 webContents 引用 send 成功、经 window 取则抛错）。
  // macOS 关窗后应用常驻、Windows 侧也可能在任务收尾时窗口已关，不兜住就会
  // 从发送路径抛进主进程（流式/任务回调里无人 catch）。
  const sendToWindow = (channel: string, payload: unknown) => {
    const target = mainWindow;
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    target.webContents.send(channel, payload);
  };
  const sendChunk = (event: LlmStreamEvent) => sendToWindow("llm:chunk", event);
  const sendDone = (event: LlmDoneEvent) => sendToWindow("llm:done", event);
  // 智能体工具调用开始：渲染端在气泡上实时显示"正在搜索/正在生成视频"（多步工具期间可达 15–25 秒黑屏）。
  const sendLlmTool = (event: LlmToolEvent) => sendToWindow("llm:tool", event);
  // 智能体工具建好任务后推送任务 id：游乐场把卡片挂到对应会话气泡上。
  const sendLlmTasks = (event: LlmTasksEvent) => sendToWindow("llm:tasks", event);
  // 步骤清单更新（update_plan）：渲染端在气泡上显示进度。
  const sendLlmPlan = (event: LlmPlanEvent) => sendToWindow("llm:plan", event);
  // 交互提问（request_user_input）：渲染端弹选择卡片；工具循环此刻正挂起等待回答。
  const sendLlmQuestion = (event: LlmQuestionEvent) => sendToWindow("llm:question", event);
  // 产出文件（create_file）：只推元数据，内容不回灌消息流（否则每轮重发给模型，白烧 token）。
  const sendLlmArtifact = (event: LlmArtifactEvent) => sendToWindow("llm:artifact", event);
  // LLM 连接测试（cc-switch 模式）：拉模型列表验证连通性——不发对话（不花钱），
  // 不受对话端点路径差异影响；/models 不通的服务商回退发一条最小对话。
  handle("llm:test", async () => {
    const service = await rebuildLlm();
    const start = Date.now();
    const settings = await settingsStore.get();
    try {
      const models = await service.listModels();
      if (models.ok) {
        return { ok: true, label: "游乐场 LLM", latencyMs: Date.now() - start, details: { model: settings.llm.model }, message: `连接成功（${Date.now() - start}ms），上游返回 ${models.models.length} 个模型。` };
      }
      // /models 不支持：回退发一条最小对话验证全链路（Key+模型名+端点）。
      let streamed = "";
      await service.chat([{ role: "user", content: "回复一个字：好" }], false, (event) => { streamed += event.delta; });
      if (!streamed.trim()) throw new Error("服务商未返回内容，请检查模型名称。");
      return { ok: true, label: "游乐场 LLM", latencyMs: Date.now() - start, details: { model: settings.llm.model }, message: `连接成功，模型已回复（${Date.now() - start}ms；该服务商不支持模型列表，走的对话验证）。` };
    } catch (error) {
      return { ok: false, label: "游乐场 LLM", latencyMs: Date.now() - start, details: {}, message: describeError(error, "连接失败") };
    }
  });
  // 从上游拉取模型列表（OpenAI 兼容 GET /models）；需先保存 Key。
  handle("llm:models", async () => {
    const service = await rebuildLlm();
    return service.listModels();
  });

  handle("settings:get", () => settingsStore.get());
  handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
    const next = await settingsStore.update(patch);
    settingsCache = next; // 同步刷新 h3media/showItem 白名单缓存，改输出目录后新结果立即可预览
    registry.invalidate(next);
    invalidateLlmSessions(); // LLM 配置可能已变，下一次对话按新配置重建
    return next;
  });
  handle("secret:set", async (_event, name: SecretName, value: string) => {
    await settingsStore.setSecret(name, value);
    registry.invalidate();
    invalidateLlmSessions(); // Key 可能已变，下一次对话按新 Key 重建
    return true;
  });
  handle("secret:has", (_event, name: SecretName) => settingsStore.hasSecret(name));
  // 对话框要用主窗口做父级（模态、居中）。**不能用 `mainWindow!` 断言**：
  // macOS 关窗后应用常驻、或窗口已销毁时，断言成非空只会在运行时抛
  // "Object has been destroyed"，一条英文错误直接透到「选择目录失败」的提示里。
  // Electron 的 `showOpenDialog` 有两个重载：带父窗口 与 不带父窗口，
  // 这里按窗口是否可用选择对应重载（不要 `as BrowserWindow` 硬塞 undefined）。
  const showOpen = async (options: Electron.OpenDialogOptions) => {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
  };
  handle("dialog:directory", async () => {
    const result = await showOpen({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle("dialog:file", async (_event, kind: "image" | "video" | "key" | "attachment") => {
    // 附件选择器的图片扩展名必须与 `attachment:read` 的图片白名单**逐项一致**：
    // 那边收 `.png/.jpg/.jpeg/.webp/.gif/.heic/.heif`，这里漏了 gif 时，
    // 选「图片与文本」过滤器根本看不到 .gif 文件（同一份能力，两处定义对不上）。
    const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif"];
    const filters = kind === "image"
      ? [{ name: "图片", extensions: IMAGE_EXTENSIONS }]
      : kind === "video"
        ? [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv"] }]
        : kind === "attachment"
          // 对话附件：图片 + 文本。此前这里用的是 "image"，而 attachment:read 明确支持
          // .txt/.md/.json/.csv/.srt/.vtt/.log —— 用户却根本选不到它们（能力存在但够不着）。
          ? [
              { name: "图片与文本", extensions: [...IMAGE_EXTENSIONS, "txt", "md", "json", "csv", "srt", "vtt", "log"] },
              { name: "所有文件", extensions: ["*"] }
            ]
          : [{ name: "SSH 私钥", extensions: ["pem", "key", "ppk", "*"] }];
    const result = await showOpen({ properties: ["openFile"], filters });
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle("environment:inspect", async () => {
    const settings = await settingsStore.get();
    return inspectEnvironment(settings.localComfyUrl, settings.outputDirectory);
  });
  handle("update:check", () => checkForUpdates(app.getVersion()));
  // 智能体框架独立更新检查：应用本体不更新时也报告框架新版本。
  handle("update:checkFramework", async () => {
    const { frameworkVersion } = await import("../shared/agentVersion.js");
    return checkFrameworkUpdate(frameworkVersion);
  });
  // 安装包下载进度转发到窗口。
  //
  // `autoUpdater` 的 `download-progress` 早就被封装成 `onDownloadProgress`，
  // 界面也备好了 `.download-progress` 样式，但**一直没有订阅方**：
  // 用户下载 100MB+ 安装包时只看到"正在下载更新…"，分不清在走还是卡住。
  // 订阅一次即常驻（listener 集合由模块持有，窗口重建也不重复注册）。
  onDownloadProgress((progress) => {
    sendToWindow("update:progress", progress);
  });
  handle("update:download-install", async () => {
    await downloadAndInstall();
    return true;
  });
  handle("resources:list", () => RESOURCE_LINKS);
  handle("models:check", async () => checkLocalModels((await settingsStore.get()).comfyuiRoot, RESOURCE_LINKS));
  handle("backend:test", async (_event, kind: BackendKind) => (await registry.get(kind)).test());
  handle("tasks:list", () => orchestrator.list());
  handle("tasks:submit", (_event, request: GenerationRequest) => orchestrator.submit(request));
  handle("tasks:cancel", (_event, id: string) => orchestrator.cancel(id));
  handle("tasks:retry", (_event, id: string) => orchestrator.retry(id));
  handle("tasks:setCategory", (_event, payload: { taskId: string; category: string }) => {
    // `String(obj)` 会把 `{...}` 变成字面量「[object Object]」并写进任务记录，
    // 随后出现在筛选条上（`projectCategories` 直接读 `task.category`）。
    // 入参来自 IPC，只接受字符串；其它类型按"清除分类"处理。
    const category = typeof payload?.category === "string" ? payload.category : "";
    return orchestrator.setCategory(payload?.taskId || "", category);
  });
  // 回收站：删除（软）→ 恢复 → 彻底清除。彻底删除的文件同样只允许输出目录内。
  handle("tasks:delete", (_event, ids: string[]) => orchestrator.deleteTasks(Array.isArray(ids) ? ids : []));
  handle("tasks:restore", (_event, ids: string[]) => orchestrator.restoreTasks(Array.isArray(ids) ? ids : []));
  handle("tasks:listDeleted", () => orchestrator.listDeleted());
  handle("tasks:purge", async (_event, ids: string[]) => {
    const settings = await settingsStore.get();
    // 删文件的白名单：当前输出目录 **或** 用户自己配置过的历史输出目录。
    // **不能**按"任务记录里的任意路径"放行：记录可能被篡改（含手改 tasks.json），
    // 而删除不可逆——读白名单宽松一点最多是多读一个文件，删白名单宽松就是任意文件删除。
    // 信任来源必须是用户显式配置过的目录（见 SettingsStore 对历史目录的维护）。
    const roots = deleteRoots(settings);
    const safeDelete = async (filePath: string) => {
      await unlinkIfInside(roots, filePath);
    };
    return orchestrator.purgeTasks(Array.isArray(ids) ? ids : [], safeDelete);
  });
  /**
   * 本轮实际发给模型的消息：压缩过就返回「上次压缩结果 + 其后新增」，否则原样。
   * 记账与显示都必须基于这一份——否则压缩后 UI 会拿原始长历史算占用，
   * 报出的比例与实际发出去的内容对不上。
   */
  function effectiveFor(session: string, messages: ChatMessage[]): ChatMessage[] {
    const budget = sessionBudgets.get(session);
    if (!budget?.compacted || budget.compactedThrough === undefined) return messages;
    if (messages.length < budget.compactedThrough) return messages; // 历史被改短（删消息），缓存作废
    return [...budget.compacted, ...messages.slice(budget.compactedThrough)];
  }

  /**
   * 上下文压缩前置检查：超阈值就把历史压成「保留的最近用户消息 + 交接摘要」。
   *
   * 记账要点（移植 Codex 的 AutoCompactWindow）：
   * - 锚定：以上一次服务端回报的 inputTokens 为基线，叠加其后新增消息的估算量
   *   （Codex 的 prefill_input_tokens + get_total_token_usage 同构）；
   * - 计入量：首个窗口算全量（Total），压缩过的窗口只算基线后的增量（BodyAfterPrefix）；
   * - 触发：计入量占「模型窗口 × 80%，或总量触达模型硬窗口；
   * - 压缩后开新窗口、基线清零，下一轮由新的服务端样本重新锚定。
   *
   * 压缩失败（摘要为空）不阻断对话——走占位摘要并在 UI 标注，绝不静默吞掉
   * （CLAUDE.md「失败必须可见」）。
   */
  async function maybeCompact(
    session: string,
    messages: ChatMessage[],
    trigger: "auto" | "manual",
    signal: AbortSignal
  ): Promise<{ messages: ChatMessage[]; info?: { before: number; after: number; windowNumber: number; reason: string } }> {
    const budget = budgetFor(session);
    const settings = await settingsStore.get();
    const modelLimit = contextWindowFor(settings.llm.model);
    const effective = effectiveFor(session, messages);
    const active = activeContextTokens(effective, budget.sample);
    const decision = shouldCompact({ activeInputTokens: active, state: budget.window, modelLimitTokens: modelLimit });

    if (trigger === "auto" && !decision.compact) return { messages: effective };

    // **历史太短就别压**：压缩产物是「保留的最近 user 消息 + 摘要」，
    // 而摘要本身至少几百 token。实测一段 21 token 的对话压完变成 375 token——
    // 不但没省，还白花一次摘要请求（真实计费）。
    // 门槛取"摘要的保守长度"：低于它时压缩不可能有净收益。
    //
    // **但 forceCompact 必须豁免**：上游已明确报过超窗，说明本地估算（含这条
    // "历史很短"的判断）在这条会话上不可信。此时再跳过压缩，下一轮会撞同一堵墙。
    const MIN_COMPACT_TOKENS = 2_000;
    if (!budget.window.forceCompact && active < MIN_COMPACT_TOKENS) {
      if (trigger === "manual") {
        // 手动触发要给反馈，否则用户点了「立即压缩」看不到任何反应。
        const info = { before: active, after: active, windowNumber: budget.window.windowNumber, reason: "历史较短，无需压缩" };
        sendToWindow("llm:compaction", { ...info, sessionId: session });
        return { messages: effective, info };
      }
      return { messages: effective };
    }

    // 压缩对象是**当前历史**（effective），不是渲染端传来的原始 messages。
    //
    // 为什么（实测踩到的坑）：渲染端永不裁剪会话，messages 会无界增长。若压缩原始 messages，
    // 第 2 次压缩会把**原始全量**再发一遍摘要（探针实测：第 1 次 44531 字符 → 第 2 次 44619 字符，
    // 不降反增），而不是在上一轮压缩结果上继续——既白烧 token，又可能让摘要请求自身超窗而失败。
    // 对齐 Codex：它压缩的是 `sess.clone_history()`（当前历史），压缩后即压缩结果。
    const summary = await summarizeHistory({ ...settings.llm, apiKey: await settingsStore.getSecret("llmApiKey") }, effective, signal);
    // **被用户中止时绝不能提交压缩结果**。
    //
    // `summarizeHistory` 对任何异常都返回空串（这是刻意的：压缩失败不该阻断对话）。
    // 但「用户点了停止」也会走那条路——此时摘要为空，下面会把历史换成
    // "（无可用摘要：… 此前对话细节已丢失）" 并写入 `budget.compacted`，
    // 于是**整段历史被永久替换成一行占位文案**，而请求本身其实已经取消了。
    // 用户只是点了下停止，回头发现对话内容没了。
    if (signal.aborted) return { messages: effective };
    const compacted = buildCompactedHistory(effective, summary);
    // **压缩没有净收益就不要提交**。
    //
    // `buildCompactedHistory` 只保留用户消息（助手回复与工具步骤全部丢弃），
    // 收益来自"丢掉那些助手内容"。若历史本身就是长用户消息（比如用户粘了一份长文档），
    // 保留部分 + 摘要可能比原历史还大——实测 2.8k → 2.9k。
    // 此时提交等于：白花一次摘要请求 + 把原始措辞换成二手摘要 + 占用不降。
    //
    // **两边必须用同一种口径**：`active` 可能以服务端样本为锚（`budget.sample`），
    // 而压缩结果是纯本地估算，直接比会拿"服务端实测"和"本地估算"相减。
    // 这里统一用本地估算器比较（同一把尺子），方向判断才是可靠的。
    const localBefore = activeContextTokens(effective, undefined);
    const afterTokens = activeContextTokens(compacted, undefined);
    // **上游明确报过超窗时不能跳过**：`forceCompact` 是"本地窗口表估小了、上游已经拒绝过"
    // 的唯一补救信号。此时哪怕这次压缩没有净收益，不提交也只会让下一轮继续撞同一堵墙
    // （用户看到的是"怎么发都不行"）。宁可换成摘要，也要让请求能发出去。
    const forced = budget.window.forceCompact === true;
    if (!forced && afterTokens >= localBefore) {
      if (trigger === "manual") {
        // 手动触发必须给反馈，否则用户点了「立即压缩」看不到任何反应。
        const info = { before: localBefore, after: localBefore, windowNumber: budget.window.windowNumber, reason: "压缩无收益（历史以你的消息为主），已保持原样" };
        sendToWindow("llm:compaction", { ...info, sessionId: session });
        return { messages: effective, info };
      }
      return { messages: effective };
    }
    budget.compacted = compacted;
    budget.compactedThrough = messages.length;
    budget.window = advanceWindow(budget.window);
    budget.sample = undefined; // 基线作废，等下一轮服务端样本重新锚定
    const info = {
      before: active,
      after: activeContextTokens(compacted, undefined),
      windowNumber: budget.window.windowNumber,
      // 摘要为空说明压缩请求失败——如实告知，别让用户以为上下文被完整保留了。
      reason: summary ? (trigger === "manual" ? "手动压缩" : decision.reason === "hard-window" ? "上下文已达模型上限" : "上下文接近上限") : "压缩失败（摘要不可用）"
    };
    sendToWindow("llm:compaction", { ...info, sessionId: session });
    return { messages: compacted, info };
  }

  // 游乐场：流式对话（异步跑完，期间 llm:chunk/llm:done 推送）、中断、附件读取。
  // agent 模式走 AI SDK 工具循环（web_search / generate_video），普通聊天走原路径零回归。
  handle("llm:chat", async (_event, messages: ChatMessage[], webSearch: boolean, agent: boolean, sessionId: string, browserSearch: boolean, planMode?: "plan" | "execute") => {
    // `planMode` 来自 IPC，类型没有保证：只写 `planMode ?? "none"` 时，
    // 任何非法字符串（"PLAN"、拼错的 "exectue"、对象）都会一路传下去——
    // `withPlanMode` 里 `mode === "plan"` 为假 → 走 `PLAN_EXECUTION_PROMPT`
    // （"计划已确认，开始执行"），而 `artifactKinds` / `chatAgent` 的 planMode
    // 又都按"不是 plan"处理。提示词与工具约束互相打架，模型行为不可预测。
    // 在边界收敛成三态之一。
    const planArg: "plan" | "execute" | undefined = planMode === "plan" ? "plan" : planMode === "execute" ? "execute" : undefined;
    // sessionId 由渲染端生成；缺失时退化成一次性的匿名会话（老调用方兼容），不再共用全局单例。
    // browserSearch=true 是「浏览器搜索」联网项：只用应用自带 Chromium 渲染抓取。
    // 与 webSearch 同开时浏览器渲染优先（实测渲染结果质量最稳）；只关掉浏览器搜索时才用 API/HTTP 链路。
    const browserOnly = Boolean(browserSearch);
    // 入参来自 IPC：history 必须是数组、每条 content 必须是字符串。
    // 下游 `normalizeHistory` 会 `.trim()`、`estimateTokens` 会 `.match()`，
    // 脏类型会以英文 TypeError 透到界面（"text.trim is not a function"）。
    const safeHistory = safeMessages(messages);
    const session = typeof sessionId === "string" && sessionId ? sessionId : `anon-${Math.random().toString(36).slice(2)}`;
    // 同一会话不允许并发（会往同一个气泡里写两股流）；不同会话各自独立，可同时生成。
    //
    // **守卫与登记必须同步完成**：`serviceForSession()` 内部会 await 读设置与密钥，
    // 若把 `sessionAborters.set` 放在它之后，两个同时到达的请求都会在 await 之前通过
    // `has()` 检查，双双进入同一会话（渲染端会把两股流写进同一个气泡）。
    if (sessionAborters.has(session)) throw new Error("该会话的上一轮回复还在进行中，请先停止或等待完成。");
    const controller = new AbortController();
    sessionAborters.set(session, controller);
    let service: LlmService;
    try {
      service = await serviceForSession(session);
      if (service.busy) throw new Error("该会话的上一轮回复还在进行中，请先停止或等待完成。");
    } catch (error) {
      // 这里抛错时没有任何分支的 finally 会跑，必须自己摘登记，
      // 否则该会话从此永久撞上面的守卫（与本轮已修的"读密钥失败"同一形态）。
      sessionAborters.delete(session);
      throw error;
    }
    const chunk = (event: LlmStreamEvent) => sendChunk({ ...event, sessionId: session });
    const done = (event: LlmDoneEvent) => sendDone({ ...event, sessionId: session });
    /**
     * 上游报"上下文超窗"（对齐 Codex 的 `ContextWindowExceeded` 触发源）时的统一处理：
     * 本地窗口表把窗口估小了 → 记录 forceCompact，下一轮 maybeCompact 会无条件压缩。
     *
     * 必须两条路径共用（普通对话 / 智能体）：此前只在普通对话里认，默认开启的智能体模式
     * 撞上超窗时既不记录也不压缩，会反复撞同一堵墙（用户看到的是"怎么发都不行"）。
     * @returns 是否确为超窗（true 表示调用方应停止本轮、不要再回落普通对话）。
     */
    const noteContextOverflow = (error: unknown): boolean => {
      if (controller.signal.aborted || !looksLikeContextOverflow(describeError(error, ""))) return false;
      // 本地模型表把窗口估小了——记下来，并在气泡里说清"下一轮会自动压缩"，
      // 而不是把上游的英文报错原样糊给用户。
      sessionBudgets.set(session, { ...budgetFor(session), window: markWindowExceeded(budgetFor(session).window) });
      chunk({ seq: 1, delta: "（本轮上下文超出模型可接受的长度。已记录，下一条消息会自动压缩历史后再发送；也可点输入框右侧的「上下文」按钮立即压缩。）\n\n" });
      return true;
    };
    // 上下文压缩前置：超阈值才动手，未超时原样透传（零回归）。
    // 放在这里而不是各分支内部，是为了普通对话与智能体共用同一套记账——两条路径吃的是同一份历史。
    // controller 已在上面（并发守卫处）创建并登记，这里不再重复建。
    let effective = safeHistory;
    try {
      effective = (await maybeCompact(session, safeHistory, "auto", controller.signal)).messages;
    } catch (error) {
      // 压缩链路异常绝不阻断对话：如实记录后按原历史继续。
      console.warn("[llm] 上下文压缩失败，按原始历史继续：", describeError(error, "未知错误"));
    }
    // 进轮时**一次性**读出本轮用到的配置与密钥，冻结成快照；之下所有分支与工具回调只读它。
    //
    // 为什么必须冻结（实测能复现的漂移，不是理论问题）：智能体一轮是多步循环，实测可达
    // 15–25 秒。搜索回调原先在**工具执行那一刻**才 `getSecret("searchApiKey")`——用户在这期间
    // 改了 Key，同一轮里前后两个工具就会用两个 Key，表现为"一个能搜到、一个搜不到"，无从解释。
    // 视频后端、模型名同理。对齐 Codex：TurnContext 在轮开始时冻结一次、整轮复用。
    //
    // 密钥只存内存快照、绝不打印（CLAUDE.md 红线）。非智能体路径不需要这些
    // （LlmService 自己读），故按 agent 条件读，不白做一次 safeStorage 解密。
    const turnSettings = await settingsStore.get();
    // 从这里到分支入口之间还有若干可能抛错的 await（读密钥、历史规范化）。
    // 而 `sessionAborters` 已在上面登记了本会话——不兜住的话，任何一处抛错都会让
    // 那个控制器**永远留在表里**，同会话之后每次发送都撞上"上一轮回复还在进行中"，
    // 用户只能重启应用。密钥解不开（换机器 / Local State 丢失）正好会走到这条路径。
    let llmApiKey = "";
    let searchApiKey = "";
    try {
      if (agent) {
        llmApiKey = await settingsStore.getSecret("llmApiKey");
        searchApiKey = await settingsStore.getSecret("searchApiKey");
      }
    } catch (error) {
      sessionAborters.delete(session);
      throw error;
    }
    const turn = freezeTurn({
      model: turnSettings.llm.model,
      browserOnly,
      webSearch: Boolean(webSearch),
      planMode: planArg ?? "none",
      baseUrl: agent ? turnSettings.llm.baseUrl : "",
      systemPrompt: agent ? turnSettings.llm.systemPrompt : "",
      searchBaseUrl: agent ? turnSettings.searchApi.baseUrl || "" : "",
      defaultBackend: agent ? turnSettings.defaultBackend : "local",
      llmApiKey,
      searchApiKey
    });
    // 历史规范化：丢空白残留、剥掉模型收不下的图片、修掉非法的首条 assistant。
    // 放在压缩之后——压缩会改写历史，规范化必须作用在**真正要发出去的那份**上。
    const normalized = normalizeHistory(effective, { model: turn.value.model });
    effective = normalized.messages;
    // `normalizeHistory` 可能把整段历史清空（全是 assistant 残留或空白消息时，实测返回 []）。
    // 空历史发出去上游只会回一条无意义的错误（"no messages"），用户看到的是"空回复"。
    // 保底：至少在末尾补一条占位 user 消息，让这一轮有内容可回。
    if (effective.length === 0) {
      effective = [{ role: "user", content: "（本轮没有可发送的对话内容，请提示用户重新输入。）" }];
    }
    // 剥掉了东西要如实告知（静默改动用户输入不可接受）：直接写进气泡开头。
    if (normalized.notes.length > 0) chunk({ seq: 0, delta: `${normalized.notes.join("\n")}\n\n` });
    if (!agent) {
      // 普通对话同样要能吃下"上游报超窗"这一信号（LlmService 用状态码+错误体摘要构造 message）。
      void service.chat(effective, webSearch || browserOnly, chunk, browserOnly)
        .then(() => done({ ok: true }))
        .catch((error: unknown) => {
          // 用户主动停止（abort）不算错误：正常收尾，不显示红色报错。
          const aborted = error instanceof DOMException && error.name === "AbortError";
          if (!aborted) noteContextOverflow(error);
          done({ ok: aborted, message: aborted ? undefined : describeError(error, "对话失败") });
        })
        .finally(() => { sessionAborters.delete(session); });
      return true;
    }
    // 智能体模式：AI SDK 多步工具循环。视频工具直接接 orchestrator（提交即返回任务 ID，卡片实时刷新）。
    // 工具支持自动检测：模型不支持工具调用（0 文本 + 0 工具调用）或 agent 路径异常但尚未输出任何内容时，
    // 自动用相同消息回落普通对话（runtime fallback）——避免出现"又是空回复"且对用户透明。
    // agent 不走 LlmService，绕过了它的 busy 检查，故上面已按会话登记取消器并挡住同会话并发。
    void (async () => {
      // 本轮配置一律读进轮时冻结的 turn.value，**不再**在分支里重新 settingsStore.get()
      // 或重新 getSecret()——那样读到的是"此刻"的值，会与轮开始时用的不一致。
      let agentSent = 0;
      let agentTaskCount = 0; // 本轮已建任务数：非 0 时不得整轮重试（否则会重复建任务）
      const agentSend = (event: LlmStreamEvent) => { agentSent += 1; chunk(event); };
      const sendTasks = (taskIds: string[]) => { agentTaskCount += taskIds.length; sendLlmTasks({ taskIds, sessionId: session }); };
      // world state：每轮都注入**完整**的环境事实（时间/联网/产物/余量）。
      //
      // **必须作为 user 消息片段注入，不能拼进 system prompt**（真实 key A/B 实测，见
      // worldState.ts 文件头）：拼进 system 时模型直接无视——问"今天几号"它答"我无法得知"，
      // 哪怕日期就在 system 里；作为 user 片段注入则每次都生效。Codex 也是作为对话片段注入的。
      //
      // 为什么"每轮完整"而不是"只发差异"：片段拼在**每轮重建**的请求里，不落盘、不累积。
      // 若照搬 Codex 的"没变就不发"，模型从第 2 轮起就再也看不到任何环境事实
      // （实测捕获请求体：第 1 轮含全部标记，第 2 轮一个都没有）。差异只用于**节流正文刷新**。
      //
      // 开关必须传真实生效值——提示词说"你可以联网"但工具表里已摘掉 web_search，
      // 模型会调一个不存在的工具、然后为"我调不了"道歉（CLAUDE.md 记过同类事故）。
      // 快照在本轮采样完成后才写回：中途抛错不应把"已注入"记成事实。
      //
      // 剩余上下文余量（对齐 Codex TokenBudgetRemainingContext）：让模型知道自己快没空间了，
      // 从而主动收尾而不是展开新工作。用与「上下文 N%」UI 完全相同的记账口径（同一份 sample/window），
      // 避免"界面说还剩 30%、模型以为还剩 90%"这种自相矛盾。
      const modelLimit = contextWindowFor(turn.value.model);
      const activeTokens = activeContextTokens(effective, budgetFor(session).sample);
      const worldDiff = diffWorldState(
        buildSections({
          webSearch: turn.value.webSearch,
          browserSearch: turn.value.browserOnly,
          searchApiReady: Boolean(turn.value.searchBaseUrl),
          artifactKinds: turn.value.planMode === "plan" ? [] : ["html（网页/小工具）", "xlsx（表格，由 csv/tsv 生成）", "md（文档）"],
          contextBudget: { remainingTokens: Math.max(0, modelLimit - activeTokens), modelLimitTokens: modelLimit }
        }),
        sessionWorldState.get(session)
      );
      const worldStateText = worldDiff.text;
      const agentOptions = {
        baseUrl: turn.value.baseUrl,
        apiKey: turn.value.llmApiKey,
        model: turn.value.model,
        // 提示词工程 = 智能体表现的最大杠杆（用户实测：同款国产模型接 Claude Code 明显更聪明，
        // 差距就在系统提示词与工具描述的打磨）。两段组装，顺序固定：
        //   ① 通用提示词（shared/agentPrompt.ts 的四层；用户自定义则整体替换）
        //   ② 历史使用习惯（从既有任务提炼，用户自定义提示词时仍追加）
        // 环境事实**不放这里**（实测被忽略），改由 injectWorldState 拼成 user 片段。
        // 最后再套 withPlanMode：本轮规则是强约束，放最末才不被稀释。
        systemPrompt: withPlanMode(buildSystemPrompt({
          custom: turn.value.systemPrompt,
          memoryHint: buildAgentMemoryHint(orchestrator.list())
        }), planArg),
        searchBaseUrl: turn.value.searchBaseUrl || undefined,
        searchApiKey: turn.value.searchApiKey
      };
      const agentCallbacks = {
        // 与普通对话共用同一条搜索链路：配了搜索 API 就优先用它，未配置则回落免 key 抓取 Bing/搜狗。
        // browserOnly（「浏览器搜索」联网项）时只用 Chromium 渲染，跳过 API 与 HTTP 直抓。
        // 读的是进轮时冻结的 Key（不是此刻重新解密的）——同一轮里多个搜索必须用同一个 Key。
        webSearch: async (query: string) => searchWeb(query, {
          apiBaseUrl: turn.value.searchBaseUrl || undefined,
          apiKey: turn.value.searchApiKey,
          // 适配签名：searchWeb 期望 `(url, signal)`，renderHtml 是 `(url, timeoutMs, signal)`。
          renderHtml: (url, signal) => renderHtml(url, undefined, signal),
          browserOnly: turn.value.browserOnly
        }, controller.signal),
        generateVideo: async (params: { prompt: string; duration: number; count: number }) => {
          const request: GenerationRequest = {
            ...initialAgentVideoRequest,
            // 跟随用户当前默认后端；不写死（写死 rb 会让没配瞬映卡密的用户必然失败）。
            backend: turn.value.defaultBackend,
            prompt: params.prompt,
            // 时长必须按**后端**约束夹取：工具 schema 允许 4–15 秒，但 RB 的
            // reference/tail_frame 只收 4/6/8（validateRequest 会直接拒）。
            // 不夹的话模型传 10 秒时任务根本建不出来，而工具报错后模型往往
            // 换个说法重试同一个时长，用户看到的是"一直失败"。
            duration: clampDurationForBackend(turn.value.defaultBackend, params.duration),
            count: Math.max(1, Math.min(4, Math.round(params.count || 1))),
            baseSeed: Math.floor(Math.random() * 1_000_000)
          };
          const response = await orchestrator.submit(request);
          // 把新任务 id 推给渲染端：对应会话气泡下直接挂结果卡片（工具文案承诺了"卡片将在下方实时显示"）。
          sendTasks(response.map((task) => task.id));
          // 返回文本带全量参数：模型据此在收尾时能准确复述任务细节（收尾质量），而不是含糊的"已创建"。
          return `已创建 ${response.length} 个视频生成任务：后端=${backendKindLabel(request.backend)}，时长=${request.duration} 秒，数量=${request.count} 路，画面描述="${params.prompt}"。任务卡片已实时显示在本会话气泡下方，完成后可直接预览与下载。请向用户简短确认这些任务参数（一两句话即可，不要重复长描述）。`;
        },
        // open_page（让模型能真正"打开浏览器"）：复用 browserFetch 的 Chromium 渲染。
        // 安全边界：只允许 http/https，**且必须拒绝内网地址**——URL 由模型生成（还可能被它刚抓到的
        // 网页内容提示注入诱导），而隐藏窗口是以主进程身份发请求的。不拦的话可以让我方去访问
        // http://127.0.0.1:8188（ComfyUI 控制面）或 http://169.254.169.254/（云元数据），
        // 再把响应原文交回对话。与结果下载那条 SSRF 同一类问题，故共用同一套私网判定。
        //
        // **取可见文本而不是整页 HTML**（实测 probe openpage-text-vs-html）：
        // 一个 120081 字符的页面里正文只有 35 字符，其余全是内联 script/style；
        // 截到 8 万字符后关键事实已被脚本挤掉，模型拿到的是一堆代码噪声。
        openPage: async (url: string) => {
          // **必须做 DNS 解析校验**，不能只比字面 hostname：
          // `127.0.0.1.nip.io` / `localtest.me` 这类公网通配 DNS 会把内网 IP 编进域名，
          // 字面看起来完全正常，解析后却落到 127.0.0.1。实测（probe-ssrf-nipio）
          // 旧的 `assertPublicHttpUrl` 放行了它，并真的读回了本机服务的内容。
          const parsed = await assertPublicHttpUrlResolved(url);
          // **必须传本轮取消信号**：`renderPageText(url, timeoutMs, signal)` 不传 signal 时
          // 用户点「停止」后隐藏窗口仍会跑满 45 秒（搜索链路早已接上信号，这里漏了）。
          // 期间该会话的取消器一直被占着，界面停在"正在打开网页"。
          const raw = await renderPageText(parsed.toString(), 45_000, controller.signal);
          const text = raw.trim();
          // 纯 canvas / 纯图片 / PDF 预览页的 innerText 可能是空的（或只有几个空白的换行）。
          // 直接返回空串会让模型以为"打开了但什么都没有"，接着凭记忆编内容。
          // 如实说明"取不到正文"，并给出可行的替代路径。
          if (!text) {
            return `已打开该网页，但页面上没有可提取的正文（可能是纯图片/画布/PDF 页面）。可以改用 web_search 搜索相关信息，或换一个以文字为主的链接。`;
          }
          // 用 sliceSafe：裸 slice 会切开 emoji 的代理对（实测 "a😀" 重复时切在 80000
          // 正好落在高代理项上），留下一个渲染成 � 的坏字符并回传给模型。
          return text.length > 80_000 ? `${sliceSafe(text, 80_000)}\n\n（页面过长已截断）` : text;
        },
        // create_file（文件产物工具）：模型对工具调用的信任远高于文字约定（实测：只靠提示词约定
        // 围栏代码块时模型会自我怀疑"没有文件写入工具"而道歉）。落盘直接复用 artifact:save 的
        // 同一逻辑——为避免 handler 内重复实现，抽出共享函数 saveArtifactFile。
        createFile: async (params: { kind: "html" | "csv" | "tsv" | "md" | "xlsx"; name: string; content: string }) => {
          const saved = await saveArtifactFile(session, params.name, params.content, params.kind === "csv" || params.kind === "tsv" ? "xlsx" : params.kind);
          // 只推**元数据**，不把内容回灌进消息流。旧做法 chunk 一段围栏代码块，导致：
          // ① 气泡里卡片与代码块重复显示；② 那段内容进会话历史、每轮重发给模型
          // （几十 KB 的 3D 页面 ≈ 每轮多烧上万 token，还会触发压缩）。内容已在磁盘上。
          const renderKind: "html" | "sheet" | "doc" =
            /\.html?$/i.test(saved.name) ? "html" : /\.xlsx$/i.test(saved.name) ? "sheet" : "doc";
          sendLlmArtifact({ name: saved.name, path: saved.path, size: saved.size, kind: renderKind, sessionId: session });
          return `文件已生成并保存：${saved.name}（${saved.size >= 1024 * 1024 ? `${(saved.size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(saved.size / 1024))}KB`}）。文件卡片已显示在对话中，用户可点「预览」查看或在文件夹中打开。**不要**把文件内容重复贴进回复——卡片已经承载了它。请用一两句话说明文件内容概要即可。`;
        },
        // inspect_artifact：把刚生成的网页**真的跑一遍**。
        //
        // 实测动机（probe-video-intent 真机，鹈鹕骑自行车）：模型写出 53KB 手写 WebGL 页面后，
        // 只能对用户说"我没有在浏览器里运行过这个文件，如果报着色器错误请告诉我"。它没说谎——
        // 之前确实没有任何让它验证自己产物的手段。Codex 的循环是"写 → 跑 → 看错误 → 修"，
        // 缺了"跑"这一环，第一版永远是没验证过的黑盒。这里补上：加载走**与预览面板同一个**
        // h3preview: 协议，所以自检受的限制就是用户预览时受的限制。
        //
        // 只接受**文件名**（不接受路径）：让模型自己解析任意路径等于给它开一个读文件的口子。
        // 会话目录由 `artifactSessionDirName` 决定，仍走 resolveWithinRoot 再做一次白名单。
        //
        // **名字对不上时必须回落找同主名的最新版本**（实测真机踩到）：模型修完 bug 会重新
        // `create_file` 同名文件，而 `uniqueArtifactPath` 不覆盖，落成 `名字 (2).html`。
        // 模型接着自检时往往还传原名——按精确匹配就会**跑旧版本**，然后回一句"自检通过"。
        // 那是静默的错误答案：模型据此告诉用户"已验证"，用户点开的却是仍带 bug 的上一版。
        // 这里的回落规则与渲染端 `foldArtifactVersions` 一致（同主名视为同一份文件的不同版本），
        // 并且**明确告知实际检查的是哪个文件**，让模型自己发现名字没对上。
        inspectArtifact: async (params: { name: string }) => {
          const dir = path.join(app.getPath("userData"), "artifacts", artifactSessionDirName(session));
          const safeName = path.basename(String(params.name || "").trim());
          if (!/\.html?$/i.test(safeName)) throw new Error("只能自检 html 产物（csv/md 没有可运行的脚本）。");
          let resolved = await resolveWithinRoot(dir, path.join(dir, safeName));
          let actualName = safeName;
          if (!resolved) {
            const fallback = await latestSiblingArtifact(dir, safeName);
            if (!fallback) throw new Error(`本会话里找不到产物「${safeName}」。请确认文件名（带扩展名）与 create_file 生成的一致。`);
            resolved = fallback.path;
            actualName = fallback.name;
          }
          // 与渲染端预览面板拼的是同一个 URL 形状：同一协议、同一 CSP。
          const url = `h3preview://artifact/?path=${encodeURIComponent(resolved)}`;
          const report = await formatProbeReport(await probeHtmlArtifact(url, 20_000, controller.signal));
          // **必须声明检查的是哪个文件**（实测真机：模型在自检反复报同一条错时，
          // 因为不知道工具到底加载了哪一份，花 4 步去怀疑"是不是命中了缓存/旧文件"，
          // 而我们事后核对磁盘——报错是真的，它自己的新文件里确实还留着那行）。
          // 报出文件名 + 文件大小 + 修改时间，模型就能自己判断"检的是不是我刚写的那份"。
          const info = await stat(resolved).catch(() => undefined);
          const stamp = info
            ? `（${info.size >= 1024 * 1024 ? `${(info.size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(info.size / 1024))}KB`}，修改于 ${new Date(info.mtimeMs).toLocaleTimeString("zh-CN", { hour12: false })}）`
            : "";
          const header = actualName === safeName
            ? `本次检查的文件：${actualName}${stamp}。\n\n`
            : `本次检查的文件：${actualName}${stamp}。\n（你给的「${safeName}」在本会话里不存在，上面是同名的**最新版本**。如果那不是你想验证的那份，请用准确文件名再调用一次。）\n\n`;
          return header + report;
        },
        // read_artifact / edit_artifact：改之前先读，改的时候只改那一处。
        //
        // 真机证据（鹈鹕案例）：模型为改一行 `M.identity`→`M.ident` 整份重写 40KB，
        // 结果新文件里**仍然留着那一处**；随后它断言"我重写后的文件里并没有这个写法"，
        // 把锅推给自检工具。根因是它**读不回**自己的文件，只能凭记忆改。
        // 这两个工具对齐 Codex `apply_patch`：给行号让人看得见，要求精确且唯一才写。
        readArtifact: async (params: { name: string; startLine?: number; endLine?: number }) => {
          const dir = path.join(app.getPath("userData"), "artifacts", artifactSessionDirName(session));
          const safeName = path.basename(String(params.name || "").trim());
          const resolved = await resolveWithinRoot(dir, path.join(dir, safeName));
          if (!resolved) throw new Error(`本会话里找不到产物「${safeName}」。请确认文件名（带扩展名）与 create_file 生成的一致。`);
          // xlsx 是二进制，读成文本没有意义——明确告知而不是吐乱码。
          if (/\.xlsx$/i.test(resolved)) throw new Error("表格产物是二进制，无法按文本读取；请用预览面板查看。");
          const raw = await readFile(resolved, "utf8");
          const slice = sliceWithLineNumbers(raw, params.startLine, params.endLine);
          return `文件：${safeName}（共 ${slice.totalLines} 行，本次显示第 ${slice.from}–${slice.to} 行）\n${slice.body}`;
        },
        editArtifact: async (params: { name: string; oldText: string; newText: string }) => {
          const dir = path.join(app.getPath("userData"), "artifacts", artifactSessionDirName(session));
          const safeName = path.basename(String(params.name || "").trim());
          const resolved = await resolveWithinRoot(dir, path.join(dir, safeName));
          if (!resolved) throw new Error(`本会话里找不到产物「${safeName}」。请确认文件名（带扩展名）与 create_file 生成的一致。`);
          if (/\.xlsx$/i.test(resolved)) throw new Error("表格产物是二进制，不支持局部编辑；请用 create_file 重新生成。");
          // 读改写在同一个串行队列里：AI SDK 会在一个 step 里并行执行多个 tool call，
          // 两个 edit 同时读同一份文件时后写的会覆盖前一个改动（与 create_file 同名覆盖同类）。
          return artifactWriteQueue.run(async (): Promise<string> => {
            const before = await readFile(resolved, "utf8");
            const outcome = applyExactEdit(before, params.oldText, params.newText);
            if (!outcome.ok) {
              // 失败要说清**为什么**、**在哪**，并给下一步动作——只说"失败"模型会盲目重试。
              if (outcome.reason === "empty-old") throw new Error("oldText 不能为空。");
              if (outcome.reason === "not-found") {
                throw new Error("在文件里找不到 oldText。内容必须逐字符一致（含缩进与空格）——请先用 read_artifact 读回原文，复制准确的片段再试。");
              }
              const where = outcome.lines.slice(0, 6).join("、");
              throw new Error(`oldText 在文件里出现了 ${outcome.count} 次（第 ${where} 行）。为了不改错位置，我拒绝执行。请把 oldText 连同上下各一行一起贴进去，让它只匹配一处。`);
            }
            await writeFile(resolved, outcome.text, "utf8");
            const after = await stat(resolved);
            // 让模型知道改完共几行 / 多大——据此判断是不是真的只动了那一处。
            const totalLines = outcome.text.split("\n").length;
            return `已修改 ${safeName}（第 ${outcome.line} 行，文件现为 ${totalLines} 行 / ${Math.max(1, Math.round(after.size / 1024))}KB）。建议立刻 inspect_artifact 自检一次，确认没有引入新报错。`;
          });
        },
        // update_plan：把任务拆解写出来让用户看得见进度。纯展示，不产生副作用。
        updatePlan: async (params: { explanation?: string; plan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> }) => {
          sendLlmPlan({ plan: params.plan, explanation: params.explanation, sessionId: session });
          const done = params.plan.filter((entry) => entry.status === "completed").length;
          return `步骤清单已更新（${done}/${params.plan.length} 已完成），用户能在对话里看到。继续执行下一步，不要在回复里重复整个清单。`;
        },
        // request_user_input：把选择题交给渲染端，挂起工具循环等用户回答。
        // 超时/跳过会 reject（见 QuestionBridge），execute 层把它翻译成"按最佳判断继续"。
        requestUserInput: async (params: { questions: AgentQuestion[] }) => {
          const requestId = randomUUID();
          // 先推事件再挂起：渲染端要拿到 requestId 才能回传答案。
          sendLlmQuestion({ requestId, questions: params.questions, sessionId: session });
          return questionBridge.ask(session, requestId, params.questions, controller.signal);
        }
      };
      let result: AgentRunResult | undefined;
      let agentError: unknown;
      let attempts = 0;
      // 整轮重试：智能体是多步工具循环，而 SDK 的 maxRetries 只覆盖"首个请求"——
      // 后续步骤（或重试那一次本身）撞上中转偶发 ECONNRESET 时，整轮会被一个抖动打挂，
      // 随即回落普通对话、视频生成意图就丢了。实测该中转的连接重置属低频偶发但会**连片出现**
      // （抖动窗口可持续 10 秒以上），所以除了放开次数还必须**在尝试之间退避等待**——
      // 背靠背的 3 次会在几秒内全部撞进同一个抖动窗口（实测复现过）。3 次 × 3 秒退避
      // ≈ 多扛 6 秒窗口；真错误（500）最多多等 3 秒才回落，可接受。
      while (attempts < 3) {
        if (attempts > 0) {
          // 重试前等待：让出抖动窗口。等待期间用户点停止要能立即退出（sleep 原生支持 signal）。
          // 时长取「服务端 retry-after」与「我们的 3 秒退避」的较大值（见 errorRecovery.retryDelayMs）：
          // 服务端在冷却窗口里会明确报数，不听它的就会在窗口内反复撞墙；但建议过长时不采纳，
          // 因为我们不延长重试次数——等 5 分钟实际等于放弃这一轮。
          const waitMs = retryDelayMs(agentError, 3_000);
          // 重试状态写进气泡：此前只写日志，用户看到的是一个静止的光标，像是卡死了。
          chunk({ seq: 0, delta: retryNotice(attempts, 3, waitMs) });
          try { await sleep(waitMs, undefined, { signal: controller.signal }); }
          catch { done({ ok: true }); return; }
        }
        attempts += 1;
        try {
          // 「浏览器搜索」也要暴露 web_search 工具：enableWebSearch 是"本轮允许联网"的总开关，
          // browserOnly 只是改变搜索的执行方式（只用 Chromium 渲染）。漏传会导致工具不暴露，
          // 模型只能凭训练知识回答"该商品尚未发布"——UI 实测抓到的就是这个 bug。
          // 工具调用开始即推送 llm:tool：气泡实时显示"正在搜索/正在生成视频"；完成时显示结果摘要（全链路透明）。
          // 环境事实拼成一条 user 消息附在**当轮**历史末尾（见 injectWorldState 的通道说明）。
          // 放在循环内：内容过滤重试会往 effective 追加改写指引，须基于最新历史注入。
          result = await chatAgent(agentOptions, injectWorldState(effective, worldStateText), agentCallbacks, agentSend, controller.signal, webSearch || browserOnly, (tool, input) => {
            sendLlmTool({ tool, input, phase: "start", sessionId: session });
          }, (tool, summary, ok) => {
            sendLlmTool({ tool, input: "", phase: "end", result: summary, ok, sessionId: session });
          }, planArg === "plan");
          break;
        } catch (error) {
          if (controller.signal.aborted) { done({ ok: true }); return; }
          agentError = error;
          // 上游报"上下文超窗"：与普通对话同一套处理（记录 forceCompact，下一轮无条件压缩）。
          // 必须在这里就停：重试同一段超长历史必然同样被拒，回落普通对话也会同样超窗——
          // 提前拦下，避免用户看到"发了半天全是同一堵墙"。追加提示即使已有输出也安全（不重发正文）。
          if (noteContextOverflow(error)) { done({ ok: true }); return; }
          // 内容被安全策略拒绝：原样重试同一个 prompt 必然同样被拒，得先注入改写指引。
          // 注入在历史末尾（作为一条普通 user 消息），下一轮重试就会带上它。
          //
          // **必须同样检查 `agentTaskCount === 0`**（与下面的网络重试一致）：
          // 本轮若已经通过 generate_video 建过任务，重试会**把任务再建一遍**——
          // 云端按次计费时等于替用户重复扣费（RB 还会重复扣卡密次数）。
          // 已建任务时不再重试，直接走下面的失败收尾，让用户看到真实原因。
          if (isContentFilterError(error) && attempts < 3 && agentSent === 0 && agentTaskCount === 0) {
            chunk({ seq: 0, delta: contentFilterNotice(attempts, 3) });
            effective = [...effective, { role: "user", content: CONTENT_FILTER_GUIDANCE }];
            continue;
          }
          const retryable = attempts < 3 && agentSent === 0 && agentTaskCount === 0 && isNetworkError(error);
          if (!retryable) break;
        }
      }
      if (!result) {
        // 已经出过内容就不能再补发普通对话（会与已流出的文本拼接成两份回答）。
        if (agentSent > 0) throw agentError;
        // 到此说明整轮重试后仍未成功（或本就不该重试）：如实报出原因再回落——
        // 原因可能是上游 5xx、连接重置、也可能服务商拒绝带 tools 的请求；统一说成
        // "模型不支持工具"会误导用户去换模型。（真"不支持工具"走下面全 0 分支，不抛错。）
        const reason = describeError(agentError, "智能体请求失败");
        chunk({ seq: 1, delta: `（智能体模式请求失败：${reason}，已自动改用普通对话模式）\n\n` });
        await service.chat(effective, webSearch || browserOnly, chunk, browserOnly);
        done({ ok: true });
        return;
      }
      if (agentSent === 0 && result.textLength === 0 && result.toolCalls === 0) {
        // 模型走了 agent 路径但没出文本也没出工具调用——基本就是不支持函数调用。自动回落普通对话。
        chunk({ seq: 1, delta: "（当前模型不支持工具调用，已自动改用普通对话模式）\n\n" });
        await service.chat(effective, webSearch || browserOnly, chunk, browserOnly);
        done({ ok: true });
        return;
      }
      if (agentSent === 0 && result.toolCalls > 0) {
        // 工具调成功了（任务卡片已经推给渲染端）但模型没再输出收尾文本：不能留空气泡让用户看到"（空回复）"。
        chunk({ seq: 1, delta: "已按你的要求创建视频生成任务，结果卡片在下方实时显示，也可到「生成工作台」查看。" });
      }
      // 撞上工具步数上限：模型还想继续干（最后一步 finishReason 仍是 tool-calls），是上限把它掐断的。
      // 不说明的话，用户看到的是一段**戛然而止**的回答，会以为软件卡了或模型答完了
      // （实测 probe-step-limit：打满 10 步后气泡停在"正在做第 10 步。"，没有任何提示）。
      // 用独立一段标明，并给出可操作的下一步，而不是让用户自己猜。
      if (result.hitStepLimit) {
        chunk({ seq: 1, delta: `\n\n---\n（本轮工具调用已达 10 步上限，任务可能还没做完。回复「继续」我就接着往下做；如果已经有可用的产物，也可以直接先看那个。）` });
      }
      // 服务端 usage 落账：本轮实测的输入 token 数 + 当时的消息条数，作为下次压缩判定的锚点。
      // 拿不到 usage 时不写样本——下一轮自动回落到字符估算（估算值不覆盖已有的服务端样本）。
      if (result.usage) {
        const budget = budgetFor(session);
        budget.sample = { serverInputTokens: result.usage.inputTokens, messageCount: effective.length };
        budget.window = recordBaseline(budget.window, result.usage.inputTokens, "server");
      } else {
        // 无 usage：用当前有效历史的估算量作基线（Codex set_estimated_prefill 的等价物）。
        const budget = budgetFor(session);
        budget.window = recordBaseline(budget.window, activeContextTokens(effective, undefined), "estimated");
      }
      // world state 快照写回：本轮已把这批环境事实发给了模型，下一轮只发差异。
      // 放在采样成功之后——中途失败没真正注入，不该记成"已注入"（否则下一轮会漏发）。
      sessionWorldState.set(session, worldDiff.snapshot);
      done({ ok: true });
    })().catch((error: unknown) => {
      const aborted = controller.signal.aborted;
      done({ ok: aborted, message: aborted ? undefined : describeError(error, "智能体对话失败") });
    }).finally(() => {
      // 收尾必摘：不摘的话该会话的取消器一直占着，同会话的并发守卫从此永久拒绝新对话。
      sessionAborters.delete(session);
    });
    return true;
  });
  // 取消：给了 sessionId 就只中止该会话（多会话并发时不能连坐），否则中止全部。
  handle("llm:abort", async (_event, sessionId?: string) => {
    if (sessionId) {
      // 挂起的选择题必须先放行：否则工具循环还在等回答，取消器摘不掉，该会话永久拒发新消息。
      questionBridge.cancelSession(sessionId);
      sessionAborters.get(sessionId)?.abort();
      sessionServices.get(sessionId)?.abort();
      return true;
    }
    for (const controller of sessionAborters.values()) controller.abort();
    for (const service of sessionServices.values()) service.abort();
    return true;
  });
  // 回传选择题答案：主进程的工具循环正挂起等这个调用，resolve 后模型继续往下走。
  handle("llm:answer", (_event, requestId: string, answers: Record<string, string[]>) => {
    // 返回 false 是正常竞态（超时后用户才点选），不抛错——抛错会在界面上弹一个无意义的失败提示。
    return questionBridge.answer(requestId, answers ?? {});
  });
  // 跳过整组问题：立即放行工具循环（模型按最佳判断继续），不必干等超时。
  handle("llm:skip-question", (_event, requestId: string) => questionBridge.skip(requestId));

  /**
   * 上下文占用查询：渲染端据此显示「上下文 42%」，并在超阈值时把压缩按钮点亮。
   * 返回的百分比以「模型窗口 × 80%」为分母——100% 即压缩触发点。
   */
  handle("llm:context-status", async (_event, messages: ChatMessage[], sessionId: string) => {
    const settings = await settingsStore.get();
    const session = typeof sessionId === "string" && sessionId ? sessionId : "anon";
    const budget = budgetFor(session);
    const modelLimit = contextWindowFor(settings.llm.model);
    // 与真正发给模型的那份保持同一口径（压缩后就是压缩结果 + 新增）。
    // 入参来自 IPC：`messages ?? []` 只挡 null/undefined，传对象/字符串时
    // 下游 `reduce` 会抛 "messages.reduce is not a function"（英文错误透到界面）。
    const active = activeContextTokens(effectiveFor(session, safeMessages(messages)), budget.sample);
    const decision = shouldCompact({ activeInputTokens: active, state: budget.window, modelLimitTokens: modelLimit });
    return {
      percent: Math.max(0, decision.percent),
      activeTokens: active,
      modelLimitTokens: modelLimit,
      windowNumber: budget.window.windowNumber,
      // 基线来源：server=已用上游实测值，estimated=纯本地估算（提示用户数字是估的）。
      baselineSource: budget.window.baselineSource
    };
  });

  /** 手动压缩：用户点「立即压缩上下文」时触发（对齐 Codex 的 Manual trigger）。 */
  handle("llm:compact", async (_event, messages: ChatMessage[], sessionId: string) => {
    const session = typeof sessionId === "string" && sessionId ? sessionId : "anon";
    const controller = new AbortController();
    try {
      const { info } = await maybeCompact(session, safeMessages(messages), "manual", controller.signal);
      return info ?? { before: 0, after: 0, windowNumber: 0, reason: "未触发压缩" };
    } catch (error) {
      throw new Error(describeError(error, "压缩失败"));
    }
  });

  handle("attachment:read", async (_event, filePath: string) => {
    if (!isAbsolutePath(filePath)) throw new Error("文件路径无效。");
    const extension = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    // 附件大小上限：图片 15MB、文本 2MB——base64 进内存且随 IPC 传输，超大文件会卡死渲染端。
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error("附件不存在或不是文件。");
    // 图片扩展名必须与 dialog:file 的选择器**保持一致**：选择器允许 heic/heif
    //（iPhone 默认格式），但这里漏了它们 → 用户选了照片却得到 kind:"other"
    //（只发文件名、不发图）。实测 probe-heic 复现。
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif"].includes(extension)) {
      if (info.size > 15 * 1024 * 1024) throw new Error("图片附件超过 15MB 上限，请压缩后再上传。");
      // **HEIC/HEIF 必须转码**：Chromium 不解码 HEIC（实测 <img> 直接 onerror），
      // 原样返回 `data:image/heic` 只会让用户看到一张破图，而模型也收不到图。
      // iPhone 默认就是 HEIC，用户根本不会意识到需要先转格式。
      if (extension === ".heic" || extension === ".heif") {
        const bytes = await readFile(filePath);
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) {
          throw new Error("这张 HEIC/HEIF 照片无法在本机解码（缺少系统 HEIF 支持）。请先转换为 JPG/PNG 后再上传。");
        }
        return { kind: "image", name, dataUrl: `data:image/jpeg;base64,${image.toJPEG(90).toString("base64")}` };
      }
      const mime = extension === ".png" ? "image/png"
        : extension === ".webp" ? "image/webp"
          : extension === ".gif" ? "image/gif"
            : "image/jpeg";
      return { kind: "image", name, dataUrl: `data:${mime};base64,${(await readFile(filePath)).toString("base64")}` };
    }
    if ([".txt", ".md", ".json", ".csv", ".srt", ".vtt", ".log"].includes(extension)) {
      if (info.size > 2 * 1024 * 1024) throw new Error("文本附件超过 2MB 上限，请只粘贴相关片段。");
      const raw = await readFile(filePath, "utf8");
      // 截断必须**如实上报**：原实现静默 `.slice(0, 100_000)`，用户以为整份文件都发给了模型，
      // 模型也只看到前一段——文件更长时两边都不知道（违反「出错/取舍必须让人看见」）。
      // 同样用 sliceSafe：这段正文会发回模型，不能留孤立代理项。
      const text = sliceSafe(raw, 100_000);
      return { kind: "text", name, text, truncated: raw.length > text.length };
    }
    return { kind: "other", name };
  });
  handle("shell:showItem", async (_event, filePath: string) => {
    if (!isAbsolutePath(filePath)) throw new Error("文件路径无效。");
    // 与 h3media 同类防护：只允许在输出目录、ComfyUI 模型目录或本应用产出过的结果路径内定位。
    const settings = await settingsStore.get();
    const roots = [settings.outputDirectory, settings.comfyuiRoot, path.join(app.getPath("userData"), "artifacts")]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value));
    const resolved = path.resolve(filePath);
    const insideRoot = roots.some((rootDir) => {
      const rel = path.relative(rootDir, resolved);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    // 同 h3media：改过输出目录后，历史结果仍应能"在文件夹中显示"。
    if (!insideRoot && !knownOutputPaths(orchestrator).has(normalizeForCompare(resolved))) {
      throw new Error("只能打开输出目录或 ComfyUI 模型目录中的位置。");
    }
    // `showItemInFolder` 对**已不存在的路径是静默空操作**：渲染端拿到 ok:true、
    // 界面上什么都没发生，用户以为按钮坏了（任务卡在结果被删/被移动后很常见）。
    // 显式检查一次，把"文件不在了"如实说出来。
    const exists = await stat(resolved).then(() => true).catch(() => false);
    if (!exists) throw new Error("该文件已不存在（可能已被删除或移动）。");
    shell.showItemInFolder(resolved);
    return true;
  });
  handle("shell:openExternal", async (_event, url: string) => {
    // 入参来自 IPC：`new URL(123)` 抛的是英文 `TypeError: Invalid URL`，
    // 会原样透到界面（与本轮修的 isAbsolutePath 同一类）。
    if (typeof url !== "string" || !url) throw new Error("链接地址无效。");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("链接地址无效。");
    }
    if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 链接。");
    await shell.openExternal(parsed.toString());
    return true;
  });
  // 把主窗口带到前台（系统通知点击后调用）。
  //
  // 渲染端的 `window.focus()` 只能在**已显示**的窗口里抢焦点；窗口最小化
  // （或应用在后台被系统压住）时它什么也做不了，用户点通知"没反应"。
  // 这里复用 `second-instance` 那套三步（restore / show / focus）。
  handle("window:focus", () => {
    const target = mainWindow;
    if (!target || target.isDestroyed()) return false;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    return true;
  });
  // 游乐场产物落盘：存 userData/artifacts/<sessionId>/，返回 {name,path,size} 供文件卡片展示。
  // 渲染端只传文本与文件名，路径由主进程生成——渲染端无法指定任意位置写文件。
  // kind: html/csv/tsv/md 写文本；xlsx 用 SheetJS 把 CSV 文本转成真 Excel 二进制（双击可开）。
  handle("artifact:save", async (_event, payload: { sessionId: string; name: string; content: string; kind: string }) => {
    // 入参来自 IPC（渲染端/可达调用方），类型没有保证：
    // - `payload` 为 null/undefined 时 `payload.sessionId` 会抛英文
    //   "Cannot read properties of undefined (reading 'sessionId')"；
    // - `content` 非字符串时 `writeFile` 抛 ERR_INVALID_ARG_TYPE（同样英文）。
    // 与 tasks:submit / secret:set 同一批修复口径：在边界翻成中文。
    if (!payload || typeof payload !== "object") throw new Error("产物参数无效。");
    if (typeof payload.sessionId !== "string") throw new Error("会话标识无效。");
    if (typeof payload.name !== "string") throw new Error("文件名必须是文本。");
    if (typeof payload.content !== "string") throw new Error("产物内容必须是文本。");
    if (typeof payload.kind !== "string") throw new Error("产物类型无效。");
    return saveArtifactFile(payload.sessionId, payload.name, payload.content, payload.kind);
  });
  // 读取已落盘产物的文本内容：表格/文档预览用（html 走 h3preview 协议，不需要读文本）。
  // 路径白名单与协议一致——只允许 userData/artifacts/ 内、且 realpath 后仍在根内的文件。
  handle("artifact:read", async (_event, filePath: string) => {
    const resolved = await resolveWithinRoot(path.join(app.getPath("userData"), "artifacts"), String(filePath || ""));
    if (!resolved) throw new Error("只能读取产物目录内的文件。");
    // xlsx 是二进制：表格产物落盘时转成了真 Excel（用户要"能双击打开"）。
    // 预览要的是表格文本，故用同一套 SheetJS 反向转回 CSV——避免"存得下、看不了"。
    if (/\.xlsx$/i.test(resolved)) {
      const XLSX = await loadXlsx();
      try {
        const book = XLSX.readFile(resolved);
        const first = book.SheetNames[0];
        if (!first) return { text: "" };
        const sheet = book.Sheets[first];
        // **必须自己限行**：`sheet_to_csv` 没有上限选项，整表转成字符串后要随 IPC
        // 传给渲染端。一个 10 万行 × 4 列的表格会转出十几 MB 文本——
        // 主进程拼一次、IPC 复制一次、渲染端再 JSON 解析一次，三份同时驻留。
        // 渲染端本来也只渲染前 500 行（`MAX_PREVIEW_ROWS`），这里多留些余量取 2000 行，
        // 并如实告知被截断了多少——不静默少给。
        //
        // **说明一定要放在 `note` 里，不能拼进 CSV 正文**：渲染端拿 `text` 直接喂
        // `parseCsvRows`，拼在末尾的一句话会被当成**一行数据**渲染出来
        // （实测：3 行表格变成 4 行，多出一行只有一列的怪文字）。
        const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
        const MAX_ROWS = 2_000;
        const rowCount = range.e.r - range.s.r + 1;
        if (rowCount > MAX_ROWS) {
          const capped = { ...sheet, "!ref": XLSX.utils.encode_range({ s: range.s, e: { r: range.s.r + MAX_ROWS - 1, c: range.e.c } }) };
          return {
            text: XLSX.utils.sheet_to_csv(capped),
            note: `表格共 ${rowCount} 行，预览仅解析前 ${MAX_ROWS} 行；完整内容可在文件夹中打开`
          };
        }
        return { text: XLSX.utils.sheet_to_csv(sheet) };
      } catch (error) {
        // SheetJS 对损坏文件抛的是英文内部错误（实测 "Unsupported ZIP encryption"）。
        // 预览面板会把它原样显示成"读取失败：Unsupported ZIP encryption"，
        // 用户既不知道原因也不知道怎么办。
        throw new Error(`表格文件已损坏或格式不受支持，无法读取（${error instanceof Error ? error.message : "未知错误"}）。可重新生成该表格。`);
      }
    }
    if (!/\.(html?|csv|tsv|md|txt|json)$/i.test(resolved)) throw new Error("该文件类型不支持文本预览。");
    // 文本预览也要有上限：整份读进内存再随 IPC 传给渲染端，异常大的文件
    // （手工替换、别的工具写进来）会让主进程与渲染进程同时吃力。
    // **只读前 1MB**，而不是"先全读再截断"——后者内存压力一点没省。
    // 预览是只读展示用途，截断比卡死好；xlsx 走 SheetJS 自己的解析路径（不受此限）。
    const MAX_PREVIEW_BYTES = 1024 * 1024;
    const textInfo = await stat(resolved).catch(() => undefined);
    if (textInfo && textInfo.size > MAX_PREVIEW_BYTES) {
      const handle = await open(resolved, "r");
      try {
        const buffer = Buffer.alloc(MAX_PREVIEW_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, MAX_PREVIEW_BYTES, 0);
        // 只截到完整字符边界：末尾可能被砍在多字节字符中间。
        const head = buffer.subarray(0, bytesRead).toString("utf8").replace(/�+$/, "");
        // 同 xlsx：截断说明走 `note`。表格预览拿 `text` 直接解析，拼进去会变成一行假数据。
        return {
          text: head,
          note: `文件较大，预览仅显示前 ${Math.round(MAX_PREVIEW_BYTES / 1024 / 1024 * 10) / 10}MB；完整内容可在文件夹中打开`
        };
      } finally {
        await handle.close();
      }
    }
    return { text: await readFile(resolved, "utf8") };
  });
  /**
   * 会话被彻底删除（用户点「彻底删除」或回收站 7 天到期）时清掉它的产物目录。
   *
   * 没有这一步的话 `userData/artifacts/<sessionId>/` 会**永久留盘**：
   * 会话记录已经从 localStorage 消失，界面里再也看不到、也无法重新打开，
   * 但磁盘上那些 HTML/Excel/文档一直在（模型生成一份 3D 页面就是几百 KB）。
   * 目录名走 `artifactSessionDirName()`——与落盘同一套规则，保证删的正是写进去的那个。
   */
  handle("artifact:purgeSession", async (_event, sessionId: string) => {
    const id = String(sessionId || "");
    // 顺带释放该会话的内存态：这几张表按 sessionId 建条目，
    // 只有"改配置/换模型"才会整体清空。会话被删掉之后条目仍在 →
    // 长期使用（反复新建/删除对话）会持续累积 LlmService 与快照对象。
    sessionServices.delete(id);
    sessionServicesGeneration.delete(id);
    sessionBudgets.delete(id);
    sessionWorldState.delete(id);
    const root = path.join(app.getPath("userData"), "artifacts");
    const target = path.join(root, artifactSessionDirName(id));
    // 再兜一层：resolve 后必须仍在 artifacts 根之下（规则若被改动，这里也不会越界）。
    const relative = path.relative(root, path.resolve(target));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    return true;
  });
}

/**
 * 产物落盘的会话目录名已抽到 `modules/artifactDir.ts`（便于单测目录名碰撞）。
 * 落盘与清理共用同一函数，保证删的正是写进去的那个。
 */

/** 产物落盘共享逻辑（artifact:save IPC 与 create_file 工具两路复用）：
 * 存 userData/artifacts/<sessionId>/，kind 白名单 html/csv/tsv/md/xlsx；xlsx 走 SheetJS 转 Excel 二进制。 */
async function saveArtifactFile(sessionId: string, name: string, content: string, kind: string): Promise<{ name: string; path: string; size: number }> {
  const extByKind: Record<string, string> = { html: ".html", csv: ".csv", tsv: ".tsv", md: ".md", xlsx: ".xlsx" };
  // **未知 kind 必须明确拒绝，不能静默落成 .html**。
  // 两个入口（`artifact:save` IPC 与 `create_file` 工具）都可能给出白名单外的值：
  // 旧写法 `extByKind[kind] || ".html"` 会把 "pdf" / "txt" / 空串都存成网页文件，
  // 而卡片按 kind 推断渲染方式——于是文件后缀与内容/渲染三者对不上，
  // 用户看到一张"HTML 文件"卡片点开却是一段纯文本。
  const ext = extByKind[kind];
  if (!ext) throw new Error(`不支持的产物类型：${kind || "（空）"}。支持 html / csv / tsv / md / xlsx。`);
  // 扩展名**必须与 kind 一致**：先剥掉名字里任何已知产物扩展名，再按 kind 补上正确的那个。
  //
  // 为什么不能"以任一扩展名结尾就保留"（实测踩到，probe-artifact-ext 复现）：
  // 模型常把表格命名为 "data.csv"，而 create_file 会把 csv/tsv 映射成 kind=xlsx——
  // 旧逻辑见 ".csv" 属已知扩展名就保留 → SheetJS 按扩展名把 **xlsx 二进制写进 .csv 文件**，
  // 卡片按 .csv 判为文档、预览读二进制成乱码；name="表格.tsv" 更会因 SheetJS 按扩展名判格式而**直接写失败**。
  // kind=html + name="page.md" 同理：落盘 page.md，卡片按 md 渲染一个 HTML 文件。
  let base = path.basename(String(name || "")).replace(/[\\/:*?"<>|]/g, "_").trim();
  base = base.replace(/\.(html?|csv|tsv|md|xlsx)$/i, "").trim();
  const safeName = `${base || "artifact"}${ext}`;
  // 目录名规则与清理共用同一函数（见 artifactDir.ts 的注释）。
  const dir = path.join(app.getPath("userData"), "artifacts", artifactSessionDirName(sessionId));
  await mkdir(dir, { recursive: true });
  // 同名不覆盖：同一会话里连着生成两份"报告.md"时，后者会把前者顶掉，
  // 于是**两张卡片指向同一个文件**、都显示第二版内容（实测 probe-dup-artifact）。
  // 这里探测重名并加 " (2)" / " (3)" 后缀，保证每次落盘都是独立文件。
  //
  // **探测与写入必须整体串行**：AI SDK 在同一个 step 里会并行执行多个 tool call，
  // 两个 create_file 同名时会在彼此 `stat` 之前都判"不重名"，然后写同一个路径——
  // 前者被静默覆盖，两张卡片显示同一份内容（与 probe-dup-artifact 的现象一样，
  // 只是成因不同）。串行化范围只需覆盖"取路径 + 落盘"这一小段。
  return artifactWriteQueue.run(async () => {
    const filePath = await uniqueArtifactPath(dir, safeName);
    // 返回的 name 必须取**实际落盘文件名**（可能带 " (2)" 序号）。
    // 用 safeName 会让卡片显示"报告.md"、磁盘上却是"报告 (2).md"——用户按卡片名去找
    // 文件会找不到（实测 probe-dup-xlsx）。
    const finalName = path.basename(filePath);
    if (kind === "xlsx") {
      // SheetJS：CSV 文本 → 工作簿 → xlsx 二进制。用户点名要"能保存成 .xlsx"，纯 CSV 落盘达不到。
      const XLSX = await loadXlsx();
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(parseCsvRows(content)), "Sheet1");
      XLSX.writeFile(book, filePath);
      const info = await stat(filePath);
      return { name: finalName, path: filePath, size: info.size };
    }
    await writeFile(filePath, content, "utf8");
    return { name: finalName, path: filePath, size: Buffer.byteLength(content, "utf8") };
  });
}

/**
 * 产物落盘的串行队列（进程级，与 TaskStore.save 同一套做法）。
 * 只用于把"重名探测 + 写文件"做成不可分割的一段，避免并发 tool call 互相覆盖。
 * 单次失败不能污染队列，否则后续所有落盘连坐失败。
 */
const artifactWriteQueue = (() => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const next = tail.then(operation, operation);
      tail = next.then(() => undefined, () => undefined);
      return next;
    }
  };
})();

/** CSV 文本 → string[][]：用共享解析器切行切格（正确处理引号字段与引号内的换行）。
 * 旧实现先 `split("\n")` 再朴素切逗号，有两个坑：
 * ① 含逗号的字段被错切成多列（xlsx 里的数据从落盘那一刻就是错的）；
 * ② 含**换行**的字段（SheetJS 会加引号跨行输出）被劈成两行，后续列全部错位。 */
function parseCsvRows(content: string): string[][] {
  return parseCsvRowsShared(content);
}

/**
 * 在目录内找一个不冲突的文件名：`报告.md` → `报告 (2).md` → `报告 (3).md`…
 *
 * 为什么需要：同一会话里连着让模型产出两份同名文件是常事（"再改一版报告"）。
 * 直接覆盖会让**两张卡片指向同一个路径**，点第一张看到的是第二版内容（实测复现）。
 * 上限 100 次，极端情况下退回带时间戳的名字，避免死循环。
 */
async function uniqueArtifactPath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; n <= 100; n += 1) {
    const candidate = path.join(dir, n === 1 ? fileName : `${stem} (${n})${ext}`);
    try {
      await stat(candidate);
      continue; // 已存在，试下一个
    } catch {
      return candidate; // 不存在 → 可用
    }
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * 找不到精确文件名时，找回**同一主名的最新版本**（`报告.html` → `报告 (3).html`）。
 *
 * 选版规则在 `artifactDir.pickLatestVersion`（纯函数、可单测，按数字比版本号）；
 * 这里只负责读目录 + 过白名单。**必须过白名单**：文件名是从目录列举出来的，
 * 仍要防"目录里被放了软链指向外部"。
 */
async function latestSiblingArtifact(dir: string, fileName: string): Promise<{ name: string; path: string } | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const name = pickLatestVersion(entries, fileName);
  if (!name) return undefined;
  const resolved = await resolveWithinRoot(dir, path.join(dir, name));
  return resolved ? { name, path: resolved } : undefined;
}

/**
 * 加载 SheetJS（xlsx）。
 *
 * **必须取 default**：`await import("xlsx")` 返回的命名空间里，cjs-module-lexer 只识别出
 * `read/write/writeFile/utils`，**没有 `readFile`**——而 `readFile` 只在 `default`（= module.exports）上。
 * 旧代码直接用命名空间调 `XLSX.readFile`，于是**每个 xlsx 产物的预览都报 "XLSX.readFile is not a function"**
 * （保存路径用的是 `writeFile`，恰好在命名空间上，所以"存得下、看不了"，实测 probe-xlsx-quoted 抓到）。
 * 统一走这里取 default，读写都拿到完整 API。
 */
async function loadXlsx(): Promise<typeof import("xlsx")> {
  const mod = (await import("xlsx")) as unknown as { default?: typeof import("xlsx") } & typeof import("xlsx");
  return (mod.default ?? mod) as typeof import("xlsx");
}

// h3media / showItem 白名单的补充放行集合：本应用自己产出过的结果路径。// 用户改过输出目录后，历史结果仍留在旧目录；只认当前目录会让历史视频全部变成打不开的死链。
// 安全性不降：放行的只是任务记录里记着的、由本应用写出的文件，渲染端仍无法随意读本地文件。
function knownOutputPaths(orchestrator: GenerationOrchestrator): Set<string> {
  const paths = new Set<string>();
  for (const task of [...orchestrator.list(), ...orchestrator.listDeleted()]) {
    if (task.outputPath) paths.add(normalizeForCompare(task.outputPath));
  }
  return paths;
}

// Windows 路径大小写不敏感：统一小写再比对，避免同一文件因盘符/目录大小写不同被判越界。
function normalizeForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 删除输出文件的信任根：**当前输出目录 + 用户自己配置过的历史输出目录**。
 *
 * 为什么不用 `knownOutputPaths()`（任务记录里的路径）：那份数据来自
 * `tasks.json`，可以被手工改写；而删除是**不可逆**的。
 * 读白名单放宽一点最多是多读一个文件，删白名单放宽就是任意文件删除。
 * 所以信任来源只能是用户在设置里显式填过的目录。
 */
function deleteRoots(settings: AppSettings): string[] {
  return Array.from(new Set([
    settings.outputDirectory,
    ...(settings.outputDirectoryHistory ?? [])
  ].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value))));
}

/**
 * 只在信任根内删除文件。**删除前做 realpath 包含性校验**（安全审查要求）：
 *
 * - 两侧都解析真实路径：候选文件若是指向外部的软链，`realpath` 后就不在根内 → 拒绝
 * - 根目录自身也解析：userData/输出目录可能被重定向到软链上
 * - 用 `path.relative` 判包含，同时排除"恰好等于根"与绝对路径（跨盘）两种越界
 * - 解析失败（文件不存在）直接跳过：本来就没有可删的东西
 */
async function unlinkIfInside(roots: string[], filePath: string): Promise<void> {
  let targetReal: string;
  try {
    targetReal = await realpath(filePath);
  } catch {
    return; // 文件不存在 / 无法解析：不删
  }
  for (const root of roots) {
    let rootReal: string;
    try {
      rootReal = await realpath(root);
    } catch {
      continue; // 该根目录不存在（用户删了旧目录）：跳过
    }
    const relative = path.relative(rootReal, targetReal);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    await unlink(targetReal).catch(() => undefined);
    return;
  }
}

/**
 * `path.isAbsolute` 的安全版本。
 *
 * Node 的 `path.isAbsolute(123)` 会抛 `ERR_INVALID_ARG_TYPE`（英文），
 * 而 `attachment:read` / `shell:showItem` 的入参直接来自 IPC，
 * 类型没有保证。先判字符串，再交给 path。
 */
function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value);
}

/**
 * IPC 入参的历史消息数组归一。
 *
 * `messages ?? []` 只挡 null/undefined：渲染端（或被构造的调用）传对象/字符串时，
 * 下游 `estimateMessagesTokens` 的 `reduce` 会抛 "messages.reduce is not a function"，
 * 这条英文错误会原样进到界面。同时把每条消息的 content 归一为字符串——
 * `estimateTokens` 内部 `.match()`、`normalizeHistory` 内部 `.trim()` 都要求字符串。
 */
function safeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message): message is ChatMessage => Boolean(message) && typeof message === "object")
    .map((message) => ({
      ...message,
      // `role` 也必须收敛：类型注释写着 `ChatRole`，但数组来自 IPC / 落盘历史，
      // 完全可能混进 "tool" / "developer" / 数字 / undefined（手改 localStorage、
      // 旧版本写脏、未来某处写入 bug）。上游对非法 role 一律 400，
      // 而这条历史会**每轮都发**——用户看到的是"这个会话再也发不出消息"，
      // 且错误文案与自己做的事毫无关系。未知 role 按 user 处理（内容仍在，语义最近）。
      role: message.role === "assistant" || message.role === "system" ? message.role : "user",
      content: typeof message.content === "string" ? message.content : "",
      images: Array.isArray(message.images) ? message.images.filter((url): url is string => typeof url === "string") : undefined
    }));
}

function handle<TArgs extends unknown[], TResult>(
  channel: string,
  action: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (event, ...args: TArgs): Promise<ApiResponse<TResult>> => {
    const requestId = randomUUID();
    try {
      return { ok: true, requestId, data: await action(event, ...args) };
    } catch (error) {
      return {
        ok: false,
        requestId,
        errorCode: "OPERATION_FAILED",
        message: describeError(error, "操作失败"),
        retryable: true
      };
    }
  });
}
