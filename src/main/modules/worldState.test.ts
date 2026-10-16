import { describe, it, expect } from "vitest";
import { buildSections, diffWorldState, historyTextOf, type WorldStateSnapshot } from "./worldState";

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

describe("diffWorldState 差异注入", () => {
  it("首次注入（无快照、历史里也没有标记）发全部 section", () => {
    const { text, snapshot } = diffWorldState(buildSections(baseInput), undefined, "");
    expect(text).toContain("# 当前时间");
    expect(text).toContain("# 联网状态");
    expect(text).toContain("# 产物能力");
    expect(snapshot).toHaveLength(3);
  });

  it("无变化时不注入任何内容（差异注入的全部意义）", () => {
    const first = diffWorldState(buildSections(baseInput), undefined, "");
    const second = diffWorldState(buildSections(baseInput), first.snapshot, first.text);
    expect(second.text).toBe("");
  });

  it("联网状态变化发 REPLACEMENT 通知，并带上新内容", () => {
    const first = diffWorldState(buildSections(baseInput), undefined, "");
    const next = buildSections({ ...baseInput, webSearch: false, browserSearch: false });
    const { text } = diffWorldState(next, first.snapshot, first.text);
    expect(text).toContain("已变化");
    expect(text).toContain("取代此前");
    expect(text).toContain("不要调用 web_search");
    // 未变化的 section 不得重发
    expect(text).not.toContain("# 产物能力");
  });

  it("时间变化被节流：保留旧快照，不注入（避免每轮都发）", () => {
    const first = diffWorldState(buildSections(baseInput), undefined, "");
    const later = new Date("2026-03-14T10:45:00");
    const result = diffWorldState(buildSections({ ...baseInput, now: later }), first.snapshot, first.text);
    expect(result.text).toBe("");
    // 快照里保留旧时间——基线不被刷新，否则下一轮又判"变了"
    expect(result.snapshot.find((entry) => entry.id === "current_time")?.content).toContain("10:30");
  });

  it("跨天必须重注入（否则模型一直拿着昨天的日期，还被告知以此为准）", () => {
    const first = diffWorldState(buildSections(baseInput), undefined, "");
    const nextDay = new Date("2026-03-15T09:05:00");
    const { text } = diffWorldState(buildSections({ ...baseInput, now: nextDay }), first.snapshot, first.text);
    expect(text).toContain("# 当前时间");
    expect(text).toContain("已变化");
    expect(text).toContain("3月15日");
  });

  it("上一轮有、这一轮消失的 section 发 REMOVAL 通知", () => {
    const previous: WorldStateSnapshot = [
      { id: "current_time", content: "旧时间" },
      { id: "network_access", content: "旧联网" }
    ];
    // 候选集里只留联网 → 联网发替换、时间发作废
    const only = buildSections(baseInput).filter((section) => section.id === "network_access");
    const { text } = diffWorldState(only, previous, "");
    expect(text).toContain("current_time 已不再适用");
  });

  it("无快照但历史里已有标记 → 按「已见过」处理，不重发（进程重启场景）", () => {
    const sections = buildSections(baseInput);
    // 历史里只有产物能力的标记：那一条不发，另两条照发
    const { text } = diffWorldState(sections, undefined, "# 产物能力\n可用类型：html");
    expect(text).not.toContain("# 产物能力");
    expect(text).toContain("# 联网状态");
    expect(text).toContain("# 当前时间");
  });

  it("全部标记都在历史里 → 一条都不发", () => {
    const sections = buildSections(baseInput);
    const history = sections.map((section) => section.marker).join("\n");
    expect(diffWorldState(sections, undefined, history).text).toBe("");
  });
});

describe("historyTextOf", () => {
  it("拼接两侧内容，空内容不产生杂讯", () => {
    expect(historyTextOf([{ role: "user", content: "A" }, { role: "assistant", content: "" }, { role: "user", content: "B" }])).toBe("A\n\nB");
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
