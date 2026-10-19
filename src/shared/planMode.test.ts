import { describe, expect, it } from "vitest";
import {
  PLAN_BLOCK_CLOSE,
  PLAN_BLOCK_OPEN,
  PLAN_EXECUTION_PROMPT,
  PLAN_MODE_BLOCKED_TOOLS,
  PLAN_MODE_PROMPT,
  PLAN_MODE_READONLY_TOOLS,
  PLAN_MODE_TOOL_NOTE,
  extractProposedPlan,
  looksLikePlan,
  withPlanMode
} from "./planMode";

describe("计划模式提示词", () => {
  it("明确要求不产生副作用（否则模型会直接动手）", () => {
    expect(PLAN_MODE_PROMPT).toContain("不产生副作用");
    // 被禁的工具必须**逐一点名**：只说"别动工具"模型会自己猜边界。
    for (const tool of PLAN_MODE_BLOCKED_TOOLS) {
      expect(PLAN_MODE_TOOL_NOTE).toContain(tool);
    }
  });

  // 实测矛盾：旧提示词第 1 条说「不调用任何工具」，后面又说「用 web_search 查完再写计划」，
  // 而工具表里 web_search / open_page / read_artifact 其实是下发的。
  // 模型只能二选一：该查的不查（凭记忆编参数），或者查了以后以为自己违规。
  it("只读工具在提示词里明确写「可用」，与工具表同一套边界", () => {
    expect(PLAN_MODE_PROMPT).toContain("只读工具照常可用");
    for (const tool of PLAN_MODE_READONLY_TOOLS) {
      expect(PLAN_MODE_TOOL_NOTE).toContain(tool);
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

  it("被禁工具就是全部会产生副作用的（含 edit / inspect / update_plan）", () => {
    // 旧断言只列了 generate_video / create_file，而工具表其实还摘了
    // edit_artifact / edit_artifact_batch / inspect_artifact / update_plan——
    // 清单与实现不同步，测试就给了一个错的"事实"。
    expect([...PLAN_MODE_BLOCKED_TOOLS].sort()).toEqual([
      "create_file", "edit_artifact", "edit_artifact_batch", "generate_video", "inspect_artifact", "update_plan"
    ]);
  });

  it("抄了 plan.md 的「用户催也不改」：催也不退出计划模式", () => {
    expect(PLAN_MODE_PROMPT).toContain("用户催也不改");
  });

  it("抄了 plan.md 的「两类未知」：可查的先查，只有偏好才问", () => {
    expect(PLAN_MODE_PROMPT).toContain("两类未知");
    expect(PLAN_MODE_PROMPT).toContain("可查到的事实");
    expect(PLAN_MODE_PROMPT).toContain("先自己去查");
    expect(PLAN_MODE_PROMPT).toContain("用户的偏好与取舍");
  });

  it("显式隔离 update_plan（对齐 Codex 在 Plan Mode 禁用该工具）", () => {
    expect(PLAN_MODE_PROMPT).toContain("update_plan");
    expect(PLAN_MODE_PROMPT).toContain("本轮它不下发");
  });

  it("给出 <proposed_plan> 块契约，且标签逐字出现", () => {
    expect(PLAN_MODE_PROMPT).toContain(PLAN_BLOCK_OPEN);
    expect(PLAN_MODE_PROMPT).toContain(PLAN_BLOCK_CLOSE);
  });
});

describe("extractProposedPlan", () => {
  it("切出块内内容", () => {
    const text = `前言\n${PLAN_BLOCK_OPEN}\n## 标题\n1. 第一步\n${PLAN_BLOCK_CLOSE}\n后记`;
    expect(extractProposedPlan(text)).toBe("## 标题\n1. 第一步");
  });

  it("无块返回 undefined（退回纯文本渲染）", () => {
    expect(extractProposedPlan("就是一段普通回答，没有方案块。")).toBeUndefined();
  });

  it("标签不闭合返回 undefined——不能返回半截内容", () => {
    expect(extractProposedPlan(`${PLAN_BLOCK_OPEN}\n## 写到一半`)).toBeUndefined();
  });

  it("空块返回 undefined（空方案不该亮「继续执行」）", () => {
    expect(extractProposedPlan(`${PLAN_BLOCK_OPEN}\n\n   \n${PLAN_BLOCK_CLOSE}`)).toBeUndefined();
  });

  it("多个块只取第一个（Codex 规定一轮最多一个）", () => {
    const text = `${PLAN_BLOCK_OPEN}甲${PLAN_BLOCK_CLOSE}中间${PLAN_BLOCK_OPEN}乙${PLAN_BLOCK_CLOSE}`;
    expect(extractProposedPlan(text)).toBe("甲");
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

  it("出现 <proposed_plan> 块即认为像计划（最强信号，不受长度限制）", () => {
    expect(looksLikePlan(`${PLAN_BLOCK_OPEN}\n1. 甲\n${PLAN_BLOCK_CLOSE}`)).toBe(true);
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
