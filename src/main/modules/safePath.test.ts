import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, symlink, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWithinRoot } from "./safePath";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "h3-root-"));
  outside = await mkdtemp(path.join(tmpdir(), "h3-outside-"));
  await mkdir(path.join(root, "sub"), { recursive: true });
  await writeFile(path.join(root, "inside.html"), "<html>ok</html>", "utf8");
  await writeFile(path.join(root, "sub", "nested.html"), "<html>ok</html>", "utf8");
  await writeFile(path.join(outside, "secret.html"), "<html>secret</html>", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  await rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * 造一个"指向 target 的链接"。
 *
 * Windows 上普通用户**建不了文件软链**（EPERM，需开发者模式），但**目录 junction 可以**——
 * 初版只用文件软链，结果那几条断言在本机被静默跳过、成了假绿（最核心的越界检查根本没跑）。
 * 故：POSIX 用文件软链；Windows 退化为"指向目录的 junction"，同样能构造越界路径。
 * 返回实际可用的链接路径；两种都不可用时返回 null（调用方须显式失败而非跳过）。
 */
async function makeLink(targetFile: string, linkPath: string): Promise<string | null> {
  // 先试文件软链（POSIX 常规路径）
  try {
    await symlink(targetFile, linkPath);
    return linkPath;
  } catch { /* 落到下面的 junction */ }
  // Windows：junction 指向目标所在目录，再由调用方拼上文件名
  try {
    await symlink(path.dirname(targetFile), linkPath, "junction");
    return linkPath;
  } catch {
    return null;
  }
}

describe("resolveWithinRoot", () => {
  it("根目录内的文件放行，返回真实路径", async () => {
    const got = await resolveWithinRoot(root, path.join(root, "inside.html"));
    expect(got).not.toBeNull();
    expect(got!.endsWith("inside.html")).toBe(true);
  });

  it("子目录内的文件也放行", async () => {
    expect(await resolveWithinRoot(root, path.join(root, "sub", "nested.html"))).not.toBeNull();
  });

  it("根目录外的文件拒绝", async () => {
    expect(await resolveWithinRoot(root, path.join(outside, "secret.html"))).toBeNull();
  });

  it("用 .. 逃逸的路径拒绝", async () => {
    expect(await resolveWithinRoot(root, path.join(root, "..", "whatever.html"))).toBeNull();
  });

  it("根目录自身不算命中（它不是根内的文件）", async () => {
    expect(await resolveWithinRoot(root, root)).toBeNull();
  });

  it("不存在的文件返回 null（不抛错，也不泄露目录结构）", async () => {
    expect(await resolveWithinRoot(root, path.join(root, "nope.html"))).toBeNull();
  });

  // —— 本次安全修复的核心：链接绕过 ——
  // 用 junction 兜底，确保这条**在本机真的执行**（初版被静默跳过）。
  it("指向根外的链接必须被拒（纯字符串比对挡不住它）", async () => {
    const linkPath = path.join(root, "link-out");
    const made = await makeLink(path.join(outside, "secret.html"), linkPath);
    expect(made).not.toBeNull(); // 造不出链接就显式失败，不再静默跳过
    // 文件软链：linkPath 即文件；junction：linkPath/secret.html 才是文件
    const candidate = made!.endsWith(".html") ? made! : path.join(linkPath, "secret.html");
    // 字符串层面它"在 root 下"，但真实落点在外部 → 必须为 null
    expect(await resolveWithinRoot(root, candidate)).toBeNull();
  });

  it("指向根内的链接放行（不能把所有链接一刀切禁掉）", async () => {
    const linkPath = path.join(root, "link-in");
    const made = await makeLink(path.join(root, "inside.html"), linkPath);
    expect(made).not.toBeNull();
    const candidate = made!.endsWith(".html") ? made! : path.join(linkPath, "inside.html");
    expect(await resolveWithinRoot(root, candidate)).not.toBeNull();
  });

  it("root 自身是链接时仍正常工作（两侧都要 realpath 的原因）", async () => {
    const linkedRoot = path.join(outside, "root-link");
    try {
      await symlink(root, linkedRoot, "junction");
    } catch {
      return; // 这一条是补充覆盖，非核心断言，建不出就跳过
    }
    expect(await resolveWithinRoot(linkedRoot, path.join(root, "inside.html"))).not.toBeNull();
  });
});
