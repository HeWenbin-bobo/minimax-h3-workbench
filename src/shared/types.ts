export type BackendKind = "local" | "ssh" | "minimax" | "rb";
export type SecretName = "minimaxApiKey" | "sshPassword" | "rbCardCode" | "llmApiKey" | "searchApiKey";
export type GenerationMode = "text" | "image" | "video";
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
  showItem(filePath: string): Promise<ApiResponse<boolean>>;
  openExternal(url: string): Promise<ApiResponse<boolean>>;
  /** 游乐场：发起一次流式对话；分块经 onLlmChunk 推送，结束/出错经 onLlmDone 推送。 */
  chatLlm(messages: ChatMessage[], webSearch: boolean): Promise<ApiResponse<boolean>>;
  abortLlm(): Promise<ApiResponse<boolean>>;
  /** 游乐场：从上游拉取模型列表（OpenAI 兼容 GET /models）；不支持的服务商返回 ok=false + 提示。 */
  listLlmModels(): Promise<ApiResponse<{ ok: boolean; models: string[]; message: string }>>;
  /** 游乐场：LLM 连接测试（发一条最小对话验证 Key/模型/端点全链路）。 */
  testLlm(): Promise<ApiResponse<BackendTestResult>>;
  /** 游乐场：读取本地附件为 data URL（图片）或文本内容。 */
  readAttachment(path: string): Promise<ApiResponse<AttachmentPayload>>;
  onLlmChunk(listener: (chunk: LlmStreamEvent) => void): () => void;
  onLlmDone(listener: (event: LlmDoneEvent) => void): () => void;
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
}

/** LLM 单轮流结束事件。 */
export interface LlmDoneEvent {
  ok: boolean;
  message?: string;
}
