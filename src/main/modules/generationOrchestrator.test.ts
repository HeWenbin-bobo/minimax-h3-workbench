import { describe, expect, it, vi } from "vitest";
import type { GenerationRequest, GenerationTask } from "../../shared/types";
import { MAX_PROMPT_LENGTH } from "../../shared/types";
import { AdapterRegistry } from "../backends/adapterRegistry";
import { GenerationOrchestrator } from "./generationOrchestrator";
import type { TaskStore } from "./taskStore";

function makeTask(overrides: Partial<GenerationTask> = {}): GenerationTask {
  return {
    id: "t1",
    parentId: "p1",
    index: 0,
    seed: 1,
    backend: "local",
    mode: "text",
    status: "succeeded",
    progress: 100,
    prompt: "测试任务",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    ...overrides
  };
}

function makeOrchestrator(tasks: GenerationTask[]) {
  const store = { load: vi.fn(), save: vi.fn(async () => undefined) } as unknown as TaskStore;
  const listener = vi.fn();
  const orchestrator = new GenerationOrchestrator(store, {} as AdapterRegistry, listener);
  (orchestrator as unknown as { tasks: GenerationTask[] }).tasks = tasks;
  return { orchestrator, store, listener };
}

describe("GenerationOrchestrator 回收站", () => {
  // `save()` 会把写盘失败抛给调用方（磁盘满/只读）。这些操作都是"先就地改内存再写盘"，
  // 不回滚的话用户看到"操作失败"的提示、刷新后列表却已经变了，完全自相矛盾。
  it("deleteTasks 写盘失败时回滚 deletedAt", async () => {
    const group = [makeTask({ id: "t1" }), makeTask({ id: "t2", index: 1 })];
    const { orchestrator, store } = makeOrchestrator(group);
    (store.save as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("磁盘已满"));
    await expect(orchestrator.deleteTasks(["t1"])).rejects.toThrow("磁盘已满");
    expect(orchestrator.list()).toHaveLength(2); // 仍在常规列表里
    expect(orchestrator.listDeleted()).toHaveLength(0);
  });

  it("restoreTasks 写盘失败时回滚 deletedAt", async () => {
    const group = [makeTask({ id: "t1", deletedAt: "2026-10-08T00:00:00.000Z" })];
    const { orchestrator, store } = makeOrchestrator(group);
    (store.save as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("磁盘已满"));
    await expect(orchestrator.restoreTasks(["t1"])).rejects.toThrow("磁盘已满");
    expect(orchestrator.listDeleted()).toHaveLength(1);
  });

  it("setCategory 写盘失败时回滚分类", async () => {
    const group = [makeTask({ id: "t1" }), makeTask({ id: "t2", index: 1 })];
    const { orchestrator, store } = makeOrchestrator(group);
    (store.save as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("磁盘已满"));
    await expect(orchestrator.setCategory("t1", "新分类")).rejects.toThrow("磁盘已满");
    expect(orchestrator.list().every((t) => t.category === undefined)).toBe(true);
  });

  it("deleteTasks 按组软删除并从常规列表隐藏", async () => {
    const group = [makeTask({ id: "t1", index: 0 }), makeTask({ id: "t2", index: 1 })];
    const { orchestrator } = makeOrchestrator(group);
    const affected = await orchestrator.deleteTasks(["t1"]);
    expect(affected.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(affected.every((t) => t.deletedAt)).toBe(true);
    expect(orchestrator.list()).toHaveLength(0);
    expect(orchestrator.listDeleted()).toHaveLength(2);
  });

  it("restoreTasks 按组恢复且重新进入常规列表", async () => {
    const group = [makeTask({ id: "t1", deletedAt: "2026-10-08T00:00:00.000Z" }), makeTask({ id: "t2", deletedAt: "2026-10-08T00:00:00.000Z" })];
    const { orchestrator } = makeOrchestrator(group);
    const restored = await orchestrator.restoreTasks(["t1"]);
    expect(restored).toHaveLength(2);
    expect(restored.every((t) => !t.deletedAt)).toBe(true);
    expect(orchestrator.list()).toHaveLength(2);
  });

  it("purgeTasks 移除记录并调用文件删除（仅限被删任务输出）", async () => {
    const group = [makeTask({ id: "t1", deletedAt: "2026-10-08T00:00:00.000Z", outputPath: "C:\\out\\t1.mp4" })];
    const { orchestrator } = makeOrchestrator(group);
    const deleteFile = vi.fn(async () => undefined);
    const purged = await orchestrator.purgeTasks(["t1"], deleteFile);
    expect(purged.map((t) => t.id)).toEqual(["t1"]);
    expect(deleteFile).toHaveBeenCalledWith("C:\\out\\t1.mp4");
    expect(orchestrator.listDeleted()).toHaveLength(0);
  });

  it("purgeExpired 只清超过 7 天的删除项", async () => {
    const old = makeTask({ id: "t-old", deletedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), outputPath: "C:\\out\\old.mp4" });
    const fresh = makeTask({ id: "t-fresh", parentId: "p2", deletedAt: new Date(Date.now() - 1 * 86_400_000).toISOString() });
    const { orchestrator } = makeOrchestrator([old, fresh]);
    const deleteFile = vi.fn(async () => undefined);
    const files = await orchestrator.purgeExpired(deleteFile);
    expect(files).toEqual(["C:\\out\\old.mp4"]);
    expect(orchestrator.listDeleted().map((t) => t.id)).toEqual(["t-fresh"]);
  });

  // 回归：到期清理**不能**按 parentId 扩展成整组。
  // 上一版的 `purgeTasks` 一律按组删：同一项目里 a1（8 天前删）过期时，
  // 会把 a2（1 天前才删、还剩 6 天可恢复）一起抹掉——不可逆，且违背
  // 「删除后 7 天内可恢复」的承诺。实测 probe-purge-expired 复现。
  it("purgeExpired 不连带删除同组的未过期任务", async () => {
    const expired = makeTask({ id: "a1", parentId: "groupA", deletedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    const freshSibling = makeTask({ id: "a2", parentId: "groupA", index: 1, deletedAt: new Date(Date.now() - 1 * 86_400_000).toISOString() });
    const { orchestrator } = makeOrchestrator([expired, freshSibling]);
    await orchestrator.purgeExpired(vi.fn(async () => undefined));
    expect(orchestrator.listDeleted().map((t) => t.id)).toEqual(["a2"]);
  });

  // 但 UI 的「彻底删除」仍是**整组**语义：界面上按项目成组展示，用户点的是那一组。
  it("purgeTasks（UI 彻底删除）仍按组整组清除", async () => {
    const a = makeTask({ id: "a1", parentId: "groupA", deletedAt: "2026-10-08T00:00:00.000Z" });
    const b = makeTask({ id: "a2", parentId: "groupA", index: 1, deletedAt: "2026-10-08T00:00:00.000Z" });
    const other = makeTask({ id: "b1", parentId: "groupB", deletedAt: "2026-10-08T00:00:00.000Z" });
    const { orchestrator } = makeOrchestrator([a, b, other]);
    const purged = await orchestrator.purgeTasks(["a1"]);
    expect(purged.map((t) => t.id).sort()).toEqual(["a1", "a2"]);
    expect(orchestrator.listDeleted().map((t) => t.id)).toEqual(["b1"]);
  });
});

describe("GenerationOrchestrator 历史淘汰", () => {
  const baseRequest: GenerationRequest = {
    mode: "text", backend: "local", prompt: "容量用例", duration: 4,
    ratio: "16:9", resolution: "768P", width: 1280, height: 720, count: 4, baseSeed: 1
  };

  // 造 groupCount 组 × 4 路；组内同 parentId，createdAt 随组递增（组号越大越旧）
  const makeGroups = (groupCount: number): GenerationTask[] => {
    const tasks: GenerationTask[] = [];
    for (let group = 0; group < groupCount; group += 1) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, group)).toISOString();
      for (let index = 0; index < 4; index += 1) {
        tasks.push(makeTask({ id: `g${group}-${index}`, parentId: `p${group}`, index, createdAt, updatedAt: createdAt }));
      }
    }
    return tasks;
  };

  it("超过上限时淘汰到上限内，且不切断任何项目组", async () => {
    const { orchestrator, store } = makeOrchestrator(makeGroups(51)); // 204 条
    await orchestrator.submit({ ...baseRequest, count: 4 });

    const listed = orchestrator.list();
    expect(listed.length).toBeLessThanOrEqual(GenerationOrchestrator.MAX_TASKS);

    // 逐组检查完整性：留下的每组必须仍是 4 路（按条数硬截会切成 2 路）
    const perGroup = new Map<string, number>();
    for (const task of listed) perGroup.set(task.parentId, (perGroup.get(task.parentId) ?? 0) + 1);
    for (const [parentId, size] of perGroup) expect(`${parentId}:${size}`).toBe(`${parentId}:4`);

    // 内存态与落盘一致（曾只裁剪落盘，导致重启后静默丢任务）
    const saved = (store.save as unknown as { mock: { calls: GenerationTask[][] } }).mock.calls.at(-1)?.[0];
    expect(saved?.length).toBe(listed.length);
  });

  it("回收站中的任务不参与容量淘汰（7 天可恢复的承诺不被打破）", async () => {
    const active = makeGroups(50); // 恰 200 条
    const recycled = [makeTask({ id: "r1", parentId: "pr", deletedAt: "2026-10-01T00:00:00.000Z" })];
    const { orchestrator } = makeOrchestrator([...active, ...recycled]);

    await orchestrator.submit({ ...baseRequest, count: 4 }); // 触发超限淘汰

    expect(orchestrator.listDeleted().map((t) => t.id)).toEqual(["r1"]);
    expect(orchestrator.list().length).toBeLessThanOrEqual(GenerationOrchestrator.MAX_TASKS);
  });

  it("未超限时不做任何淘汰（保留全部历史）", async () => {
    const { orchestrator } = makeOrchestrator(makeGroups(10)); // 40 条
    await orchestrator.submit({ ...baseRequest, count: 4 });
    expect(orchestrator.list()).toHaveLength(44);
  });
});

