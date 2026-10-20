import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, symlink, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWithinRoot, resolveWithinRootDetailed } from "./safePath";

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
 * 造一个指向 target 的链接，返回**链接路径**与**它是不是目录链接**。
 *
 * Windows 上普通用户**建不了文件软链**（EPERM，需开发者模式），但**目录 junction 可以**——
 * 初版只用文件软链，结果那几条断言在本机被静默跳过、成了假绿（最核心的越界检查根本没跑）。
 * 故：POSIX 用文件软链；Windows 退化为"指向目录的 junction"。
 *
 * 必须显式返回 `isDirLink`，不能靠调用方猜：初版让调用方用 `linkPath.endsWith(".html")`
 * 判断，而链接名是 `link-in`（不含 .html）→ Linux 上把文件名错误地拼到了**文件软链**后面，
 * 得到不存在的 `link-in/inside.html`，断言因此失败（CI 抓到；本机 Windows 走 junction 分支没暴露）。
 */
async function makeLink(targetFile: string, linkPath: string): Promise<{ link: string; isDirLink: boolean } | null> {
  // 先试文件软链（POSIX 常规路径）
  try {
    await symlink(targetFile, linkPath);
    return { link: linkPath, isDirLink: false };
  } catch { /* 落到下面的 junction */ }
  // Windows：junction 指向目标所在目录，调用方需再拼上文件名
  try {
    await symlink(path.dirname(targetFile), linkPath, "junction");
    return { link: linkPath, isDirLink: true };
  } catch {
    return null;
  }
}

/** 按链接类型还原出"应被校验的真实文件路径"。 */
function candidateOf(made: { link: string; isDirLink: boolean }, fileName: string): string {
  return made.isDirLink ? path.join(made.link, fileName) : made.link;
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
    // 字符串层面它"在 root 下"，但真实落点在外部 → 必须为 null
    expect(await resolveWithinRoot(root, candidateOf(made!, "secret.html"))).toBeNull();
  });

  it("指向根内的链接放行（不能把所有链接一刀切禁掉）", async () => {
    const linkPath = path.join(root, "link-in");
    const made = await makeLink(path.join(root, "inside.html"), linkPath);
    expect(made).not.toBeNull();
    expect(await resolveWithinRoot(root, candidateOf(made!, "inside.html"))).not.toBeNull();
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

  // **以两个点开头的合法文件名**（实测缺陷）：旧判定是 `relative.startsWith("..")`，
  // 它把 `..报告.html` 当成"往上跳一层"——产物目录里真有这种文件时，
  // 预览 / 读回 / 在文件夹中显示 / 清理全部失效，而报错是「不在产物目录内」，
  // 用户看着一个完全正常的文件名，根本查不出原因。
  it("以两个点开头的文件名仍算根内（.. 只在整段等于 .. 时才是越界）", async () => {
    const dotted = path.join(root, "..报告.html");
    await writeFile(dotted, "<html>ok</html>", "utf8");
    expect(await resolveWithinRoot(root, dotted)).not.toBeNull();
  });

  it("真正的 .. 越界仍被拒（放宽后不能漏）", async () => {
    expect(await resolveWithinRoot(root, path.join(root, "..", "nope.html"))).toBeNull();
  });

  // **"文件没了"与"越界"必须能分开**（实测缺口）：两者在旧实现里都返回 null，
  // 于是产物预览在文件被删除时对用户说「不在产物目录内」——
  // 那是安全提示，用户只会去怀疑路径被拦，而真实原因是最常见的那种：文件没了。
  it("Detailed：根内但不存在 → missing（不是 outside）", async () => {
    const result = await resolveWithinRootDetailed(root, path.join(root, "deleted.md"));
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("Detailed：真正越界 → outside", async () => {
    const result = await resolveWithinRootDetailed(root, path.join(outside, "secret.html"));
    expect(result).toEqual({ ok: false, reason: "outside" });
  });

  it("Detailed：存在且在根内 → ok + 真实路径", async () => {
    const result = await resolveWithinRootDetailed(root, path.join(root, "inside.html"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.endsWith("inside.html")).toBe(true);
  });

  it("Detailed：根目录本身不存在 → missing（不能当成越界）", async () => {
    const result = await resolveWithinRootDetailed(path.join(root, "not-yet-created"), path.join(root, "not-yet-created", "a.md"));
    expect(result).toEqual({ ok: false, reason: "missing" });
  });
});
