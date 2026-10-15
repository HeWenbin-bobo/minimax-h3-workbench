import { describe, it, expect } from "vitest";
import { DEFAULT_FRAGMENTS, buildSystemPrompt, defaultAgentPrompt } from "./agentPrompt";

describe("默认提示词分层", () => {
  it("四层按 base → tools → artifacts → workflow 顺序", () => {
    expect(DEFAULT_FRAGMENTS.map((f) => f.id)).toEqual(["base", "tools", "artifacts", "workflow"]);
  });

  it("全文含四个小节标题，与拆分前的文案一致", () => {
    const text = defaultAgentPrompt();
    expect(text).toContain("# 角色");
    expect(text).toContain("# 你的工具");
    expect(text).toContain("# 文件产物");
    expect(text).toContain("# 工作方式（对齐 Codex / Claude Code）");
    // 拆分只动结构，不改文案：抽查几个改动前存在的原句。
    expect(text).toContain("不是解释你做不了或反问一堆");
    expect(text).toContain("失败就换路");
  });
});

describe("buildSystemPrompt 组装", () => {
  it("无任何可选输入时等于默认四层", () => {
    expect(buildSystemPrompt({})).toBe(defaultAgentPrompt());
  });

  it("自定义提示词整体替换默认层（用户永远优先）", () => {
    const out = buildSystemPrompt({ custom: "# 我自己的规则" });
    expect(out).toBe("# 我自己的规则");
    expect(out).not.toContain("# 你的工具");
  });

  it("只有空白的自定义提示词视为没写，回落默认层", () => {
    expect(buildSystemPrompt({ custom: "   \n  " })).toBe(defaultAgentPrompt());
  });

  it("历史习惯追加在通用提示词之后", () => {
    const out = buildSystemPrompt({ memoryHint: "（参考：常用时长 6 秒）" });
    expect(out.indexOf("# 工作方式")).toBeLessThan(out.indexOf("常用时长"));
  });

  it("world state 增量排在历史习惯之后（越靠近采样点越不被稀释）", () => {
    const out = buildSystemPrompt({ memoryHint: "习惯A", worldState: "环境B" });
    expect(out.indexOf("习惯A")).toBeLessThan(out.indexOf("环境B"));
  });

  it("空 world state 不加尾巴（不产生多余空行）", () => {
    expect(buildSystemPrompt({ worldState: "  \n " })).toBe(defaultAgentPrompt());
  });
});
