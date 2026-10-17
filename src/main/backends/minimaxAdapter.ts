import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeError } from "../../shared/errors";
import { estimateCloudCost } from "../../shared/capabilities";
import { assertSafeResultUrl } from "./resultUrl";
import type {
  BackendTestResult,
  GenerationAdapter,
  GenerationRequest,
  GenerationTask,
  TaskStatus
} from "../../shared/types";

interface MiniMaxAdapterOptions {
  baseUrl: string;
  apiKey: string;
  outputDirectory: string;
}

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" | "reference_image" }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" };

export class MiniMaxAdapter implements GenerationAdapter {
  private readonly baseUrl: string;

  constructor(private readonly options: MiniMaxAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async test(signal?: AbortSignal): Promise<BackendTestResult> {
    const start = Date.now();
    if (!this.options.apiKey) {
      return { ok: false, label: "MiniMax 云 API", latencyMs: 0, details: {}, message: "尚未保存 MiniMax API Key。" };
    }
    try {
      const response = await fetch(`${this.baseUrl}/v2/query/video_generation/nonexistent`, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal: requestSignal(signal, 8_000)
      });
      // 401 与 403 都算鉴权失败：403 常见于 Key 被禁用/无该模型权限/地区限制，
      // 只认 401 会把这类"实际不可用"误报成"已通过鉴权"（与 RbAdapter 的判定保持一致）。
      const authenticated = response.status !== 401 && response.status !== 403;
      return {
        ok: authenticated,
        label: "MiniMax 云 API",
        latencyMs: Date.now() - start,
        details: { httpStatus: response.status },
        message: authenticated ? "API Key 已通过鉴权检查。" : `API Key 无效、已失效或无访问权限（HTTP ${response.status}）。`
      };
    } catch (error) {
      return {
        ok: false,
        label: "MiniMax 云 API",
        latencyMs: Date.now() - start,
        details: {},
        message: describeError(error, "MiniMax API 不可达")
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
    if (!this.options.apiKey) throw new Error("请先在连接设置中保存 MiniMax API Key。 ");
    onProgress("uploading", 5, "正在编码参考素材");
    const content = await this.buildContent(request);
    onProgress("queued", 10, "正在提交 MiniMax H3 云任务");
    const response = await fetch(`${this.baseUrl}/v2/video_generation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "MiniMax-H3",
        content,
        resolution: request.resolution,
        duration: request.duration,
        ratio: request.mode === "image" || request.firstFramePath || request.lastFramePath ? "adaptive" : request.ratio
      }),
      signal: requestSignal(signal, 30_000)
    });
    const created = (await response.json()) as { task_id?: string; error?: { type?: string; message?: string } };
    if (!response.ok || !created.task_id) throw new Error(created.error?.message || `MiniMax 提交失败：${response.status}`);
    onProviderId?.(created.task_id); // 提交成功立即回传：中途取消时云端任务也能被终止（按次计费）。
    const result = await this.wait(created.task_id, onProgress, signal);
    onProgress("downloading", 95, "正在保存云端结果");
    const outputPath = await this.download(result.url, task.id, signal);
    onProgress("succeeded", 100, "生成完成");
    return {
      providerTaskId: created.task_id,
      outputPath,
      outputUrl: result.url,
      usage: {
        inputSeconds: result.inputSeconds,
        outputSeconds: result.outputSeconds,
        estimatedUsd: estimateCloudCost(request.resolution, request.duration, 1)
      }
    };
  }

  private async buildContent(request: GenerationRequest): Promise<ContentItem[]> {
    const content: ContentItem[] = [{ type: "text", text: request.prompt }];
    if (request.mode === "video") {
      if (!request.sourceVideoPath) throw new Error("视频生视频模式必须选择源视频。 ");
      content.push({ type: "video_url", video_url: { url: await dataUri(request.sourceVideoPath) }, role: "reference_video" });
      return content;
    }
    // **按模式取素材，不能把四个路径都发上去**：切换模式时界面只是不显示对应选择器，
    // `request.*Path` 里的旧值仍在。都发的话会出现**两个 first_frame**
    // （image 模式的 sourceImage 与 text 模式残留的 firstFrame），
    // 云端对重复角色的处理未定义——实测本地构造确认会同时发出两个 first_frame。
    if (request.mode === "image") {
      if (request.sourceImagePath) {
        content.push({ type: "image_url", image_url: { url: await dataUri(request.sourceImagePath) }, role: "first_frame" });
      }
      return content;
    }
    // 文生视频：可选用首帧/尾帧控制。
    if (request.firstFramePath) {
      content.push({ type: "image_url", image_url: { url: await dataUri(request.firstFramePath) }, role: "first_frame" });
    }
    if (request.lastFramePath) {
      content.push({ type: "image_url", image_url: { url: await dataUri(request.lastFramePath) }, role: "last_frame" });
    }
    return content;
  }

  private async wait(
    taskId: string,
    onProgress: (status: TaskStatus, progress: number, message?: string) => void,
    signal?: AbortSignal
  ): Promise<{ url: string; inputSeconds?: number; outputSeconds?: number }> {
    let progress = 15;
    const startedAt = Date.now();
    const timeoutMs = 60 * 60 * 1_000; // 云端排队+生成上限 1 小时：防止任务永远转圈
    for (;;) {
      if (signal?.aborted) throw new DOMException("任务已取消", "AbortError");
      if (Date.now() - startedAt > timeoutMs) throw new Error("云端任务超过 1 小时未完成，已停止轮询。请到 MiniMax 控制台确认任务状态。");
      const response = await fetch(`${this.baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal: requestSignal(signal, 20_000)
      });
      const payload = (await response.json()) as {
        task?: {
          status?: string;
          content?: { url?: string };
          usage?: { input_seconds?: number; output_seconds?: number };
          error?: { message?: string };
        };
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message || `查询失败：${response.status}`);
      // MiniMax 官方文档的成功态是 "Success"（首字母大写），不是 succeeded；比对前统一小写并收下常见写法。
      // 只认 succeeded 的话，生成已完成的任务永远匹配不上，界面会一直"正在生成"直到 1 小时超时。
      // （本机无 MiniMax API Key，未能真机验证；该改动只放宽匹配、不放宽下载条件，故不会误判未完成任务。）
      const taskStatus = String(payload.task?.status ?? "").toLowerCase();
      // 注意：这里是 `succeeded && url` 的联合条件，**不能**拆成"成功就报错"。
      // 实测契约：云端可能先回报 Success、下一轮才给 content.url（转码未完成），
      // 所以"成功但暂无 url"必须继续轮询（minimaxAdapter.test 有专门用例锁定）。
      if (["success", "succeeded", "done", "completed"].includes(taskStatus) && payload.task?.content?.url) {
        return {
          url: payload.task.content.url,
          inputSeconds: payload.task.usage?.input_seconds,
          outputSeconds: payload.task.usage?.output_seconds
        };
      }
      if (["failed", "fail", "cancelled", "canceled"].includes(taskStatus)) {
        throw new Error(payload.task?.error?.message || `任务${payload.task?.status}`);
      }
      progress = Math.min(92, progress + 3);
      onProgress("running", progress, taskStatus === "queued" ? "云端排队中" : "MiniMax H3 正在生成");
      await delay(10_000, signal);
    }
  }

  private async download(url: string, taskId: string, signal?: AbortSignal): Promise<string> {
    // content.url 来自远端响应，属不可信输入——与 RB 后端同样过 SSRF 校验，
    // 否则被劫持的响应可让本应用替它访问内网、并把内网内容当作"生成结果"落盘。
    const safeUrl = assertSafeResultUrl(url);
    // redirect:"manual"：禁止自动跟随重定向，否则可用 302 绕过上面的校验指向内网。
    const response = await fetch(safeUrl, { signal: requestSignal(signal, 300_000), redirect: "manual" });
    if (!response.ok) throw new Error(`生成结果下载失败：${response.status}`);
    await mkdir(this.options.outputDirectory, { recursive: true });
    const target = path.join(this.options.outputDirectory, `${taskId}.mp4`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }
}

async function dataUri(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  const mime: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    // 选择器也允许 webm / mkv；MIME 表漏了它们会回落成 application/octet-stream，
    // 云端拿到无类型数据多半直接拒收（与 heic/heif 那处同类）。
    ".webm": "video/webm",
    ".mkv": "video/x-matroska"
  };
  const bytes = await readFile(filePath);
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("参考素材超过云 API 允许的 50MB，请改用公网 URL 或压缩文件。 ");
  return `data:${mime[extension] || "application/octet-stream"};base64,${bytes.toString("base64")}`;
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

/**
 * 单次请求超时（与调用方取消信号合并）。CLAUDE.md 纪律：外部调用必须自己加超时，
 * 不让 fetch 裸等——否则上游挂住会把整条降级链拖死。没有调用方信号时只带超时。
 */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
