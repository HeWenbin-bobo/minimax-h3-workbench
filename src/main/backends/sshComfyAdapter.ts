import { describeError } from "../../shared/errors";
import type {
  AppSettings,
  BackendTestResult,
  GenerationAdapter,
  GenerationRequest,
  GenerationTask,
  TaskStatus
} from "../../shared/types";
import { ComfyAdapter } from "./comfyAdapter";
import { SshTunnel } from "./sshTunnel";

export class SshComfyAdapter implements GenerationAdapter {
  private readonly tunnel: SshTunnel;
  private delegate?: ComfyAdapter;
  /** delegate 绑定的隧道 URL。掉线重建后本地端口会变，必须据此判断是否需要重建 delegate。 */
  private delegateUrl?: string;

  constructor(settings: AppSettings, sshPassword: string) {
    this.tunnel = new SshTunnel(settings.ssh, sshPassword);
    this.settings = settings;
  }

  private readonly settings: AppSettings;

  /**
   * 拿到与**当前**隧道匹配的 ComfyAdapter。
   *
   * 不能只在 `!this.delegate` 时创建：隧道掉线后会重新监听（通常换一个本地端口），
   * 而旧 delegate 仍指向那个已死的端口——之后每次生成都得到 ECONNREFUSED，
   * 界面报"连接被拒绝"，真实原因却是 SSH 掉线（用户无从对症）。
   */
  private async delegateFor(): Promise<ComfyAdapter> {
    const tunnel = await this.tunnel.start();
    if (!this.delegate || this.delegateUrl !== tunnel.url) {
      this.delegate = new ComfyAdapter({ baseUrl: tunnel.url, outputDirectory: this.settings.outputDirectory });
      this.delegateUrl = tunnel.url;
    }
    return this.delegate;
  }

  async test(signal?: AbortSignal): Promise<BackendTestResult> {
    const start = Date.now();
    try {
      // 必须先建好隧道再 exec：`SshTunnel.exec` 在未连接时会抛「SSH 尚未连接」，
      // 而 delegateFor() 内部才做 start()（上一版把 start 挪走后这里变成了必然失败）。
      const delegate = await this.delegateFor();
      const hardware = await this.tunnel.exec(
        "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || true; free -h 2>/dev/null | head -2; df -h . | tail -1"
      );
      const comfy = await delegate.test(signal);
      return {
        ...comfy,
        label: "SSH 远程 ComfyUI",
        latencyMs: Date.now() - start,
        // 指纹取当前隧道的实测值（重建后仍是同一台主机，但要从当前连接读，避免用陈旧缓存）。
        details: { ...comfy.details, fingerprint: this.tunnel.fingerprint, hardware: hardware.stdout.trim() },
        message: comfy.ok ? "SSH 隧道和远程 H3 ComfyUI 均已就绪。" : comfy.message
      };
    } catch (error) {
      return {
        ok: false,
        label: "SSH 远程 ComfyUI",
        latencyMs: Date.now() - start,
        details: {},
        message: describeError(error, "SSH 连接失败")
      };
    }
  }

  async generate(
    request: GenerationRequest,
    task: GenerationTask,
    onProgress: (status: TaskStatus, progress: number, message?: string) => void,
    signal?: AbortSignal,
    onProviderId?: (providerTaskId: string) => void
  ): Promise<Pick<GenerationTask, "providerTaskId" | "outputPath" | "outputUrl" | "usage">> {
    const delegate = await this.delegateFor();
    return delegate.generate(request, task, onProgress, signal, onProviderId);
  }

  async cancel(providerTaskId: string): Promise<void> {
    await this.delegate?.cancel?.(providerTaskId);
  }

  close(): void {
    this.tunnel.close();
  }
}
