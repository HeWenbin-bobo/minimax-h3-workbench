export type BackendKind = "local" | "ssh" | "minimax" | "rb";
export type SecretName = "minimaxApiKey" | "sshPassword" | "rbCardCode" | "llmApiKey" | "searchApiKey";
/** 运行时可用的 SecretName 白名单。IPC 入口用它校验，避免把密钥写到下游读不到的键上。 */
export const SECRET_NAMES: readonly SecretName[] = ["minimaxApiKey", "sshPassword", "rbCardCode", "llmApiKey", "searchApiKey"];
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
  /**
   * 用户**自己配置过**的历史输出目录（由 settingsStore 自动维护，不由界面直接编辑）。
   *
   * 用途只有一个：删除历史结果文件时的白名单。改过输出目录后，旧目录里的成片
   * 仍属于本应用写出，彻底删除时应当能清掉；但**不能**因此信任"任务记录里的任意路径"——
   * 记录可被篡改，而删除不可逆。信任来源必须是用户显式配置过的目录。
   */
  outputDirectoryHistory?: string[];
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

/** 安装包下载进度（electron-updater 的 download-progress 事件）。 */
export interface UpdateProgress {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
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
  selectFile(kind: "image" | "video" | "key" | "attachment"): Promise<ApiResponse<string | undefined>>;
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
  /**
   * 读取已落盘产物的文本内容（表格/文档预览用）。
   * 只允许 userData/artifacts/ 内的文件——与 h3preview 协议同一套路径白名单。
   *
   * 返回结构化对象而不是裸字符串：`text` 是**纯内容**，任何"被截断了多少"的说明
   * 放在 `note` 里。早前把提示拼在 `text` 末尾，表格预览会把它当成**一行数据**
   * 渲染出来（实测：3 行表格变成 4 行，多出一行只有一列的说明文字）。
   */
  readArtifactText(filePath: string): Promise<ApiResponse<{ text: string; note?: string; totalRows?: number }>>;
  /** 会话被彻底删除时清掉它的产物目录（userData/artifacts/<sessionId>/），避免永久占盘。 */
  purgeSessionArtifacts(sessionId: string): Promise<ApiResponse<boolean>>;
  openExternal(url: string): Promise<ApiResponse<boolean>>;
  /**
   * 把主窗口带到前台（最小化时先还原）。
   *
   * 为什么需要 IPC：渲染端的 `window.focus()` 只能在**已显示**的窗口里抢焦点，
   * 窗口最小化或不在前台时它什么也做不了——系统通知点击后"点了没反应"就是这个原因。
   * 主进程的 `second-instance` 早就用了 restore/show/focus 三步，这里复用同一套。
   */
  focusWindow(): Promise<ApiResponse<boolean>>;
  /**
   * 游乐场：发起一次流式对话；分块经 onLlmChunk 推送，结束/出错经 onLlmDone 推送。agent=true 走 AI SDK 工具循环。
   * sessionId 由渲染端生成：不同会话可并发对话，事件按该 id 路由回各自的会话，互不串流。
   * browserSearch=true 走「浏览器搜索」：只用应用自带 Chromium 渲染抓取（跳过搜索 API 与 HTTP 直抓），
   * 与 webSearch 互斥。
   */
  chatLlm(messages: ChatMessage[], webSearch: boolean, agent: boolean, sessionId: string, browserSearch?: boolean, planMode?: "plan" | "execute"): Promise<ApiResponse<boolean>>;
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
  /** 上下文占用查询：渲染端据此显示「上下文 N%」并把压缩按钮点亮。 */
  getContextStatus(messages: ChatMessage[], sessionId: string): Promise<ApiResponse<ContextStatus>>;
  /** 手动压缩上下文（对齐 Codex 的 Manual trigger）。 */
  compactContext(messages: ChatMessage[], sessionId: string): Promise<ApiResponse<CompactionEvent>>;
  onLlmChunk(listener: (chunk: LlmStreamEvent) => void): () => void;
  onLlmDone(listener: (event: LlmDoneEvent) => void): () => void;
  /** 智能体工具经 generate_video 建好任务后推送任务 id：渲染端把卡片挂到当前会话气泡上。 */
  onLlmTasks(listener: (event: LlmTasksEvent) => void): () => void;
  /** 智能体工具调用开始事件：渲染端把"正在搜索/正在生成视频"实时显示在气泡上（透明度）。 */
  onLlmTool(listener: (event: LlmToolEvent) => void): () => void;
  /** 上下文被压缩（自动或手动）：渲染端在对话流里插入分割提示。 */
  onLlmCompaction(listener: (event: CompactionEvent) => void): () => void;
  /** 智能体更新步骤清单（update_plan）：渲染端在气泡上显示/刷新进度清单。 */
  onLlmPlan(listener: (event: LlmPlanEvent) => void): () => void;
  /** 智能体产出文件（create_file）：渲染端据此挂产物卡片（内容在磁盘上，不经消息流）。 */
  onLlmArtifact(listener: (event: LlmArtifactEvent) => void): () => void;
  /** 智能体向用户提选择题（request_user_input）：渲染端弹选择卡片，答案经 answerLlmQuestion 回传。 */
  onLlmQuestion(listener: (event: LlmQuestionEvent) => void): () => void;
  /**
   * 回传选择题答案。主进程的工具循环正挂起等待这个调用。
   * answers 形如 `{ questionId: [optionId, ...] }`。**未作答的题不要放进 map**——
   * 主进程据此区分"用户选了跳过"与"这道题没答"。
   */
  answerLlmQuestion(requestId: string, answers: Record<string, string[]>): Promise<ApiResponse<boolean>>;
  /** 跳过整组问题：主进程立即放行工具循环（模型按最佳判断继续），不必等超时。 */
  skipLlmQuestion(requestId: string): Promise<ApiResponse<boolean>>;
  /**
   * 取该会话**当前挂起**的选择题（没有则 `undefined`）。
   *
   * 为什么需要（实测缺陷 probe-question-while-away）：渲染端切页会卸载 `PlaygroundPage`，
   * 那段时间 `llm:question` 事件没有订阅者、被直接丢弃，而主进程的 `questionBridge`
   * 仍在挂起等回答。用户切回来时看不到卡片，只能干等到超时。
   * 渲染端在**挂载时**与**切回会话时**各调一次即可把丢掉的那张卡片补回来。
   */
  pendingQuestion(sessionId: string): Promise<ApiResponse<{ requestId: string; questions: LlmQuestionEvent["questions"] } | undefined>>;
  /**
   * 安装包下载进度（`downloadAndInstallUpdate` 期间推送）。
   *
   * 主进程早就把 electron-updater 的 `download-progress` 接出来了，界面也备好了
   * `.download-progress` 样式，但一直**没有订阅方**——用户下载 100MB+ 安装包时
   * 只能看到"正在下载更新…"，不知道是在走还是一动不动。
   */
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;
  onTaskUpdate(listener: (task: GenerationTask) => void): () => void;
}

