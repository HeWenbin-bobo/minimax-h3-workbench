import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, SecretName } from "../../shared/types";
import { SECRET_NAMES } from "../../shared/types";

const defaultSettings = (): AppSettings => ({
  localComfyUrl: "http://127.0.0.1:8188",
  outputDirectory: path.join(app.getPath("videos"), "MiniMax-H3"),
  outputDirectoryHistory: [],
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

/**
 * settings.json 的读取归一化。**纯函数**，导出以便单测（文件 IO 与 Electron 依赖留在 store 里）。
 *
 * 为什么每个字段都要类型校验，而不是 `raw.x || default`：
 * settings.json 可能被手改、或被旧版本写进错误类型。实测 localComfyUrl=123 会一路传到
 * ComfyAdapter，抛 "options.baseUrl.replace is not a function"，用户看到英文技术错误。
 * 嵌套对象同理：只做浅合并的话 `llm.baseUrl: 123` / `ssh.port: "abc"` 会原样透出，
 * 分别变成 LlmService 里的 replace 报错和 ssh 的 NaN 端口。
 */
export function normalizeSettings(raw: Partial<AppSettings>, defaults: AppSettings): AppSettings {
  const defaultBackend = raw.defaultBackend === "ssh" || raw.defaultBackend === "minimax" || raw.defaultBackend === "rb" || raw.defaultBackend === "local"
    ? raw.defaultBackend
    : "local";
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.trim() ? value : fallback;
  // 允许空串的字段（comfyuiRoot 不填就是"未配置"）不能用 str 的 trim 判空。
  const maybeStr = (value: unknown, fallback: string): string =>
    typeof value === "string" ? value : fallback;
  const num = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  // 嵌套对象：非对象（null/数组/字符串）整体回落默认值，避免 {...null} 之类的半残状态。
  const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const llm = obj(raw.llm);
  const searchApi = obj(raw.searchApi);
  const ssh = obj(raw.ssh);
  // 历史输出目录：只保留字符串项、去重、剔除当前目录本身。
  // 这是**删除白名单**的信任来源，绝不能从任务记录里取值（见 AppSettings 的注释）。
  const currentOutput = str(raw.outputDirectory, defaults.outputDirectory);
  const history = Array.isArray(raw.outputDirectoryHistory)
    ? Array.from(new Set(
        raw.outputDirectoryHistory
          .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
          .map((entry) => entry.trim())
      )).filter((entry) => entry !== currentOutput)
    : [];
  return {
    localComfyUrl: str(raw.localComfyUrl, defaults.localComfyUrl),
    outputDirectory: currentOutput,
    outputDirectoryHistory: history,
    comfyuiRoot: maybeStr(raw.comfyuiRoot, defaults.comfyuiRoot),
    rbBaseUrl: str(raw.rbBaseUrl, defaults.rbBaseUrl),
    defaultBackend,
    minimaxBaseUrl: str(raw.minimaxBaseUrl, defaults.minimaxBaseUrl),
    llm: {
      provider: str(llm.provider, defaults.llm.provider),
      baseUrl: str(llm.baseUrl, defaults.llm.baseUrl),
      model: str(llm.model, defaults.llm.model),
      // 系统提示词允许为空（空 = 用内置默认）。
      systemPrompt: maybeStr(llm.systemPrompt, defaults.llm.systemPrompt)
    },
    searchApi: {
      // 空串有语义（未配置 → 回落免 key 抓取），不能用 str。
      baseUrl: maybeStr(searchApi.baseUrl, defaults.searchApi.baseUrl)
    },
    ssh: {
      name: str(ssh.name, defaults.ssh.name),
      // 主机可以为空（未配置），但不能是数字。
      host: maybeStr(ssh.host, defaults.ssh.host),
      port: num(ssh.port, defaults.ssh.port, 1, 65_535),
      username: str(ssh.username, defaults.ssh.username),
      privateKeyPath: maybeStr(ssh.privateKeyPath, defaults.ssh.privateKeyPath),
      hostFingerprint: maybeStr(ssh.hostFingerprint, defaults.ssh.hostFingerprint),
      remoteComfyHost: str(ssh.remoteComfyHost, defaults.ssh.remoteComfyHost),
      remoteComfyPort: num(ssh.remoteComfyPort, defaults.ssh.remoteComfyPort, 1, 65_535),
      remoteComfyPath: str(ssh.remoteComfyPath, defaults.ssh.remoteComfyPath)
    }
  };
}

/**
 * 解密一个已保存的密钥。
 *
 * safeStorage 在"密文存在但解不开"时抛英文错误
 * （"Error while decrypting the ciphertext provided to safeStorage.decryptString.
 * Ciphertext does not appear to be encrypted."）。换机器、`Local State` 丢失、
 * 系统账号变更都会走到这里，而这条英文对用户毫无指向性——界面只会显示
 * "生成失败"，没人知道该重新填一次 Key。这里翻译成可执行的中文。
 */
function decryptSecret(encrypted: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    throw new Error("已保存的密钥无法解密（可能更换了电脑或系统账户）。请到「连接设置」重新填写并保存。");
  }
}

export class SettingsStore {
  private readonly filePath = path.join(app.getPath("userData"), "settings.json");
  private readonly secretPath = path.join(app.getPath("userData"), "secrets.json");

  async get(): Promise<AppSettings> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AppSettings>;
      return normalizeSettings(raw, defaultSettings());
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
      const merged: Partial<AppSettings> = {
        ...current,
        ...patch,
        // `outputDirectoryHistory` **不接受渲染端写入**：它是删除白名单的信任根。
        // 渲染端（或从其内部发起的调用）若能任意追加目录，就等于拿到了"任意文件删除"的
        // 能力（先塞 `C:\`，再触发「彻底删除」）。该字段只由本方法在检测到目录变更时维护。
        outputDirectoryHistory: current.outputDirectoryHistory,
        llm: patch.llm ? { ...current.llm, ...patch.llm } : current.llm,
        searchApi: patch.searchApi ? { ...current.searchApi, ...patch.searchApi } : current.searchApi,
        ssh: patch.ssh ? { ...current.ssh, ...patch.ssh } : current.ssh
      };
      // 写盘前再归一化一次：patch 来自渲染端（可构造），脏类型不该落到磁盘上。
      // 只在 get() 里纠正的话，磁盘上会一直留着 `port: "abc"` 这类值。
      const next = normalizeSettings(merged, defaultSettings());
      // 改过输出目录时把旧目录记进历史：彻底删除/过期清理要靠它才敢删旧目录里的成片。
      // **只记录用户主动配置过的目录**——这是删除白名单唯一的信任来源，
      // 绝不能从任务记录取值（记录可被篡改，删除不可逆）。
      if (current.outputDirectory && current.outputDirectory !== next.outputDirectory) {
        next.outputDirectoryHistory = Array.from(new Set([
          ...(next.outputDirectoryHistory ?? []),
          current.outputDirectory
        ])).filter((entry) => entry !== next.outputDirectory);
      }
      await this.atomicWrite(this.filePath, next);
      // 回读而非直接返回 next：get() 会做归一化（非法 defaultBackend 落到 local、未知字段被丢弃），
      // 直接返回 next 会让"保存后立刻读回"拿到与磁盘不同的值，渲染端据此渲染就会用到脏状态。
      return this.get();
    });
  }

  async setSecret(name: SecretName, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，拒绝保存明文密钥。 ");
    // 两个参数都来自 IPC，类型没有保证：
    // - `encryptString(123)` 抛英文 TypeError（实测 "Error processing argument at index 0,
    //   conversion failure"），直接透到界面
    // - `name` 非白名单值时会把密钥写到一个下游永远读不到的键上（表现为"保存了但没生效"），
    //   且 `__proto__` 这类键在普通对象赋值上是**静默无效**的（实测写入后 Object.keys 为空）
    if (typeof name !== "string" || !SECRET_NAMES.includes(name)) throw new Error("密钥类型无效。");
    if (typeof value !== "string") throw new Error("密钥内容必须是文本。");
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
    return decryptSecret(encrypted);
  }

  async hasSecret(name: SecretName): Promise<boolean> {
    const secrets = await this.readSecrets();
    // 不能只看"密文存在"：换机器 / Local State 丢失 / 系统账号变更后，
    // 密文仍在但已解不开（safeStorage 抛 "Ciphertext does not appear to be encrypted"）。
    // 那时 hasSecret 报 true 会让界面显示"已保存"，实际每次调用都失败（实测探针 decrypt-failure）。
    const encrypted = secrets[name];
    if (!encrypted) return false;
    try {
      decryptSecret(encrypted);
      return true;
    } catch {
      return false;
    }
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
