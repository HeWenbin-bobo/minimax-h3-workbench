import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent
} from "electron";
import { AdapterRegistry } from "./backends/adapterRegistry";
import { RESOURCE_LINKS } from "../shared/resourceLinks";
import { describeError, isNetworkError } from "../shared/errors";
import type { ApiResponse, AppSettings, BackendKind, ChatMessage, GenerationRequest, LlmArtifactEvent, LlmDoneEvent, LlmPlanEvent, LlmQuestionEvent, LlmStreamEvent, LlmTasksEvent, LlmToolEvent, SecretName } from "../shared/types";
import { downloadAndInstall } from "./modules/autoUpdater";
import { GenerationOrchestrator } from "./modules/generationOrchestrator";
import { checkLocalModels } from "./modules/localModels";
import { LlmService, chatAgent, type AgentQuestion, type AgentRunResult } from "./modules/llmService";
import { SettingsStore } from "./modules/settingsStore";
import { inspectEnvironment } from "./modules/systemInspector";
import { TaskStore } from "./modules/taskStore";
import { checkForUpdates, checkFrameworkUpdate } from "./modules/updateChecker";
import { renderHtml, clearBrowserFetchCache } from "./modules/browserFetch";
import { searchWeb } from "./modules/webSearch";
import { buildAgentMemoryHint } from "./modules/agentMemory";
import { buildSections, diffWorldState, injectWorldState, type WorldStateSnapshot } from "./modules/worldState";
import { QuestionBridge } from "./modules/questionBridge";
import { PREVIEW_CSP } from "./modules/previewCsp";
import { resolveWithinRoot } from "./modules/safePath";
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
    return net.fetch(pathToFileURL(resolved ?? path.resolve(requestedPath)).toString());
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

  // 回收站过期清理：删除超过 7 天的任务，连同输出目录内的视频文件一并清除（安全删除白名单内）。
  void orchestrator.purgeExpired(async (filePath) => {
    const settings = await settingsStore.get();
    const resolved = path.resolve(filePath);
    const root = path.resolve(settings.outputDirectory);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return; // 仅限输出目录内
    await unlink(resolved).catch(() => undefined);
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
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
  // 游乐场 LLM：按会话各建一个服务实例，互不干扰；流式分块经 llm:chunk 推送（带 sessionId），结束经 llm:done 推送。
  // 早期是单例 + 全局并发守卫，导致"一个会话在回复时其它会话完全不能发消息"；改为按会话隔离后天然支持并发。
  let llm: LlmService | undefined; // 共享实例：仅用于 llm:test / llm:models 这类无状态探测
  const sessionServices = new Map<string, LlmService>();
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
      searchRenderHtml: renderHtml
    });
    return llm;
  };
  // 会话级服务实例：同一会话内复用（LlmService.busy 只挡"同一会话"的并发），Key/地址变更后由 invalidate 清理重建。
  const serviceForSession = async (sessionId: string): Promise<LlmService> => {
    const existing = sessionServices.get(sessionId);
    if (existing) return existing;
    const settings = await settingsStore.get();
    const service = new LlmService({
      baseUrl: settings.llm.baseUrl,
      apiKey: await settingsStore.getSecret("llmApiKey"),
      model: settings.llm.model,
      systemPrompt: settings.llm.systemPrompt,
      searchBaseUrl: settings.searchApi.baseUrl || undefined,
      searchApiKey: await settingsStore.getSecret("searchApiKey"),
      searchRenderHtml: renderHtml
    });
    sessionServices.set(sessionId, service);
    return service;
  };
  const invalidateLlmSessions = () => {
    llm = undefined;
    sessionServices.clear();
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
  handle("dialog:directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle("dialog:file", async (_event, kind: "image" | "video" | "key" | "attachment") => {
    const filters = kind === "image"
      ? [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "heic", "heif"] }]
      : kind === "video"
        ? [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv"] }]
        : kind === "attachment"
          // 对话附件：图片 + 文本。此前这里用的是 "image"，而 attachment:read 明确支持
          // .txt/.md/.json/.csv/.srt/.vtt/.log —— 用户却根本选不到它们（能力存在但够不着）。
          ? [
              { name: "图片与文本", extensions: ["png", "jpg", "jpeg", "webp", "heic", "heif", "txt", "md", "json", "csv", "srt", "vtt", "log"] },
              { name: "所有文件", extensions: ["*"] }
            ]
          : [{ name: "SSH 私钥", extensions: ["pem", "key", "ppk", "*"] }];
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openFile"], filters });
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
  handle("tasks:setCategory", (_event, payload: { taskId: string; category: string }) =>
    orchestrator.setCategory(payload?.taskId || "", String(payload?.category || "")));
  // 回收站：删除（软）→ 恢复 → 彻底清除。彻底删除的文件同样只允许输出目录内。
  handle("tasks:delete", (_event, ids: string[]) => orchestrator.deleteTasks(Array.isArray(ids) ? ids : []));
  handle("tasks:restore", (_event, ids: string[]) => orchestrator.restoreTasks(Array.isArray(ids) ? ids : []));
  handle("tasks:listDeleted", () => orchestrator.listDeleted());
  handle("tasks:purge", async (_event, ids: string[]) => {
    const settings = await settingsStore.get();
    const safeDelete = async (filePath: string) => {
      const resolved = path.resolve(filePath);
      const root = path.resolve(settings.outputDirectory);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return; // 仅限输出目录内
      await unlink(resolved).catch(() => undefined);
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

    // 压缩对象是**当前历史**（effective），不是渲染端传来的原始 messages。
    //
    // 为什么（实测踩到的坑）：渲染端永不裁剪会话，messages 会无界增长。若压缩原始 messages，
    // 第 2 次压缩会把**原始全量**再发一遍摘要（探针实测：第 1 次 44531 字符 → 第 2 次 44619 字符，
    // 不降反增），而不是在上一轮压缩结果上继续——既白烧 token，又可能让摘要请求自身超窗而失败。
    // 对齐 Codex：它压缩的是 `sess.clone_history()`（当前历史），压缩后即压缩结果。
    const summary = await summarizeHistory({ ...settings.llm, apiKey: await settingsStore.getSecret("llmApiKey") }, effective, signal);
    const compacted = buildCompactedHistory(effective, summary);
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
    // sessionId 由渲染端生成；缺失时退化成一次性的匿名会话（老调用方兼容），不再共用全局单例。
    // browserSearch=true 是「浏览器搜索」联网项：只用应用自带 Chromium 渲染抓取。
    // 与 webSearch 同开时浏览器渲染优先（实测渲染结果质量最稳）；只关掉浏览器搜索时才用 API/HTTP 链路。
    const browserOnly = Boolean(browserSearch);
    const session = typeof sessionId === "string" && sessionId ? sessionId : `anon-${Math.random().toString(36).slice(2)}`;
    const service = await serviceForSession(session);
    // 同一会话不允许并发（会往同一个气泡里写两股流）；不同会话各自独立，可同时生成。
    if (sessionAborters.has(session) || service.busy) throw new Error("该会话的上一轮回复还在进行中，请先停止或等待完成。");
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
    const controller = new AbortController();
    sessionAborters.set(session, controller);
    let effective = messages;
    try {
      effective = (await maybeCompact(session, messages, "auto", controller.signal)).messages;
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
    const turn = freezeTurn({
      model: turnSettings.llm.model,
      browserOnly,
      webSearch: Boolean(webSearch),
      planMode: planMode ?? "none",
      baseUrl: agent ? turnSettings.llm.baseUrl : "",
      systemPrompt: agent ? turnSettings.llm.systemPrompt : "",
      searchBaseUrl: agent ? turnSettings.searchApi.baseUrl || "" : "",
      defaultBackend: agent ? turnSettings.defaultBackend : "local",
      llmApiKey: agent ? await settingsStore.getSecret("llmApiKey") : "",
      searchApiKey: agent ? await settingsStore.getSecret("searchApiKey") : ""
    });
    // 历史规范化：丢空白残留、剥掉模型收不下的图片、修掉非法的首条 assistant。
    // 放在压缩之后——压缩会改写历史，规范化必须作用在**真正要发出去的那份**上。
    const normalized = normalizeHistory(effective, { model: turn.value.model });
    effective = normalized.messages;
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
        }), planMode),
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
          renderHtml,
          browserOnly: turn.value.browserOnly
        }, controller.signal),
        generateVideo: async (params: { prompt: string; duration: number; count: number }) => {
          const request: GenerationRequest = {
            ...initialAgentVideoRequest,
            // 跟随用户当前默认后端；不写死（写死 rb 会让没配瞬映卡密的用户必然失败）。
            backend: turn.value.defaultBackend,
            prompt: params.prompt,
            duration: Math.max(4, Math.min(15, Math.round(params.duration || 4))),
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
        // 安全边界：只允许 http/https，渲染走独立 session 分区（browserFetch 内部保证），
        // 返回前截断到 8 万字符——超长 HTML 会撑爆模型上下文（百度首页渲染后 >1MB）。
        openPage: async (url: string) => {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只允许打开 http/https 网页。");
          const html = await renderHtml(parsed.toString(), 45_000);
          return html.length > 80_000 ? `${html.slice(0, 80_000)}\n\n（页面过长已截断）` : html;
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
          }, (tool, summary) => {
            sendLlmTool({ tool, input: "", phase: "end", result: summary, sessionId: session });
          }, planMode === "plan");
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
          if (isContentFilterError(error) && attempts < 3 && agentSent === 0) {
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
    const active = activeContextTokens(effectiveFor(session, messages ?? []), budget.sample);
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
      const { info } = await maybeCompact(session, messages ?? [], "manual", controller.signal);
      return info ?? { before: 0, after: 0, windowNumber: 0, reason: "未触发压缩" };
    } catch (error) {
      throw new Error(describeError(error, "压缩失败"));
    }
  });

  handle("attachment:read", async (_event, filePath: string) => {
    if (!path.isAbsolute(filePath)) throw new Error("文件路径无效。");
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
      const mime = extension === ".png" ? "image/png"
        : extension === ".webp" ? "image/webp"
          : extension === ".gif" ? "image/gif"
            : extension === ".heic" ? "image/heic"
              : extension === ".heif" ? "image/heif"
                : "image/jpeg";
      return { kind: "image", name, dataUrl: `data:${mime};base64,${(await readFile(filePath)).toString("base64")}` };
    }
    if ([".txt", ".md", ".json", ".csv", ".srt", ".vtt", ".log"].includes(extension)) {
      if (info.size > 2 * 1024 * 1024) throw new Error("文本附件超过 2MB 上限，请只粘贴相关片段。");
      return { kind: "text", name, text: (await readFile(filePath, "utf8")).slice(0, 100_000) };
    }
    return { kind: "other", name };
  });
  handle("shell:showItem", async (_event, filePath: string) => {
    if (!path.isAbsolute(filePath)) throw new Error("文件路径无效。");
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
    shell.showItemInFolder(resolved);
    return true;
  });
  handle("shell:openExternal", async (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 链接。");
    await shell.openExternal(url);
    return true;
  });
  // 游乐场产物落盘：存 userData/artifacts/<sessionId>/，返回 {name,path,size} 供文件卡片展示。
  // 渲染端只传文本与文件名，路径由主进程生成——渲染端无法指定任意位置写文件。
  // kind: html/csv/tsv/md 写文本；xlsx 用 SheetJS 把 CSV 文本转成真 Excel 二进制（双击可开）。
  handle("artifact:save", async (_event, payload: { sessionId: string; name: string; content: string; kind: string }) => {
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
      const book = XLSX.readFile(resolved);
      const first = book.SheetNames[0];
      return first ? XLSX.utils.sheet_to_csv(book.Sheets[first]) : "";
    }
    if (!/\.(html?|csv|tsv|md|txt|json)$/i.test(resolved)) throw new Error("该文件类型不支持文本预览。");
    return readFile(resolved, "utf8");
  });
}

