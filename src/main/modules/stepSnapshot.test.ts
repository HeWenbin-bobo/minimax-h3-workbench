import { describe, it, expect } from "vitest";
import { freezeTurn, guaranteeDelivery } from "./stepSnapshot";

describe("freezeTurn", () => {
  it("冻结后的值不可被改写", () => {
    const snapshot = freezeTurn({ model: "a", backend: "rb" });
    expect(Object.isFrozen(snapshot.value)).toBe(true);
    expect(snapshot.value.model).toBe("a");
  });

  it("忽略事后对原对象的改写（快照是副本）", () => {
    const live: Record<string, unknown> = { model: "a" };
    const snapshot = freezeTurn(live);
    live.model = "b";
    expect(snapshot.value.model).toBe("a");
  });

  it("staleAgainst 只在真的有差异时为真", () => {
    const snapshot = freezeTurn({ model: "a", count: 1 });
    expect(snapshot.staleAgainst({ model: "a", count: 1 })).toBe(false);
    expect(snapshot.staleAgainst({ model: "b", count: 1 })).toBe(true);
  });

  it("changedFields 精确报出改了哪些字段（UI 提示文案要用）", () => {
    const snapshot = freezeTurn({ model: "a", count: 1, backend: "rb" });
    expect(snapshot.changedFields({ model: "b", count: 1, backend: "local" })).toEqual(["model", "backend"]);
  });

  it("字段增删也算变更（不能只看交集）", () => {
    const snapshot = freezeTurn({ model: "a" });
    expect(snapshot.changedFields({ model: "a", extra: 1 })).toEqual(["extra"]);
  });
});

describe("guaranteeDelivery", () => {
  it("已交付时不补发任何东西", () => {
    const seen: string[] = [];
    guaranteeDelivery(() => true, (m) => seen.push(m), "兜底");
    expect(seen).toEqual([]);
  });

  it("未交付时补一条可见说明（不允许静默丢弃用户消息）", () => {
    const seen: string[] = [];
    guaranteeDelivery(() => false, (m) => seen.push(m), "本轮没有产出，请重试。");
    expect(seen).toEqual(["本轮没有产出，请重试。"]);
  });
});
