import { describe, it, expect } from "vitest";
import { buildSections, diffWorldState, type WorldStateSnapshot } from "./worldState";

const NOW = new Date("2026-03-14T10:30:00");
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

  it("时间变化被节流：正文沿用旧值（保持 system 前缀稳定），但**仍在场**", () => {
    const first = diffWorldState(buildSections(baseInput), undefined);
    const later = new Date("2026-03-14T10:45:00");
    const result = diffWorldState(buildSections({ ...baseInput, now: later }), first.snapshot);
    // 同一天：正文不刷新（沿用 10:30），但 section 必须仍出现在注入块里。
    expect(result.text).toContain("# 当前时间");
    expect(result.text).toContain("10:30");
    expect(result.text).not.toContain("10:45");
    // 快照里保留旧时间——基线不被刷新，否则下一轮又判"变了"。
    expect(result.snapshot.find((entry) => entry.id === "current_time")?.content).toContain("10:30");
  });

  it("跨天必须刷新正文（否则模型一直拿着昨天的日期，还被告知以此为准）", () => {
    const first = diffWorldState(buildSections(baseInput), undefined);
    const nextDay = new Date("2026-03-15T09:05:00");
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
    expect(text).toContain("current_time 已不再适用");
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
