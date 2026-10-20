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

/** 后端在界面/回执里的中文名（与渲染端「连接设置」的写法一致）。 */
export function backendKindLabel(kind: BackendKind): string {
  if (kind === "local") return "本机 ComfyUI";
  if (kind === "ssh") return "SSH 远程显卡";
  if (kind === "rb") return "瞬映 RB";
  return "MiniMax H3";
}

/**
 * 这段话里有没有**明确**说要走哪个后端。
 *
 * 用途：有多个后端可用时，`generate_video` 要求模型先问用户；但如果用户自己已经说了
 * 「用本机的」「走云端」，再拦着不让动手就是刁难。这里只认**明确的指名**，
 * 不做任何推断——认不出来就返回 `undefined`（走"先问"那条路，宁多问一句）。
 *
 * **误判的代价不对称**：判成"用户选了云端"会跳过询问，直接按秒计费/扣卡密（花真钱）；
 * 判不出来只是多问一句。所以词表刻意保守。
 *
 * @param options.loose 用于**选择题答案**语境。那里的文本是我们自己给出的选项
 *   （如「云端（按秒计费）」），出现「云端」没有歧义；而用户**原话**里的「云端」
 *   多半是画面内容（「云端漂浮的城堡」），不能当成选了后端——实测这条会花错钱。
 */
export function backendMentionedInText(value: unknown, options?: { loose?: boolean }): BackendKind | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const loose = options?.loose === true;
  if (/瞬映|卡密|`rb`|\brb\b/i.test(value)) return "rb";
  // 「云端」只在 loose 下无条件算：原话里的「云端城堡」「站在云端」都是画面描述。
  // 严格模式下只认**指令形态**——"用/走/选 云端"或"云端 生成/跑/渲染"，
  // 这两种说法不可能是画面描述。
  if (/minimax|云\s*api|走云|云生成/i.test(value)) return "minimax";
  if (loose ? /云端/.test(value) : /(?:用|走|选|要)\s*云端|云端\s*(?:生成|跑|渲染)/.test(value)) return "minimax";
  if (/\bssh\b|远程显卡/i.test(value)) return "ssh";
  if (/本机|本地|comfy\s*ui|comfy/i.test(value)) return "local";
  return undefined;
}

export interface BackendAvailability {
  kind: BackendKind;
  label: string;
  note: string;
  /** 有值 = 现在用不了，值就是给用户看的原因（已配好时没有这个字段）。 */
  reason?: string;
}

/**
 * 四个后端**此刻能不能用**的单一判定，两个调用方共用：
 * ① 世界状态「视频生成后端」小节（告诉模型哪些能选）；
 * ② `generateVideo` 真正 `submit()` **之前**的前置检查。
 *
 * 为什么必须共用（实测缺陷 probe-nocred-backend）：`orchestrator.submit()` 只校验参数、
 * 不查凭据，会先把任务建出来并返回成功 → 工具回执写「已创建 1 个视频生成任务」→
 * 随后 `runTask()` 异步抛「请先保存 АРI keys」→ 模型据此对用户说"已经帮你提交了"，
 * 卡片却是失败的。两处各写一份判定必然漂移（一处"有地址就行"、另一处要"有密钥"）。
 *
 * 判据只认"能不能发出去"，不做连通性探测（要几秒，且每轮都探会拖慢对话）：
 * - `local`：填了 ComfyUI 地址（服务开没开由工具执行时的报错回答）；
 * - `ssh`：填了主机 + 用户名；
 * - `minimax` / `rb`：存了密钥 / 卡密。
 *
 * @param hasSecret 注入而非直接读 store：`hasSecret` 会真的试解密（换机器 / Local State
 * 丢失时密文在但解不开，必须算"没有"），但那需要 Electron 的 safeStorage，单测里给不了。
 */
export async function backendAvailability(
  settings: Pick<AppSettings, "localComfyUrl" | "ssh">,
  hasSecret: (name: "minimaxApiKey" | "rbCardCode") => Promise<boolean>
): Promise<BackendAvailability[]> {
  const [hasMinimax, hasRb] = await Promise.all([
    hasSecret("minimaxApiKey").catch(() => false),
    hasSecret("rbCardCode").catch(() => false)
  ]);
  return [
    {
      kind: "local",
      label: backendKindLabel("local"),
      note: "不额外计费，用本机显卡",
      ...(settings.localComfyUrl ? {} : { reason: "还没填 ComfyUI 地址" })
    },
    {
      kind: "ssh",
      label: backendKindLabel("ssh"),
      note: settings.ssh?.host ? `远程 ${settings.ssh.host}` : "远程显卡",
      ...(settings.ssh?.host && settings.ssh?.username ? {} : { reason: "还没填 SSH 主机与用户名" })
    },
    {
      kind: "minimax",
      label: backendKindLabel("minimax"),
      note: "云端按秒计费",
      ...(hasMinimax ? {} : { reason: "还没保存 MiniMax АРI keys" })
    },
    {
      kind: "rb",
      label: backendKindLabel("rb"),
      note: "扣卡密次数",
      ...(hasRb ? {} : { reason: "还没保存瞬映卡密" })
    }
  ];
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
