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

  // index 参与项目内排序（`sort((a, b) => a.index - b.index)`），非数字会让比较函数
  // 返回 NaN → 4 路结果顺序未定义；seed 直接进 ComfyUI 的 noise_seed（非数字变 null）。
  it("index / seed 非数字时归一为 0", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ index: "abc", seed: null })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].index).toBe(0);
    expect(tasks[0].seed).toBe(0);
  });

  it("index / seed 正常数字原样保留（不误伤）", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ index: 3, seed: 12345 })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].index).toBe(3);
    expect(tasks[0].seed).toBe(12345);
  });
});

// message 也必须归一：任务卡片会 `task.message?.slice(0, 60)`，
// 可选链只挡 null/undefined —— 数字照样抛 "task.message.slice is not a function"。
describe("TaskStore.load message 归一", () => {
  it("message 非字符串时归一为 undefined（不留数字/对象）", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ message: 123 })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].message).toBeUndefined();
  });

  it("message 为正常字符串时原样保留", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ message: "生成完成" })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].message).toBe("生成完成");
  });

  it("request.prompt 非字符串时归一为空串（重试路径会 trim）", async () => {
    const badRequest = { ...makeTask().request, prompt: 123 };
    await writeFile(taskFile(), JSON.stringify([makeTask({ request: badRequest })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].request?.prompt).toBe("");
  });
});

// parentId 缺失会让"整组"语义把所有缺 parentId 的无辜任务一起删掉；
// createdAt 非字符串会让 list() 的排序直接抛错（整个任务列表打不开）。
describe("TaskStore.load parentId / 时间字段归一", () => {
  it("parentId 缺失时回落到自身 id（不把无关任务串成一组）", async () => {
    await writeFile(taskFile(), JSON.stringify([
      makeTask({ id: "a", parentId: undefined }),
      makeTask({ id: "b", parentId: undefined })
    ]), "utf8");
    const tasks = await new TaskStore().load();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    expect(byId.get("a")?.parentId).toBe("a");
    expect(byId.get("b")?.parentId).toBe("b");
    expect(byId.get("a")?.parentId).not.toBe(byId.get("b")?.parentId);
  });

  it("createdAt 非字符串时归一为可比较的时间串（list 排序不抛错）", async () => {
    await writeFile(taskFile(), JSON.stringify([
      makeTask({ id: "a", createdAt: 123 }),
      makeTask({ id: "b", createdAt: "2026-10-01T00:00:00.000Z" })
    ]), "utf8");
    const tasks = await new TaskStore().load();
    for (const task of tasks) expect(typeof task.createdAt).toBe("string");
    // 复刻 list() 的排序，确认不抛
    expect(() => [...tasks].sort((x, y) => y.createdAt.localeCompare(x.createdAt))).not.toThrow();
  });

  it("updatedAt 缺失时回落到 createdAt", async () => {
    await writeFile(taskFile(), JSON.stringify([
      makeTask({ id: "a", updatedAt: undefined, createdAt: "2026-10-02T03:04:05.000Z" })
    ]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].updatedAt).toBe("2026-10-02T03:04:05.000Z");
  });
});

// 任务侧 deletedAt 与会话侧同源：非法值会让回收站显示「NaN 天后自动清除」，
// 且 `Date.now() - NaN > 7 天` 恒为 false —— purgeExpired 永远清不掉（连视频一起白占磁盘）。
describe("TaskStore.load deletedAt 归一", () => {
  it("非法字符串被改成可解析时间（7 天计时能正常走）", async () => {
    const before = Date.now();
    await writeFile(taskFile(), JSON.stringify([makeTask({ deletedAt: "abc" })]), "utf8");
    const tasks = await new TaskStore().load();
    const stamp = new Date(tasks[0].deletedAt!).getTime();
    expect(Number.isNaN(stamp)).toBe(false);
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);
    // 关键：7 天后必须真的被判为过期
    expect(Date.now() - stamp > 7 * 86_400_000).toBe(false);
  });

  it("非字符串被改成可解析时间", async () => {
    await writeFile(taskFile(), JSON.stringify([makeTask({ deletedAt: 123 })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(Number.isNaN(new Date(tasks[0].deletedAt!).getTime())).toBe(false);
  });

  it("空值/缺失仍表示「未删除」（不误标成已删除）", async () => {
    for (const value of [undefined, null, ""]) {
      await writeFile(taskFile(), JSON.stringify([makeTask({ deletedAt: value })]), "utf8");
      const tasks = await new TaskStore().load();
      expect(tasks[0].deletedAt).toBeUndefined();
    }
  });

  it("合法时间串原样保留", async () => {
    const iso = "2026-10-01T00:00:00.000Z";
    await writeFile(taskFile(), JSON.stringify([makeTask({ deletedAt: iso })]), "utf8");
    const tasks = await new TaskStore().load();
    expect(tasks[0].deletedAt).toBe(iso);
  });
});
