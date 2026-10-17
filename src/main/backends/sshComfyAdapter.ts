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
  /**
   * 正在进行的操作数（generate / test）。
   *
   * `AdapterRegistry.invalidate()` 会在**任何**设置保存时被调用（改个提示词也算），
   * 它立即 `close()` 隧道——正在跑的 SSH 生成会当场断在 ECONNREFUSED 上：
   * 用户只是点了「保存设置」，回过头发现任务失败了，且错误与真实原因（隧道被关）无关。
   * 这里记录在途数，close 时若仍有在途操作就延后到最后一个结束。
   */
  private inFlight = 0;
  private closePending = false;

  constructor(settings: AppSettings, sshPassword: string) {
    this.tunnel = new SshTunnel(settings.ssh, sshPassword);
    this.settings = settings;
  }

  private readonly settings: AppSettings;

  /** 在途计数包装：无论成功、失败还是取消都要减一，否则隧道永远不会被真正关闭。 */
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await operation();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0 && this.closePending) this.tunnel.close();
    }
  }

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
    return this.track(async () => {
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
    });
  }

  async generate(
    request: GenerationRequest,
    task: GenerationTask,
    onProgress: (status: TaskStatus, progress: number, message?: string) => void,
    signal?: AbortSignal,
    onProviderId?: (providerTaskId: string) => void
  ): Promise<Pick<GenerationTask, "providerTaskId" | "outputPath" | "outputUrl" | "usage">> {
    return this.track(async () => {
      const delegate = await this.delegateFor();
      return delegate.generate(request, task, onProgress, signal, onProviderId);
    });
  }

  async cancel(providerTaskId: string): Promise<void> {
    await this.delegate?.cancel?.(providerTaskId);
  }

  /**
   * 请求关闭隧道。
   *
   * **有在途操作时延后**：`AdapterRegistry.invalidate()` 会在任何一次设置保存时调用
   * （改提示词、改分类阈值都算），当场 close 会让正在跑的 SSH 生成断在 ECONNREFUSED，
   * 而用户只看到"连接被拒绝"，完全想不到是自己刚点了「保存设置」。
   * 最后一个在途操作结束时由 `track()` 真正关闭。
   */
  close(): void {
    if (this.inFlight > 0) {
      this.closePending = true;
      return;
    }
    this.closePending = false;
    this.tunnel.close();
  }
}
