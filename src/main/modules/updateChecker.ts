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
    const response = await fetcher(`https://registry.npmjs.org/${AGENT_FRAMEWORK}/latest`, {
      headers: { Accept: "application/vnd.npm.install-v1+json", "User-Agent": `MiniMax-H3-Workbench/${bundledVersion}` },
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

function normalizeVersion(value?: string): string | undefined {
  const normalized = value?.trim().replace(/^v/i, "");
  return normalized && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : undefined;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split("-")[0].split(".").map(Number);
  const rightParts = right.split("-")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}