// 背景：工作台计数器标称 2000 字，但文本域曾无 maxlength、主进程也不校验，
// 2500 字的描述能一路提交到云端。这里固化"标称上限就是真实约束"。
describe("GenerationOrchestrator 提示词长度校验", () => {
  const request: GenerationRequest = {
    mode: "text", backend: "local", prompt: "描述", duration: 4,
    ratio: "16:9", resolution: "768P", width: 1280, height: 720, count: 1, baseSeed: 1
  };

  it("恰好达到上限时放行", async () => {
    const { orchestrator } = makeOrchestrator([]);
    const created = await orchestrator.submit({ ...request, prompt: "长".repeat(MAX_PROMPT_LENGTH) });
    expect(created).toHaveLength(1);
  });

  it("超过上限时拒绝且不建任务", async () => {
    const { orchestrator } = makeOrchestrator([]);
    await expect(orchestrator.submit({ ...request, prompt: "长".repeat(MAX_PROMPT_LENGTH + 1) }))
      .rejects.toThrow(`视频描述不能超过 ${MAX_PROMPT_LENGTH} 字。`);
    expect(orchestrator.list()).toHaveLength(0);
  });

  it("RB 后端同样受限", async () => {
    const { orchestrator } = makeOrchestrator([]);
    await expect(orchestrator.submit({ ...request, backend: "rb", prompt: "长".repeat(MAX_PROMPT_LENGTH + 1) }))
      .rejects.toThrow("视频描述不能超过");
  });
});