export type ChatRole = "user" | "assistant" | "system";

/** 游乐场消息：文本内容 + 可选图片附件（data URL）。 */
/**
 * 游乐场消息：文本内容 + 可选图片附件（data URL）。
 * 渲染端的 PlaygroundMessage 在 App.tsx 内定义（含流式/工具步骤等瞬态字段）。
 */
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
  /** 文本附件是否被截断（原文件超过上限）。界面据此明确提示，而不是静默少给内容。 */
  truncated?: boolean;
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
  /**
   * 本轮推给渲染端的**全部 delta 拼接结果**。
   *
   * 为什么主进程要多带一份（实测缺陷 probe-switch-mid-stream 的残留）：
   * 渲染端切页会卸载 `PlaygroundPage`，那段时间没有订阅者，`llm:chunk` 事件被丢弃——
   * 切回后恢复出来的正文**中间缺一段**（实测：`甲乙` + `戊己庚辛`，缺「丙丁」）。
   * 主进程本来就经手每个 delta，顺手累计一份即可让渲染端在收尾时补齐。
   *
   * 语义：包含所有 `chunk()` 推过的文本（含"已停止生成""连接中断重试"这类提示），
   * 与渲染端 `streamBuffers` 的累计口径**完全一致**（那边也是把所有 delta 相加）。
   */
  fullText?: string;
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
  /**
   * end 阶段：这次工具调用**是否成功**。
   *
   * 为什么不能靠 result 猜（实测踩到）：`edit_artifact` 拒绝歧义编辑时返回的是
   * "oldText 出现了 2 次…"，渲染端却把它拼成 `✓ 修改文件完成（oldText 出现了 2 次…）`——
   * 打勾、"完成"、"失败"三件事同时出现，用户看了一头雾水。
   * "完成"只表示工具调用结束，不代表操作成功，故把成败做成结构化字段。
   * 缺省视为成功（兼容旧事件）。
   */
  ok?: boolean;
  sessionId?: string;
}

