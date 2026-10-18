import { describe, expect, it } from "vitest";
import { artifactSessionDirName } from "./artifactDir";

// 背景：`sessionId` 来自渲染端（可构造），而目录名同时用于落盘与 `artifact:purgeSession`。
// 旧实现只把危险字符替换成 `_`，会产生**目录名碰撞**：
//   Windows 上 path.basename("x:y") → "y"、"a|b" 与 "a_b" → 都变 "a_b"。
// 于是一个构造出来的 id 就能命中**另一个会话**的产物目录，再触发删除即不可逆。
describe("artifactSessionDirName", () => {
  it("正常 UUID 原样返回（保证历史产物不失联）", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(artifactSessionDirName(id)).toBe(id);
  });

  it("不同输入必然得到不同目录名（含 Windows 盘符式冒号）", () => {
    const ids = ["a|b", "a_b", "x:y", "x_y", "sub/dir", "dir", "a/b", "a\\b"];
    const names = ids.map(artifactSessionDirName);
    expect(new Set(names).size).toBe(ids.length);
  });

  it("即使拼成「盘符:别人的 UUID」也不会落到对方目录", () => {
    const victim = "550e8400-e29b-41d4-a716-446655440000";
    const forged = `x:${victim}`;
    expect(artifactSessionDirName(forged)).not.toBe(artifactSessionDirName(victim));
  });

  it("危险输入仍落在安全目录名下（无分隔符、无纯点段）", () => {
    for (const bad of ["..", "...", "", "/", "../../etc", "C:\\Windows"]) {
      const name = artifactSessionDirName(bad);
      expect(name.includes("/")).toBe(false);
      expect(name.includes("\\")).toBe(false);
      expect(/^\.+$/.test(name)).toBe(false);
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
