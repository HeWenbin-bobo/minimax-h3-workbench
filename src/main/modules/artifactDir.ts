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
