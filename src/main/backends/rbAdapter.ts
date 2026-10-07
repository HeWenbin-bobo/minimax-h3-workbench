import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BackendTestResult,
  GenerationAdapter,
  GenerationRequest,
  GenerationTask,
  TaskStatus
} from "../../shared/types";

interface RbAdapterOptions {
  baseUrl: string;
  cardCode: string;
  outputDirectory: string;
}

// 瞬映 RB（rb.coolhs.com）：卡密即 Bearer；提交→轮询→下载三段流程与 MiniMax 云后端同构。
export class RbAdapter implements GenerationAdapter {
  private readonly baseUrl: string;

  constructor(private readonly options: RbAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.cardCode}` };
  }

  // 站点走 Cloudflare，冷连接偶发 >8s（实测 p95≈6.4s）。每次尝试独立超时；超时/网络抖动自动重试一次；
  // 用户主动取消（signal 已中止）不重试。提交任务传 retries=0：响应丢失时无法确认服务端是否已建任务，重试可能重复扣次。
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
    retries = 1
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        return await fetch(url, { ...init, signal: combined });
      } catch (error) {
        if (attempt >= retries || signal?.aborted) throw error;
      }
    }
  }

  async test(signal?: AbortSignal): Promise<BackendTestResult> {
    const start = Date.now();
    if (!this.options.cardCode) {
      return { ok: false, label: "瞬映 RB 云生成", latencyMs: 0, details: {}, message: "尚未保存瞬映卡密。" };
    }
    try {
      const response = await this.fetchWithRetry(`${this.baseUrl}/api/v1/jobs?limit=1`, {
        headers: this.headers()
      }, 15_000, signal);
      const authenticated = response.status !== 401 && response.status !== 403;
      return {
        ok: authenticated,
        label: "瞬映 RB 云生成",
        latencyMs: Date.now() - start,
        details: { httpStatus: response.status },
        message: authenticated
          ? "卡密已通过鉴权检查。"
          : `卡密无效或已失效（HTTP ${response.status}）。`
      };
    } catch (error) {
      return {
        ok: false,
        label: "瞬映 RB 云生成",
        latencyMs: Date.now() - start,
        details: {},
        message: error instanceof Error
          ? (error.name === "TimeoutError" ? "连接瞬映服务超时（已自动重试）。请检查网络后重试。" : error.message)
          : "瞬映 RB 不可达"
      };
    }
  }

  async generate(
    request: GenerationRequest,
    task: GenerationTask,
    onProgress: (status: TaskStatus, progress: number, message?: string) => void,
    signal?: AbortSignal,
    onProviderId?: (providerTaskId: string) => void
  ): Promise<Pick<GenerationTask, "providerTaskId" | "outputPath" | "outputUrl" | "usage">> {
    if (!this.options.cardCode) throw new Error("请先在连接设置中保存瞬映卡密。");
    onProgress("uploading", 5, "正在上传参考素材");
    const refs = await this.uploadRefs(request, signal);
    onProgress("queued", 10, "正在提交瞬映 RB 任务");
    const jobId = await this.submitJob(request, refs, signal);
    onProviderId?.(jobId);
    onProgress("running", 15, "瞬映 RB 正在生成");
    const result = await this.wait(jobId, onProgress, signal);
    onProgress("downloading", 95, "正在保存生成结果");
    const outputPath = await this.downloadVideo(jobId, task.id, signal);
    onProgress("succeeded", 100, "生成完成");
    return {
      providerTaskId: jobId,
      outputPath,
      outputUrl: result.videoUrl,
      usage: { estimatedUsd: undefined }
    };
  }

  // 官网有取消端点（/api/portal/jobs/{id}/cancel，v1 镜像同路径）；失败静默——任务可能已完成。
  async cancel(providerTaskId?: string): Promise<void> {
    if (!providerTaskId) return;
    await this.fetchWithRetry(`${this.baseUrl}/api/v1/jobs/${encodeURIComponent(providerTaskId)}/cancel`, {
      method: "POST",
      headers: this.headers()
    }, 15_000, undefined, 0).catch(() => undefined);
  }

  private async uploadRefs(
    request: GenerationRequest,
    signal?: AbortSignal
  ): Promise<{ images: string[]; videos: string[] }> {
    const images: string[] = [];
    const videos: string[] = [];
    const candidates = [
      { filePath: request.sourceImagePath, kind: "image" as const },
      { filePath: request.firstFramePath, kind: "image" as const },
      { filePath: request.lastFramePath, kind: "image" as const },
      { filePath: request.sourceVideoPath, kind: "video" as const }
    ];
    for (const candidate of candidates) {
      if (!candidate.filePath) continue;
      const ref = await this.uploadFile(candidate.filePath, candidate.kind, signal);
      if (candidate.kind === "image") images.push(ref); else videos.push(ref);
    }
    return { images, videos };
  }

  private async uploadFile(filePath: string, kind: "image" | "video", signal?: AbortSignal): Promise<string> {
    const bytes = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    if (kind === "image" && ![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
      throw new Error("瞬映 RB 参考图仅支持 JPEG/PNG/WebP。");
    }
    const uploadPath = kind === "image" ? "/api/v1/uploads" : "/api/v1/uploads/video";
    const form = new FormData();
    // 图片端点用 files（多文件数组），视频端点用 file（单文件）。
    form.append(kind === "image" ? "files" : "file", new Blob([new Uint8Array(bytes)]), path.basename(filePath));
    const response = await this.fetchWithRetry(`${this.baseUrl}${uploadPath}`, {
      method: "POST",
      headers: this.headers(),
      body: form
    }, 300_000, signal);
    const payload = (await response.json().catch(() => ({}))) as {
      items?: Array<{ ref?: string }>;
      ref?: string;
      error?: { message?: string };
      message?: string;
    };
    if (!response.ok) throw new Error(`瞬映 RB 上传失败：${response.status} ${payload.error?.message || payload.message || ""}`.trim());
    const ref = kind === "image" ? payload.items?.[0]?.ref : payload.ref;
    if (!ref) throw new Error("瞬映 RB 上传成功但未返回素材引用。");
    return ref;
  }

  private async submitJob(
    request: GenerationRequest,
    refs: { images: string[]; videos: string[] },
    signal?: AbortSignal
  ): Promise<string> {
    const body = this.buildJobBody(request, refs);
    // retries=0：提交失败若因网络超时，无法确认服务端是否已建任务，重试可能重复扣次，宁可让用户重试。
    const response = await this.fetchWithRetry(`${this.baseUrl}/api/v1/jobs`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, 30_000, signal, 0);
    const payload = (await response.json().catch(() => ({}))) as {
      job?: { id?: string };
      id?: string;
      job_id?: string;
      error?: { message?: string };
      message?: string;
    };
    // 官网 API 返回 {job:{id,...}} 包装（官网 bundle 实证）；兼容老网关平铺 id/job_id。
    const jobId = payload.job?.id || payload.id || payload.job_id;
    if (!response.ok || !jobId) {
      throw new Error(`瞬映 RB 提交失败：${response.status} ${payload.error?.message || payload.message || ""}`.trim());
    }
    return jobId;
  }

  // 按官网预设组装 JobBody（预设约束来自 rb.coolhs.com 前端 bundle 的静态清单）：
  // - reference: ≤8 图 + 参考视频，时长 4/6/8s，宽高可传
  // - tail_frame: ≤2 图（首+尾），时长 4/6/8s
  // - easy_15 / easy_30: 固定时长，画布 1344×768，不接受宽高
  // - flashvsr_upscale: 只收源视频，无 prompt
  // 未指定 preset 时沿用旧行为：有首尾帧→tail_frame，否则 reference。
  buildJobBody(
    request: GenerationRequest,
    refs: { images: string[]; videos: string[] }
  ): Record<string, unknown> {
    const preset = request.preset || (request.firstFramePath && request.lastFramePath ? "tail_frame" : "reference");
    const body: Record<string, unknown> = { preset };
    if (preset === "flashvsr_upscale") {
      if (!request.sourceVideoPath) throw new Error("视频变清晰模式必须选择源视频。");
      if (refs.videos.length > 0) body.video = refs.videos[0];
      return body;
    }
    body.prompt = request.prompt;
    if (refs.images.length > 0) body.images = refs.images;
    if (refs.videos.length > 0) body.ref_videos = refs.videos;
    if (preset === "easy_15" || preset === "easy_30") {
      body.width = 1344;
      body.height = 768;
      body.seconds = preset === "easy_15" ? 15 : 30;
    } else {
      body.width = request.width;
      body.height = request.height;
      body.seconds = request.duration;
      if (request.interpolate) body.interpolate = true;
      if (request.samplerSteps) body.sampler_steps = request.samplerSteps;
    }
    return body;
  }

  private async wait(
    jobId: string,
    onProgress: (status: TaskStatus, progress: number, message?: string) => void,
    signal?: AbortSignal
  ): Promise<{ videoUrl?: string }> {
    let progress = 15;
    const startedAt = Date.now();
    const timeoutMs = 60 * 60 * 1_000; // 与 MiniMax 云后端一致：1 小时兜底超时
    for (;;) {
      if (signal?.aborted) throw new DOMException("任务已取消", "AbortError");
      if (Date.now() - startedAt > timeoutMs) throw new Error("瞬映 RB 任务超过 1 小时未完成，已停止轮询。请到瞬映工作台确认任务状态。");
      const response = await this.fetchWithRetry(`${this.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: this.headers()
      }, 20_000, signal);
      // 官网 API 返回 {job:{...}} 包装（官网 bundle 实证）；兼容老网关平铺字段。
      const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const payload = (raw.job ?? raw) as {
        status?: string;
        has_video?: boolean;
        hasVideo?: boolean;
        video_url?: string;
        videoUrl?: string;
        error?: { message?: string };
        message?: string;
      };
      if (!response.ok) throw new Error(`瞬映 RB 查询失败：${response.status} ${payload.error?.message || payload.message || ""}`.trim());
      const hasVideo = payload.has_video ?? payload.hasVideo;
      if (payload.status === "succeeded") {
        if (hasVideo || payload.video_url || payload.videoUrl) {
          return { videoUrl: payload.video_url ?? payload.videoUrl };
        }
        // succeeded 但视频尚未就绪（转码中）：继续轮询。
        onProgress("decoding", Math.min(92, progress), "视频转码中");
      } else if (payload.status === "failed") {
        throw new Error(payload.error?.message || payload.message || "瞬映 RB 任务失败");
      }
      progress = Math.min(92, progress + 2);
      onProgress("running", progress, payload.status === "queued" ? "云端排队中" : "瞬映 RB 正在生成");
      await delay(5_000, signal);
    }
  }

  private async downloadVideo(jobId: string, taskId: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/video`, {
      headers: this.headers()
    }, 300_000, signal);
    if (!response.ok) throw new Error(`生成结果下载失败：${response.status}`);
    await mkdir(this.options.outputDirectory, { recursive: true });
    const target = path.join(this.options.outputDirectory, `${taskId}.mp4`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("任务已取消", "AbortError"));
    }, { once: true });
  });
}
