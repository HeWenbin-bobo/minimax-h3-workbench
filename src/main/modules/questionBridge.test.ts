import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QuestionBridge, formatAnswers } from "./questionBridge";
import type { AgentQuestion } from "./llmService";

const QUESTIONS: AgentQuestion[] = [
  {
    id: "duration",
    header: "视频时长",
    question: "你想要多长的视频？",
    options: [
      { id: "6", label: "6 秒", description: "默认，适合单个镜头" },
      { id: "15", label: "15 秒", description: "能容纳一段完整叙事" }
    ]
  },
  {
    id: "aspect",
    header: "画幅",
    question: "竖屏还是横屏？",
    options: [
      { id: "vertical", label: "竖屏 9:16", description: "适合手机端" },
      { id: "wide", label: "横屏 16:9", description: "适合电脑端" }
    ]
  }
];

describe("formatAnswers", () => {
  it("把选项 id 换成人话（含描述），不让模型去猜 id 含义", () => {
    const text = formatAnswers(QUESTIONS, { duration: ["15"] });
    expect(text).toContain("【视频时长】用户选择：15 秒（能容纳一段完整叙事）");
  });

  it("多选时用顿号连接全部选项", () => {
    const text = formatAnswers(QUESTIONS, { aspect: ["vertical", "wide"] });
    expect(text).toContain("竖屏 9:16（适合手机端）、横屏 16:9（适合电脑端）");
  });

  it("单题未作答时如实说明，并要求按最佳判断处理（不替用户编答案）", () => {
    const text = formatAnswers(QUESTIONS, { duration: ["6"] });
    expect(text).toContain("【画幅】用户未作答");
    expect(text).toContain("按你认为最合理的方式处理");
  });

  it("空问题组不抛错", () => {
    expect(formatAnswers([], {})).toBe("未获得用户回答。");
  });
});

describe("QuestionBridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answer 后 resolve 出格式化答案", async () => {
    const bridge = new QuestionBridge();
    const promise = bridge.ask("s1", "r1", QUESTIONS);
    expect(bridge.answer("r1", { duration: ["15"] })).toBe(true);
    await expect(promise).resolves.toContain("15 秒");
  });

  it("超时 reject（不能 resolve 空值——模型要能区分未答与空答）", async () => {
    const bridge = new QuestionBridge(1_000);
    const promise = bridge.ask("s1", "r1", QUESTIONS);
    const assertion = expect(promise).rejects.toThrow("未在时限内回答");
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    // 超时后登记表已清空：用户再点选是正常竞态，返回 false 而不是二次 resolve
    expect(bridge.answer("r1", { duration: ["6"] })).toBe(false);
  });

  it("跳过走与超时同一条路径（reject），模型按最佳判断继续", async () => {
    const bridge = new QuestionBridge();
    const promise = bridge.ask("s1", "r1", QUESTIONS);
    const assertion = expect(promise).rejects.toThrow("跳过了");
    expect(bridge.skip("r1")).toBe(true);
    await assertion;
  });

  it("会话取消时挂起的问题立即 reject（否则工具循环不退出、该会话永久拒发）", async () => {
    const bridge = new QuestionBridge();
    const promise = bridge.ask("s1", "r1", QUESTIONS);
    const assertion = expect(promise).rejects.toThrow("对话已结束");
    bridge.cancelSession("s1");
    await assertion;
  });

  it("取消只影响自己的会话（多会话并发不能连坐）", async () => {
    const bridge = new QuestionBridge();
    const mine = bridge.ask("s1", "r1", QUESTIONS);
    const theirs = bridge.ask("s2", "r2", QUESTIONS);
    bridge.cancelSession("s1");
    // s2 的仍可正常作答
    expect(bridge.answer("r2", { duration: ["6"] })).toBe(true);
    await expect(theirs).resolves.toContain("6 秒");
    await expect(mine).rejects.toThrow();
  });

  it("已中止的信号直接 reject，不把 resolver 挂进表里", async () => {
    const bridge = new QuestionBridge();
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.ask("s1", "r1", QUESTIONS, controller.signal)).rejects.toThrow("停止了本轮对话");
    expect(bridge.hasPending()).toBe(false);
  });

  it("hasPending 可按会话过滤", () => {
    const bridge = new QuestionBridge();
    void bridge.ask("s1", "r1", QUESTIONS).catch(() => {});
    expect(bridge.hasPending("s1")).toBe(true);
    expect(bridge.hasPending("s2")).toBe(false);
    expect(bridge.hasPending()).toBe(true);
    bridge.cancelSession("s1");
    expect(bridge.hasPending()).toBe(false);
  });
});

// `answers` 来自 IPC（llm:answer），值类型没有保证。
// 旧实现对非数组值直接 `.map()` → "picked.map is not a function"，
// 而这里跑在工具循环的 resolve 路径上，会把整轮对话打挂。
describe("formatAnswers 入参容错", () => {
  const questions = [{
    id: "q1", header: "时长", question: "多久？",
    options: [{ id: "a", label: "8 秒", description: "标准" }]
  }];

  it("字符串答案按单选处理", () => {
    expect(formatAnswers(questions, { q1: "a" } as never)).toContain("8 秒");
  });

  it("数字/对象答案视为未作答，不抛错", () => {
    for (const bad of [42, { x: 1 }, true]) {
      const text = formatAnswers(questions, { q1: bad } as never);
      expect(text).toContain("用户未作答");
    }
  });

  it("数组里混入非字符串项被过滤", () => {
    const text = formatAnswers(questions, { q1: ["a", 42, null, {}] } as never);
    expect(text).toContain("8 秒");
    expect(text).not.toContain("[object Object]");
  });

  it("answers 整体缺失/为 null 时按未作答处理", () => {
    expect(formatAnswers(questions, undefined as never)).toContain("用户未作答");
    expect(formatAnswers(questions, null as never)).toContain("用户未作答");
  });
});
