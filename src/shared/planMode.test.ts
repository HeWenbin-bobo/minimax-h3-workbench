import { describe, expect, it } from "vitest";
import {
  PLAN_EXECUTION_PROMPT,
  PLAN_MODE_BLOCKED_TOOLS,
  PLAN_MODE_PROMPT,
  looksLikePlan,
  withPlanMode
} from "./planMode";

describe("计划模式提示词", () => {
  it("明确要求不调用工具（否则模型会直接动手）", () => {
    expect(PLAN_MODE_PROMPT).toContain("不调用任何工具");
    for (const tool of PLAN_MODE_BLOCKED_TOOLS) {
      expect(PLAN_MODE_PROMPT).toContain(tool);
    }
  });

  it("要求结尾给出确认话术，而不是把球踢回给用户", () => {
    expect(PLAN_MODE_PROMPT).toContain("确认后我就开始执行");
  });

  it("为简单任务留了出口（不强行分步）", () => {
    expect(PLAN_MODE_PROMPT).toContain("不需要分步");
  });

  it("执行阶段提示词要求直接动手、不复述计划", () => {
    expect(PLAN_EXECUTION_PROMPT).toContain("不要再复述计划");
  });

  it("被禁工具就是不产生副作用的两个", () => {
    expect([...PLAN_MODE_BLOCKED_TOOLS].sort()).toEqual(["create_file", "generate_video"]);
  });
});

describe("withPlanMode 拼接", () => {
  it("计划模式：段落追加在用户提示词之后（本轮规则优先）", () => {
    const result = withPlanMode("你是助手。", "plan");
    expect(result.startsWith("你是助手。")).toBe(true);
    expect(result).toContain("本轮是「计划模式」");
    expect(result).toContain("可用工具");
  });

  it("执行模式：只追加执行段，不带计划约束", () => {
    const result = withPlanMode("你是助手。", "execute");
    expect(result).toContain("计划已确认");
    expect(result).not.toContain("本轮是「计划模式」");
  });

  it("基础提示词为空时不产生前导空行", () => {
    expect(withPlanMode("", "plan").startsWith("# 本轮是")).toBe(true);
  });
});

describe("looksLikePlan 判定", () => {
  it("有序列表 ≥2 项即认为是计划", () => {
    const plan = ["1. 先用 web_search 查 iPhone 18 Pro 的京东价格", "2. 把结果整理成 csv 表格", "3. 用 create_file 存成 Excel 文件"].join("\n");
    expect(looksLikePlan(plan)).toBe(true);
  });

  it("两条列表项但整体过短时不误判（避免把短回答当计划）", () => {
    expect(looksLikePlan("1. 甲\n2. 乙")).toBe(false);
  });

  it("出现标志词也认为像计划（容忍格式差异）", () => {
    expect(looksLikePlan("我打算这样做，确认后我就开始执行。先查价格再出表格，最后存成 Excel 文件。")).toBe(true);
  });

  it("短回复不算计划", () => {
    expect(looksLikePlan("好的")).toBe(false);
    expect(looksLikePlan("")).toBe(false);
  });

  it("普通长回答（无列表无标志词）不算计划", () => {
    const paragraph = "这是一段普通的回答，".repeat(8) + "没有任何列表结构。";
    expect(looksLikePlan(paragraph)).toBe(false);
  });
});