/** 产物落盘共享逻辑（artifact:save IPC 与 create_file 工具两路复用）：
 * 存 userData/artifacts/<sessionId>/，kind 白名单 html/csv/tsv/md/xlsx；xlsx 走 SheetJS 转 Excel 二进制。 */
async function saveArtifactFile(sessionId: string, name: string, content: string, kind: string): Promise<{ name: string; path: string; size: number }> {
  const extByKind: Record<string, string> = { html: ".html", csv: ".csv", tsv: ".tsv", md: ".md", xlsx: ".xlsx" };
  const ext = extByKind[kind] || ".html";
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
  // sessionId 来自渲染端（可构造）。只取 basename 不够：`path.basename("..")` 仍返回 ".."，
  // join 后会把产物目录**抬到 userData 根**（实测复现）。这里再把危险字符与纯点段滤掉，
  // 保证落点始终在 artifacts 之下。
  const sessionDirName = path.basename(String(sessionId || "unknown")).replace(/[\\/:*?"<>|]/g, "_").trim();
  const safeSession = !sessionDirName || /^\.+$/.test(sessionDirName) ? "unknown" : sessionDirName;
  const dir = path.join(app.getPath("userData"), "artifacts", safeSession);
  await mkdir(dir, { recursive: true });
  // 同名不覆盖：同一会话里连着生成两份"报告.md"时，后者会把前者顶掉，
  // 于是**两张卡片指向同一个文件**、都显示第二版内容（实测 probe-dup-artifact）。
  // 这里探测重名并加 " (2)" / " (3)" 后缀，保证每次落盘都是独立文件。
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
}

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
