import type { EnvironmentReport, GpuInfo } from "./types";

export interface CapabilityInput {
  gpus: GpuInfo[];
  memoryTotalBytes: number;
  diskFreeBytes: number;
  comfyReachable: boolean;
  comfyHasH3Nodes: boolean;
  comfyMissingH3Models?: string[];
}

export interface LocalRuntimeEstimate {
  resolution: "720P" | "2K";
  minMinutes: number;
  maxMinutes: number;
  risk: "medium" | "high" | "very_high";
  note: string;
}

const GiB = 1024 ** 3;

export interface VolumeInfo {
  mount: string;
  size: number;
  used: number;
}

// 选出应报告的磁盘卷：优先输出目录所在卷（Windows 下 mount 形如 "C:"），否则取剩余空间最大的卷。
export function pickVolumeForOutput(volumes: VolumeInfo[], outputDirectory?: string): VolumeInfo | undefined {
  if (volumes.length === 0) return undefined;
  const dir = outputDirectory?.toLowerCase();
  // 必须按**路径前缀边界**匹配，不能裸 startsWith：mount 是 "/home" 时，
  // "/homepage/out" 也会命中，于是磁盘指标读错卷（实测 probe-volume 复现）。
  // 合法边界：目录恰好等于 mount，或 mount 之后紧跟路径分隔符
  //（Windows 的 "C:" 天然以 "C:\" 或 "C:/" 继续，也走这条）。
  const matchesMount = (pathDir: string, mount: string): boolean => {
    if (!mount) return false;
    if (pathDir === mount) return true;
    if (!pathDir.startsWith(mount)) return false;
    // 挂载点自身以分隔符结尾（Linux/macOS 的根 "/"、Windows 的 "C:\"）时，
    // 前缀匹配已经落在边界上——再去看下一个字符会把 "/" 永远判为不匹配，
    // 于多卷场景下把输出目录错配到别的卷（实测 probe-volume-root）。
    if (/[\\/]$/.test(mount)) return true;
    const next = pathDir.charAt(mount.length);
    return next === "/" || next === "\\";
  };
  const matched = dir ? volumes.find((item) => matchesMount(dir, String(item.mount).toLowerCase())) : undefined;
  const freeOf = (item: VolumeInfo) => Number(item.size) - Number(item.used);
  return matched ?? volumes.reduce((best, item) => (freeOf(item) > freeOf(best) ? item : best), volumes[0]);
}

export function classifyEnvironment(input: CapabilityInput): Pick<EnvironmentReport, "grade" | "verdict" | "recommendations"> {
  const nvidia = input.gpus.filter((gpu) => /nvidia/i.test(`${gpu.vendor} ${gpu.model}`));
  const appleGpu = input.gpus.some((gpu) => /apple/i.test(`${gpu.vendor} ${gpu.model}`));
  const totalVram = nvidia.reduce((sum, gpu) => sum + gpu.vramBytes, 0);
  const recommendations: string[] = [];

  // 磁盘读数未知时不要拿 0 当"空间不足"：
  // `systemInspector` 在 `pickVolumeForOutput` 找不到卷（fsSize 返回空/异常）时
  // 会把 `diskFreeBytes` 置为 0。若照常判定，用户会看到「至少释放 70GB 磁盘空间」，
  // 而他的磁盘可能一块都没满——这种假告警比不提示更误导。
  // 真正的 0 字节可用与"读不到"在语义上都无法生成，故统一按"未知"处理。
  //
  // **C 级门槛同样要按"未知"放行**：那里原来直接写 `diskFreeBytes >= 45 GiB`，
  // 于是读不到磁盘时，一块 24GB 显存的机器会被判成 D 级并显示
  // "当前硬件低于量化实验配置"——硬件明明够，结论却相反（与 70GB 告警同一类错误）。
  // 读不到就不作为否决条件，改为提示用户自行确认空间。
  const diskKnown = input.diskFreeBytes > 0;
  if (diskKnown && input.diskFreeBytes < 70 * GiB) recommendations.push("至少释放 70GB 磁盘空间后再安装完整创作包。 ");

  // **内存读数未知时同理**：`systeminformation` 在 Windows 上走 WMI，
  // 驱动异常时 `si.mem()` 可能超时——`systemInspector` 的兜底会把它置 0。
  // 与磁盘一样，"读不到"不等于"不够"：照常比较的话，
  // 一台 24GB 显存的机器会因为内存读数缺失被判成 D 级并显示
  // 「当前硬件低于量化实验配置」，结论正好相反。
  const memoryKnown = input.memoryTotalBytes > 0;
  const memoryAtLeast = (bytes: number) => !memoryKnown || input.memoryTotalBytes >= bytes;

  // **显卡读不到时不要断言"硬件不行"**：`si.graphics()` 在 Windows 上走 WMI，
  // 超时兜底会给一个空 `controllers`。此时 `nvidia.length === 0` 与"真的没有 NVIDIA 卡"
  // 无法区分——但 D 级文案会写成「当前硬件低于量化实验配置」，
  // 而这台机器可能只是一次 WMI 超时。改为如实说明"未能读取显卡信息"。
  const gpuKnown = input.gpus.length > 0;
  if (!gpuKnown) recommendations.push("未能读取显卡信息（可能是显卡驱动或系统管理服务异常），请确认后重新检测。 ");

  if (nvidia.length >= 2 && totalVram >= 48 * GiB && memoryAtLeast(256 * GiB)) {
    if (!memoryKnown) recommendations.push("未能读取内存总量，请自行确认至少 256GB 再开始。 ");
    if (!input.comfyReachable) recommendations.push("安装或启动 ComfyUI 0.30.0+，然后重新检测。 ");
    if (input.comfyReachable && !input.comfyHasH3Nodes) recommendations.push("更新 ComfyUI，当前实例缺少 MiniMax H3 原生节点。 ");
    if (input.comfyHasH3Nodes && input.comfyMissingH3Models?.length) recommendations.push(`安装缺少的 ${input.comfyMissingH3Models.length} 个 H3 模型文件，然后完全重启 ComfyUI。`);
    return {
      grade: "B",
      verdict: "硬件接近官方验证的本地配置，完成模型安装后可运行预检。",
      recommendations
    };
  }

  // 磁盘门槛在"读不到"时放行（`!diskKnown || …`）：读不到不等于没空间。
  // 放行后补一条提示，让用户自己确认，而不是悄悄按"够用"处理。
  const diskEnough = !diskKnown || input.diskFreeBytes >= 45 * GiB;
  if (nvidia.length >= 1 && totalVram >= 12 * GiB && memoryAtLeast(32 * GiB) && diskEnough) {
    if (!diskKnown) recommendations.push("未能读取磁盘剩余空间，请自行确认至少留出 45GB 再开始。 ");
    if (!memoryKnown) recommendations.push("未能读取内存总量，请自行确认至少 32GB 再开始。 ");
    if (!input.comfyReachable) recommendations.push("安装或启动 ComfyUI 0.30.0+，然后重新检测。 ");
    if (input.comfyReachable && !input.comfyHasH3Nodes) recommendations.push("更新 ComfyUI，当前实例缺少 MiniMax H3 原生节点。 ");
    if (input.comfyHasH3Nodes && input.comfyMissingH3Models?.length) recommendations.push(`安装缺少的 ${input.comfyMissingH3Models.length} 个 H3 模型文件，然后完全重启 ComfyUI。`);
    recommendations.push("该配置属于 ComfyUI 量化实验路径，必须通过 5 秒预检后才标记为可用。 ");
    return {
      grade: "C",
      verdict: "可以尝试本地量化运行，但不属于官方保证配置。",
      recommendations
    };
  }

  recommendations.push("不建议继续配置本机生成；优先使用 SSH 远程显卡或 MiniMax 云 API。 ");
  recommendations.push("如仍要强行本机运行，请先做单条 5 秒 720P 预检，并预留失败或内存溢出的可能。 ");
  return {
    grade: "D",
    verdict: appleGpu
      ? "本机不建议运行 MiniMax H3：Apple GPU 不属于当前验证的 NVIDIA CUDA 路径。"
      : "本机不建议运行 MiniMax H3：当前硬件低于量化实验配置。",
    recommendations
  };
}

