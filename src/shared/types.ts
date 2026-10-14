export type BackendKind = "local" | "ssh" | "minimax" | "rb";
export type SecretName = "minimaxApiKey" | "sshPassword" | "rbCardCode" | "llmApiKey" | "searchApiKey";
export type GenerationMode = "text" | "image" | "video";

/** 视频描述长度上限。工作台计数器、文本域 maxlength 与主进程校验共用同一来源，避免标称值与实际约束不一致。 */
export const MAX_PROMPT_LENGTH = 2000;
export type TaskStatus =
  | "draft"
  | "validating"
  | "uploading"
  | "queued"
  | "running"
  | "decoding"
  | "downloading"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AppSettings {
  localComfyUrl: string;
  outputDirectory: string;
  /** 本机 ComfyUI 根目录（可选）。设置后模型下载页按此目录检查 5 个 H3 模型文件是否就位。 */
  comfyuiRoot: string;
  /** 瞬映 RB（rb.coolhs.com 或兼容中转）的 API 根地址。 */
  rbBaseUrl: string;
  defaultBackend: BackendKind;
  minimaxBaseUrl: string;
  /** 游乐场 LLM 配置：OpenAI 兼容接入（预设提供商或自定义）。对话端点不存储，运行时按域名推导。 */
  llm: {
    /** 预设提供商 id 或 "custom"。 */
    provider: string;
    baseUrl: string;
    model: string;
    systemPrompt: string;
  };
  /** 游乐场可选联网搜索（OpenAI 兼容搜索 API，如博查/Tavily 转接）。 */
  searchApi: {
    baseUrl: string;
  };
  ssh: {
    name: string;
    host: string;
    port: number;
    username: string;
    privateKeyPath: string;
    hostFingerprint: string;
    remoteComfyHost: string;
    remoteComfyPort: number;
    remoteComfyPath: string;
  };
}

/** LLM 提供商预设（OpenAI 兼容）。对话端点由主进程按域名推导，预设只提供地址与默认模型。 */
export const LLM_PROVIDERS = [
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-Text-01" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { id: "moonshot", label: "月之暗面 Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "ollama", label: "Ollama（本机）", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5" },
  { id: "custom", label: "自定义（OpenAI 兼容）", baseUrl: "", model: "" }
] as const;

export interface GpuInfo {
  vendor: string;
  model: string;
  vramBytes: number;
}

export interface EnvironmentReport {
  checkedAt: string;
  os: string;
  arch: string;
  cpu: string;
  cpuCores: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  diskFreeBytes: number;
  gpus: GpuInfo[];
  comfyReachable: boolean;
  comfyVersion?: string;
  comfyHasH3Nodes: boolean;
  comfyHasH3Models: boolean;
  comfyMissingH3Models: string[];
  ffmpegAvailable: boolean;
  grade: "A" | "B" | "C" | "D";
  verdict: string;
  recommendations: string[];
}

export interface ResourceLink {
  id: string;
  label: string;
  category: "model" | "comfyui" | "workflow" | "docs";
  url: string;
  description: string;
  action: "download" | "open";
  sizeBytes?: number;
  targetDirectory?: string;
}

export interface GenerationRequest {
  mode: GenerationMode;
  backend: BackendKind;
  prompt: string;
  duration: number;
  ratio: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive";
  resolution: "768P" | "2K";
  width: number;
  height: number;
  count: number;
  baseSeed: number;
  firstFramePath?: string;
  lastFramePath?: string;
  sourceImagePath?: string;
  sourceVideoPath?: string;
  /** RB 后端专用：官网预设（reference/tail_frame/easy_15/easy_30/flashvsr_upscale）。 */
  preset?: string;
  /** RB 后端专用：是否补帧（仅 reference/tail_frame 支持）。 */
  interpolate?: boolean;
  /** RB 后端专用：采样步数（reference/tail_frame 可选 8/20）。 */
  samplerSteps?: number;
}

export interface GenerationTask {
  id: string;
  parentId: string;
  index: number;
  seed: number;
  backend: BackendKind;
  mode: GenerationMode;
  status: TaskStatus;
  progress: number;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  providerTaskId?: string;
  outputPath?: string;
  outputUrl?: string;
  errorCode?: string;
  message?: string;
  request?: GenerationRequest; // 原始提交参数，失败/取消后用于一键重试
  /** 回收站：非空表示已删除（软删除），7 天后被自动清除（含输出视频）。 */
  deletedAt?: string;
  /** 用户自定义项目分类（空 = 未分类；整组任务同值）。 */
  category?: string;
  usage?: {
    inputSeconds?: number;
    outputSeconds?: number;
    estimatedUsd?: number;
  };
}

