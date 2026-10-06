import { randomUUID } from "node:crypto";
import type { GenerationRequest, GenerationTask, TaskStatus } from "../../shared/types";
import { AdapterRegistry } from "../backends/adapterRegistry";
import { TaskStore } from "./taskStore";

type TaskListener = (task: GenerationTask) => void;

export class GenerationOrchestrator {
  private tasks: GenerationTask[] = [];
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: TaskStore,
    private readonly adapters: AdapterRegistry,
    private readonly listener: TaskListener
  ) {}

  async initialize(): Promise<void> {
    this.tasks = await this.store.load();
  }

  list(): GenerationTask[] {
    return [...this.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async submit(request: GenerationRequest): Promise<GenerationTask[]> {
    validateRequest(request);
    const parentId = randomUUID();
    const now = new Date().toISOString();
    const count = Math.max(1, Math.min(4, Math.round(request.count || 4)));
    const created = Array.from({ length: count }, (_, index): GenerationTask => ({
      id: randomUUID(),
      parentId,
      index,
      seed: request.baseSeed + index,
      backend: request.backend,
      mode: request.mode,
      status: "queued",
      progress: 0,
      prompt: request.prompt.trim(),
      createdAt: now,
      updatedAt: now,
      message: "等待生成",
      request
    }));
    this.tasks.unshift(...created);
    await this.store.save(this.tasks);
    created.forEach(this.listener);

    const concurrency = request.backend === "minimax" ? 2 : 1;
    void runPool(created, concurrency, (task) => this.runTask(request, task));
    return created;
  }

  // 失败/取消任务的一键重试：复用原始请求参数（新种子），生成单个替换任务。
  async retry(taskId: string): Promise<GenerationTask> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("任务不存在。");
    if (!task.request) throw new Error("该任务没有保存原始参数，无法重试。请重新提交。");
    if (!["failed", "cancelled", "interrupted"].includes(task.status)) throw new Error("只有失败或已取消的任务才能重试。");
    const request = { ...task.request, baseSeed: Math.floor(Math.random() * 1_000_000) };
    const parentId = randomUUID();
    const now = new Date().toISOString();
    const created: GenerationTask = {
      id: randomUUID(),
      parentId,
      index: task.index,
      seed: request.baseSeed,
      backend: request.backend,
      mode: request.mode,
      status: "queued",
      progress: 0,
      prompt: request.prompt.trim(),
      createdAt: now,
      updatedAt: now,
      message: "等待重试",
      request: task.request
    };
    this.tasks.unshift(created);
    await this.store.save(this.tasks);
    this.listener({ ...created });
    void runPool([created], request.backend === "minimax" ? 2 : 1, (item) => this.runTask(request, item));
    return created;
  }

  async cancel(taskId: string): Promise<GenerationTask> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("任务不存在。");
    // 先打终态标记：排队任务据此跳过执行，运行中任务据此把 AbortError 归为取消而非失败。
    task.status = "cancelled";
    task.message = "已取消";
    this.controllers.get(taskId)?.abort();
    if (task.providerTaskId) {
      const adapter = await this.adapters.get(task.backend);
      await adapter.cancel?.(task.providerTaskId).catch(() => undefined);
    }
    return this.update(task, "cancelled", task.progress, "已取消");
  }

  private async runTask(request: GenerationRequest, task: GenerationTask): Promise<void> {
    // 提交后才拿到 providerTaskId 之前也可能被取消；运行到中途取消时，用 prompt_id 通知后端中断。
    if (task.status === "cancelled") return;
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    try {
      this.update(task, "validating", 2, "正在校验参数与连接");
      const adapter = await this.adapters.get(request.backend);
      let cancelNotified = false;
      controller.signal.addEventListener("abort", () => {
        if (cancelNotified) return;
        cancelNotified = true;
        // ComfyAdapter.cancel 忽略参数并请求全局 /interrupt（本地/SSH 后端并发为 1，目标即当前任务）；
        // MiniMax 无 cancel 方法，云端任务由 abort 信号停止轮询即可。
        void this.adapters.get(request.backend).then((a) => a.cancel?.(task.providerTaskId ?? "").catch(() => undefined));
      }, { once: true });
      const result = await adapter.generate(
        request,
        task,
        (status, progress, message) => this.update(task, status, progress, message),
        controller.signal,
        (providerTaskId) => {
          // 云后端提交成功即回传 ID：中途取消时 cancel()/abort 监听才能通知云端终止（云任务按次计费）。
          task.providerTaskId = providerTaskId;
          void this.store.save(this.tasks);
        }
      );
      Object.assign(task, result);
      // cancel() 会在另一个调用栈把 status 改写为 cancelled；generate 若仍返回则不覆盖终态。
      if ((task.status as GenerationTask["status"]) === "cancelled") return;
      this.update(task, "succeeded", 100, "生成完成");
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      if (cancelled) {
        this.update(task, "cancelled", task.progress, "已取消");
      } else {
        this.update(task, "failed", task.progress, messageOf(error));
        task.errorCode = "GENERATION_FAILED";
      }
    } finally {
      this.controllers.delete(task.id);
      await this.store.save(this.tasks);
    }
  }

  private update(task: GenerationTask, status: TaskStatus, progress: number, message?: string): GenerationTask {
    task.status = status;
    task.progress = Math.max(0, Math.min(100, Math.round(progress)));
    task.updatedAt = new Date().toISOString();
    task.message = message;
    this.listener({ ...task });
    void this.store.save(this.tasks);
    return task;
  }
}

function validateRequest(request: GenerationRequest): void {
  if (request.backend === "rb") {
    // RB 预设自带时长约束（easy_15/30 固定，flashvsr 只收视频）；prompt 仅 flashvsr 不需要。
    if (request.preset !== "flashvsr_upscale" && !request.prompt?.trim()) throw new Error("请输入视频描述。");
    return;
  }
  if (!request.prompt?.trim()) throw new Error("请输入视频描述。");
  if (request.duration < 4 || request.duration > 15) throw new Error("视频时长必须在 4–15 秒之间。");
  if (request.mode === "image" && !request.sourceImagePath && !request.firstFramePath) {
    throw new Error("图生视频模式必须选择一张图片。");
  }
  if (request.mode === "video" && !request.sourceVideoPath) throw new Error("视频生视频模式必须选择源视频。");
  if (request.lastFramePath && !request.firstFramePath) throw new Error("使用尾帧时必须同时设置首帧。");
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item) await worker(item);
      }
    })
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "生成失败，请检查连接与参数。";
}
