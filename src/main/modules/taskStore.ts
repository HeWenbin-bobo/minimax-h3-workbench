import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationTask } from "../../shared/types";

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

export class TaskStore {
  private readonly filePath = path.join(app.getPath("userData"), "tasks.json");
  // 进度更新高频触发 save；串行化写入链，避免并发原子写同一 .tmp 文件在 Windows 上互撞。
  private pending: Promise<void> = Promise.resolve();

  async load(): Promise<GenerationTask[]> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      // 逐条容错：一条坏数据不该让**全部**任务历史消失。
      // 旧实现直接 `tasks.map(...)` 并靠外层 catch 兜底：数组里只要有一个 null/非对象，
      // 访问 `task.status` 就抛 TypeError → catch 返回 [] → 用户的任务记录与回收站里的
      // 「7 天可恢复」全部一次性清空（与渲染端会话加载同一类错误，见 App.normalizeStoredSessions）。
      const tasks = (Array.isArray(raw) ? raw : []).filter(
        (task): task is GenerationTask => Boolean(task) && typeof task === "object" && typeof (task as GenerationTask).id === "string"
      );
      // 丢掉坏元素后要落盘一次，否则每次启动都重复过滤、且坏数据一直留在文件里。
      let changed = Array.isArray(raw) && raw.length !== tasks.length;
      const recovered = tasks.map((task) => {
        // 字段类型也要归一：磁盘 JSON 是外部数据，`prompt: 123` 这类脏值会一路穿透——
        // `buildAgentMemoryHint` 每轮都读 `task.prompt.trim()`（整条智能体链路会挂），
        // 任务卡片的 `prompt.slice()`、`retry` 的 `prompt.trim()` 同理。
        // 在读取边界修一次，比在每个下游各判一次便宜且不易漏。
        const prompt = typeof task.prompt === "string" ? task.prompt : "";
        const progress = Number.isFinite(task.progress) ? task.progress : 0;
        // message 同理：任务卡片会 `task.message?.slice(0, 60)`——可选链只挡 null/undefined，
        // 数字照样抛 "task.message.slice is not a function"。
        const message = typeof task.message === "string" ? task.message : undefined;
        // request.prompt 也会被重试路径 `prompt.trim()` 读取。
        const normalizedRequest = task.request && typeof task.request.prompt === "string"
          ? task.request
          : typeof task.request === "object" && task.request
            ? { ...task.request, prompt: "" }
            : task.request;
        if (prompt !== task.prompt || progress !== task.progress || message !== task.message || normalizedRequest !== task.request) {
          changed = true;
          task = { ...task, prompt, progress, message, request: normalizedRequest };
        }
        // `parentId` 缺失时**每个**任务的 parentId 都是 undefined，
        // 而删除/恢复/分类都按 parentId 找"同组"——删一条会把所有缺 parentId 的
        // 无辜任务一起删掉（实测：`filter(t => t.parentId === target.parentId)` 命中全部）。
        // 缺失时回落到自身 id，保证"组"至少是它自己。
        if (typeof task.parentId !== "string" || !task.parentId) {
          changed = true;
          task = { ...task, parentId: task.id };
        }
        // 排序依据：`list()` / `listDeleted()` 都调 `createdAt.localeCompare`，
        // 非字符串会抛 "b.createdAt.localeCompare is not a function"，整个任务列表打不开。
        // `updatedAt` 同样参与卡片展示与回收站保留期计算。
        const createdAt = typeof task.createdAt === "string" && task.createdAt ? task.createdAt : new Date(0).toISOString();
        const updatedAt = typeof task.updatedAt === "string" && task.updatedAt ? task.updatedAt : createdAt;
        if (createdAt !== task.createdAt || updatedAt !== task.updatedAt) {
          changed = true;
          task = { ...task, createdAt, updatedAt };
        }
        if (terminal.has(task.status)) return task;
        changed = true;
        return {
          ...task,
          status: "interrupted" as const,
          updatedAt: new Date().toISOString(),
          message: "应用上次退出时任务尚未完成，请重新提交。"
        };
      });
      if (changed) await this.save(recovered);
      return recovered;
    } catch {
      return [];
    }
  }

  async save(tasks: GenerationTask[]): Promise<void> {
    this.pending = this.pending.then(() => this.write(tasks)).catch(() => undefined);
    return this.pending;
  }

  private async write(tasks: GenerationTask[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    // 这里不按条数截断：淘汰归 GenerationOrchestrator.trimHistory 管（按项目整组淘汰，
    // 且刻意让回收站任务不参与计数以保住"7 天可恢复"承诺）。此处再硬截一次会与那套策略打架——
    // 实测内存 300 条（200 在役 + 100 回收站）只落盘 200 条，重启后 100 条任务凭空消失。
    // 体积上界由 trimHistory（在役 ≤200）与 purgeExpired（回收站 7 天）共同约束。
    await writeFile(temporary, JSON.stringify(tasks, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
