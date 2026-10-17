import type { UpdateInfo } from "../../shared/types";

// 发布更新的 GitHub 仓库（owner/repo）。换成你自己的仓库后，应用内更新检查会自动指向它。
export const UPDATE_REPO = "HeWenbin-bobo/minimax-h3-workbench";
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const RELEASE_PREFIX = `https://github.com/${UPDATE_REPO}/releases/`;

// 游乐场智能体框架（Vercel AI SDK）：随安装包分发（npm dependencies），
// 但版本独立于应用本体的更新检查——应用不更新时框架也能独立提示新版本。
export const AGENT_FRAMEWORK = "ai";

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
}

interface NpmPackageInfo {
  version?: string;
  "dist-tags"?: { latest?: string };
}

export async function checkForUpdates(
  currentVersion: string,
  fetcher: typeof fetch = fetch
): Promise<UpdateInfo> {
  const response = await fetcher(LATEST_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `MiniMax-H3-Workbench/${currentVersion}`
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}`);

  const release = (await response.json()) as GithubRelease;
  const latestVersion = normalizeVersion(release.tag_name);
  if (!latestVersion) throw new Error("更新服务器没有返回有效版本号");
  if (!release.html_url?.startsWith(RELEASE_PREFIX)) throw new Error("更新下载地址未通过安全校验");

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseName: release.name || `MiniMax H3 工作台 v${latestVersion}`,
    releaseUrl: release.html_url,
    publishedAt: release.published_at
  };
}

/** 智能体框架独立更新检查：npm registry 最新版 vs 打包版本（应用本体不更新也可提示）。 */
export async function checkFrameworkUpdate(
  bundledVersion: string,
  fetcher: typeof fetch = fetch
): Promise<{ bundledVersion: string; latestVersion?: string; updateAvailable: boolean; message: string }> {
  try {
    // Accept 不能用 application/vnd.npm.install-v1+json：应用主进程环境实测稳定 406（裸 Node/裸 Electron 均 200，成因未明），通配即可。
    const response = await fetcher(`https://registry.npmjs.org/${AGENT_FRAMEWORK}/latest`, {
      headers: { Accept: "*/*", "User-Agent": `MiniMax-H3-Workbench/${bundledVersion}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return { bundledVersion, updateAvailable: false, message: `框架更新检查失败（HTTP ${response.status}）。` };
    const payload = (await response.json()) as NpmPackageInfo;
    const latestVersion = normalizeVersion(payload.version || payload["dist-tags"]?.latest);
    if (!latestVersion) return { bundledVersion, updateAvailable: false, message: "框架更新源未返回有效版本号。" };
    const updateAvailable = compareVersions(latestVersion, bundledVersion) > 0;
    return {
      bundledVersion,
      latestVersion,
      updateAvailable,
      message: updateAvailable
        ? `智能体框架有新版本 v${latestVersion}（当前 v${bundledVersion}），更新应用时将一并升级。`
        : `智能体框架已是最新（v${bundledVersion}）。`
    };
  } catch (error) {
    return { bundledVersion, updateAvailable: false, message: error instanceof Error ? `框架更新检查失败：${error.message}` : "框架更新检查失败。" };
  }
}

/**
 * 版本号归一化。
 *
 * 参数类型必须是 `unknown` 而不是 `string`：上游 JSON 只是"我们以为"的形状，
 * GitHub 的 `tag_name` 或 npm 的 `version` 返回数字/对象时，直接 `.trim()`
 * 会抛 "value.trim is not a function"（英文技术错误直接透到界面上）。
 */
function normalizeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^v/i, "");
  return normalized && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : undefined;
}

/**
 * 版本比较，按 semver 语义处理预发布标签。
 *
 * 原实现直接 `split("-")[0]` 把预发布段丢掉，于是：
 * - `0.3.0-beta.2` 与 `0.3.0-beta.1` 判为相等 → **永远不会提示预发布版更新**
 * - `0.3.0` 与 `0.3.0-beta.1` 判为相等 → 正式版发布后不提示升级（用户停在 beta）
 * `normalizeVersion` 明确允许 `-beta.1` 这类后缀，两处语义必须一致。
 */
function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core, ...pre] = value.split("-");
    return { core: core.split(".").map(Number), pre: pre.join("-") };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0;
    const y = b.core[index] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 主版本号相同：没有预发布标签的版本**更高**（semver：1.0.0 > 1.0.0-rc.1）。
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  // 两边都有预发布标签：逐段比较，数字段按数值比、其余按字典序（semver 11.4）。
  const partsA = a.pre.split(".");
  const partsB = b.pre.split(".");
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const x = partsA[index];
    const y = partsB[index];
    if (x === undefined) return -1; // 前缀更短的更小（1.0.0-alpha < 1.0.0-alpha.1）
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx > ny ? 1 : -1;
    if (!Number.isNaN(nx)) return -1; // 数字段小于字母段
    if (!Number.isNaN(ny)) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
