import { describe, expect, it, vi } from "vitest";
import type { GenerationTask } from "../../shared/types";
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
