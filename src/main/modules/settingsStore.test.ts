import { describe, expect, it } from "vitest";
import type { AppSettings } from "../../shared/types";
import { normalizeSettings } from "./settingsStore";

// 用固定默认值，不调 defaultSettings()——那里会调 app.getPath，测试环境没有 Electron。
const defaults: AppSettings = {
  localComfyUrl: "http://127.0.0.1:8188",
  outputDirectory: "F:\\out",
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
    const result = normalizeSettings({ localComfyUrl: 123 as never, rbBaseUrl: "   " }, defaults);
    expect(result.localComfyUrl).toBe(defaults.localComfyUrl);
    expect(result.rbBaseUrl).toBe(defaults.rbBaseUrl);
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