// IPC 可达入口的参数类型兜底：渲染端/智能体给出的参数不保证类型。
// 不做兜底时 `prompt: 123` 会抛英文 "p.trim is not a function"，
// 而 `duration: NaN` 能同时绕过 `< 4` 与 `> 15` 两个比较被送进工作流。
describe("validateRequest 类型兜底", () => {
  function submitWith(patch: Record<string, unknown>) {
    const { orchestrator } = makeOrchestrator([]);
    return orchestrator.submit({
      mode: "text", backend: "local", prompt: "测试", duration: 4,
      ratio: "16:9", resolution: "768P", width: 1280, height: 720,
      count: 1, baseSeed: 1, ...patch
    } as never);
  }

  it("prompt 非字符串报中文错误（不透出 trim is not a function）", async () => {
    const error = await submitWith({ prompt: 123 }).catch((e: Error) => e);
    expect((error as Error).message).toBe("视频描述必须是文本。");
  });

  it("duration 为 NaN/Infinity 被拒绝（否则会绕过区间比较）", async () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      await expect(submitWith({ duration: bad })).rejects.toThrow("视频时长必须是数字。");
    }
  });

  it("count / baseSeed / width / height 非数字被拒绝", async () => {
    await expect(submitWith({ count: "abc" })).rejects.toThrow("生成数量必须是数字。");
    await expect(submitWith({ baseSeed: "abc" })).rejects.toThrow("随机种子必须是数字。");
    await expect(submitWith({ width: "abc" })).rejects.toThrow("画面宽度必须是数字。");
    await expect(submitWith({ height: "abc" })).rejects.toThrow("画面高度必须是数字。");
  });

  it("参数对象本身为 null 时报中文错误", async () => {
    const { orchestrator } = makeOrchestrator([]);
    await expect(orchestrator.submit(null as never)).rejects.toThrow("生成参数无效。");
  });

  it("合法参数照常通过（不误伤）", async () => {
    await expect(submitWith({})).resolves.toHaveLength(1);
  });
});