export interface BackendTestResult {
  ok: boolean;
  label: string;
  latencyMs: number;
  details: Record<string, unknown>;
  message: string;
}

export interface GenerationAdapter {
  test(signal?: AbortSignal): Promise<BackendTestResult>;
  generate(
    request: GenerationRequest,
    task: GenerationTask,
    onProgress: (status: TaskStatus, progress: number, message?: string) => void,
    signal?: AbortSignal,
    /** 可选：云后端提交成功后立即回传 providerTaskId，让 orchestrator 在任务运行中也能通知云端取消（按次计费）。 */
    onProviderId?: (providerTaskId: string) => void
  ): Promise<Pick<GenerationTask, "providerTaskId" | "outputPath" | "outputUrl" | "usage">>;
  cancel?(providerTaskId: string): Promise<void>;
}

export interface ApiResponse<T> {
  ok: boolean;
  requestId: string;
  data?: T;
  warnings?: string[];
  errorCode?: string;
  message?: string;
  retryable?: boolean;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseUrl: string;
  publishedAt?: string;
}

export interface LocalModelStatus {
  id: string;
  name: string;
  directory: string;
  fullPath: string;
  present: boolean;
  sizeBytes?: number;
  downloadUrl?: string;
}

export interface WorkbenchApi {
  getSettings(): Promise<ApiResponse<AppSettings>>;
  updateSettings(patch: Partial<AppSettings>): Promise<ApiResponse<AppSettings>>;
  setSecret(name: SecretName, value: string): Promise<ApiResponse<boolean>>;
  hasSecret(name: SecretName): Promise<ApiResponse<boolean>>;
  selectDirectory(): Promise<ApiResponse<string | undefined>>;
  selectFile(kind: "image" | "video" | "key"): Promise<ApiResponse<string | undefined>>;
  inspectEnvironment(): Promise<ApiResponse<EnvironmentReport>>;
  checkForUpdates(): Promise<ApiResponse<UpdateInfo>>;
  downloadAndInstallUpdate(): Promise<ApiResponse<boolean>>;
  checkLocalModels(): Promise<ApiResponse<LocalModelStatus[]>>;
  getResourceLinks(): Promise<ApiResponse<ResourceLink[]>>;
  testBackend(kind: BackendKind): Promise<ApiResponse<BackendTestResult>>;
  listTasks(): Promise<ApiResponse<GenerationTask[]>>;
  submitGeneration(request: GenerationRequest): Promise<ApiResponse<GenerationTask[]>>;
  cancelTask(taskId: string): Promise<ApiResponse<GenerationTask>>;
  retryTask(taskId: string): Promise<ApiResponse<GenerationTask>>;
  /** 更新任务的分类标签（整组同值；空串 = 未分类）。 */
  setTaskCategory(taskId: string, category: string): Promise<ApiResponse<GenerationTask[]>>;
  /** 回收站：软删除任务（运行中的先取消），7 天内可恢复；传 parentId 可整组删除。 */
  deleteTasks(taskIds: string[]): Promise<ApiResponse<GenerationTask[]>>;
  /** 回收站：恢复软删除的任务（按 parentId 组恢复）。 */
  restoreTasks(taskIds: string[]): Promise<ApiResponse<GenerationTask[]>>;
  /** 回收站：彻底删除（含输出视频文件，仅限输出目录内）。 */
  purgeTasks(taskIds: string[]): Promise<ApiResponse<GenerationTask[]>>;
  /** 回收站：列出已删除任务（含剩余毫秒数由渲染端按 deletedAt 自算）。 */
  listDeletedTasks(): Promise<ApiResponse<GenerationTask[]>>;
  showItem(filePath: string): Promise<ApiResponse<boolean>>;
  /** 游乐场产物落盘：存 userData/artifacts/<sessionId>/，kind 决定扩展名与转换（xlsx 走 SheetJS），返回 {name,path,size}。 */
  saveArtifact(sessionId: string, name: string, content: string, kind: "html" | "csv" | "tsv" | "md" | "xlsx"): Promise<ApiResponse<{ name: string; path: string; size: number }>>;
  openExternal(url: string): Promise<ApiResponse<boolean>>;
  /**
   * 游乐场：发起一次流式对话；分块经 onLlmChunk 推送，结束/出错经 onLlmDone 推送。agent=true 走 AI SDK 工具循环。
   * sessionId 由渲染端生成：不同会话可并发对话，事件按该 id 路由回各自的会话，互不串流。
   * browserSearch=true 走「浏览器搜索」：只用应用自带 Chromium 渲染抓取（跳过搜索 API 与 HTTP 直抓），
   * 与 webSearch 互斥。
   */
  chatLlm(messages: ChatMessage[], webSearch: boolean, agent: boolean, sessionId: string, browserSearch?: boolean): Promise<ApiResponse<boolean>>;
  /** 智能体框架独立更新检查（npm registry 最新版 vs 打包版本）。 */
  checkAgentFrameworkUpdate(): Promise<ApiResponse<{ bundledVersion: string; latestVersion?: string; updateAvailable: boolean; message: string }>>;
  /** 中止指定会话的对话（省略则中止全部会话）。 */
  abortLlm(sessionId?: string): Promise<ApiResponse<boolean>>;
  /** 游乐场：从上游拉取模型列表（OpenAI 兼容 GET /models）；不支持的服务商返回 ok=false + 提示。 */
  listLlmModels(): Promise<ApiResponse<{ ok: boolean; models: string[]; message: string }>>;
  /** 游乐场：LLM 连接测试（发一条最小对话验证 Key/模型/端点全链路）。 */
  testLlm(): Promise<ApiResponse<BackendTestResult>>;
  /** 游乐场：读取本地附件为 data URL（图片）或文本内容。 */
  readAttachment(path: string): Promise<ApiResponse<AttachmentPayload>>;
  onLlmChunk(listener: (chunk: LlmStreamEvent) => void): () => void;
  onLlmDone(listener: (event: LlmDoneEvent) => void): () => void;
  /** 智能体工具经 generate_video 建好任务后推送任务 id：渲染端把卡片挂到当前会话气泡上。 */
  onLlmTasks(listener: (event: LlmTasksEvent) => void): () => void;
  /** 智能体工具调用开始事件：渲染端把"正在搜索/正在生成视频"实时显示在气泡上（透明度）。 */
  onLlmTool(listener: (event: LlmToolEvent) => void): () => void;
  onTaskUpdate(listener: (task: GenerationTask) => void): () => void;
}

