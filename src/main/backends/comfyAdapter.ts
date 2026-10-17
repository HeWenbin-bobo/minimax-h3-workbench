import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BackendTestResult,
  GenerationAdapter,
  GenerationRequest,
  GenerationTask,
  TaskStatus
} from "../../shared/types";
import { describeError } from "../../shared/errors";
import { readUploadFile } from "./mediaFile";
import { inspectH3Readiness } from "./comfyReadiness";
import { buildFl2vaWorkflow, buildRef2vaWorkflow, type ComfyPrompt, type UploadedMedia } from "./workflows";

interface ComfyAdapterOptions {
  baseUrl: string;
  outputDirectory: string;
}

type JsonObject = Record<string, unknown>;

export class ComfyAdapter implements GenerationAdapter {
  private readonly baseUrl: string;

  constructor(private readonly options: ComfyAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async test(signal?: AbortSignal): Promise<BackendTestResult> {
    const start = Date.now();
    try {
      const [statsResponse, nodesResponse] = await Promise.all([
        fetch(`${this.baseUrl}/system_stats`, { signal: requestSignal(signal, 8_000) }),
        fetch(`${this.baseUrl}/object_info`, { signal: requestSignal(signal, 12_000) })
      ]);
      if (!statsResponse.ok || !nodesResponse.ok) throw new Error(`ComfyUI 返回 ${statsResponse.status}/${nodesResponse.status}`);
      const stats = (await statsResponse.json()) as Record<string, unknown>;
      const nodes = (await nodesResponse.json()) as JsonObject;
      const { hasH3Nodes: hasH3, missingModels: missing } = inspectH3Readiness(nodes);
      const ok = hasH3 && missing.length === 0;
      return {
        ok,
        label: "ComfyUI",
        latencyMs: Date.now() - start,
        details: {
          stats,
          hasH3,
          missingModels: missing.map((item) => item.name),
          missingModelPaths: missing.map((item) => `${item.directory}${item.name}`)
        },
        message: !hasH3
          ? "ComfyUI 已连接，但缺少 H3 原生节点，请更新到 0.30.0+。"
          : missing.length > 0
            ? `ComfyUI 已连接，但缺少 ${missing.length} 个 H3 模型文件。请进入“模型下载”按标注目录安装。`
            : "ComfyUI 已连接，H3 节点与 5 个模型文件均已就绪。"
      };
    } catch (error) {
      return {
        ok: false,
        label: "ComfyUI",
        latencyMs: Date.now() - start,
        details: {},
        message: describeError(error, "无法连接 ComfyUI")
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
    await this.assertModelsReady(request.mode, signal);
    onProgress("uploading", 5, "正在准备参考素材");
    const workflow = await this.prepareWorkflow(request, task.seed, signal);
    onProgress("queued", 10, "正在提交 ComfyUI 队列");
    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: task.id }),
      signal: requestSignal(signal, 30_000)
    });
    if (!response.ok) throw new Error(`ComfyUI 提交失败：${response.status} ${await response.text()}`);
    const submitted = (await response.json()) as { prompt_id?: string; error?: { message?: string } };
    if (!submitted.prompt_id) throw new Error(submitted.error?.message || "ComfyUI 未返回 prompt_id");
    onProviderId?.(submitted.prompt_id);
    onProgress("running", 15, "ComfyUI 正在生成");

