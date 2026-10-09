import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import type { ApiResponse, AppSettings, BackendKind, ChatMessage, GenerationRequest, LlmDoneEvent, LlmStreamEvent, SecretName } from "../shared/types";
import { downloadAndInstall } from "./modules/autoUpdater";
import { GenerationOrchestrator } from "./modules/generationOrchestrator";
import { checkLocalModels } from "./modules/localModels";
import { LlmService, chatAgent } from "./modules/llmService";
import { SettingsStore } from "./modules/settingsStore";
import { inspectEnvironment } from "./modules/systemInspector";
import { TaskStore } from "./modules/taskStore";
import { checkForUpdates, checkFrameworkUpdate } from "./modules/updateChecker";

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
  // h3media 只允许读取输出目录内的生成结果，防止渲染进程借协议读任意本地文件。
  const allowedMediaRoot = async () => path.resolve((settingsCache ?? await settingsStore.get()).outputDirectory);

  protocol.handle("h3media", async (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath || !path.isAbsolute(requestedPath)) return new Response("Invalid media path", { status: 400 });
    const resolved = path.resolve(requestedPath);
    const mediaRoot = await allowedMediaRoot();
    // path.relative 为空或以 .. 开头 = 目标不在根内；用分隔符判断避免 "C:\out2" 误匹配 "C:\out" 前缀。
    const relative = path.relative(mediaRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return new Response("Path outside output directory", { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });

  adapters = new AdapterRegistry(settingsStore);
  const orchestrator = new GenerationOrchestrator(
    new TaskStore(),
    adapters,
    (task) => mainWindow?.webContents.send("task:update", task)
  );
  await orchestrator.initialize();
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

app.on("before-quit", () => adapters?.close());

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
  const initialAgentVideoRequest: GenerationRequest = {
    mode: "text",
    backend: "rb",
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
  // 游乐场 LLM：单例服务，随设置刷新重建；流式分块经 llm:chunk 推送，结束经 llm:done 推送。
  let llm: LlmService | undefined;
  const llmAborters: Array<AbortController> = []; // agent 模式的取消器（llm:abort 时全部中止）
  const rebuildLlm = async (): Promise<LlmService> => {
    const settings = await settingsStore.get();
    llm = new LlmService({
      baseUrl: settings.llm.baseUrl,
      apiKey: await settingsStore.getSecret("llmApiKey"),
      model: settings.llm.model,
      systemPrompt: settings.llm.systemPrompt,
      searchBaseUrl: settings.searchApi.baseUrl || undefined,
      searchApiKey: await settingsStore.getSecret("searchApiKey")
    });
    return llm;
  };
  const sendChunk = (event: LlmStreamEvent) => mainWindow?.webContents.send("llm:chunk", event);
  const sendDone = (ok: boolean, message?: string) => mainWindow?.webContents.send("llm:done", { ok, message } satisfies LlmDoneEvent);
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
      return { ok: false, label: "游乐场 LLM", latencyMs: Date.now() - start, details: {}, message: error instanceof Error ? error.message : "连接失败" };
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
    llm = undefined; // LLM 配置可能已变，下一轮对话重建服务
    return next;
  });
  handle("secret:set", async (_event, name: SecretName, value: string) => {
    await settingsStore.setSecret(name, value);
    registry.invalidate();
    llm = undefined; // Key 可能已变，下一轮对话重建服务
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
  handle("llm:chat", async (_event, messages: ChatMessage[], webSearch: boolean, agent: boolean) => {
    const service = llm ?? await rebuildLlm();
    if (!agent) {
      void service.chat(messages, webSearch, sendChunk)
        .then(() => sendDone(true))
        .catch((error: unknown) => {
          // 用户主动停止（abort）不算错误：正常收尾，不显示红色报错。
          const aborted = error instanceof DOMException && error.name === "AbortError";
          sendDone(aborted, aborted ? undefined : error instanceof Error ? error.message : "对话失败");
        });
      return true;
    }
    // 智能体模式：AI SDK 多步工具循环。视频工具直接接 orchestrator（提交即返回任务 ID，卡片实时刷新）。
    // 工具支持自动检测：模型不支持工具调用（0 文本 + 0 工具调用）或 agent 路径异常但尚未输出任何内容时，
    // 自动用相同消息回落普通对话（runtime fallback）——避免出现"又是空回复"且对用户透明。
    const controller = new AbortController();
    llmAborters.push(controller);
    void (async () => {
      const settings = await settingsStore.get();
      let agentSent = 0;
      const agentSend = (event: LlmStreamEvent) => { agentSent += 1; sendChunk(event); };
      const agentOptions = {
        baseUrl: settings.llm.baseUrl,
        apiKey: await settingsStore.getSecret("llmApiKey"),
        model: settings.llm.model,
        systemPrompt: settings.llm.systemPrompt,
        searchBaseUrl: settings.searchApi.baseUrl || undefined,
        searchApiKey: await settingsStore.getSecret("searchApiKey")
      };
      const agentCallbacks = {
        webSearch: async (query: string) => {
          const response = await fetch(`${(settings.searchApi.baseUrl || "").replace(/\/+$/, "")}/search`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(await settingsStore.getSecret("searchApiKey") ? { Authorization: `Bearer ${await settingsStore.getSecret("searchApiKey")}` } : {})
            },
            body: JSON.stringify({ query, count: 6 }),
            signal: controller.signal
          });
          if (!response.ok) throw new Error(`搜索请求失败：${response.status}`);
          const payload = await response.json() as { results?: Array<{ title?: string; name?: string; url?: string; snippet?: string; content?: string }> };
          return (payload.results ?? [])
            .map((item, index) => `[${index + 1}] ${item.title || item.name || ""}\n${item.url || ""}\n${item.snippet || item.content || ""}`)
            .join("\n\n");
        },
        generateVideo: async (params: { prompt: string; duration: number; count: number }) => {
          const request: GenerationRequest = {
            ...initialAgentVideoRequest,
            prompt: params.prompt,
            duration: Math.max(4, Math.min(15, Math.round(params.duration || 4))),
            count: Math.max(1, Math.min(4, Math.round(params.count || 1))),
            baseSeed: Math.floor(Math.random() * 1_000_000)
          };
          const response = await orchestrator.submit(request);
          return `已创建 ${response.length} 个视频生成任务（${backendKindLabel(request.backend)}·${request.duration} 秒），卡片将在下方实时显示进度，也可到「生成工作台」查看。`;
        }
      };
      let result: { textLength: number; toolCalls: number } | undefined;
      try {
        result = await chatAgent(agentOptions, messages, agentCallbacks, agentSend, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) { sendDone(true); return; }
        // agent 异常且还没输出内容：自动用普通对话补发（普通路径有完整的错误信息）。
        if (agentSent === 0) {
          sendChunk({ seq: 1, delta: "（当前模型/服务商对智能体工具调用支持不完整，已自动改用普通对话模式）\n\n" });
          await service.chat(messages, webSearch, sendChunk);
          sendDone(true);
          return;
        }
        throw error;
      }
      if (agentSent === 0 && result.textLength === 0 && result.toolCalls === 0) {
        // 模型走了 agent 路径但没出文本也没出工具调用——基本就是不支持函数调用。自动回落普通对话。
        sendChunk({ seq: 1, delta: "（当前模型不支持工具调用，已自动改用普通对话模式）\n\n" });
        await service.chat(messages, webSearch, sendChunk);
        sendDone(true);
        return;
      }
      sendDone(true);
    })().catch((error: unknown) => {
      const aborted = controller.signal.aborted;
      sendDone(aborted, aborted ? undefined : error instanceof Error ? error.message : "智能体对话失败");
    });
    return true;
  });
  handle("llm:abort", async () => {
    llm?.abort();
    while (llmAborters.length > 0) llmAborters.pop()?.abort(); // agent 模式的取消
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
    // 与 h3media 同类防护：只允许在输出目录或 ComfyUI 模型目录内定位文件/文件夹。
    const settings = await settingsStore.get();
    const roots = [settings.outputDirectory, settings.comfyuiRoot]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value));
    const resolved = path.resolve(filePath);
    const allowed = roots.some((rootDir) => {
      const rel = path.relative(rootDir, resolved);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!allowed) throw new Error("只能打开输出目录或 ComfyUI 模型目录中的位置。");
    shell.showItemInFolder(resolved);
    return true;
  });
  handle("shell:openExternal", async (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 链接。");
    await shell.openExternal(url);
    return true;
  });
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
        message: error instanceof Error ? error.message : "操作失败",
        retryable: true
      };
    }
  });
}
