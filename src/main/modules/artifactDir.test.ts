import { describe, expect, it } from "vitest";
import { artifactSessionDirName, pickLatestVersion } from "./artifactDir";

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

// 自检回落找"同主名最新版本"：模型修完 bug 会重写成 `名字 (2).html`，
// 但自检时往往还传原名。选错版本 = 拿旧代码的结论给用户。
describe("pickLatestVersion", () => {
  it("选出版本号最大的那个", () => {
    expect(pickLatestVersion(["报告.html", "报告 (2).html", "报告 (3).html"], "报告.html")).toBe("报告 (3).html");
  });

  it("版本号按数字比：(10) 必须胜过 (9)", () => {
    expect(pickLatestVersion(["图.html", "图 (9).html", "图 (10).html"], "图.html")).toBe("图 (10).html");
  });

  it("拿带后缀的名字去查也能收敛到同一组", () => {
    expect(pickLatestVersion(["图.html", "图 (2).html"], "图 (2).html")).toBe("图 (2).html");
  });

  it("只有无后缀的版本", () => {
    expect(pickLatestVersion(["唯一.html"], "唯一.html")).toBe("唯一.html");
  });

  it("不同主名不串组", () => {
    expect(pickLatestVersion(["图.html", "图表.html"], "图.html")).toBe("图.html");
  });

  it("扩展名大小写不敏感（Windows 同一文件）", () => {
    expect(pickLatestVersion(["A.HTML", "A (2).html"], "A.html")).toBe("A (2).html");
  });

  it("一个都没有时返回 undefined", () => {
    expect(pickLatestVersion(["别的.html"], "目标.html")).toBeUndefined();
    expect(pickLatestVersion([], "目标.html")).toBeUndefined();
  });

  it("中间括号属于主名，不当版本后缀", () => {
    expect(pickLatestVersion(["图表 (草稿).html", "图表 (草稿) (2).html"], "图表 (草稿).html")).toBe("图表 (草稿) (2).html");
  });
});
