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

  // 回归：`String(t.request?.duration ?? "")` 会给"没有这个字段"的任务塞一个空串，
  // 它与真实值平票时，Map 里**先插入**的胜出——缺字段的任务排在前面时，
  // `best` 拿到空串、`best ? …` 判假，整条提示静默消失。
  // 实测（probe-memory2）：同样的 4 条任务，只是缺字段的排在前后不同，提示就时有时无。
  it("部分任务缺 duration/count 时，仍能提炼出其余任务的习惯（不受排序影响）", () => {
    const withFields = () => task({ request: { duration: 6, count: 2 } as never });
    const withoutFields = () => task({});
    for (const tasks of [
      [withoutFields(), withoutFields(), withFields(), withFields()],
      [withFields(), withFields(), withoutFields(), withoutFields()]
    ]) {
      const hint = buildAgentMemoryHint(tasks);
      expect(hint).toContain("常用时长（2/4 条任务为 6 秒）");
      expect(hint).toContain("常用数量（2/4 条任务为 2 路）");
    }
  });

  // 脏数据（duration 被写成字符串）不该被当成一个"习惯值"统计出来。
  it("duration 非数字时不产生「常用时长」", () => {
    const tasks = Array.from({ length: 3 }, () => task({ request: { duration: "abc" } as never }));
    expect(buildAgentMemoryHint(tasks)).not.toContain("常用时长");
  });

  /**
   * **英文 prompt 的主题词不能被逗号粘成一团**（实测 2026-10-21）。
   *
   * `generate_video` 的工具描述明确写着「画面感强的英文 prompt 效果更好」，
   * 所以真实用户的提示词大量是英文、且用逗号分隔短语。而分词只把**中文**标点
   * 与空白当分隔符，英文逗号不断开：`lake,` 变成 5 个字符的"词"（刚好通过长度过滤），
   * bigram 于是产出 `overlake,`、`moonlitlake,` 这类**没有任何意义**的串。
   *
   * 更糟的是它会被注入**每一轮**的系统提示词——一旦用户的英文提示词里有
   * 3 次重复的短语组合，之后每条消息都带着这堆噪声。
   */
  it("英文 prompt 的主题词要按空格切干净（不能把逗号粘进词里）", () => {
    const prompt = "a fairy floating over a moonlit lake, cinematic lighting, ultra detailed, no text, no watermark";
    const tasks = Array.from({ length: 5 }, () => task({ prompt }));
    const hint = buildAgentMemoryHint(tasks);
    // **右边界要含「。」**：`常见主题` 是这条提示里的最后一项，后面接的是
    // 「。用户未明确指定时…」而不是「；」。只按 `；）` 截会把后面的说明文字一起吞进来，
    // 于是断言永远报"含标点"（我第一版就写错了，这是探针/测试自身的错，不是产品的）。
    const matched = /常见主题：([^；。）]*)/.exec(hint)?.[1] ?? "";
    for (const theme of matched.split("、").filter(Boolean)) {
      expect(theme, `主题词「${theme}」不该含标点`).not.toMatch(/[,，.。!！?？、;；:：]/);
    }
  });

  it("中文主题词提取不受这次收紧影响", () => {
    const prompt = "赛博朋克城市夜景，霓虹灯效果，赛博朋克风格";
    const tasks = Array.from({ length: 5 }, () => task({ prompt }));
    expect(buildAgentMemoryHint(tasks)).toContain("赛博朋克");
  });

  // 实测（本会话）：任务记录的 `backend` 是数字时，平票排序会调
  // `a[0].localeCompare(b[0])` → `TypeError: localeCompare is not a function`。
  // 而本函数跑在"构建 system prompt"的热路径上——一个脏任务记录就能让**整轮对话**抛错。
  it("backend 是数字等脏类型时不抛错（也不产出脏习惯）", () => {
    const tasks = [
      task({ backend: 111 as never }),
      task({ backend: 222 as never }),
      task({ backend: "local" as never })
    ];
    expect(() => buildAgentMemoryHint(tasks)).not.toThrow();
    // 三条各 1 条 → 平票，但仍应给出一个稳定结果（不会崩）
    expect(buildAgentMemoryHint(tasks)).toContain("常用后端");
  });
});
