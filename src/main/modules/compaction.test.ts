import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/types";
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  buildCompactedHistory,
  isSummaryMessage,
  SUMMARY_PREFIX,
  SUMMARIZATION_PROMPT
} from "./compaction";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

describe("提示词与 Codex 原文一致", () => {
  it("摘要提示词包含 Codex 的四个必含项", () => {
    for (const key of ["Current progress and key decisions", "constraints", "remains to be done", "critical data"]) {
      expect(SUMMARIZATION_PROMPT).toContain(key);
    }
  });

  it("回注前缀声明这是前任模型的交接摘要", () => {
    expect(SUMMARY_PREFIX).toContain("Another language model started to solve this problem");
  });

  it("isSummaryMessage 认得出自家摘要，认不出普通消息", () => {
    expect(isSummaryMessage(`${SUMMARY_PREFIX}\n\n内容`)).toBe(true);
    expect(isSummaryMessage("你好")).toBe(false);
  });
});

describe("buildCompactedHistory 保留策略", () => {
  it("只保留 user 消息——助手回复与工具步骤的信息已进摘要", () => {
    const result = buildCompactedHistory(
      [user("需求一"), assistant("我来做"), user("需求二"), assistant("做好了")],
      "摘要正文"
    );
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(result.map((m) => m.content)).toEqual(["需求一", "需求二", `${SUMMARY_PREFIX}\n\n摘要正文`]);
  });

  it("摘要追加为最后一条且角色是 user（对齐 Codex 的 CompactionSummary）", () => {
    const result = buildCompactedHistory([user("甲")], "摘要");
    expect(result.at(-1)?.role).toBe("user");
    expect(result.at(-1)?.content.startsWith(SUMMARY_PREFIX)).toBe(true);
  });

  it("保留顺序是时间正序：最近的 user 消息在摘要之前", () => {
    const result = buildCompactedHistory([user("最老"), user("中间"), user("最新")], "摘要");
    expect(result.slice(0, 3).map((m) => m.content)).toEqual(["最老", "中间", "最新"]);
  });

  it("既有摘要消息被排除，不会出现摘要套摘要", () => {
    const old: ChatMessage = { role: "user", content: `${SUMMARY_PREFIX}\n\n上一次的摘要` };
    const result = buildCompactedHistory([old, user("新需求")], "本次摘要");
    expect(result.filter((m) => isSummaryMessage(m.content))).toHaveLength(1);
    expect(result[0].content).toBe("新需求");
  });

  it("图片附件在预算内一并保留", () => {
    const withImage: ChatMessage = { role: "user", content: "看这张图", images: ["data:image/png;base64,AAA"] };
    const result = buildCompactedHistory([withImage], "摘要");
    expect(result[0].images).toEqual(["data:image/png;base64,AAA"]);
  });
});

describe("buildCompactedHistory 预算边界", () => {
  it("预算耗尽即停：更老的 user 消息被整体丢弃", () => {
    // 预算 4 token：最新一条占 2、次新占 2 → 恰好耗尽，最老的一条整条丢弃。
    const oldest = user("最老的消息最老的消息");
    const result = buildCompactedHistory([oldest, user("中间"), user("新新新")], "摘要", 4);
    expect(result.some((m) => m.content === oldest.content)).toBe(false);
    expect(result.slice(0, 2).map((m) => m.content)).toEqual(["中间", "新新新"]);
    expect(result).toHaveLength(3); // 两条 user + 一条摘要
  });

  it("单条超预算时截断而非丢弃（Codex 的截断语义）", () => {
    const long = "很长的一段用户输入".repeat(200);
    const result = buildCompactedHistory([user(long)], "摘要", 50);
    expect(result[0].content).toContain("已截断");
    expect(result[0].content.length).toBeLessThan(long.length);
  });

  it("预算为 0 时不留任何 user 消息，只剩摘要", () => {
    const result = buildCompactedHistory([user("甲"), user("乙")], "摘要", 0);
    expect(result).toHaveLength(1);
    expect(result[0].content.startsWith(SUMMARY_PREFIX)).toBe(true);
  });

  it("默认预算与 Codex 的 COMPACT_USER_MESSAGE_MAX_TOKENS 一致", () => {
    expect(COMPACT_USER_MESSAGE_MAX_TOKENS).toBe(20_000);
  });
});

describe("buildCompactedHistory 摘要兜底", () => {
  it("摘要为空时用占位文案，绝不返回空的 user 消息", () => {
    const result = buildCompactedHistory([user("甲")], "");
    const last = result.at(-1);
    expect(last?.content).toBeTruthy();
    expect(last?.content).not.toContain(SUMMARY_PREFIX);
    expect(last?.content).toContain("无可用摘要");
  });

  it("只有空白的摘要同样走占位", () => {
    const result = buildCompactedHistory([user("甲")], "   \n  ");
    expect(result.at(-1)?.content).toContain("无可用摘要");
  });
});
