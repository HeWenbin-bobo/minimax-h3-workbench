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

// 回归护栏：实测复现过——用户说"生成一个鹈鹕骑自行车的 3D 页面，尽可能把你所有的
// 能力全部都用上"，模型把它理解成"能力清单任务"，出了 3D 页面还额外建了 4 路 AI 视频。
// 成因：角色设定只强调"动手做"、工具平级罗列、generate_video 写着"用户描述画面即调用"。
describe("产物优先级（防「把所有能力用上」被理解成每个工具都调）", () => {
  it("角色层明确：一次请求对应一个产物，只做用户要的那个", () => {
    const text = defaultAgentPrompt();
    expect(text).toContain("只做用户要的那个产物");
    expect(text).toContain("一个**具体产出物");
  });

  it("角色层明确否定「把每个工具都点一遍」的读法", () => {
    const text = defaultAgentPrompt();
    expect(text).toContain("不是**让你把每个工具都点一遍");
    expect(text).toContain("不要为了\"展示能力\"额外生成用户没要的产出物");
  });

  it("工具清单分成「产出物工具」与「辅助工具」两层", () => {
    const text = defaultAgentPrompt();
    expect(text).toContain("## 产出物工具");
    expect(text).toContain("## 辅助工具");
  });

  it("产出物工具标明「选一个，不要都做」", () => {
    expect(defaultAgentPrompt()).toContain("**选一个**，不要都做");
  });

  it("create_file 明确覆盖「页面/游戏/3D 场景」（本次失败的那一类）", () => {
    const text = defaultAgentPrompt();
    expect(text).toContain("网页/页面/小工具/游戏");
    expect(text).toContain("3D 场景");
  });

  it("generate_video 标为「仅当用户要的就是视频本身」", () => {
    expect(defaultAgentPrompt()).toContain("**仅当用户要的就是视频本身时**才用");
  });

  it("辅助工具标明「不是必做步骤」", () => {
    expect(defaultAgentPrompt()).toContain("不是必做步骤");
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
