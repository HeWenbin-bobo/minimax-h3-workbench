import { describe, it, expect } from "vitest";
import { buildSections, diffWorldState, injectWorldState, type WorldStateSnapshot } from "./worldState";

// 固定用 UTC 字面量：北京时间 = UTC+8，写成 "2026-03-14T10:30:00"（无时区）
// 会随宿主时区解析出不同时刻，CI（UTC）与开发机（+8）断言就会不一致。
const NOW = new Date("2026-03-14T02:30:00Z"); // 北京时间 10:30
const baseInput = { webSearch: true, browserSearch: true, searchApiReady: true, artifactKinds: ["html", "xlsx", "md"], now: NOW };

describe("section 正文", () => {
  it("联网开启时如实列出当前走哪条链路", () => {
    const text = buildSections(baseInput)[1].render();
    expect(text).toContain("可用");
    expect(text).toContain("浏览器渲染");
    expect(text).toContain("搜索 API");
  });

  it("未配置搜索 API 时点明免 key 抓取稳定性一般", () => {
    const text = buildSections({ ...baseInput, searchApiReady: false })[1].render();
    expect(text).toContain("免 key 抓取");
  });

  it("联网全关时明确禁止调用 web_search（开关与工具表必须一致）", () => {
    const text = buildSections({ ...baseInput, webSearch: false, browserSearch: false })[1].render();
    expect(text).toContain("不可用");
    expect(text).toContain("不要调用 web_search");
  });

  it("产物能力如实反映本轮可用的 kind", () => {
    expect(buildSections(baseInput)[2].render()).toContain("html / xlsx / md");
  });

  it("计划模式（无产物）时说明只出方案不产出文件", () => {
    const text = buildSections({ ...baseInput, artifactKinds: [] })[2].render();
    expect(text).toContain("不可用");
    expect(text).toContain("计划模式");
  });

  it("时间含年月日与星期", () => {
    const text = buildSections(baseInput)[0].render();
    expect(text).toContain("2026年3月14日");
    expect(text).toContain("周六");
  });
});

describe("diffWorldState 注入", () => {
  it("首次注入（无快照）发全部 section", () => {
    const { text, snapshot } = diffWorldState(buildSections(baseInput), undefined);
    expect(text).toContain("# 当前时间");
    expect(text).toContain("# 联网状态");
    expect(text).toContain("# 产物能力");
    expect(snapshot).toHaveLength(3);
  });

  it("无变化时**仍然每轮注入**（载体是每轮重建的 system prompt，不发就永久丢失）", () => {
    const first = diffWorldState(buildSections(baseInput), undefined);
    const second = diffWorldState(buildSections(baseInput), first.snapshot);
    // 关键回归：绝不能因为"没变"就返回空串——那会让模型从第 2 轮起看不到任何环境事实。
    expect(second.text).toContain("# 当前时间");
    expect(second.text).toContain("# 联网状态");
    expect(second.text).toContain("# 产物能力");
  });

  it("联网状态变化后正文刷新为新值", () => {
    const first = diffWorldState(buildSections(baseInput), undefined);
    const next = buildSections({ ...baseInput, webSearch: false, browserSearch: false });
    const { text } = diffWorldState(next, first.snapshot);
    expect(text).toContain("# 联网状态");
    expect(text).toContain("不要调用 web_search");
  });

  // 节流语义（本轮修正）：**同一天内超过 15 分钟就要刷新**。
  //
  // 旧规则是"跨天才刷新"，结果是同一会话里过了六小时，模型仍被告知"现在是 09:00"
  // （实测 probe-time-stale：09:00 首次注入 → 15:30 第二轮拿到的还是 09:00）。
  // 用户问"现在几点""离八点还有多久"会得到确定性的错答案，且越聊越离谱。
  it("同一天内 15 分钟以内的变化被节流：正文沿用旧值，但 section 仍在场", () => {
    const first = diffWorldState(buildSections(baseInput), undefined);
    const soon = new Date("2026-03-14T02:40:00Z"); // 北京时间 10:40（+10 分钟）
    const result = diffWorldState(buildSections({ ...baseInput, now: soon }), first.snapshot);
    expect(result.text).toContain("# 当前时间");
    expect(result.text).toContain("10:30");
    expect(result.text).not.toContain("10:40");
    // 快照里保留旧时间——基线不被刷新，否则下一轮又判"变了"。
    expect(result.snapshot.find((entry) => entry.id === "current_time")?.content).toContain("10:30");
  });

  it("同一天内超过 15 分钟必须刷新正文（否则模型一直拿着过时的时间）", () => {
    const first = diffWorldState(buildSections(baseInput), undefined);
    const later = new Date("2026-03-14T07:30:00Z"); // 北京时间 15:30（+5 小时）
    const result = diffWorldState(buildSections({ ...baseInput, now: later }), first.snapshot);
    expect(result.text).toContain("15:30");
    expect(result.text).not.toContain("10:30");
  });

  it("跨天必须刷新正文（否则模型一直拿着昨天的日期，还被告知以此为准）", () => {
    const first = diffWorldState(buildSections(baseInput), undefined);
    const nextDay = new Date("2026-03-15T01:05:00Z"); // 北京时间 3月15日 09:05
    const { text } = diffWorldState(buildSections({ ...baseInput, now: nextDay }), first.snapshot);
    expect(text).toContain("# 当前时间");
    expect(text).toContain("3月15日");
  });

  it("上一轮有、这一轮消失的 section 发作废说明", () => {
    const previous: WorldStateSnapshot = [
      { id: "current_time", content: "旧时间" },
      { id: "network_access", content: "旧联网" }
    ];
    // 候选集里只留联网 → 时间发"作废"，联网正常在场
    const only = buildSections(baseInput).filter((section) => section.id === "network_access");
    const { text } = diffWorldState(only, previous);
    expect(text).toContain("「当前时间」已不再适用");
    expect(text).toContain("# 联网状态");
  });
});

