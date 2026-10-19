import path from "node:path";
import { realpath } from "node:fs/promises";

/**
 * `child` 是否真的落在 `parent` 之内（**字符串层面**，调用方负责先 realpath）。
 *
 * 为什么不能写 `!relative.startsWith("..")`（实测缺陷）：那只挡"往上跳"，同时把
 * **以两个点开头的合法文件名**（`..报告.html`、`..notes.md`）当成越界——
 * 产物目录里真有这种文件时，预览、读回、在文件夹中显示、清理全部失效，
 * 而错误信息是「不在产物目录内」，用户完全查不出原因（文件名看着很正常）。
 *
 * 越界的正确判据是：`relative` 恰好等于 `..`，或以 `..` + 分隔符开头。
 * `..foo` 是"根目录下名叫 ..foo 的条目"，不是越界。
 */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (!relative) return false; // 同一路径（是目录本身，不是目录内的文件）
  if (path.isAbsolute(relative)) return false; // Windows 跨盘符时 relative 是绝对路径
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * 把候选路径解析到真实路径后，判断它是否落在 root 之内；在根内返回**真实路径**，否则返回 null。
 *
 * 为什么必须 realpath：`path.resolve` 只做字符串规范化，**不解析符号链接**。
 * 若产物目录里存在一个指向外部的软链，纯字符串比对会判它"在根内"而放行——
 * 白名单形同虚设（安全审查指出的越界读取面）。realpath 后再比对才反映真实落点。
 *
 * 两个容易写错的细节：
 * - **两侧都要 realpath**：root 自身也可能是软链（如 userData 被重定向到别处），
 *   只解析候选侧会让所有合法路径都被误判为越界。
 * - **解析失败返回 null**：realpath 对不存在的路径抛错，此时按"不在根内"处理，
 *   由调用方决定回 403 还是 404——也避免用报错差异探测目录结构。
 */
export async function resolveWithinRoot(root: string, candidate: string): Promise<string | null> {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(root);
    realCandidate = await realpath(candidate);
  } catch {
    return null;
  }
  return isPathInside(realRoot, realCandidate) ? realCandidate : null;
}
