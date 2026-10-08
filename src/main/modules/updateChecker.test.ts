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
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
