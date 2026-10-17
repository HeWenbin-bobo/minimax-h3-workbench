import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeError } from "../../shared/errors";
import { assertSafeResultUrl } from "./resultUrl";
import { readUploadFile } from "./mediaFile";
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
      // 401/403 = 卡密问题；5xx/429 = 服务此刻不可用（不能报成"卡密有效"）。
      // 用一个正常请求（列 1 条任务）探活，非鉴权类成功即视为通过。
      const status = response.status;
      if (status === 401 || status === 403) {
        return {
          ok: false,
          label: "瞬映 RB 云生成",
          latencyMs: Date.now() - start,
          details: { httpStatus: status },
          message: `卡密无效或已失效（HTTP ${status}）。`
        };
      }
      if (status === 429 || status >= 500) {
        return {
          ok: false,
          label: "瞬映 RB 云生成",
          latencyMs: Date.now() - start,
          details: { httpStatus: status },
          message: `瞬映服务暂时不可用（HTTP ${status}），无法确认卡密状态，请稍后重试。`
        };
      }
      return {
        ok: true,
        label: "瞬映 RB 云生成",
        latencyMs: Date.now() - start,
        details: { httpStatus: status },
        message: "卡密已通过鉴权检查。"
      };
    } catch (error) {
      return {
        ok: false,
        label: "瞬映 RB 云生成",
        latencyMs: Date.now() - start,
        details: {},
        message: describeError(error, "瞬映 RB 不可达")
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
    const outputPath = await this.downloadVideo(jobId, task.id, result.videoUrl, signal);
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
    // **按预设决定传哪些素材**，不能无脑把所有已选路径都传上去。
    //
    // 切换预设时界面只是不显示对应的选择器，`request.*Path` 里的旧值仍然在：
    // 用户在「贴合参考图」选了图、再切到「15 秒」(easy_15)，界面已无任何素材入口，
    // 但参考图仍会被上传并写进 job body——实测（本地跑 buildJobBody）确认。
    // easy_15/30 的官网契约是固定时长、不带素材；多余的参考图轻则被忽略，
    // 重则改变生成结果或直接被拒（失败照样扣卡密次数）。
    const preset = request.preset || (request.firstFramePath && request.lastFramePath ? "tail_frame" : "reference");
    const candidates = preset === "flashvsr_upscale"
      // 视频变清晰只收源视频。
      ? [{ filePath: request.sourceVideoPath, kind: "video" as const }]
      : preset === "tail_frame"
        // 首尾过渡只收这两张，不接纳参考图/参考视频。
        ? [
            { filePath: request.firstFramePath, kind: "image" as const },
            { filePath: request.lastFramePath, kind: "image" as const }
          ]
        : preset === "easy_15" || preset === "easy_30"
          // 固定时长预设不接受任何素材。
          ? []
          // reference：≤8 图 + 参考视频。
          : [
              { filePath: request.sourceImagePath, kind: "image" as const },
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
    const extension = path.extname(filePath).toLowerCase();
    if (kind === "image" && ![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
      throw new Error("瞬映 RB 参考图仅支持 JPEG/PNG/WebP。");
    }
    // **先验大小再读**：这里是整份读进内存再塞 multipart，用户选了上 GB 的视频时
    // 会直接把主进程撑爆（OOM 闪退，连错误都来不及提示）。
    const bytes = await readUploadFile(filePath, kind === "image" ? "参考图" : "参考视频");
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
    // 实测 rb.coolhs.com 在 Electron/undici 下相当比例的请求会瞬时报连接超时（Cloudflare 冷连接），
    // 紧接着重试几乎必然成功。旧实现在轮询里一次抖动就抛错——云端任务还在跑、卡密次数已经扣掉，
    // 用户却看到"失败"。改为容忍连续抖动：只有连续失败到上限才认定服务不可用。
    const MAX_CONSECUTIVE_NETWORK_ERRORS = 5;
    let consecutiveNetworkErrors = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException("任务已取消", "AbortError");
      if (Date.now() - startedAt > timeoutMs) throw new Error("瞬映 RB 任务超过 1 小时未完成，已停止轮询。请到瞬映工作台确认任务状态。");
      let response: Response;
      try {
        response = await this.fetchWithRetry(`${this.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
          headers: this.headers()
        }, 20_000, signal);
      } catch (error) {
        // 用户主动取消照旧抛出；网络抖动则在原任务上继续轮询（不重新提交、不重复扣次）。
        if (signal?.aborted) throw error;
        consecutiveNetworkErrors += 1;
        if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
          throw new Error(`连续 ${consecutiveNetworkErrors} 次查询瞬映任务失败：${describeError(error, "网络异常")}任务可能仍在云端生成，请到瞬映工作台确认。`);
        }
        onProgress("running", progress, `网络抖动，正在重试（第 ${consecutiveNetworkErrors} 次）`);
        await delay(5_000, signal);
        continue;
      }
      consecutiveNetworkErrors = 0;
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
      if (!response.ok) {
        // 5xx / 429 属临时性（网关过载、限流），与原任务无关：继续轮询。
        // 卡密**已按次扣除**，云端任务仍在跑——一次 502 就把任务判死，
        // 用户既拿不到成片、也退不回次数（与网络抖动那条同一类）。
        const transient = response.status >= 500 || response.status === 429;
        if (transient) {
          consecutiveNetworkErrors += 1;
          const detail = payload.error?.message || payload.message || "";
          if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
            throw new Error(`连续 ${consecutiveNetworkErrors} 次查询瞬映任务失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}。任务可能仍在云端生成，请到瞬映工作台确认。`);
          }
          onProgress("running", progress, `瞬映暂时不可用（HTTP ${response.status}），正在重试（第 ${consecutiveNetworkErrors} 次）`);
          await delay(5_000, signal);
          continue;
        }
        // 4xx（除 429）是真错误：卡密失效、任务不存在等，重试没有意义。
        throw new Error(`瞬映 RB 查询失败：${response.status} ${payload.error?.message || payload.message || ""}`.trim());
      }
      const hasVideo = payload.has_video ?? payload.hasVideo;
      const status = (payload.status || "").toLowerCase();
      // 实测官网真实词汇表是 done / failed（progress 为"已完成"/"已失败"），并非 OpenAI 式的 succeeded。
      // 旧实现只认 succeeded：任务早已生成完成（has_video=true）却永远匹配不上，界面卡在"正在生成 92%"，
      // 成片永远不下载——卡密已扣、结果拿不到。这里把两种写法都收下。
      const isDone = status === "succeeded" || status === "done" || status === "success" || status === "completed";
      if (isDone) {
        if (hasVideo || payload.video_url || payload.videoUrl) {
          return { videoUrl: payload.video_url ?? payload.videoUrl };
        }
        // 已完成但视频尚未就绪（转码中）：继续轮询。
        onProgress("decoding", Math.min(92, progress), "视频转码中");
      } else if (status === "failed" || status.includes("fail") || status.includes("error")) {
        // 兼容失败态的各种写法（failed / extract_failed …）：带服务端原文抛出，别再静默轮询。
        throw new Error(payload.error?.message || payload.message || `瞬映 RB 任务失败（状态：${payload.status || "unknown"}）`);
      } else if (status === "extracting" || status === "decoding" || status === "processing") {
        // 生成完成后的提取/转码阶段（官网状态机）：属进行中，不是失败。
        onProgress("decoding", Math.min(92, progress), "正在提取生成结果");
      }
      progress = Math.min(92, progress + 2);
      onProgress("running", progress, status === "queued" ? "云端排队中" : "瞬映 RB 正在生成");
      await delay(5_000, signal);
    }
  }

  // 结果下载：/video 直链失败时回落查询接口给的 video_url（官网两种形态都出现过）。
  // video_url 来自远端响应，属不可信输入——落回下载前必须过 SSRF 校验（见 assertSafeResultUrl）。
  private async downloadVideo(jobId: string, taskId: string, videoUrl: string | undefined, signal?: AbortSignal): Promise<string> {
    // **网络层失败也要能回落**：旧写法把直链请求放在 if 外，`fetchWithRetry` 抛异常时
    // 直接跳出函数，那个专门为"直链不可用"准备的 video_url 回落永远轮不到。
    // 云端任务此刻已扣卡密次数，成片却拿不到——与"轮询一次抖动就判死"同一类损失。
    // 用户主动取消仍要原样抛出（不能被回落当成"直链失败"继续下载）。
    let response: Response | undefined;
    try {
      response = await this.fetchWithRetry(`${this.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/video`, {
        headers: this.headers()
      }, 300_000, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if ((!response || !response.ok) && videoUrl) {
      const safeUrl = assertSafeResultUrl(videoUrl);
      response = await this.fetchWithRetry(safeUrl.toString(), { redirect: "manual" }, 300_000, signal);
    }
    if (!response) throw new Error("生成结果下载失败：无法连接瞬映下载地址，且任务没有返回可用的直链。");
    if (!response.ok) {
      // 带上服务端响应片段：定位是 404（产物未就绪）还是鉴权/网关问题。
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`生成结果下载失败：${response.status}${detail ? ` ${detail}` : ""}`);
    }
    await mkdir(this.options.outputDirectory, { recursive: true });
    const target = path.join(this.options.outputDirectory, `${taskId}.mp4`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }
}

// SSRF 防护已抽到 ./resultUrl 供所有云后端共用（MiniMax 结果下载同样需要）；
// 这里 re-export 保持既有调用方与单测的 import 路径不变。
export { assertSafeResultUrl } from "./resultUrl";

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("任务已取消", "AbortError"));
    }, { once: true });
  });
}
