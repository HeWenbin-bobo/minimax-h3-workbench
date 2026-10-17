import { randomUUID } from "node:crypto";
import { describeError } from "../../shared/errors";
import type { GenerationRequest, GenerationTask, TaskStatus } from "../../shared/types";
import { MAX_PROMPT_LENGTH } from "../../shared/types";
import { AdapterRegistry } from "../backends/adapterRegistry";
import { TaskStore } from "./taskStore";

type TaskListener = (task: GenerationTask) => void;

export class GenerationOrchestrator {
  private tasks: GenerationTask[] = [];
  private readonly controllers = new Map<string, AbortController>();
  // 任务历史上限。TaskStore 落盘时的截断只是防御；真正的淘汰在这里按「项目整组」做——
  // 按条数硬截会切断项目组（4 路只剩 2 路），且内存态不裁剪会让 UI 显示得出来、重启后凭空少一批。
  static readonly MAX_TASKS = 200;

  constructor(
    private readonly store: TaskStore,
    private readonly adapters: AdapterRegistry,
    private readonly listener: TaskListener
  ) {}

  async initialize(): Promise<void> {
    this.tasks = await this.store.load();
  }

  list(): GenerationTask[] {
    // 回收站中的任务不进常规列表（渲染端经 tasks:listDeleted 单独获取）。
    return [...this.tasks].filter((task) => !task.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // 历史淘汰：超过上限时按项目整组丢掉最旧的组（不切断组内 4 路），并同步内存态。
  // 回收站中的任务不参与淘汰——它们归 purgeExpired 的 7 天保留策略管，
  // 否则"删除后 7 天内可恢复"的承诺会被容量淘汰悄悄打破。
  private trimHistory(): void {
    const active = this.tasks.filter((task) => !task.deletedAt);
    if (active.length <= GenerationOrchestrator.MAX_TASKS) return;
    const byGroup = new Map<string, GenerationTask[]>();
    for (const task of active) {
      const group = byGroup.get(task.parentId);
      if (group) group.push(task); else byGroup.set(task.parentId, [task]);
    }
    // 组按最新任务时间倒序（新组在前），从头累积到放不下为止，其余整组丢弃。
    const newestOf = (group: GenerationTask[]) => group.reduce((max, task) => (task.createdAt > max ? task.createdAt : max), "");
    const groups = Array.from(byGroup.values()).sort((a, b) => newestOf(b).localeCompare(newestOf(a)));
    const keep = new Set<string>();
    let total = 0;
    for (const group of groups) {
      // 第一组无论多大都保留，避免上限被设得过小时把项目全清空。
      if (keep.size > 0 && total + group.length > GenerationOrchestrator.MAX_TASKS) break;
      for (const task of group) keep.add(task.id);
      total += group.length;
    }
    this.tasks = this.tasks.filter((task) => task.deletedAt || keep.has(task.id));
  }

  // 回收站：软删除（运行中的先取消）→ 7 天内可恢复 → 到期彻底清除（含输出视频）。
  static readonly RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

  async deleteTasks(taskIds: string[]): Promise<GenerationTask[]> {
    const ids = new Set(taskIds);
    const affected: GenerationTask[] = [];
    for (const task of this.tasks) {
      if (!ids.has(task.id) || task.deletedAt) continue;
      // 整组语义：删任一路即删整组（UI 以项目为单位）。
      const siblings = this.tasks.filter((t) => t.parentId === task.parentId);
      for (const sibling of siblings) {
        if (sibling.deletedAt) continue;
        sibling.deletedAt = new Date().toISOString();
        if (!["succeeded", "failed", "cancelled", "interrupted"].includes(sibling.status)) {
          sibling.message = "已删除（生成中止）";
          await this.cancel(sibling.id).catch(() => undefined);
        }
        affected.push(sibling);
      }
    }
    await this.store.save(this.tasks);
    affected.forEach(this.listener);
    return affected;
  }

  async restoreTasks(taskIds: string[]): Promise<GenerationTask[]> {
    const ids = new Set(taskIds);
    const affected: GenerationTask[] = [];
    for (const task of this.tasks) {
      if (!ids.has(task.id) || !task.deletedAt) continue;
      const siblings = this.tasks.filter((t) => t.parentId === task.parentId);
      for (const sibling of siblings) {
        if (!sibling.deletedAt) continue;
        delete sibling.deletedAt;
        affected.push(sibling);
      }
    }
    await this.store.save(this.tasks);
    affected.forEach(this.listener);
    return affected;
  }

  async purgeTasks(taskIds: string[], deleteFile?: (path: string) => Promise<void>): Promise<GenerationTask[]> {
    const ids = new Set(taskIds);
    const affected: GenerationTask[] = [];
    const groupIds = new Set(this.tasks.filter((t) => ids.has(t.id) && t.deletedAt).map((t) => t.parentId));
    for (const task of this.tasks.filter((t) => groupIds.has(t.parentId) && t.deletedAt)) {
      if (task.outputPath && deleteFile) await deleteFile(task.outputPath).catch(() => undefined);
      this.tasks = this.tasks.filter((t) => t.id !== task.id);
      affected.push(task);
    }
    await this.store.save(this.tasks);
    return affected;
  }

  listDeleted(): GenerationTask[] {
    return [...this.tasks].filter((task) => task.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 设置项目分类：整组同值（空串 = 未分类）。 */
  async setCategory(taskId: string, category: string): Promise<GenerationTask[]> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("任务不存在。");
    const normalized = category.trim().slice(0, 20);
    const siblings = this.tasks.filter((t) => t.parentId === task.parentId);
    for (const sibling of siblings) sibling.category = normalized || undefined;
    await this.store.save(this.tasks);
    siblings.forEach(this.listener);
    return siblings;
  }

  /** 启动时清理：回收站中超过 7 天的任务连同输出视频一并清除；返回被清除的输出路径。 */
  async purgeExpired(deleteFile?: (path: string) => Promise<void>): Promise<string[]> {
    const now = Date.now();
    const expired = this.tasks.filter((t) => t.deletedAt && now - new Date(t.deletedAt).getTime() > GenerationOrchestrator.RETENTION_MS);
    const files = expired.map((t) => t.outputPath).filter((p): p is string => Boolean(p));
    if (expired.length > 0) {
      await this.purgeTasks(expired.map((t) => t.id), deleteFile);
    }
    return files;
  }

  async submit(request: GenerationRequest): Promise<GenerationTask[]> {
    validateRequest(request);
    const parentId = randomUUID();
    const now = new Date().toISOString();
    // 只在**没给**时才用默认 4。旧写法 `request.count || 4` 把显式的 0 也当成"没给"，
    // 于是 `count: 0` 会变成 4 路——云端按次计费时等于替用户多扣 4 次。
    // 给 0 的调用方（IPC 可达、智能体工具也会传）本意是"最少"，夹到 1 才对。
    const count = Math.max(1, Math.min(4, Math.round(request.count ?? 4)));
    // **校验器允许缺省的字段必须补上默认值**，见 normalizeRequest 的注释。
    // 写进任务的 request 与传给 runTask 的必须是**同一份**（重试时才不会漂移）。
    const normalized = normalizeRequest(request);
    const created = Array.from({ length: count }, (_, index): GenerationTask => ({
      id: randomUUID(),
      parentId,
      index,
      seed: normalized.baseSeed + index,
      backend: request.backend,
      mode: request.mode,
      status: "queued",
      progress: 0,
      prompt: request.prompt.trim(),
      createdAt: now,
      updatedAt: now,
      message: "等待生成",
      request: normalized
    }));
    // **写盘失败要把内存态回滚**。
    // `save()` 现在会把写盘失败抛给调用方（磁盘满、目录只读），而这里先改了内存：
    // `unshift` 加进了新任务、`trimHistory` 还可能淘汰了旧组。不回滚的话，
    // 用户看到"提交失败"的报错，界面上却仍多出一批停在「等待生成」的幽灵任务，
    // 重启后又消失（因为磁盘上根本没写成功）——典型的"报错了但界面更乱"。
    const before = this.tasks;
    this.tasks = [...created, ...before];
    this.trimHistory();
    try {
      await this.store.save(this.tasks);
    } catch (error) {
      this.tasks = before;
      throw error;
    }
    created.forEach(this.listener);

    const concurrency = request.backend === "minimax" ? 2 : 1;
    // `runTask` 内部有 try/catch，但 `finally` 里的 `store.save` 与 `update()` 里的
    // `listener`（向窗口推送）仍在保护范围外。裸 `void runPool(...)` 会让那类失败
    // 变成未处理的 rejection（Electron 主进程会直接退出）。
    // 用 `normalized` 而不是原始 request：后端读的是 request.width/height/duration 等，
    // 与实际写进任务记录、并在重试时复用的那份必须同源（否则重试会退回未补默认值的版本）。
    void runPool(created, concurrency, (task) => this.runTask(normalized, task)).catch(() => undefined);
    return created;
  }

  // 失败/取消任务的一键重试：复用原始请求参数（新种子），生成单个替换任务。
  async retry(taskId: string): Promise<GenerationTask> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("任务不存在。");
    if (!task.request) throw new Error("该任务没有保存原始参数，无法重试。请重新提交。");
    if (!["failed", "cancelled", "interrupted"].includes(task.status)) throw new Error("只有失败或已取消的任务才能重试。");
    const request = { ...task.request, baseSeed: Math.floor(Math.random() * 1_000_000) };
    // **重试也必须过同一道校验**。`task.request` 来自 `tasks.json`（外部数据），
    // `TaskStore.load` 只归一了 prompt，backend/duration/width 等仍是原样：
    // - `backend: "evil"` 会被 `AdapterRegistry.get` 的分支链**静默落到 SSH**，
    //   用户得到"请填写 SSH 主机和用户名"，与实际动作完全无关；
    // - 非法的 duration/preset 组合会真的发到云端（失败照样扣卡密次数）。
    // 放在建任务之前：脏记录应当被明确拒绝，而不是先建一条注定失败、还会计费的任务。
    validateRequest(request);
    // 和 submit 一样补齐可缺省字段：老记录（或手改过的 tasks.json）可能没有
    // width/height/ratio/resolution，直接透传会让工作流缺必填输入。
    const normalized = normalizeRequest(request);
    const parentId = randomUUID();
    const now = new Date().toISOString();
    const created: GenerationTask = {
      id: randomUUID(),
      parentId,
      index: task.index,
      seed: normalized.baseSeed,
      backend: normalized.backend,
      mode: normalized.mode,
      status: "queued",
      progress: 0,
      prompt: normalized.prompt.trim(),
      createdAt: now,
      updatedAt: now,
      message: "等待重试",
      // 存**本次实际使用**的请求（含新 baseSeed），不能存 task.request（旧种子）——
      // 否则任务自报 seed=新值、存档 request.baseSeed=旧值，两者矛盾（实测复现）。
      request: normalized
    };
    // 与 submit 同一理由：写盘失败要把内存态回滚，否则会留下一条永远「等待重试」的幽灵任务。
    const before = this.tasks;
    this.tasks = [created, ...before];
    this.trimHistory();
    try {
      await this.store.save(this.tasks);
    } catch (error) {
      this.tasks = before;
      throw error;
    }
    this.listener({ ...created });
    void runPool([created], normalized.backend === "minimax" ? 2 : 1, (item) => this.runTask(normalized, item)).catch(() => undefined);
    return created;
  }

  async cancel(taskId: string): Promise<GenerationTask> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("任务不存在。");
    // 已到终态就原样返回：再走一遍会抹掉失败原因（"请先保存 API Key" → "已取消"），
    // 对已成功的任务更糟——状态被翻成"已取消"，成片在界面上消失、只留一条假的中止记录。
    // UI 不给终态任务取消入口，但 tasks:cancel 是一条可达 IPC。
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(task.status)) return { ...task };
    // 先打终态标记：排队任务据此跳过执行，运行中任务据此把 AbortError 归为取消而非失败。
    task.status = "cancelled";
    task.message = "已取消";
    this.controllers.get(taskId)?.abort();
    if (task.providerTaskId) {
      // 通知云端取消是**尽力而为**，整段必须兜住：
      // `adapters.get()` 会去读密钥（`getSecret`），而密钥可能解不开——那次会抛错。
      // 不兜的话异常发生在"已标记取消"与 `update()` 之间，于是任务永远停在半截状态：
      // 内存里说取消了、磁盘没写、渲染端也收不到通知（界面一直显示"取消中"）。
      try {
        const adapter = await this.adapters.get(task.backend);
        await adapter.cancel?.(task.providerTaskId);
      } catch {
        // 云端取消失败不改变本地结论：本地已中止轮询，用户看到的就是"已取消"。
      }
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
        //
        // **必须 catch 到链末**：`adapters.get()` 会读密钥（`getSecret` → 解不开时抛错），
        // 而这里在 abort 回调中、没有任何调用方能接住 —— 裸 `void promise.then(...)`
        // 会变成未处理的 rejection，Node/Electron 主进程**直接退出**（用户点一下取消，软件就没了）。
        void this.adapters
          .get(request.backend)
          .then((a) => a.cancel?.(task.providerTaskId ?? ""))
          .catch(() => undefined);
      }, { once: true });
      const result = await adapter.generate(
        request,
        task,
        (status, progress, message) => this.update(task, status, progress, message),
        controller.signal,
        (providerTaskId) => {
          // 云后端提交成功即回传 ID：中途取消时 cancel()/abort 监听才能通知云端终止（云任务按次计费）。
          task.providerTaskId = providerTaskId;
          // `save()` 现在会把写盘失败抛出来（供能 await 的调用方感知），
          // 这里是 fire-and-forget 回调，必须自己兜住，否则变成未处理的 rejection。
          void this.store.save(this.tasks).catch((error) => {
            console.error("[tasks] 保存任务失败（providerTaskId 回传）：", error instanceof Error ? error.message : error);
          });
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
    // `Math.max(0, Math.min(100, Math.round(NaN)))` 仍是 NaN —— 夹取对 NaN 无效。
    // 适配器若传了 NaN（算错、上游字段缺失），进度条宽度会变成 `NaN%`，
    // 卡片布局错乱且落盘后长期存在（下次启动读回仍是 NaN）。
    task.progress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : task.progress || 0;
    task.updatedAt = new Date().toISOString();
    task.message = message;
    this.listener({ ...task });
    // 同上：`update()` 是同步方法，无法 await，写盘失败只能记录。
    // 真正需要让用户看见的失败点在下单/删除等能返回结果的调用上（它们 `await save()`）。
    void this.store.save(this.tasks).catch((error) => {
      console.error("[tasks] 保存任务进度失败：", error instanceof Error ? error.message : error);
    });
    return task;
  }
}

/**
 * 补齐「校验器允许缺省、但下游当必有」的字段。**submit 与 retry 共用这一处**。
 *
 * `validateRequest` 对 baseSeed / width / height / ratio / resolution 都是
 * "给了才校验类型"（`!== undefined`），但下游把它们当必有：
 * - `baseSeed + index` → `undefined + 0` 是 **NaN**，写进任务记录与 ComfyUI 的
 *   `noise_seed`（JSON 里变成 null），任务卡片显示 "Seed NaN"，且落盘后长期存在；
 * - 缺 width/height 时 ComfyUI 工作流那两个必填输入会被 JSON.stringify 直接丢掉，
 *   提交到 ComfyUI 才报参数错误（用户看到的是云端 400，与真实原因无关）；
 * - ratio/resolution 缺省时 MiniMax 请求体里就没有这两个字段。
 *
 * 返回的新对象要**同时**用于「写进任务的 request」与「传给 runTask」——
 * 两处不同源会让重试读到未补默认值的旧对象（种子/尺寸与实际执行不一致）。
 */
function normalizeRequest(request: GenerationRequest): GenerationRequest {
  const baseSeed = Number.isFinite(request.baseSeed) ? request.baseSeed : Math.floor(Math.random() * 1_000_000);
  return {
    ...request,
    baseSeed,
    width: Number.isFinite(request.width) ? request.width : 1280,
    height: Number.isFinite(request.height) ? request.height : 720,
    // 白名单外的字符串（拼错的、数字、旧版本脏值）一律回落到最常用值，
    // 而不是原样塞进云端请求体。
    ratio: (["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"] as const).includes(request.ratio) ? request.ratio : "16:9",
    resolution: request.resolution === "2K" ? "2K" : "768P"
  };
}

function validateRequest(request: GenerationRequest): void {
  // 入口即做类型兜底：`tasks:submit` 是可达 IPC，参数由渲染端/智能体给出，
  // 不保证类型。`prompt: 123` 会一路走到 `request.prompt.trim()` 抛
  // "p.trim is not a function"（英文技术错误直接透给用户）；
  // 而 `duration: NaN` 能同时绕过 `< 4` 与 `> 15` 两个比较，被原样送进工作流。
  if (!request || typeof request !== "object") throw new Error("生成参数无效。");
  // 后端必须在白名单内：`AdapterRegistry.get()` 的分支链以 SSH 兜底，
  // 未知/拼错的 kind（"RB"、""、null）会**静默落到 SSH**，
  // 用户得到的错误是"请填写 SSH 主机和用户名"——与实际动作完全无关。
  if (!["local", "ssh", "minimax", "rb"].includes(request.backend)) throw new Error("生成后端无效。");
  if (typeof request.prompt !== "string") throw new Error("视频描述必须是文本。");
  if (!Number.isFinite(request.duration)) throw new Error("视频时长必须是数字。");
  if (request.count !== undefined && !Number.isFinite(request.count)) throw new Error("生成数量必须是数字。");
  if (request.baseSeed !== undefined && !Number.isFinite(request.baseSeed)) throw new Error("随机种子必须是数字。");
  if (request.width !== undefined && !Number.isFinite(request.width)) throw new Error("画面宽度必须是数字。");
  if (request.height !== undefined && !Number.isFinite(request.height)) throw new Error("画面高度必须是数字。");
  // 长度上限在工作台/游乐场 UI 已由 maxlength 挡住，但 IPC 与智能体工具是可达入口：
  // 不在这里兜住的话，超长提示词会被真的塞进云端请求体。
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`视频描述不能超过 ${MAX_PROMPT_LENGTH} 字。`);
  }
  if (request.backend === "rb") {
    // RB 预设自带时长约束（flashvsr 只收视频，无 prompt、无时长）：
    // reference / tail_frame 官网只接受 4/6/8 秒；easy_15 / easy_30 是固定时长（忽略 duration）。
    // 必须在这里兜住——工作台 UI 会 clamp，但 tasks:submit 与智能体的 generate_video 工具
    // 都是可达入口（后者会把 4–15 秒原样传进来）。非法 seconds+preset 组合会真的发到云端，
    // **失败也照样扣卡密次数**（CLAUDE.md 记过这条）。
    if (request.preset === "flashvsr_upscale") {
      if (!request.sourceVideoPath) throw new Error("视频变清晰模式必须选择源视频。");
      return;
    }
    if (!request.prompt?.trim()) throw new Error("请输入视频描述。");
    if (request.preset === "easy_15" || request.preset === "easy_30") return; // 固定时长，不用校验
    if (![4, 6, 8].includes(request.duration)) {
      throw new Error("瞬映 RB 的参考图/首尾帧模式只支持 4、6、8 秒。");
    }
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
  return describeError(error, "生成失败，请检查连接与参数。");
}
