import { describe, expect, it, vi } from "vitest";

/**
 * `browserFetch` 的重定向守卫：`will-redirect` / `will-navigate` 是同步事件，
 * 只能比字面 hostname；而 `127.0.0.1.nip.io` / `localtest.me` 这类通配 DNS
 * 把内网 IP 编进域名，字面完全正常、解析后落到回环地址（实测 probe-ssrf-nipio
 * 真的读回了本机服务内容）。所以额外在 `webRequest.onBeforeRequest`（异步回调）
 * 里做 DNS 校验。
 *
 * 这里只锁定「守卫确实装上、并且会 cancel」——DNS 判定本身由 resultUrl.test 覆盖。
 */

type Listener = (
  details: { url: string; resourceType: string },
  callback: (response: { cancel?: boolean }) => void
) => void;

const registered: { listener?: Listener } = {};

vi.mock("electron", () => ({
  BrowserWindow: class { static getAllWindows() { return []; } },
  session: {
    fromPartition: () => ({
      webRequest: {
        onBeforeRequest: (listener: Listener) => { registered.listener = listener; }
      },
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      clearCache: async () => undefined
    })
  }
}));

const { installNavigationDnsGuardForTest } = await import("./browserFetch");

/** 装一个守卫并跑一次请求，返回它给出的响应。 */
async function runGuard(
  url: string,
  resourceType: string,
  resolveTo: string
): Promise<{ cancel?: boolean }> {
  const session = { webRequest: { onBeforeRequest: (listener: Listener) => { registered.listener = listener; } } };
  installNavigationDnsGuardForTest(session as never, async () => [{ address: resolveTo }]);
  const listener = registered.listener!;
  return new Promise((resolve) => listener({ url, resourceType }, resolve));
}

describe("browserFetch 导航 DNS 守卫", () => {
  it("主框架导航解析到内网时取消", async () => {
    await expect(runGuard("http://127.0.0.1.nip.io:8080/object_info", "mainFrame", "127.0.0.1"))
      .resolves.toEqual({ cancel: true });
  });

  it("子资源不校验（避免每个页面逐条 DNS 把加载拖慢）", async () => {
    await expect(runGuard("http://127.0.0.1.nip.io:8080/a.png", "image", "127.0.0.1"))
      .resolves.toEqual({});
  });

  it("非 http(s) scheme 放行（预览页的 data/blob 不过网络）", async () => {
    await expect(runGuard("blob:https://example.com/abc", "mainFrame", "127.0.0.1"))
      .resolves.toEqual({});
  });

  it("解析到公网时放行", async () => {
    await expect(runGuard("https://example.com/x", "mainFrame", "93.184.216.34"))
      .resolves.toEqual({});
  });
});