/** 步骤清单里的一项（update_plan 工具）。 */
export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

/** 智能体更新步骤清单事件（update_plan）：渲染端在气泡上显示进度清单。 */
export interface LlmPlanEvent {
  /** 全量清单（每次调用都替换，不是增量）。 */
  plan: PlanStep[];
  /** 本次更新的原因，可能缺省。 */
  explanation?: string;
  sessionId?: string;
}

/**
 * 智能体产出文件事件（create_file 工具）。
 *
 * 为什么用事件而不是把内容回灌进消息流（旧做法）：旧做法把**整个文件内容**以围栏代码块
 * 追加进助手消息，带来三个问题——① 气泡里卡片与代码块重复显示一遍；
 * ② 那段内容会进会话历史，**每轮都重新发给模型**（几十 KB 的 3D 页面 ≈ 每轮多烧上万 token，
 * 还会触发上下文压缩）；③ 大文件把消息撑得极长。改为只传元数据，内容留在磁盘上。
 */
export interface LlmArtifactEvent {
  /** 落盘文件名（含扩展名）。 */
  name: string;
  /** 绝对路径：渲染端预览与「在文件夹中显示」都用它。 */
  path: string;
  /** 字节数。 */
  size: number;
  /** 渲染端据此选卡片图标与预览方式。 */
  kind: "html" | "sheet" | "doc";
  /**
   * `true` 表示这是**对已有产物的更新**（edit_artifact 写回同一个文件），
   * 渲染端应当就地刷新那张卡片与已打开的预览，而不是再追加一张新卡片。
   * 缺省 = 新增产物（兼容旧事件）。
   */
  updated?: boolean;
  sessionId?: string;
}

/** 交互提问的一个选项（request_user_input 工具）。 */
export interface LlmQuestionOption {
  id: string;
  label: string;
  description: string;
}

/** 交互提问的一道题。 */
export interface LlmQuestion {
  id: string;
  /** 很短的标签（最多 12 字），渲染成 chip。 */
  header: string;
  question: string;
  multiSelect?: boolean;
  options: LlmQuestionOption[];
}

/**
 * 智能体向用户提选择题事件（request_user_input）。
 * 渲染端弹出选择卡片，用户点选后经 `answerLlmQuestion` 回传——主进程那边工具循环正挂起等待。
 */
export interface LlmQuestionEvent {
  /** 本次提问的标识：回传答案时必须原样带上，否则主进程找不到对应的待答登记。 */
  requestId: string;
  questions: LlmQuestion[];
  sessionId?: string;
}

/** 上下文占用查询结果（渲染端据此显示占用比例并把压缩按钮点亮）。 */
export interface ContextStatus {
  /** 已用比例（分母为「模型窗口 × 80%」，即 100% 就是压缩触发点）。 */
  percent: number;
  activeTokens: number;
  modelLimitTokens: number;
  /** 已压缩次数；0 表示还没压过。 */
  windowNumber: number;
  /** 基线来源：server=上游实测，estimated=本地字符估算，none=还没锚定。 */
  baselineSource: "server" | "estimated" | "none";
}

/** 一次压缩的结果摘要，用于在对话里插入分割提示。 */
export interface CompactionEvent {
  /** 压缩前/后的 token 估算量。 */
  before: number;
  after: number;
  /** 人类可读的触发原因。 */
  reason: string;
  /** 压缩后的窗口序号。 */
  windowNumber: number;
  sessionId?: string;
}
