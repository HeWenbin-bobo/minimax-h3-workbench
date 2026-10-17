import { describe, expect, it, vi } from "vitest";
import { checkForUpdates, checkFrameworkUpdate } from "./updateChecker";

describe("checkForUpdates", () => {
  it("reports a newer public GitHub release", async () => {
    const fetcher = vi.fn(async () => json({
      tag_name: "v0.1.5",
      name: "MiniMax H3 工作台 v0.1.5",
      html_url: "https://github.com/HeWenbin-bobo/minimax-h3-workbench/releases/tag/v0.1.5",
      published_at: "2026-08-10T00:00:00Z"
    }));

    await expect(checkForUpdates("0.1.4", fetcher)).resolves.toEqual({
      currentVersion: "0.1.4",
      latestVersion: "0.1.5",
      updateAvailable: true,
      releaseName: "MiniMax H3 工作台 v0.1.5",
      releaseUrl: "https://github.com/HeWenbin-bobo/minimax-h3-workbench/releases/tag/v0.1.5",
      publishedAt: "2026-08-10T00:00:00Z"
    });
  });

  it("reports that the installed version is current", async () => {
    const fetcher = vi.fn(async () => json({
      tag_name: "v0.1.4",
      name: "MiniMax H3 工作台 v0.1.4",
      html_url: "https://github.com/HeWenbin-bobo/minimax-h3-workbench/releases/tag/v0.1.4",
      published_at: "2026-08-09T00:00:00Z"
    }));

    const result = await checkForUpdates("0.1.4", fetcher);
    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe("0.1.4");
  });

  it("returns an actionable error when GitHub cannot be reached", async () => {
    const fetcher = vi.fn(async () => new Response("rate limited", { status: 403 }));
    await expect(checkForUpdates("0.1.4", fetcher)).rejects.toThrow("更新服务器返回 HTTP 403");
  });
});

describe("checkFrameworkUpdate", () => {
  it("flags a newer npm framework version independently of the app release", async () => {
    const fetcher = vi.fn(async () => json({ version: "6.0.0" }));
    const result = await checkFrameworkUpdate("5.0.0", fetcher);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("6.0.0");
    expect(result.message).toContain("6.0.0");
  });

  it("reports the bundled framework is current", async () => {
    const fetcher = vi.fn(async () => json({ version: "5.0.0" }));
    const result = await checkFrameworkUpdate("5.0.0", fetcher);
    expect(result.updateAvailable).toBe(false);
    expect(result.message).toContain("已是最新");
  });

  it("never throws on network failure", async () => {
    const fetcher = vi.fn(async () => new Response("offline", { status: 500 }));
    const result = await checkFrameworkUpdate("5.0.0", fetcher);
    expect(result.updateAvailable).toBe(false);
    expect(result.message).toContain("500");
  });

  // 回归护栏：Accept 曾用 application/vnd.npm.install-v1+json，在应用主进程内实测稳定 406
  // （裸 Node/裸 Electron 均 200），导致框架更新检查永远失败。必须保持通配。
  it("请求 npm registry 时使用通配 Accept（避免主进程环境 406）", async () => {
    const fetcher = vi.fn(async () => json({ version: "5.0.0" }));
    await checkFrameworkUpdate("5.0.0", fetcher);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("registry.npmjs.org");
    expect((init.headers as Record<string, string>).Accept).toBe("*/*");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

// semver 预发布语义：normalizeVersion 明确允许 `-beta.1` 这类后缀，
// 所以比较逻辑不能把它丢掉（原实现 `split("-")[0]` 会让 beta.1 与 beta.2 判为相等）。
describe("预发布版本比较", () => {
  async function latestIsNewer(current: string, latest: string): Promise<boolean> {
    const fetcher = vi.fn(async () => json({
      tag_name: `v${latest}`,
      name: `v${latest}`,
      html_url: `https://github.com/HeWenbin-bobo/minimax-h3-workbench/releases/tag/v${latest}`,
      published_at: "2026-10-01T00:00:00Z"
    }));
    return (await checkForUpdates(current, fetcher)).updateAvailable;
  }

  it("beta.2 比 beta.1 新", async () => {
    await expect(latestIsNewer("0.3.0-beta.1", "0.3.0-beta.2")).resolves.toBe(true);
  });

  it("正式版比同号 beta 新（用户不该停在 beta）", async () => {
    await expect(latestIsNewer("0.3.0-beta.1", "0.3.0")).resolves.toBe(true);
  });

  it("beta 不比同号正式版新", async () => {
    await expect(latestIsNewer("0.3.0", "0.3.0-beta.1")).resolves.toBe(false);
  });

  it("beta.10 按数值比较（不是字典序）", async () => {
    await expect(latestIsNewer("0.3.0-beta.9", "0.3.0-beta.10")).resolves.toBe(true);
  });

  it("主版本号更大时，预发布也照样算新", async () => {
    await expect(latestIsNewer("0.2.1", "0.3.0-beta.1")).resolves.toBe(true);
  });

  it("相同版本不算更新", async () => {
    await expect(latestIsNewer("0.3.0-beta.1", "0.3.0-beta.1")).resolves.toBe(false);
    await expect(latestIsNewer("0.3.0", "0.3.0")).resolves.toBe(false);
  });
});

// 上游 JSON 只是"我们以为"的形状：tag_name / version 可能是数字或对象。
// 直接 `.trim()` 会抛 "value.trim is not a function"（英文错误透到界面）。
describe("版本号类型容错", () => {
  it("tag_name 为数字/对象/null 时不抛错，按无有效版本处理", async () => {
    for (const bad of [5, {}, null, [], true]) {
      const fetcher = vi.fn(async () => json({
        tag_name: bad,
        html_url: "https://github.com/HeWenbin-bobo/minimax-h3-workbench/releases/tag/v1",
        published_at: "2026-10-01T00:00:00Z"
      }));
      await expect(checkForUpdates("0.2.1", fetcher)).rejects.toThrow("更新服务器没有返回有效版本号");
    }
  });

  it("npm version 为数字时给出可读失败信息而非英文 TypeError", async () => {
    const fetcher = vi.fn(async () => json({ version: 5 }));
    const result = await checkFrameworkUpdate("5.0.0", fetcher);
    expect(result.updateAvailable).toBe(false);
    expect(result.message).toContain("未返回有效版本号");
    expect(result.message).not.toMatch(/trim is not a function/);
  });
});
