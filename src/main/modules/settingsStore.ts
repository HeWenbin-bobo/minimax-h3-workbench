import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, SecretName } from "../../shared/types";

const defaultSettings = (): AppSettings => ({
  localComfyUrl: "http://127.0.0.1:8188",
  outputDirectory: path.join(app.getPath("videos"), "MiniMax-H3"),
  comfyuiRoot: "",
  rbBaseUrl: "https://rb.coolhs.com",
  defaultBackend: "local",
  minimaxBaseUrl: "https://api.minimax.io",
  llm: {
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-Text-01",
    systemPrompt: ""
  },
  searchApi: {
    baseUrl: ""
  },
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
});

export class SettingsStore {
  private readonly filePath = path.join(app.getPath("userData"), "settings.json");
  private readonly secretPath = path.join(app.getPath("userData"), "secrets.json");

  async get(): Promise<AppSettings> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AppSettings>;
      const defaults = defaultSettings();
      const defaultBackend = raw.defaultBackend === "ssh" || raw.defaultBackend === "minimax" || raw.defaultBackend === "rb" || raw.defaultBackend === "local"
        ? raw.defaultBackend
        : "local";
      return {
        localComfyUrl: raw.localComfyUrl || defaults.localComfyUrl,
        outputDirectory: raw.outputDirectory || defaults.outputDirectory,
        comfyuiRoot: typeof raw.comfyuiRoot === "string" ? raw.comfyuiRoot : defaults.comfyuiRoot,
        rbBaseUrl: typeof raw.rbBaseUrl === "string" && raw.rbBaseUrl ? raw.rbBaseUrl : defaults.rbBaseUrl,
        defaultBackend,
        minimaxBaseUrl: raw.minimaxBaseUrl || defaults.minimaxBaseUrl,
        llm: { ...defaults.llm, ...(raw.llm ?? {}) },
        searchApi: { ...defaults.searchApi, ...(raw.searchApi ?? {}) },
        ssh: { ...defaults.ssh, ...(raw.ssh ?? {}) }
      };
    } catch {
      return defaultSettings();
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    // 读-改-写必须整体串行：并发时会互相覆盖 patch，且两路同时写 settings.json.tmp
    // 会让后完成的 rename 报 ENOENT（实测 20/20 轮都失败）。
    return this.serialize(async () => {
      const current = await this.get();
      // 嵌套对象一律**局部合并**：patch 只带 llm.model 时，不能把 llm.baseUrl/provider/systemPrompt
      // 打回默认值。此前只对 ssh 做了合并，llm/searchApi 是整体替换——同样的坑（实测
      // probe-settings-partial 复现：只更新 llm.model → baseUrl 被清成官方默认）。
      const next = {
        ...current,
        ...patch,
        llm: patch.llm ? { ...current.llm, ...patch.llm } : current.llm,
        searchApi: patch.searchApi ? { ...current.searchApi, ...patch.searchApi } : current.searchApi,
        ssh: patch.ssh ? { ...current.ssh, ...patch.ssh } : current.ssh
      };
      await this.atomicWrite(this.filePath, next);
      // 回读而非直接返回 next：get() 会做归一化（非法 defaultBackend 落到 local、未知字段被丢弃），
      // 直接返回 next 会让"保存后立刻读回"拿到与磁盘不同的值，渲染端据此渲染就会用到脏状态。
      return this.get();
    });
  }

  async setSecret(name: SecretName, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，拒绝保存明文密钥。 ");
    // 与 update 共用同一条队列：密钥写入同样是读-改-写，并发会丢键/写坏 tmp。
    return this.serialize(async () => {
      const secrets = await this.readSecrets();
      secrets[name] = safeStorage.encryptString(value).toString("base64");
      await this.atomicWrite(this.secretPath, secrets);
    });
  }

  async getSecret(name: SecretName): Promise<string> {
    const secrets = await this.readSecrets();
    const encrypted = secrets[name];
    if (!encrypted) return "";
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  async hasSecret(name: SecretName): Promise<boolean> {
    const secrets = await this.readSecrets();
    return Boolean(secrets[name]);
  }

  private async readSecrets(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.secretPath, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /**
   * 写入串行化（与 TaskStore.save 同一套做法）。
   *
   * 不串行会**真实损坏**：两次并发 updateSettings 同时写同一个 `settings.json.tmp`，
   * 先完成的那次把它 rename 走，后一次 rename 就报 ENOENT（实测 20/20 轮都失败）。
   * 而且 update() 是「读-改-写」，并发时后写者会覆盖前者的 patch（丢失更新）。
   * 因此串行化覆盖**整个事务**，而不只是文件写入那一步。
   */
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    // 队列不能被单次失败污染，否则后续所有写入连坐失败。
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temporary, filePath);
  }
}
