import { describe, it, expect } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, contextWindowFor } from "./modelWindows";

// 这个表此前没有测试——所以 `dk-` 缺失（落到默认 128k，而真实窗口 64k）
// 一直没被发现。本文件的首要目的就是**锁住别名**，避免再靠人肉记忆维护。
describe("contextWindowFor", () => {
  it("查不到时回落默认值", () => {
    expect(contextWindowFor("some-unknown-model")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor("")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("已知前缀命中各自窗口", () => {
    expect(contextWindowFor("minimax-abab6.5")).toBe(192_000);
    expect(contextWindowFor("glm-4.6")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4")).toBe(200_000);
    expect(contextWindowFor("gpt-5-codex")).toBe(400_000);
  });

  it("取最长前缀（glm-4.6 不被 glm- 抢先）", () => {
    expect(contextWindowFor("glm-4.6")).toBe(200_000);
    expect(contextWindowFor("glm-4.5")).toBe(128_000);
  });

  it("大小写不敏感", () => {
    expect(contextWindowFor("MiniMax-Abab")).toBe(192_000);
    expect(contextWindowFor("DEEPSEEK-CHAT")).toBe(64_000);
  });

  // 实测（该中转的 /models）该站同时提供 dk-v4.1-flash 与 deepseek-v4.1-flash，
  // 是同一模型的别名。漏了 dk- 会"估大"：压缩触发太晚，请求先被上游拒绝。
  it("dk- 是 deepseek 的中转别名，必须同窗口（防「估大」）", () => {
    expect(contextWindowFor("dk-v4.1-flash")).toBe(64_000);
    expect(contextWindowFor("dk-v4.1-flash")).toBe(contextWindowFor("deepseek-v4.1-flash"));
  });

  it("别名判定大小写不敏感", () => {
    expect(contextWindowFor("DK-V4.1-Flash")).toBe(64_000);
  });

  // 保守取向的护栏：默认值只用于"完全查不到"的模型，因此**能识别的别名必须收录**。
  it("默认值用于未知模型（提醒：别名漏收录会退到这里，可能估大）", () => {
    expect(contextWindowFor("totally-unknown-xyz")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(64_000);
  });
});
