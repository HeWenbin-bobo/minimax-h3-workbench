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
import type { ApiResponse, AppSettings, BackendKind, ChatMessage, GenerationRequest, LlmDoneEvent, LlmStreamEvent, LlmTasksEvent, LlmToolEvent, SecretName } from "../shared/types";
import { downloadAndInstall } from "./modules/autoUpdater";
import { GenerationOrchestrator } from "./modules/generationOrchestrator";
import { checkLocalModels } from "./modules/localModels";
import { LlmService, chatAgent } from "./modules/llmService";
import { SettingsStore } from "./modules/settingsStore";
import { inspectEnvironment } from "./modules/systemInspector";
import { TaskStore } from "./modules/taskStore";
import { checkForUpdates, checkFrameworkUpdate } from "./modules/updateChecker";
import { renderHtml, clearBrowserFetchCache } from "./modules/browserFetch";
import { searchWeb } from "./modules/webSearch";
import { buildAgentMemoryHint } from "./modules/agentMemory";

protocol.registerSchemesAsPrivileged([
  { scheme: "h3media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

let mainWindow: BrowserWindow | undefined;
let adapters: AdapterRegistry | undefined;
let settingsCache: AppSettings | undefined; // 模块级：h3media/showItem 白名单与 registerIpc 共享

app.whenReady().then(async () => {
  // E2E/多实例隔离：H3_USER_DATA 指定独立 userData 目录（settings/secrets/tasks 全随隔离）。
  if (process.env.H3_USER_DATA) app.setPath("userData", path.resolve(process.env.H3_USER_DATA));
  const settingsStore = new SettingsStore();
  void settingsStore.get().then((s) => { settingsCache = s; });

  adapters = new AdapterRegistry(settingsStore);
  const orchestrator = new GenerationOrchestrator(
    new TaskStore(),
    adapters,
    (task) => mainWindow?.webContents.send("task:update", task)
  );
  await orchestrator.initialize();
  // h3media 只允许读取输出目录内的生成结果，防止渲染进程借协议读任意本地文件。
  const allowedMediaRoot = async () => path.resolve((settingsCache ?? await settingsStore.get()).outputDirectory);

  protocol.handle("h3media", async (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath || !path.isAbsolute(requestedPath)) return new Response("Invalid media path", { status: 400 });
    const resolved = path.resolve(requestedPath);
    const mediaRoot = await allowedMediaRoot();
    // path.relative 为空或以 .. 开头 = 目标不在根内；用分隔符判断避免 "C:\out2" 误匹配 "C:\out" 前缀。
    const relative = path.relative(mediaRoot, resolved);
    const outside = !relative || relative.startsWith("..") || path.isAbsolute(relative);
    // 用户改过输出目录后，历史结果仍留在原目录——按任务记录放行，否则整个历史都变成打不开的死链。
    if (outside && !knownOutputPaths(orchestrator).has(normalizeForCompare(resolved))) {
      return new Response("Path outside output directory", { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
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
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (new URL(url).origin !== new URL(current).origin) event.preventDefault();
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
  };
  const sendChunk = (event: LlmStreamEvent) => mainWindow?.webContents.send("llm:chunk", event);
  const sendDone = (event: LlmDoneEvent) => mainWindow?.webContents.send("llm:done", event);
  // 智能体工具调用开始：渲染端在气泡上实时显示"正在搜索/正在生成视频"（多步工具期间可达 15–25 秒黑屏）。
  const sendLlmTool = (event: LlmToolEvent) => mainWindow?.webContents.send("llm:tool", event);
  // 智能体工具建好任务后推送任务 id：游乐场把卡片挂到对应会话气泡上。
  const sendLlmTasks = (event: LlmTasksEvent) => mainWindow?.webContents.send("llm:tasks", event);
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
  handle("dialog:file", async (_event, kind: "image" | "video" | "key") => {
    const filters = kind === "image"
      ? [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "heic", "heif"] }]
      : kind === "video"
        ? [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv"] }]
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
  // 游乐场：流式对话（异步跑完，期间 llm:chunk/llm:done 推送）、中断、附件读取。
  // agent 模式走 AI SDK 工具循环（web_search / generate_video），普通聊天走原路径零回归。
  handle("llm:chat", async (_event, messages: ChatMessage[], webSearch: boolean, agent: boolean, sessionId: string, browserSearch: boolean) => {
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
    if (!agent) {
      void service.chat(messages, webSearch || browserOnly, chunk, browserOnly)
        .then(() => done({ ok: true }))
        .catch((error: unknown) => {
          // 用户主动停止（abort）不算错误：正常收尾，不显示红色报错。
          const aborted = error instanceof DOMException && error.name === "AbortError";
          done({ ok: aborted, message: aborted ? undefined : describeError(error, "对话失败") });
        });
      return true;
    }
    // 智能体模式：AI SDK 多步工具循环。视频工具直接接 orchestrator（提交即返回任务 ID，卡片实时刷新）。
    // 工具支持自动检测：模型不支持工具调用（0 文本 + 0 工具调用）或 agent 路径异常但尚未输出任何内容时，
    // 自动用相同消息回落普通对话（runtime fallback）——避免出现"又是空回复"且对用户透明。
    // agent 不走 LlmService，绕过了它的 busy 检查，故这里按会话登记取消器并挡住同会话并发。
    const controller = new AbortController();
    sessionAborters.set(session, controller);
    void (async () => {
      const settings = await settingsStore.get();
      let agentSent = 0;
      let agentTaskCount = 0; // 本轮已建任务数：非 0 时不得整轮重试（否则会重复建任务）
      const agentSend = (event: LlmStreamEvent) => { agentSent += 1; chunk(event); };
      const sendTasks = (taskIds: string[]) => { agentTaskCount += taskIds.length; sendLlmTasks({ taskIds, sessionId: session }); };
      const agentOptions = {
        baseUrl: settings.llm.baseUrl,
        apiKey: await settingsStore.getSecret("llmApiKey"),
        model: settings.llm.model,
        // 历史感知（候选 4）：从既有任务提炼常用时长/数量/后端/主题，注入系统提示词；
        // 用户自定义 systemPrompt 优先，习惯提示只作追加。
        // 产物交付方式（Excel/网页/文档）必须写进提示词——否则模型不知道自己有文件能力，
        // 用户说"生成 Excel"时只会道歉推脱（实测），智能程度全靠自我认知。
        systemPrompt: `${settings.llm.systemPrompt || `你是 MiniMax H3 工作台的智能助手，像 Codex / Claude Code 一样主动完成用户的各种任务。你的能力：
1. 生成 AI 视频：调用 generate_video 工具（4–15 秒、1–4 路）。
2. 联网搜索：调用 web_search 工具查实时资料。
3. 打开网页：调用 open_page 工具抓取指定网址的页面内容。
4. 生成文件产物（Excel / 网页 / Word 文档）：直接把完整内容写进代码块，界面会自动把它变成可预览、可保存的文件卡片——
   - Excel/表格：把数据写成 \`\`\`csv 代码块（首行为表头），会保存为 .xlsx 文件，Excel 可直接打开；
   - 网页/小工具/游戏：写成 \`\`\`html 完整网页代码块，可在侧栏预览并直接交互（支持 JS）；
   - Word/文档：写成 \`\`\`markdown 代码块，会保存为 .md 文件（Word 可打开）。
用户要文件时不要道歉或教他自己去做——你直接生成。复杂任务拆步骤、主动调用工具，别一口气问一堆问题。`}${buildAgentMemoryHint(orchestrator.list())}`,
        searchBaseUrl: settings.searchApi.baseUrl || undefined,
        searchApiKey: await settingsStore.getSecret("searchApiKey")
      };
      const agentCallbacks = {
        // 与普通对话共用同一条搜索链路：配了搜索 API 就优先用它，未配置则回落免 key 抓取 Bing/搜狗。
        // browserOnly（「浏览器搜索」联网项）时只用 Chromium 渲染，跳过 API 与 HTTP 直抓。
        webSearch: async (query: string) => searchWeb(query, {
          apiBaseUrl: settings.searchApi.baseUrl || undefined,
          apiKey: await settingsStore.getSecret("searchApiKey"),
          renderHtml,
          browserOnly
        }, controller.signal),
        generateVideo: async (params: { prompt: string; duration: number; count: number }) => {
          const request: GenerationRequest = {
            ...initialAgentVideoRequest,
            // 跟随用户当前默认后端；不写死（写死 rb 会让没配瞬映卡密的用户必然失败）。
            backend: settings.defaultBackend,
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
        }
      };
      let result: { textLength: number; toolCalls: number } | undefined;
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
          try { await sleep(3_000, undefined, { signal: controller.signal }); }
          catch { done({ ok: true }); return; }
        }
        attempts += 1;
        try {
          // 「浏览器搜索」也要暴露 web_search 工具：enableWebSearch 是"本轮允许联网"的总开关，
          // browserOnly 只是改变搜索的执行方式（只用 Chromium 渲染）。漏传会导致工具不暴露，
          // 模型只能凭训练知识回答"该商品尚未发布"——UI 实测抓到的就是这个 bug。
          // 工具调用开始即推送 llm:tool：气泡实时显示"正在搜索/正在生成视频"；完成时显示结果摘要（全链路透明）。
          result = await chatAgent(agentOptions, messages, agentCallbacks, agentSend, controller.signal, webSearch || browserOnly, (tool, input) => {
            sendLlmTool({ tool, input, phase: "start", sessionId: session });
          }, (tool, summary) => {
            sendLlmTool({ tool, input: "", phase: "end", result: summary, sessionId: session });
          });
          break;
        } catch (error) {
          if (controller.signal.aborted) { done({ ok: true }); return; }
          agentError = error;
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
        await service.chat(messages, webSearch || browserOnly, chunk, browserOnly);
        done({ ok: true });
        return;
      }
      if (agentSent === 0 && result.textLength === 0 && result.toolCalls === 0) {
        // 模型走了 agent 路径但没出文本也没出工具调用——基本就是不支持函数调用。自动回落普通对话。
        chunk({ seq: 1, delta: "（当前模型不支持工具调用，已自动改用普通对话模式）\n\n" });
        await service.chat(messages, webSearch || browserOnly, chunk, browserOnly);
        done({ ok: true });
        return;
      }
      if (agentSent === 0 && result.toolCalls > 0) {
        // 工具调成功了（任务卡片已经推给渲染端）但模型没再输出收尾文本：不能留空气泡让用户看到"（空回复）"。
        chunk({ seq: 1, delta: "已按你的要求创建视频生成任务，结果卡片在下方实时显示，也可到「生成工作台」查看。" });
      }
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
      sessionAborters.get(sessionId)?.abort();
      sessionServices.get(sessionId)?.abort();
      return true;
    }
    for (const controller of sessionAborters.values()) controller.abort();
    for (const service of sessionServices.values()) service.abort();
    return true;
  });  handle("attachment:read", async (_event, filePath: string) => {
    if (!path.isAbsolute(filePath)) throw new Error("文件路径无效。");
    const extension = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    // 附件大小上限：图片 15MB、文本 2MB——base64 进内存且随 IPC 传输，超大文件会卡死渲染端。
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error("附件不存在或不是文件。");
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
      if (info.size > 15 * 1024 * 1024) throw new Error("图片附件超过 15MB 上限，请压缩后再上传。");
      const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
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
    const extByKind: Record<string, string> = { html: ".html", csv: ".csv", tsv: ".tsv", md: ".md", xlsx: ".xlsx" };
    const ext = extByKind[payload.kind] || ".html";
    const safeName = path.basename(String(payload.name || `artifact${ext}`)).replace(/[\\/:*?"<>|]/g, "_") || `artifact${ext}`;
    if (!Object.values(extByKind).some((allowed) => safeName.toLowerCase().endsWith(allowed))) {
      throw new Error(`不支持的产物类型：${payload.kind}`);
    }
    const dir = path.join(app.getPath("userData"), "artifacts", path.basename(String(payload.sessionId || "unknown")));
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, safeName);
    if (payload.kind === "xlsx") {
      // SheetJS：CSV 文本 → 工作簿 → xlsx 二进制。用户点名要"能保存成 .xlsx"，纯 CSV 落盘达不到。
      const XLSX = await import("xlsx");
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(parseCsvRows(payload.content)), "Sheet1");
      XLSX.writeFile(book, filePath);
      const info = await stat(filePath);
      return { name: safeName, path: filePath, size: info.size };
    }
    await writeFile(filePath, payload.content, "utf8");
    return { name: safeName, path: filePath, size: Buffer.byteLength(payload.content, "utf8") };
  });
}

/** CSV 文本 → string[][]：按行切分再按逗号/制表符切格。模型输出极少含引号转义，简单切分够用。 */
function parseCsvRows(content: string): string[][] {
  return content.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.split(/,|\t/).map((cell) => cell.trim()));
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
