import { execFile } from "node:child_process";
import { promisify } from "node:util";
import si from "systeminformation";
import { classifyEnvironment, pickVolumeForOutput } from "../../shared/capabilities";
import type { EnvironmentReport, GpuInfo } from "../../shared/types";
import { inspectH3Readiness } from "../backends/comfyReadiness";

const execFileAsync = promisify(execFile);

/**
 * 给本地硬件采集加超时。
 *
 * 为什么需要：`systeminformation` 在 Windows 上要调 WMI（显卡、磁盘卷尤其明显），
 * 驱动异常 / WMI 服务卡住时这些 Promise **可能长时间不 resolve**。
 * 而「开始配置检测」是等待返回的 IPC——主进程不返回，渲染端就永久停在
 * 「正在检测…」，用户只能重启应用（违反 CLAUDE.md「外部调用必须自己加超时」）。
 * 超时后用兜底值继续：界面显示"未检测"，比永远转圈诚实得多。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  // 原 Promise 仍可能稍后 reject：必须自己吞掉，否则会变成未处理的 rejection。
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function inspectEnvironment(comfyUrl: string, outputDirectory?: string): Promise<EnvironmentReport> {
  const HARDWARE_TIMEOUT_MS = 10_000;
  const [osInfo, cpu, memory, graphics, fileSystems, comfy, ffmpegAvailable] = await Promise.all([
    withTimeout(si.osInfo(), HARDWARE_TIMEOUT_MS, { distro: "", release: "", arch: process.arch } as Awaited<ReturnType<typeof si.osInfo>>),
    withTimeout(si.cpu(), HARDWARE_TIMEOUT_MS, { brand: "", physicalCores: 0, cores: 0 } as Awaited<ReturnType<typeof si.cpu>>),
    withTimeout(si.mem(), HARDWARE_TIMEOUT_MS, { total: 0, available: 0 } as Awaited<ReturnType<typeof si.mem>>),
    withTimeout(si.graphics(), HARDWARE_TIMEOUT_MS, { controllers: [], displays: [] } as Awaited<ReturnType<typeof si.graphics>>),
    withTimeout(si.fsSize(), HARDWARE_TIMEOUT_MS, [] as Awaited<ReturnType<typeof si.fsSize>>),
    inspectComfy(comfyUrl),
    hasFfmpeg()
  ]);

  // **每个字段都要按"可能缺失/类型不对"处理**。
  //
  // `withTimeout` 只兜住"超时"，兜不住"解析成功但形状不对"：
  // `systeminformation` 在 Windows 上走 WMI，驱动异常/服务半死时可能返回
  // **缺字段的对象**（而不是 reject）。实测（probe-graphics-shape）：
  // `si.graphics()` 若没有 `controllers`，`graphics.controllers.map(...)` 直接抛
  // `TypeError: Cannot read properties of undefined (reading 'map')`，
  // 整份「开始配置检测」失败——用户只看到转圈后一条英文技术错误，
  // 而磁盘/内存/ComfyUI 那几项其实都已经采到了。
  const gpus: GpuInfo[] = (Array.isArray(graphics?.controllers) ? graphics.controllers : []).map((gpu) => ({
    vendor: typeof gpu?.vendor === "string" && gpu.vendor ? gpu.vendor : "Unknown",
    model: typeof gpu?.model === "string" && gpu.model ? gpu.model : "Unknown GPU",
    // `gpu.vram` 单位是 MB。非数字（字符串/undefined/null）统一当 0——
    // `Number("abc") * 1024 * 1024` 是 NaN，会让显存合计变成 NaN，
    // 进而把 classifyEnvironment 的 `totalVram >= 48 GiB` 判成 false（静默降级）。
    vramBytes: Number.isFinite(Number(gpu?.vram)) ? Math.max(0, Number(gpu?.vram)) * 1024 * 1024 : 0
  }));
  // Windows 下 fsSize 的 mount 形如 "C:"，没有 "/"；按输出目录所在卷（其次剩余空间最大卷）报告，避免错报 C 盘。
  const volumes = Array.isArray(fileSystems) ? fileSystems : [];
  const volume = pickVolumeForOutput(volumes, outputDirectory);
  const diskFreeBytes = volume ? Number(volume.size - volume.used) : 0;
  const memoryTotal = Number.isFinite(memory?.total) ? memory.total : 0;
  const capability = classifyEnvironment({
    gpus,
    memoryTotalBytes: memoryTotal,
    diskFreeBytes,
    comfyReachable: comfy.reachable,
    comfyHasH3Nodes: comfy.hasH3Nodes,
    comfyMissingH3Models: comfy.missingModels
  });

  return {
    checkedAt: new Date().toISOString(),
    os: `${osInfo?.distro ?? ""} ${osInfo?.release ?? ""}`.trim(),
    arch: osInfo?.arch ?? process.arch,
    cpu: typeof cpu?.brand === "string" ? cpu.brand : "",
    cpuCores: Number.isFinite(cpu?.physicalCores) && cpu.physicalCores > 0 ? cpu.physicalCores : Number(cpu?.cores) || 0,
    memoryTotalBytes: memoryTotal,
    memoryAvailableBytes: Number.isFinite(memory?.available) ? memory.available : 0,
    diskFreeBytes,
    gpus,
    comfyReachable: comfy.reachable,
    comfyVersion: comfy.version,
    comfyHasH3Nodes: comfy.hasH3Nodes,
    comfyHasH3Models: comfy.hasH3Nodes && comfy.missingModels.length === 0,
    comfyMissingH3Models: comfy.missingModels,
    ffmpegAvailable,
    ...capability
  };
}

async function inspectComfy(baseUrl: string): Promise<{ reachable: boolean; version?: string; hasH3Nodes: boolean; missingModels: string[] }> {
  try {
    const [statsResponse, nodeResponse] = await Promise.all([
      fetch(`${baseUrl.replace(/\/$/, "")}/system_stats`, { signal: AbortSignal.timeout(4_000) }),
      fetch(`${baseUrl.replace(/\/$/, "")}/object_info`, { signal: AbortSignal.timeout(8_000) })
    ]);
    if (!statsResponse.ok || !nodeResponse.ok) return { reachable: false, hasH3Nodes: false, missingModels: [] };
    const stats = (await statsResponse.json()) as { system?: { comfyui_version?: string } };
    const nodes = (await nodeResponse.json()) as Record<string, unknown>;
    const readiness = inspectH3Readiness(nodes);
    return {
      reachable: true,
      version: stats.system?.comfyui_version,
      hasH3Nodes: readiness.hasH3Nodes,
      missingModels: readiness.missingModels.map((item) => item.name)
    };
  } catch {
    return { reachable: false, hasH3Nodes: false, missingModels: [] };
  }
}

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
