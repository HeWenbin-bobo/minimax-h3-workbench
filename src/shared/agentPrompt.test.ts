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

  it("world state 不再进 system prompt（实测拼进 system 会被模型忽略）", () => {
    // SystemPromptInput 已无 worldState 字段；这里断言 system 里不含环境事实标记。
    const out = buildSystemPrompt({ memoryHint: "习惯A" });
    expect(out).not.toContain("# 当前时间");
    expect(out).not.toContain("# 联网状态");
  });
});

// 回归护栏：提示词里的工具清单**必须覆盖实际下发的工具**。
// 实测踩过两次：加 edit_artifact_batch 时提示词没提（模型不知道它存在，
// 继续一条条调单处编辑，白白吃掉步数预算）；加 read_artifact 的 keyword
// 参数时也没提（模型仍分段读完整个文件）。
// 工具存在但提示词不提 = 只做了一半。
describe("提示词覆盖所有实际下发的工具", () => {
  // 新增工具时：**同时**改这里和 TOOLS 层。这个列表故意手写——
  // 它就是要逼你想起"还有个地方要改"。
  const DELIVERED_TOOLS = [
    "create_file",
    "generate_video",
    "read_artifact",
    "edit_artifact",
    "edit_artifact_batch",
    "inspect_artifact",
    "web_search",
    "open_page",
    "update_plan",
    "request_user_input"
  ];

  it("每个下发的工具在提示词里都有对应条目", () => {
    const text = defaultAgentPrompt();
    // **必须匹配行首的列表项**（`- tool(`），不能只做子串匹配：
    // 自检时我把条目改成 "XX_edit_artifact_batch(" 试护栏，子串断言照样 PASS——
    // 又造了个假通过。行首锚定才真的能测到"这条被删了/改名了"。
    const missing = DELIVERED_TOOLS.filter(
      (tool) => !new RegExp(`^-\\s*${tool}\\(`, "m").test(text)
    );
    expect(missing).toEqual([]);
  });

  it("read_artifact 的 keyword 参数有说明（否则模型只会分段读完）", () => {
    expect(defaultAgentPrompt()).toContain("keyword");
  });
});
