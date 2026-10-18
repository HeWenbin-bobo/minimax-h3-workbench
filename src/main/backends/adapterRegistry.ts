import type { AppSettings, BackendKind, GenerationAdapter } from "../../shared/types";
import { SettingsStore } from "../modules/settingsStore";
import { ComfyAdapter } from "./comfyAdapter";
import { MiniMaxAdapter } from "./minimaxAdapter";
import { RbAdapter } from "./rbAdapter";
import { SshComfyAdapter } from "./sshComfyAdapter";

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