    const output = await this.waitForOutput(submitted.prompt_id, onProgress, signal);
    onProgress("downloading", 94, "正在保存生成结果");
    const outputPath = await this.downloadOutput(output, task.id, signal);
    onProgress("succeeded", 100, "生成完成");
    return { providerTaskId: submitted.prompt_id, outputPath };
  }

  async cancel(providerTaskId?: string): Promise<void> {
    // ComfyUI 无"按 prompt 中断"接口：先把仍在排队的任务出队（对不存在/运行中任务是无害 no-op），
    // 再中断当前采样；本应用本地/SSH 后端并发为 1，两步组合等价于只取消目标任务。
    //
    // **必须带超时**：编排层的 cancel() 会 await 这里，而 `tasks:cancel` 是等待返回的 IPC。
    // ComfyUI 无响应（模型加载卡死、连接半开）时裸 fetch 永不落定，用户点了「停止」
    // 界面一直转圈、任务也停不下来——取消功能在最该起作用的场景失效。
    if (providerTaskId) {
      await fetch(`${this.baseUrl}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [providerTaskId] }),
        signal: AbortSignal.timeout(5_000)
      }).catch(() => undefined);
    }
    await fetch(`${this.baseUrl}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }

  private async assertModelsReady(mode: GenerationRequest["mode"], signal?: AbortSignal): Promise<void> {
    // 必须用 requestSignal 合并超时，不能写 `signal ?? AbortSignal.timeout()`：
    // 编排层传的正是用户取消信号（永不到期），有它就没有超时 → ComfyUI 卡住时这里无限挂住。
    const response = await fetch(`${this.baseUrl}/object_info`, { signal: requestSignal(signal, 12_000) });
    if (!response.ok) throw new Error(`无法读取 ComfyUI 模型清单：HTTP ${response.status}`);
    const nodes = (await response.json()) as JsonObject;
    const readiness = inspectH3Readiness(nodes);
    if (!readiness.hasH3Nodes) throw new Error("当前 ComfyUI 缺少 MiniMax H3 原生节点，请更新到 0.30.0+ 后完全重启。 ");
    const requiredKeys = mode === "video"
      ? new Set(["ref2va", "clip", "videoVae", "audioVae"])
      : new Set(["fl2va", "clip", "videoVae", "audioVae"]);
    const missing = readiness.missingModels.filter((item) => requiredKeys.has(item.key));
    if (missing.length === 0) return;
    const list = missing.map((item) => `${item.name} → ${item.directory}`).join("；");
    throw new Error(`缺少本次生成所需的 H3 模型：${list}。安装后请完全重启 ComfyUI。`);
  }

  private async prepareWorkflow(request: GenerationRequest, seed: number, signal?: AbortSignal): Promise<ComfyPrompt> {
    if (request.mode === "video") {
      if (!request.sourceVideoPath) throw new Error("视频生视频模式必须选择源视频。 ");
      const sourceVideo = await this.upload(request.sourceVideoPath, signal);
      return buildRef2vaWorkflow(request, seed, { sourceVideo });
    }
    // **按模式取素材**：切换模式时界面只是不显示对应的选择器，`request.*Path` 里的旧值仍在。
    // 全都传的话，图生视频模式下会额外挂一个残留的尾帧（实测：buildFl2vaWorkflow 收到
    // stale last 后照样生成 lastImage 节点与 last_frame 输入）——首帧来自参考图、
    // 尾帧却来自上次文生视频残留的文件，生成结果与用户预期完全不符。
    if (request.mode === "image") {
      // 与 MiniMax 同一个边界：`validateRequest` 允许图生视频只设 `firstFramePath`,
      // 只读 `sourceImagePath` 会让这类请求变成"没带图的文生视频"。
      const imagePath = request.sourceImagePath || request.firstFramePath;
      const sourceImage = imagePath ? await this.upload(imagePath, signal) : undefined;
      return buildFl2vaWorkflow(request, seed, { sourceImage });
    }
    // 文生视频：可选首帧/尾帧。
    const [first, last] = await Promise.all([
      request.firstFramePath ? this.upload(request.firstFramePath, signal) : undefined,
      request.lastFramePath ? this.upload(request.lastFramePath, signal) : undefined
    ]);
    return buildFl2vaWorkflow(request, seed, { first, last });
  }

  private async upload(filePath: string, signal?: AbortSignal): Promise<UploadedMedia> {
    // 先验大小再读：BunlessFile.read 会把整份文件读进内存，上 GB 的视频会撑爆主进程。
    const bytes = await readUploadFile(filePath);
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(bytes)]), path.basename(filePath));
    form.append("type", "input");
    form.append("overwrite", "true");
    const response = await fetch(`${this.baseUrl}/upload/image`, { method: "POST", body: form, signal: requestSignal(signal, 120_000) });
    if (!response.ok) throw new Error(`素材上传失败：${response.status} ${await response.text()}`);
    return (await response.json()) as UploadedMedia;
  }

  private async waitForOutput(
    promptId: string,
    onProgress: (status: TaskStatus, progress: number, message?: string) => void,
    signal?: AbortSignal
  ): Promise<{ filename: string; subfolder?: string; type?: string }> {
    let progress = 18;
    const startedAt = Date.now();
    const timeoutMs = 30 * 60 * 1_000; // 30 分钟：防止 ComfyUI 卡死导致任务永远转圈
    for (;;) {
      if (signal?.aborted) throw new DOMException("任务已取消", "AbortError");
      if (Date.now() - startedAt > timeoutMs) throw new Error("等待 ComfyUI 生成超过 30 分钟，已超时终止。请检查 ComfyUI 是否正常运行。");
      const response = await fetch(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: requestSignal(signal, 20_000) });
      if (response.ok) {
        const history = (await response.json()) as Record<string, unknown>;
        const entry = history[promptId] as {
          outputs?: unknown;
          status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
        } | undefined;
        if (entry?.status?.status_str === "error") throw new Error(`ComfyUI 任务失败：${JSON.stringify(entry.status.messages ?? [])}`);
        const output = findMedia(entry?.outputs);
        if (output) return output;
        // 已完成但没有媒体产物：**立刻报错**，不要继续轮询到 30 分钟超时。
        // 实测场景：工作流跑完了、outputs 为空（节点没接 SaveVideo、或模型输出被丢弃）。
        // 旧实现只认 `status_str === "error"`，这种"成功但没东西"的状态会被当成"还在跑"，
        // 于是一直轮询到 30 分钟才报超时——用户白等半小时，还以为是机器慢。
        //
        // **判据只认 `status.completed === true`，不能认 `status_str === "success"`**：
        // 实测（e2e test-03 的 mock，与真实 ComfyUI 行为一致）任务刚入 history 时
        // 就可能带 `status_str: "success"` 而 outputs 还是空的，此时立刻报错会把
        // 还在产出的任务判死。`completed` 才是"整条工作流真正跑完"的信号。
        if (entry && entry.status?.completed === true) {
          throw new Error("ComfyUI 任务已完成，但没有产出视频。请检查工作流的输出节点是否接到了保存/预览节点。");
        }
      }
      progress = Math.min(90, progress + 2);
      onProgress("running", progress, "模型正在采样和解码");
      await delay(3_000, signal);
    }
  }

  private async downloadOutput(
    output: { filename: string; subfolder?: string; type?: string },
    taskId: string,
    signal?: AbortSignal
  ): Promise<string> {
    await mkdir(this.options.outputDirectory, { recursive: true });
    const extension = path.extname(output.filename) || ".mp4";
    const target = path.join(this.options.outputDirectory, `${taskId}${extension}`);
    const query = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder || "",
      type: output.type || "output"
    });
    const response = await fetch(`${this.baseUrl}/view?${query.toString()}`, { signal: requestSignal(signal, 300_000) });
    if (!response.ok) throw new Error(`结果下载失败：${response.status}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }
}

/**
 * 从 ComfyUI `history[promptId].outputs` 里挑出**成片**。
 *
 * 不能见 filename 就取第一个：`outputs` 里常同时有预览帧（`type: "temp"` 的 png）
 * 与真正的视频/音频（`type: "output"`）。旧实现递归取第一个，会把预览图当成生成结果
 * 下载成 .png（实测 probe-findmedia：拿到 preview_frame_0001.png）。
 *
 * 优先级：output 类型的视频/音频 > 任意类型的视频/音频 > 第一个带 filename 的（保底）。
 */
export function findMedia(value: unknown): { filename: string; subfolder?: string; type?: string } | undefined {
  const all: Array<{ filename: string; subfolder?: string; type?: string }> = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.filename === "string") {
      all.push(record as { filename: string; subfolder?: string; type?: string });
      return;
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(value);
  const isMedia = (item: { filename: string }) => /\.(mp4|webm|mov|mkv|gif|mp3|wav|flac)$/i.test(item.filename);
  return all.find((item) => isMedia(item) && item.type === "output")
    ?? all.find(isMedia)
    ?? all[0];
}

/**
 * 可取消的 sleep。
 *
 * **正常结束必须摘掉 abort 监听器**：`{ once: true }` 只在**取消时**生效。
 * 轮询每轮都调一次 delay（ComfyUI 3 秒一轮、最长 30 分钟 ≈ 600 次），
 * 每次都往同一个长生命周期的 signal 上挂一个闭包且从不移除——
 * 连接取消时要遍历几百个已失效的监听器，长任务里还会持续增长。
 * 用 finally 统一摘除，成功与取消两条路径都干净。
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("任务已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 单次请求超时，与调用方取消信号合并。
 *
 * 为什么必须有：`signal ?? AbortSignal.timeout(x)` 只在调用方**没传** signal 时才有超时，
 * 而编排层传的恰恰是取消信号（用户点「停止」才 abort）——它本身永不到期。
 * 于是 ComfyUI 卡住时（模型加载、队列死锁、连接半开）请求无限挂着，任务永远停在
 * "正在提交/正在采样"，用户只能重启应用。
 * CLAUDE.md 明令：「外部调用必须自己加超时……不要让 fetch 裸等」。
 */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

class BunlessFile {
  static async read(filePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(filePath)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
