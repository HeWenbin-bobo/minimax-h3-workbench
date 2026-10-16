// 真实 Key 复现用 harness：把真实 userData 克隆到临时目录，再让被测应用指向克隆。
//
// 为什么克隆而不是直接用真实 userData：真实目录里有用户的会话/任务/产物，
// 复现过程会往里写东西（新会话、新任务）。克隆后互不影响。
//
// 密钥处理（CLAUDE.md 红线）：secrets.json 原样复制，**只在应用进程内由 safeStorage 解密**；
// 本文件与任何探针都不读取、不打印其内容。Windows 上 safeStorage 走 DPAPI，
// 同一用户账户下克隆目录也能解密，故无需额外处理。
import { mkdtemp, cp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REAL = path.join(process.env.APPDATA || "", "minimax-h3-workbench");

// 只克隆这几项：设置、密钥、任务、以及 safeStorage 依赖的 Local State。
const ITEMS = ["settings.json", "secrets.json", "tasks.json", "Local State"];

export async function cloneUserData() {
  const dir = await mkdtemp(path.join(tmpdir(), "h3-real-"));
  const copied = [];
  for (const item of ITEMS) {
    const from = path.join(REAL, item);
    try {
      await access(from);
      await cp(from, path.join(dir, item), { recursive: true });
      copied.push(item);
    } catch {
      // 缺失项跳过（如首次运行没有 tasks.json），不影响复现。
    }
  }
  return { dir, copied };
}

export { REAL };