export type ChatRole = "user" | "assistant" | "system";

/** 游乐场消息：文本内容 + 可选图片附件（data URL）。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  images?: string[];
}

/** 附件读取结果：图片转 data URL，文本类直接读内容，其他仅返回名称。 */
export interface AttachmentPayload {
  kind: "image" | "text" | "other";
  name: string;
  dataUrl?: string;
  text?: string;
}

/** LLM 流式分块事件。 */
export interface LlmStreamEvent {
  /** 递增序号，渲染端用于去重与排序。 */
  seq: number;
  delta: string;
  /** 发起该轮的会话 id：多会话并发时用于把分块路由回正确的会话。 */
  sessionId?: string;
}

/** LLM 单轮流结束事件。 */
export interface LlmDoneEvent {
  ok: boolean;
  message?: string;
  /** 发起该轮的会话 id（老调用方可能不带，渲染端按"当前流式会话"兜底）。 */
  sessionId?: string;
}

/** 智能体工具创建视频任务事件：渲染端据此把结果卡片挂到当前会话的助手气泡上（否则任务只在工作台可见）。 */
export interface LlmTasksEvent {
  taskIds: string[];
  sessionId?: string;
}

/** 智能体工具调用事件：渲染端把"正在搜索/正在生成视频"及其结果实时显示在气泡上（工具透明度）。 */
export interface LlmToolEvent {
  /** 工具名（web_search / generate_video）。 */
  tool: string;
  /** start 阶段为人类可读的调用摘要；end 阶段为结果摘要（如"找到 6 条结果"）。 */
  input: string;
  /** 阶段：start=工具开始执行，end=工具执行完成。旧事件可能缺省，按 start 处理。 */
  phase?: "start" | "end";
  /** end 阶段的结果摘要文本。 */
  result?: string;
  sessionId?: string;
}
