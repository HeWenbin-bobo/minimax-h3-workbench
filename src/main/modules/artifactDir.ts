import { createHash } from "node:crypto";
import path from "node:path";

/**
 * 产物落盘的会话目录名。**落盘与清理必须共用这一处**，否则两边算出的目录不一致，
 * 清理会漏（或误删别的会话）。
 *
 * sessionId 来自渲染端（可构造）。只取 `basename` 不够：`path.basename("..")` 仍返回
 * ".."，join 后会把产物目录**抬到 userData 根**（实测复现）。这里再把危险字符与
 * 纯点段滤掉，保证落点始终在 artifacts 之下。
 *
 * **只做"滤掉危险字符"会产生目录名碰撞**（实测）：
 * - Windows 上 `path.basename("x:y")` 返回 `"y"`（冒号前被当成盘符），
 *   于是 `sessionId = "x:<别人的会话 id>"` 会落到**对方**的产物目录；
 * - `"a|b"` 与 `"a_b"` 都变成 `"a_b"`；`"sub/dir"` 与 `"dir"` 都变成 `"dir"`。
 * 配上 `artifact:purgeSession`（删除会话时清目录），构造一个 id 就能**删掉另一个
 * 会话的产物**——不可逆。
 *
 * 修复方式：**只要净化过程真的改动了原值，就追加原值的短哈希**，
 * 让不同输入必然得到不同目录名。正常 id（UUID / 纯字母数字）不被改动，
 * 目录名保持不变，已有的历史产物不会失联。
 */
export function artifactSessionDirName(sessionId: string): string {
  const raw = String(sessionId ?? "");
  const base = path.basename(raw || "unknown").replace(/[\\/:*?"<>|]/g, "_").trim();
  const safe = !base || /^\.+$/.test(base) ? "unknown" : base;
  // 净化没有改动原值 → 直接用（保持向后兼容，UUID 就是这样）。
  if (safe === raw) return safe;
  // 被改动过 → 追加原值的短哈希，消除碰撞。
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safe}-${digest}`;
}

/** 去掉末尾的 ` (数字)` 版本后缀：`报告 (2).html` → `报告.html`。与渲染端折叠规则一致。 */
function versionStem(fileName: string): string {
  const ext = path.extname(fileName);
  return fileName.slice(0, fileName.length - ext.length).replace(/ \(\d+\)$/, "");
}

/**
 * 在一批文件名里找出与 `fileName` **同一主名的最新版本**（`报告.html` → `报告 (3).html`）。
 * 找不到返回 undefined。
 *
 * 为什么需要（实测真机）：模型修完 bug 会重新 `create_file` 同名文件，而 `uniqueArtifactPath`
 * 不覆盖，于是落成 `名字 (2).html`；它接着自检时往往还传原名。按精确匹配就会**跑旧版本**，
 * 然后回一句"自检通过"——模型据此告诉用户"已验证"，用户点开的却仍是带 bug 的上一版。
 *
 * **版本号必须按数字比**：字符串比较会把 `(10)` 判成比 `(9)` 小，于是永远选到第 9 版。
 * 没有后缀的算第 1 版。
 */
export function pickLatestVersion(entries: readonly string[], fileName: string): string | undefined {
  const ext = path.extname(fileName);
  const stem = versionStem(fileName);
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(?: \\((\\d+)\\))?$`);
  let best: { name: string; version: number } | undefined;
  for (const entry of entries) {
    const entryExt = path.extname(entry);
    // 扩展名大小写不敏感（Windows 上 `.HTML` 与 `.html` 是同一个文件）。
    if (entryExt.toLowerCase() !== ext.toLowerCase()) continue;
    const match = pattern.exec(entry.slice(0, entry.length - entryExt.length));
    if (!match) continue;
    const version = match[1] ? Number(match[1]) : 1;
    if (!best || version > best.version) best = { name: entry, version };
  }
  return best?.name;
}

/**
 * 请求名 → 依次尝试的候选文件名。
 *
 * 背景（实测工具契约不一致）：`create_file` 的参数说明是"文件名，**不含**扩展名"，
 * 而 `read_artifact` / `edit_artifact` 说明是"带扩展名"。模型按前者的写法调用后者时
 * （`read_artifact("科技新闻")`），精确匹配与同主名回落都按**空扩展名**比对 →
 * 必然找不到 → 报"本会话里找不到产物"。文件明明在磁盘上，模型只会重新生成一份重复产物。
 *
 * 规则：**有扩展名就只试它**（尊重模型明确指定的类型）；
 * 没有扩展名才按已知产物类型依次补全。
 */
export function artifactNameCandidates(requestedName: string): string[] {
  const name = String(requestedName ?? "").trim();
  if (!name) return [];
  // **只认已知产物扩展名**，不能用 `path.extname` 非空就判定"已有扩展名"：
  // `path.extname("v1.2 报告")` 返回 `".2 报告"`——名字里有点但并没有产物扩展名，
  // 那种情况仍然必须补全（单测「v1.2 报告」抓到的）。
  const ext = path.extname(name).toLowerCase();
  if ((KNOWN_ARTIFACT_EXTS as readonly string[]).includes(ext)) return [name];
  return [name, ...KNOWN_ARTIFACT_EXTS.map((known) => `${name}${known}`)];
}

/** 与 `saveArtifactFile` 的 kind 白名单保持一致（新增 kind 时两边都要改）。 */
export const KNOWN_ARTIFACT_EXTS = [".html", ".md", ".xlsx", ".csv", ".tsv"] as const;