export function estimateLocalRuntime(
  input: Pick<EnvironmentReport, "gpus" | "memoryTotalBytes">
): LocalRuntimeEstimate[] {
  const nvidia = input.gpus.filter((gpu) => /nvidia/i.test(`${gpu.vendor} ${gpu.model}`));
  const totalVram = nvidia.reduce((sum, gpu) => sum + gpu.vramBytes, 0);
  const appleDescription = input.gpus.map((gpu) => `${gpu.vendor} ${gpu.model}`).join(" ");
  const isAppleMax = /apple.*(?:m[1-9].*)?max/i.test(appleDescription);

  if (nvidia.length >= 2 && totalVram >= 48 * GiB) {
    return runtimeRanges([10, 25], [45, 120], "medium", "多卡通信、工作流和参考素材会明显影响速度。");
  }
  if (totalVram >= 24 * GiB) {
    return runtimeRanges([6, 15], [35, 90], "high", "2K 会触发显存卸载，实际时间可能继续增加。");
  }
  if (totalVram >= 16 * GiB) {
    return runtimeRanges([10, 25], [60, 150], "high", "需要 INT8/AWQ 与动态显存卸载；2K 有失败风险。");
  }
  if (totalVram >= 12 * GiB) {
    return runtimeRanges([15, 40], [120, 300], "very_high", "仅建议量化预检；2K 很可能内存溢出。");
  }
  if (isAppleMax && input.memoryTotalBytes >= 64 * GiB) {
    return runtimeRanges([45, 90], [180, 360], "very_high", "MPS 路径未经充分验证；2K 可能失败，且会长时间占满统一内存。");
  }
  if (/apple/i.test(appleDescription) && input.memoryTotalBytes >= 48 * GiB) {
    return runtimeRanges([60, 150], [300, 720], "very_high", "MPS 路径未经充分验证；2K 极易进入交换内存或失败。");
  }
  return runtimeRanges([120, 360], [480, 1_440], "very_high", "当前设备缺少合适的 CUDA 显卡，运行可能失败而无法产出视频。");
}

function runtimeRanges(
  hd: [number, number],
  twoK: [number, number],
  risk: LocalRuntimeEstimate["risk"],
  note: string
): LocalRuntimeEstimate[] {
  return [
    { resolution: "720P", minMinutes: hd[0], maxMinutes: hd[1], risk, note },
    { resolution: "2K", minMinutes: twoK[0], maxMinutes: twoK[1], risk: risk === "medium" ? "high" : "very_high", note }
  ];
}

export function estimateCloudCost(resolution: "768P" | "2K", duration: number, count: number): number {
  const perSecond = resolution === "2K" ? 0.13 : 0.08;
  return Number((perSecond * duration * count).toFixed(2));
}
