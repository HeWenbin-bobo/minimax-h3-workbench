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
