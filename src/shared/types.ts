export type BackendKind = "local" | "ssh" | "minimax" | "rb";
export type SecretName = "minimaxApiKey" | "sshPassword" | "rbCardCode";
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
    signal?: AbortSignal
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
  onTaskUpdate(listener: (task: GenerationTask) => void): () => void;
}
