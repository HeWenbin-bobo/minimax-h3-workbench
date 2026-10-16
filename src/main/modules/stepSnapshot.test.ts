import { describe, it, expect } from "vitest";
import { freezeTurn } from "./stepSnapshot";

describe("freezeTurn", () => {
  it("冻结后的值不可被改写", () => {
    const snapshot = freezeTurn({ model: "a", backend: "rb" });
    expect(Object.isFrozen(snapshot.value)).toBe(true);
    expect(snapshot.value.model).toBe("a");
  });

  it("快照是副本而非原对象引用（否则冻结等于没冻）", () => {
    const live: Record<string, unknown> = { model: "a" };
    const snapshot = freezeTurn(live);
    live.model = "b";
    expect(snapshot.value.model).toBe("a");
  });

  it("中途改 live 配置不影响快照——这正是它要防的漂移", () => {
    // 场景：一轮多步工具循环里，用户改了搜索 Key / 模型名。
    const live: Record<string, unknown> = { searchApiKey: "key-1", model: "m1" };
    const turn = freezeTurn(live);
    live.searchApiKey = "key-2";
    live.model = "m2";
    expect(turn.value.searchApiKey).toBe("key-1");
    expect(turn.value.model).toBe("m1");
  });

  it("冻结是浅的：嵌套对象仍可被改写（调用方须保证不改写它）", () => {
    // 记录这个已知边界，避免后来者以为拿到了深不可变的快照。
    const nested = { systemPrompt: "x" };
    const turn = freezeTurn({ llm: nested });
    nested.systemPrompt = "y";
    expect((turn.value.llm as { systemPrompt: string }).systemPrompt).toBe("y");
  });
});
