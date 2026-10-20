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

  // 题目对象由**模型**生成，schema 不保证 `options` 一定在（历史数据/老版本也会缺）。
  // 这个函数跑在工具循环的 resolve 路径上，抛错会让整轮对话挂掉——
  // 实测（probe-more）：缺 `options` 时 `.find` 直接抛 TypeError。
  it("题目缺 options / label / description 时不抛错", () => {
    const noOptions = [{ id: "q1", header: "时长", question: "多久？" }];
    expect(() => formatAnswers(noOptions as never, { q1: ["a"] })).not.toThrow();
    // 选项找不到就退回原始 id，不要编一个不存在的中文名。
    expect(formatAnswers(noOptions as never, { q1: ["a"] })).toContain("用户选择：a");

    const noLabels = [{ id: "q1", header: "时长", question: "多久？", options: [{ id: "a" }] }];
    const text = formatAnswers(noLabels as never, { q1: ["a"] });
    expect(text).not.toContain("undefined");
    expect(text).toContain("用户选择：a");
  });
});

// 实测缺陷：模型偶尔给两个问题同一个 id（复制粘贴，或干脆都写 `q`）。
// 答案表是 `{ [id]: [optionId] }`，按 id 查表时**后一题会顶用前一题的答案**——
// 用户只答了"时长 6 秒"，回执里"画幅"也变成了"用户选择：横屏"。
// 入口（request_user_input）会去重；这里再兜一层：同一个 id 只用一次。
describe("formatAnswers：重复的问题 id", () => {
  const dup: AgentQuestion[] = [
    { id: "q", header: "时长", question: "几秒？", options: [{ id: "a", label: "6 秒", description: "短" }] },
    { id: "q", header: "画幅", question: "横还是竖？", options: [{ id: "a", label: "横屏", description: "" }] }
  ];

  it("同一个 id 的第二题按未作答处理（不能替用户编答案）", () => {
    const text = formatAnswers(dup, { q: ["a"] });
    expect(text).toContain("【时长】用户选择：6 秒");
    expect(text).toContain("【画幅】用户未作答");
  });
});

/**
 * `pendingFor` —— 切页后补回丢掉的选择题（实测缺陷 probe-question-while-away）。
 *
 * 渲染端切页会卸载 `PlaygroundPage`，那段时间 `llm:question` 事件没有订阅者、被丢弃，
 * 而 `ask()` 仍在挂起等回答。渲染端挂载时经 IPC 调这个方法来补挂卡片，
 * 所以它必须**不消耗**登记项（只是读，不能 settle），且按会话隔离。
 */
describe("QuestionBridge.pendingFor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("能取到本会话挂起的问题与 requestId", () => {
    const bridge = new QuestionBridge();
    void bridge.ask("s1", "r1", QUESTIONS).catch(() => undefined);
    expect(bridge.pendingFor("s1")).toEqual({ requestId: "r1", questions: QUESTIONS });
  });

  it("**只是读**：取过之后仍可正常作答（不能把登记项消费掉）", async () => {
    const bridge = new QuestionBridge();
    const promise = bridge.ask("s1", "r1", QUESTIONS);
    bridge.pendingFor("s1");
    bridge.pendingFor("s1"); // 多次调用也必须无害
    expect(bridge.answer("r1", { duration: ["15"] })).toBe(true);
    await expect(promise).resolves.toContain("15 秒");
  });

  it("按会话隔离：别的会话的问题取不到", () => {
    const bridge = new QuestionBridge();
    void bridge.ask("s1", "r1", QUESTIONS).catch(() => undefined);
    expect(bridge.pendingFor("s2")).toBeUndefined();
  });

  it("没有挂起项时返回 undefined（不是空对象）", () => {
    expect(new QuestionBridge().pendingFor("s1")).toBeUndefined();
  });

  it("答完之后取不到（登记项已落定）", async () => {
    const bridge = new QuestionBridge();
    const promise = bridge.ask("s1", "r1", QUESTIONS);
    bridge.answer("r1", { duration: ["6"] });
    await promise;
    expect(bridge.pendingFor("s1")).toBeUndefined();
  });
});
