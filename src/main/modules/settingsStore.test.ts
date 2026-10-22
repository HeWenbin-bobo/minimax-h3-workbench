import { describe, expect, it } from "vitest";
import type { AppSettings } from "../../shared/types";
import { normalizeSettings } from "./settingsStore";

// 用固定默认值，不调 defaultSettings()——那里会调 app.getPath，测试环境没有 Electron。
const defaults: AppSettings = {
  localComfyUrl: "http://127.0.0.1:8188",
  outputDirectory: "F:\\out",
  outputDirectoryHistory: [],
  comfyuiRoot: "",
  rbBaseUrl: "https://rb.example.com",
  defaultBackend: "local",
  minimaxBaseUrl: "https://api.minimax.io",
  llm: { provider: "minimax", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-Text-01", systemPrompt: "" },
  searchApi: { baseUrl: "" },
  ssh: {
    name: "远程显卡",
    host: "",
    port: 22,
    username: "root",
    privateKeyPath: "",
    hostFingerprint: "",
    remoteComfyHost: "127.0.0.1",
    remoteComfyPort: 8188,
    remoteComfyPath: "~/ComfyUI"
  }
};

describe("normalizeSettings", () => {
  it("非法 defaultBackend 落到 local", () => {
    expect(normalizeSettings({ defaultBackend: "evil" as never }, defaults).defaultBackend).toBe("local");
    expect(normalizeSettings({ defaultBackend: "rb" }, defaults).defaultBackend).toBe("rb");
  });

  // 顶层字段此前已做类型校验（实测 localComfyUrl=123 会抛英文 replace 错误）。
  it("顶层字符串字段类型错误时回落默认值", () => {
    const result = normalizeSettings({ localComfyUrl: 123 as never, rbBaseUrl: { a: 1 } as never }, defaults);
    expect(result.localComfyUrl).toBe(defaults.localComfyUrl);
    expect(result.rbBaseUrl).toBe(defaults.rbBaseUrl);
  });

  /**
   * **纯空格不是"没给"，是"给了但等于没填"** —— 与服务地址的空串语义一致。
   *
   * 这条原本把 `rbBaseUrl: "   "` 与"类型错误"写在同一个用例里，断言它回落默认值。
   * 但 `rbBaseUrl` 现在是允许空的字段（清空地址必须真的生效），
   * 纯空格与空串同属"未配置"，不该被悄悄换成默认服务地址。
   * 两个意图不同，拆开表达才看得清。
   */
  it("服务地址是纯空格时保留（视为未配置），不回落默认值", () => {
    const result = normalizeSettings({ rbBaseUrl: "   ", minimaxBaseUrl: "  " }, defaults);
    expect(result.rbBaseUrl.trim()).toBe("");
    expect(result.minimaxBaseUrl.trim()).toBe("");
  });

  it("允许为空的顶层字段保留空串", () => {
    expect(normalizeSettings({ comfyuiRoot: "" }, defaults).comfyuiRoot).toBe("");
  });

  // 这三个嵌套对象此前只做 {...defaults, ...raw} 浅合并，字段类型完全没校验。
  it("嵌套 llm 字段类型错误时逐个回落（不是整块打回默认值）", () => {
    const result = normalizeSettings(
      { llm: { baseUrl: 123, model: "custom-model" } as never },
      defaults
    );
    expect(result.llm.baseUrl).toBe(defaults.llm.baseUrl);
    expect(result.llm.model).toBe("custom-model");
    expect(result.llm.provider).toBe(defaults.llm.provider);
  });

  it("嵌套 llm 为非对象时整块回落默认值", () => {
    for (const bad of [null, [], "x", 42]) {
      expect(normalizeSettings({ llm: bad as never }, defaults).llm).toEqual(defaults.llm);
    }
  });

  it("searchApi.baseUrl 保留空串（未配置 = 免 key 抓取）", () => {
    expect(normalizeSettings({ searchApi: {} }, defaults).searchApi.baseUrl).toBe("");
    expect(normalizeSettings({ searchApi: { baseUrl: 123 } as never }, defaults).searchApi.baseUrl).toBe("");
  });

  // ssh.port = "abc" 会被 ssh2 拿去连端口，NaN 的报错对用户毫无指向性。
  it("ssh 端口非数字或越界时回落默认值", () => {
    for (const bad of ["abc", NaN, Infinity, 0, -1, 70_000, {}, null] as never[]) {
      expect(normalizeSettings({ ssh: { port: bad } as never }, defaults).ssh.port).toBe(22);
    }
    expect(normalizeSettings({ ssh: { port: 2222 } as never }, defaults).ssh.port).toBe(2222);
  });

  it("ssh 端口为数字字符串时接受（设置页输入框给的就是字符串）", () => {
    expect(normalizeSettings({ ssh: { port: "2222" } as never }, defaults).ssh.port).toBe(2222);
    expect(normalizeSettings({ ssh: { remoteComfyPort: "8188" } as never }, defaults).ssh.remoteComfyPort).toBe(8188);
  });

  it("ssh 其余字段类型错误时回落，且保留合法值", () => {
    const result = normalizeSettings(
      { ssh: { host: 123, username: "alice", privateKeyPath: null } as never },
      defaults
    );
    expect(result.ssh.host).toBe(defaults.ssh.host);
    expect(result.ssh.username).toBe("alice");
    expect(result.ssh.privateKeyPath).toBe(defaults.ssh.privateKeyPath);
  });

  it("空对象整体走默认值", () => {
    expect(normalizeSettings({}, defaults)).toEqual(defaults);
  });
});

/**
 * 用户名**空串是有语义的**（未配置），不能回落到默认值 `"root"`。
 *
 * 实测缺陷（probe-assert-usable）：用户在连接设置里清空用户名并保存后，
 * `str()` 把空串换成默认 `"root"` 写回磁盘——界面看起来清空了、读回来又是 root；
 * 更糟的是 `assertUsable("ssh")` 的判据是"host 与 username 都非空"，
 * 被这个假值骗过而放行，建出一条注定失败的任务（用户还得手动删）。
 *
 * 与 `host` / `comfyuiRoot` 同一口径：空串 = 未配置，原样保留。
 */
describe("normalizeSettings：ssh 用户名允许为空", () => {
  it("显式传空串时保持空（不回落到 root）", () => {
    expect(normalizeSettings({ ssh: { username: "" } as never }, defaults).ssh.username).toBe("");
  });

  it("只填空格也视为空（trim 后为空同样是未配置）", () => {
    const result = normalizeSettings({ ssh: { username: "   " } as never }, defaults);
    // 保留原值还是 trim 成空串都可以接受，唯独不能变成 "root"。
    expect(result.ssh.username.trim()).toBe("");
  });

  it("非字符串（数字/null/对象）仍回落默认值", () => {
    for (const bad of [123, null, {}, []]) {
      expect(normalizeSettings({ ssh: { username: bad } as never }, defaults).ssh.username, JSON.stringify(bad))
        .toBe(defaults.ssh.username);
    }
  });

  it("不传 username 时仍是默认值（区分'没给'与'给了空串'）", () => {
    expect(normalizeSettings({ ssh: { host: "1.2.3.4" } as never }, defaults).ssh.username).toBe(defaults.ssh.username);
  });
});

/**
 * **地址空串 = 未配置，不能回落成默认地址**（实测缺陷 probe-no-backend, 2026-10-21）。
 *
 * 旧实现 `str(raw.localComfyUrl, defaults.localComfyUrl)` 会把空串换成默认的
 * `http://127.0.0.1:8188`。后果很具体：用户清空地址表达"不想用本机"后，
 * `backendAvailability` 仍判"本机可用"，`generate_video` 的准入闸门放行，
 * **在没有任何可用后端的情况下建出一条注定失败的任务**，
 * 工具回执还写着「已创建 1 个视频生成任务：后端=本机 ComfyUI」。
 *
 * 与 host / username / comfyuiRoot 同一口径：空串是有语义的"未配置"。
 */
describe("normalizeSettings：本机 ComfyUI 地址允许为空", () => {
  it("显式传空串时保持空（不回落到默认 :8188）", () => {
    expect(normalizeSettings({ localComfyUrl: "" }, defaults).localComfyUrl).toBe("");
  });

  it("只填空格也视为空（trim 后为空同样是未配置）", () => {
    const result = normalizeSettings({ localComfyUrl: "   " }, defaults);
    expect(result.localComfyUrl.trim()).toBe("");
  });

  it("非字符串（数字/null/对象）仍回落默认值", () => {
    for (const bad of [123, null, {}, []]) {
      expect(normalizeSettings({ localComfyUrl: bad } as never, defaults).localComfyUrl, JSON.stringify(bad))
        .toBe(defaults.localComfyUrl);
    }
  });

  it("不传该字段时仍是默认值（区分「没给」与「给了空串」）", () => {
    expect(normalizeSettings({}, defaults).localComfyUrl).toBe(defaults.localComfyUrl);
  });
});
