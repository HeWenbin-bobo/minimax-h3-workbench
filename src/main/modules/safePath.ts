import path from "node:path";
import { realpath } from "node:fs/promises";

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
  const relative = path.relative(realRoot, realCandidate);
  // relative 为空说明两者是同一路径（是目录本身，不是目录内的文件）→ 不算命中。
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return realCandidate;
}