// 剩余上下文余量（移植 Codex TokenBudgetRemainingContext）：
// 让模型知道自己快没空间了，主动收尾而不是展开新工作。
describe("上下文余量 section", () => {
  const withBudget = (remaining: number, limit = 100_000) => ({ ...baseInput, contextBudget: { remainingTokens: remaining, modelLimitTokens: limit } });
  const budgetOf = (input: Parameters<typeof buildSections>[0]) => buildSections(input).find((s) => s.id === "context_budget");

  it("拿不到可信数字时**不注入**（不写「未知」当噪声）", () => {
    expect(budgetOf(baseInput)).toBeUndefined();
  });

  it("窗口上限为 0 时也不注入（避免除零与无意义提示）", () => {
    expect(budgetOf({ ...baseInput, contextBudget: { remainingTokens: 0, modelLimitTokens: 0 } })).toBeUndefined();
  });

  it("充裕时给出正常推进的措辞", () => {
    const text = budgetOf(withBudget(90_000))!.render();
    expect(text).toContain("# 上下文余量");
    expect(text).toContain("剩余约 90%");
    expect(text).toContain("空间充裕");
  });

  it("告急时明确要求立刻收尾、不要再开新工作", () => {
    const text = budgetOf(withBudget(5_000))!.render();
    expect(text).toContain("空间告急");
    expect(text).toContain("立刻收尾");
    expect(text).toContain("不要再展开新工作");
  });

  it("三档措辞各不相同（10/25/50 边界）", () => {
    expect(budgetOf(withBudget(10_000))!.render()).toContain("空间告急");
    expect(budgetOf(withBudget(20_000))!.render()).toContain("空间偏紧");
    expect(budgetOf(withBudget(40_000))!.render()).toContain("空间尚可");
  });

  it("同档内数字变化**不重注入**（否则每轮都发，节流形同虚设）", () => {
    const a = budgetOf(withBudget(90_000))!;
    const b = budgetOf(withBudget(80_000))!; // 都属"充裕"档
    expect(a.shouldReinject!(a.render(), b.render())).toBe(false);
  });

  it("跨档才重注入", () => {
    const plenty = budgetOf(withBudget(90_000))!;
    const tight = budgetOf(withBudget(20_000))!;
    expect(plenty.shouldReinject!(plenty.render(), tight.render())).toBe(true);
  });

  it("剩余量被夹到 0（不会出现负数百分比）", () => {
    const text = budgetOf(withBudget(-500))!.render();
    expect(text).toContain("剩余约 0%");
  });
});

// injectWorldState：环境事实必须作为一条 user 消息附在历史末尾（不能拼进 system prompt——
// 真实 key 实测拼进 system 会被模型无视）。这条是回归护栏。
describe("injectWorldState", () => {
  const history = [
    { role: "user" as const, content: "你好" },
    { role: "assistant" as const, content: "你好" }
  ];

  it("把环境事实作为一条 user 消息追加到末尾", () => {
    const out = injectWorldState(history, "# 当前时间\n2026年10月17日");
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: "user", content: "# 当前时间\n2026年10月17日" });
  });

  it("不改原数组（纯函数）", () => {
    injectWorldState(history, "x");
    expect(history).toHaveLength(2);
  });

  it("空/空白文本原样返回，不产生多余空消息", () => {
    expect(injectWorldState(history, "")).toBe(history);
    expect(injectWorldState(history, "   \n ")).toBe(history);
  });
});

// 时间必须按北京时间显示，且**与宿主时区无关**。
// 旧实现用 `date.getHours()`（本机时区）却固定写「北京时间」：
// 本机不在 UTC+8 时模型会拿到错的时间，而它被明确告知要以此为准。
describe("当前时间固定按北京时间渲染", () => {
  it("UTC 02:30 渲染成北京时间 10:30（不受宿主时区影响）", () => {
    const text = buildSections({ ...baseInput, now: new Date("2026-03-14T02:30:00Z") })[0].render();
    expect(text).toContain("2026年3月14日");
    expect(text).toContain("10:30");
    expect(text).toContain("北京时间");
  });

  it("UTC 前一天的 20:00 已跨到北京时间次日", () => {
    const text = buildSections({ ...baseInput, now: new Date("2026-03-14T20:00:00Z") })[0].render();
    expect(text).toContain("3月15日");
    expect(text).toContain("04:00");
  });
});
