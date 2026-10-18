import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupCorruptFile, readJsonFile } from "./jsonFile";

const freshDir = () => mkdtemp(path.join(tmpdir(), "h3-json-"));

describe("readJsonFile", () => {
  it("正常读取并解析", async () => {
    const dir = await freshDir();
    const file = path.join(dir, "a.json");
    await writeFile(file, JSON.stringify({ ok: true }), "utf8");
    await expect(readJsonFile(file)).resolves.toEqual({ ok: true });
  });

  it("内容损坏（解析错误）立即抛出，不做无谓重试", async () => {
    const dir = await freshDir();
    const file = path.join(dir, "bad.json");
    await writeFile(file, "{ 半截", "utf8");
    const started = Date.now();
    await expect(readJsonFile(file, 3)).rejects.toThrow();
    // 3 次重试会额外等 ≥120ms；解析错误不该走那条路径。
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("文件不存在（ENOENT）直接抛出", async () => {
    const dir = await freshDir();
    await expect(readJsonFile(path.join(dir, "missing.json"))).rejects.toThrow();
  });
});

describe("backupCorruptFile", () => {
  it("内容损坏时把原文件改名备份，原路径让开", async () => {
    const dir = await freshDir();
    const file = path.join(dir, "settings.json");
    await writeFile(file, "{ 半截", "utf8");
    await backupCorruptFile(file, new SyntaxError("Unexpected end of JSON input"), "settings");
    const files = await readdir(dir);
    expect(files.some((name) => name.startsWith("settings.json.corrupt-"))).toBe(true);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("ENOENT 不改名（文件本来就不存在）", async () => {
    const dir = await freshDir();
    const file = path.join(dir, "settings.json");
    const error = Object.assign(new Error("no such file"), { code: "ENOENT" });
    await backupCorruptFile(file, error, "settings");
    expect(await readdir(dir)).toEqual([]);
  });

  it("重试耗尽的 I/O 错误同样备份（否则下一次写盘会覆盖唯一副本）", async () => {
    const dir = await freshDir();
    const file = path.join(dir, "secrets.json");
    await writeFile(file, "{\"a\":1}", "utf8");
    const error = Object.assign(new Error("busy"), { code: "EBUSY" });
    await backupCorruptFile(file, error, "settings");
    const files = await readdir(dir);
    expect(files.some((name) => name.startsWith("secrets.json.corrupt-"))).toBe(true);
  });
});
