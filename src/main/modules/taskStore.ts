import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationTask } from "../../shared/types";

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/**
 * 回收站时间的归一化（与会话侧 `App.normalizeDeletedAt` 同一套理由）。
 *
 * `deletedAt` 参与两处：回收站每项的「N 天后自动清除」，以及启动时的
 * `purgeExpired`（`now - deletedAt > 7 天`）。磁盘里的非法值（`"abc"`）会让
 * `new Date(...)` 得到 Invalid Date：
 * - 界面显示「NaN 天后自动清除」
 * - `Date.now() - NaN > 7 天` 恒为 false → 这条记录**永远不会被清理**
 *   （连同输出视频一起白占磁盘）
 * 非法值按"刚删除"处理，让 7 天计时正常走完；`undefined/null/空串` 仍是"未删除"。
 */
function normalizeDeletedAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) return value;
  return new Date().toISOString();
}

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
        // 除了"是不是数字"，还要**夹回 0–100**：手改或旧版本写进 `progress: 500`
        // 时有限性校验会放行，卡片上显示「500%」、进度条宽度也是 500%
        // （溢出到容器外）。`update()` 对运行期做了夹取，磁盘这条路径漏了。
        const progress = Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : 0;
        // message 同理：任务卡片会 `task.message?.slice(0, 60)`——可选链只挡 null/undefined，
        // 数字照样抛 "task.message.slice is not a function"。
        const message = typeof task.message === "string" ? task.message : undefined;
        // `index` 参与项目内排序（`[...activeProject].sort((a, b) => a.index - b.index)`）：
        // 非数字时比较函数返回 NaN，sort 结果是**未定义顺序**，项目里的 4 路会乱序排。
        // `seed` 直接进 ComfyUI 的 `noise_seed`（非数字会被 JSON.stringify 成 null）。
        // 两者都只在磁盘上出错，界面看不出原因，故在读取边界统一归一。
        const index = Number.isFinite(task.index) ? task.index : 0;
        const seed = Number.isFinite(task.seed) ? task.seed : 0;
        if (index !== task.index || seed !== task.seed) {
          changed = true;
          task = { ...task, index, seed };
        }
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
        // `deletedAt` 决定回收站的保留期与「N 天后自动清除」文案（同会话侧）。
        const deletedAt = normalizeDeletedAt(task.deletedAt);
        if (deletedAt !== task.deletedAt) {
          changed = true;
          task = { ...task, deletedAt };
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
      // 回写归一化结果：**失败不能影响"读到了什么"**。
      // `save()` 现在会把写盘失败抛出来（供能 await 的调用方感知），若让它冒到
      // 外层 catch，`load()` 会返回 [] —— 磁盘满时反而把已读到的好数据全丢光。
      if (changed) {
        await this.save(recovered).catch((error) => {
          console.error("[tasks] 回写归一化结果失败：", error instanceof Error ? error.message : error);
        });
      }
      return recovered;
    } catch (error) {
      // **读不出来不等于"没有历史"**。
      //
      // 旧实现直接 `return []`：调用方（orchestrator.initialize）把空数组当成当前任务表，
      // 之后任何一次写盘（提交新任务、甚至一条进度更新）都会把 `[]` **覆盖**回
      // tasks.json —— 用户的历史记录与回收站内容被永久抹掉。
      // 触发条件并不罕见：杀毒软件短暂锁文件（EBUSY/EACCES）、磁盘故障、
      // 或文件被手工改坏（JSON 解析失败）。
      //
      // 现在分两种情况：
      // - **文件不存在**（ENOENT）：确实没有历史，返回 [] 正常；
      // - 其它失败：先把原文件挪成 `.corrupt-<时间戳>` 备份（保住数据、也避免
      //   下次启动继续踩同一个坏文件），再返回 []。用户仍可在备份里找回内容。
      const code = (error as { code?: unknown })?.code;
      if (code !== "ENOENT") {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        await rename(this.filePath, backup).catch(() => undefined);
        console.error(
          "[tasks] 任务历史读取失败，已备份为",
          backup,
          "：",
          error instanceof Error ? error.message : error
        );
      }
      return [];
    }
  }

  /**
   * 落盘。
   *
   * **失败必须让调用方知道**：旧实现是
   * `this.pending = this.pending.then(...).catch(() => undefined)`，
   * 于是 `await save()` 永远 resolve —— 磁盘满（视频产物很容易占满）、目录只读时，
   * 任务历史一直写不进去，命令却全部"成功"，用户重启后发现这一批记录全没了。
   *
   * 现在：返回值把这次写入的真实结果交给调用方（IPC 层会翻成中文），
   * 队列本身仍不被单次失败污染（后续写入照常进行）。
   */
  async save(tasks: GenerationTask[]): Promise<void> {
    const run = this.pending.then(() => this.write(tasks));
    this.pending = run.then(() => undefined, () => undefined);
    return run;
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
