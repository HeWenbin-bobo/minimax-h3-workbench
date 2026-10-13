import { describe, expect, it } from "vitest";
import type { GenerationTask } from "../../shared/types";
import { buildAgentMemoryHint } from "./agentMemory";

const task = (overrides: Partial<GenerationTask>): GenerationTask => ({
  id: Math.random().toString(36).slice(2),
  parentId: "g1",
  index: 0,
  seed: 1,
  backend: "rb",
  mode: "text",
  status: "succeeded",
  progress: 100,
  prompt: "一只猫在草地上奔跑",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  ...overrides
});

describe("buildAgentMemoryHint", () => {
  it("样本少于 3 条时不提炼（避免把偶然当习惯）", () => {
    expect(buildAgentMemoryHint([task({}), task({})])).toBe("");
    expect(buildAgentMemoryHint([])).toBe("");
  });

  it("提炼高频时长/数量/后端", () => {
    const tasks = Array.from({ length: 4 }, () => task({
      request: { duration: 6, count: 2 } as never,
      backend: "rb"
    }));
    const hint = buildAgentMemoryHint(tasks);
    expect(hint).toContain("常用时长（4/4 条任务为 6 秒）");
    expect(hint).toContain("常用数量（4/4 条任务为 2 路）");
    expect(hint).toContain("常用后端（4/4 条任务为 rb）");
  });

  it("常见主题：高频 bigram 被提炼", () => {
    const prompt = "赛博朋克城市夜景，霓虹灯效果，赛博朋克风格";
    const tasks = Array.from({ length: 5 }, () => task({ prompt }));
    const hint = buildAgentMemoryHint(tasks);
    expect(hint).toContain("赛博朋克");
  });

  it("hint 是追加段落而非替换（用户自定义提示优先的语义）", () => {
    const tasks = Array.from({ length: 3 }, () => task({}));
    const hint = buildAgentMemoryHint(tasks);
    expect(hint.startsWith("\n\n")).toBe(true);
    expect(hint).toContain("用户明确说了的参数永远优先");
  });
});
