import type { AppSettings, BackendKind, GenerationAdapter } from "../../shared/types";
import { SettingsStore } from "../modules/settingsStore";
import { ComfyAdapter } from "./comfyAdapter";
import { MiniMaxAdapter } from "./minimaxAdapter";
import { RbAdapter } from "./rbAdapter";
import { SshComfyAdapter } from "./sshComfyAdapter";

/** 四个后端 + 模型/用户可能用的口语叫法。`generate_video` 的 `backend` 参数走这里归一。 */
const BACKEND_ALIASES: Record<string, BackendKind> = {
  local: "local", comfy: "local", comfyui: "local", 本机: "local", 本地: "local",
  ssh: "ssh", remote: "ssh", 远程: "ssh",
  minimax: "minimax", 云: "minimax", 云端: "minimax", 云api: "minimax",
  rb: "rb", 瞬映: "rb", 卡密: "rb"
};

/**
 * 把模型（或用户）写的后端名归一成 `BackendKind`；认不出来返回 `undefined`。
 *
 * **不要在工具 schema 里用 `z.enum`**（本会话已修 19 处同类坑）：模型写「本机」「ComfyUI」
 * 时，枚举会在 `parseToolCall` 阶段拒掉整个调用——模型收不到回执、反复重试、20 步预算烧光。
 * 这里返回 `undefined` 让调用方**回一句"可选后端是哪些"**，而不是静默换成默认后端：
 * 用户以为选了云端、实际跑在本机，账与结果都完全不同。
 */
export function normalizeBackendKind(value: unknown): BackendKind | undefined {
  if (typeof value !== "string") return undefined;
  return BACKEND_ALIASES[value.trim().toLowerCase()];
}

export class AdapterRegistry {
  private sshAdapter?: SshComfyAdapter;

  constructor(private readonly settingsStore: SettingsStore) {}

  async get(kind: BackendKind): Promise<GenerationAdapter> {
    // **未知 kind 必须明确拒绝，不能落到 SSH 兜底**。
    // 这是所有后端的唯一入口（`tasks:submit` / `tasks:retry` / `backend:test`
    // 与智能体的 generate_video 都经它），而参数来自 IPC，类型没有保证。
    // 分支链以 SSH 兜底时，拼错的 "RB"、空串、null、undefined 都会被当成 SSH 后端——
    // 用户得到的错误是"请填写 SSH 主机和用户名"，与他实际想用的后端毫无关系。
    // `validateRequest` 已在提交路径挡过一次，但 `backend:test` 与部分重试路径
    // 不经过它，故在根源处再挡一次。
    if (!["local", "ssh", "minimax", "rb"].includes(kind)) throw new Error("生成后端无效。");
    const settings = await this.settingsStore.get();
    if (kind === "local") {
      return new ComfyAdapter({ baseUrl: settings.localComfyUrl, outputDirectory: settings.outputDirectory });
    }
    if (kind === "minimax") {
      return new MiniMaxAdapter({
        baseUrl: settings.minimaxBaseUrl,
        apiKey: await this.settingsStore.getSecret("minimaxApiKey"),
        outputDirectory: settings.outputDirectory
      });
    }
    if (kind === "rb") {
      return new RbAdapter({
        baseUrl: settings.rbBaseUrl,
        cardCode: await this.settingsStore.getSecret("rbCardCode"),
        outputDirectory: settings.outputDirectory
      });
    }
    if (!this.sshAdapter) {
      this.sshAdapter = new SshComfyAdapter(settings, await this.settingsStore.getSecret("sshPassword"));
    }
    return this.sshAdapter;
  }

  invalidate(settings?: AppSettings): void {
    void settings;
    this.sshAdapter?.close();
    this.sshAdapter = undefined;
  }

  close(): void {
    this.invalidate();
  }
}