// `count: 0` 曾因 `request.count || 4` 被当成"没给"，于是生成 4 路——
// 云端按次计费时等于替用户多扣 4 次。显式给 0 应夹到 1（"最少"），没给才用默认 4。
describe("submit 的数量夹取", () => {
  function makeRequest(count?: number) {
    return {
      mode: "text" as const, backend: "local" as const, prompt: "测试", duration: 4,
      ratio: "16:9" as const, resolution: "768P" as const, width: 1280, height: 720,
      baseSeed: 1, ...(count === undefined ? {} : { count })
    };
  }

  it("count = 0 夹到 1（不是默认 4）", async () => {
    const { orchestrator } = makeOrchestrator([]);
    await expect(orchestrator.submit(makeRequest(0))).resolves.toHaveLength(1);
  });

  it("未给 count 时按默认 4", async () => {
    const { orchestrator } = makeOrchestrator([]);
    await expect(orchestrator.submit(makeRequest())).resolves.toHaveLength(4);
  });

  it("超过 4 夹到 4，负数夹到 1", async () => {
    const a = makeOrchestrator([]);
    await expect(a.orchestrator.submit(makeRequest(9))).resolves.toHaveLength(4);
    const b = makeOrchestrator([]);
    await expect(b.orchestrator.submit(makeRequest(-3))).resolves.toHaveLength(1);
  });
});

// `validateRequest` 对 baseSeed / width / height / ratio / resolution 是"给了才校验类型"，
// 但 submit 把它们当必有：`undefined + 0` 是 NaN（写进任务记录与 ComfyUI 的 noise_seed），
// 缺 width/height 会让工作流的必填输入在序列化时直接消失。
// 这里锁定"校验器允许的调用方式，下游也能正常执行"。
describe("submit 对可缺省字段补默认值", () => {
  it("缺 baseSeed 时 seed 是有限数（不是 NaN）", async () => {
    const { orchestrator } = makeOrchestrator([]);
    const [task] = await orchestrator.submit({
      mode: "text", backend: "local", prompt: "测试", duration: 4,
      ratio: "16:9", resolution: "768P", width: 1280, height: 720, count: 2
    } as never);
    expect(Number.isFinite(task.seed)).toBe(true);
    // 组内按 index 递增，且与存进任务的 request.baseSeed 一致（重试不会漂移）。
    const all = orchestrator.list();
    expect(all[0].seed + 1).toBe(all[1].seed);
    expect(task.request?.baseSeed).toBe(task.seed);
  });

  it("缺 width/height 时按 720P 16:9 补齐", async () => {
    const { orchestrator } = makeOrchestrator([]);
    const [task] = await orchestrator.submit({
      mode: "text", backend: "local", prompt: "测试", duration: 4,
      ratio: "16:9", resolution: "768P", count: 1, baseSeed: 1
    } as never);
    expect(task.request?.width).toBe(1280);
    expect(task.request?.height).toBe(720);
  });

  it("非法 ratio/resolution 回落到 16:9 / 768P", async () => {
    const { orchestrator } = makeOrchestrator([]);
    const [task] = await orchestrator.submit({
      mode: "text", backend: "local", prompt: "测试", duration: 4,
      ratio: "99:1", resolution: "4K", width: 1280, height: 720, count: 1, baseSeed: 1
    } as never);
    expect(task.request?.ratio).toBe("16:9");
    expect(task.request?.resolution).toBe("768P");
  });
});

// 重试直接展开 `task.request` 建任务，而那份数据来自 tasks.json（外部数据）。
// 不过校验的话：未知 backend 会被 registry 的分支链静默落到 SSH；
// 非法的 RB seconds+preset 会真的发到云端（失败照样扣卡密次数）。
describe("retry 复用存档参数时同样过校验", () => {
  it("存档里 backend 被手改成未知值时拒绝重试，不建任务", async () => {
    const broken = makeTask({
      id: "t-bad",
      status: "failed",
      request: { mode: "text", backend: "evil", prompt: "测试", duration: 4, ratio: "16:9", resolution: "768P", width: 1280, height: 720, count: 1, baseSeed: 1 } as never
    });
    const { orchestrator } = makeOrchestrator([broken]);
    await expect(orchestrator.retry("t-bad")).rejects.toThrow("生成后端无效。");
    expect(orchestrator.list()).toHaveLength(1); // 只有原来那条失败记录
  });

  it("存档里 RB 时长非法时拒绝重试（不会白扣卡密）", async () => {
    const broken = makeTask({
      id: "t-rb",
      status: "failed",
      backend: "rb",
      request: { mode: "text", backend: "rb", prompt: "测试", duration: 10, ratio: "16:9", resolution: "768P", width: 1280, height: 720, count: 1, baseSeed: 1 } as never
    });
    const { orchestrator } = makeOrchestrator([broken]);
    await expect(orchestrator.retry("t-rb")).rejects.toThrow("只支持 4、6、8 秒");
  });
});
