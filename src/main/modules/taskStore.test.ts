import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userData = await mkdtemp(path.join(tmpdir(), "h3-taskstore-"));
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { TaskStore } = await import("./taskStore");

const taskFile = () => path.join(userData, "tasks.json");

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    parentId: "p1",
    index: 0,
    seed: 1,
    backend: "local",
    mode: "text",
    status: "succeeded",
    progress: 100,
    prompt: "测试",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

describe("TaskStore.load 坏数据容错", () => {
  beforeEach(async () => {
    await writeFile(taskFile(), "[]", "utf8");
  });

  // 关键回归：一条坏数据不该让**全部**任务历史消失。
  // 旧实现 `tasks.map((task) => task.status ...)` 遇 null 抛 TypeError，
  // 被外层 catch 吞成 []，用户任务与回收站一起清空。
  it("数组里有坏元素时保留正常任务", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask(), null, "坏数据", { noId: true }]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks.map((task) => task.id)).toEqual(["t1"]);
  });

  it("非数组（对象/字符串/null）返回空数组且不抛错", async () => {
    for (const bad of [{}, "x", null, 42]) {
      await writeFile(taskFile(), JSON.stringify(bad), "utf8");
      await expect(new TaskStore().load()).resolves.toEqual([]);
    }
  });

  it("文件损坏（非 JSON）返回空数组", async () => {
    await writeFile(taskFile(), "{ 半截", "utf8");
    await expect(new TaskStore().load()).resolves.toEqual([]);
  });

  it("未完成的任务标记为 interrupted 并写回磁盘", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ status: "running" })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].status).toBe("interrupted");
    // save 走串行队列，等它落定再读盘。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const onDisk = JSON.parse(await readFile(taskFile(), "utf8"));
    expect(onDisk[0].status).toBe("interrupted");
  });

  it("坏元素被过滤后同步落盘（不每次启动重复处理）", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask(), null]), "utf8");
    await new TaskStore().load();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const onDisk = JSON.parse(await readFile(taskFile(), "utf8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].id).toBe("t1");
  });

  it("终态任务原样保留、不写盘", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask()]), "utf8");
    const before = await readFile(taskFile(), "utf8");
    await new TaskStore().load();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readFile(taskFile(), "utf8")).toBe(before);
  });
});

// 字段类型归一：磁盘 JSON 是外部数据，`prompt: 123` 会一路穿透到
// `buildAgentMemoryHint`（每轮智能体对话都调 `.trim()`）→ 整条链路挂着。
describe("TaskStore.load 字段类型归一", () => {
  it("prompt 非字符串时归一为空串（不让下游抛 trim is not a function）", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ prompt: 123 })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe("");
  });

  it("progress 非数字时归一为 0", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ progress: "abc" })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].progress).toBe(0);
  });

  it("归一后的脏值会写回磁盘（不只停留在内存）", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ prompt: 123 })]), "utf8");
    await new TaskStore().load();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const onDisk = JSON.parse(await readFile(taskFile(), "utf8"));
    expect(onDisk[0].prompt).toBe("");
  });
});
