// 构建前同步智能体框架版本：从 node_modules/ai/package.json 读取实际安装版本，
// 写入 src/shared/agentVersion.ts——checkFrameworkUpdate 据此与 npm registry 比对。
// 由 package.json 的 prebuild 钩子调用（npm run build 自动执行）。
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const pkgPath = path.resolve("node_modules/ai/package.json");
const targetPath = path.resolve("src/shared/agentVersion.ts");

const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
const version = String(pkg.version || "");
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`无法从 ${pkgPath} 读取有效版本号：${version}`);

const content = `// 游乐场智能体框架（Vercel AI SDK）的打包版本——由 scripts/sync-agent-version.mjs 自动生成（勿手改），
// 与 package.json 实际安装版本保持一致；updateChecker.checkFrameworkUpdate 据此做独立更新检查。
export const frameworkVersion = "${version}";
`;
await writeFile(targetPath, content, "utf8");
console.log(`[sync-agent-version] ai@${version} -> src/shared/agentVersion.ts`);
