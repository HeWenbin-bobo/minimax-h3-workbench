import { describe, expect, it } from "vitest";
import { classifyEnvironment, estimateCloudCost, estimateLocalRuntime, pickVolumeForOutput } from "./capabilities";

const GiB = 1024 ** 3;

describe("classifyEnvironment", () => {
  it("recommends SSH or cloud when there is no NVIDIA GPU", () => {
    const result = classifyEnvironment({
      gpus: [{ vendor: "Apple", model: "M4", vramBytes: 32 * GiB }],
      memoryTotalBytes: 32 * GiB,
      diskFreeBytes: 100 * GiB,
      comfyReachable: false,
      comfyHasH3Nodes: false
    });
    expect(result.grade).toBe("D");
    expect(result.recommendations.join(" ")).toContain("SSH");
    expect(result.verdict).toContain("本机不建议运行");
  });

  it("classifies a 24GB NVIDIA workstation as an experimental local path", () => {
    const result = classifyEnvironment({
      gpus: [{ vendor: "NVIDIA", model: "RTX 4090", vramBytes: 24 * GiB }],
      memoryTotalBytes: 64 * GiB,
      diskFreeBytes: 100 * GiB,
      comfyReachable: true,
      comfyHasH3Nodes: true
    });
    expect(result.grade).toBe("C");
  });
});

describe("estimateLocalRuntime", () => {
  it("shows high-risk 720P and 2K ranges for an Apple M3 Max with 64GB memory", () => {
    const estimates = estimateLocalRuntime({
      gpus: [{ vendor: "Apple", model: "Apple M3 Max", vramBytes: 0 }],
      memoryTotalBytes: 64 * GiB
    });
    expect(estimates).toEqual([
      expect.objectContaining({ resolution: "720P", minMinutes: 45, maxMinutes: 90, risk: "very_high" }),
      expect.objectContaining({ resolution: "2K", minMinutes: 180, maxMinutes: 360, risk: "very_high" })
    ]);
  });

  it("gives a faster but still cautious range to a 24GB NVIDIA GPU", () => {
    const estimates = estimateLocalRuntime({
      gpus: [{ vendor: "NVIDIA", model: "RTX 4090", vramBytes: 24 * GiB }],
      memoryTotalBytes: 64 * GiB
    });
    expect(estimates[0]).toMatchObject({ resolution: "720P", minMinutes: 6, maxMinutes: 15 });
    expect(estimates[1]).toMatchObject({ resolution: "2K", minMinutes: 35, maxMinutes: 90 });
  });
});

describe("estimateCloudCost", () => {
  it("scales with duration and output count", () => {
    expect(estimateCloudCost("768P", 10, 4)).toBe(3.2);
    expect(estimateCloudCost("2K", 10, 4)).toBe(5.2);
  });
});

describe("pickVolumeForOutput", () => {
  const volumes = [
    { mount: "C:", size: 500 * GiB, used: 480 * GiB }, // 20GB 剩余
    { mount: "F:", size: 1300 * GiB, used: 1000 * GiB } // 300GB 剩余
  ];

  it("picks the volume containing the output directory (case-insensitive Windows drive match)", () => {
    expect(pickVolumeForOutput(volumes, "F:\\Videos\\MiniMax-H3")?.mount).toBe("F:");
    expect(pickVolumeForOutput(volumes, "f:/videos/out")?.mount).toBe("F:");
  });

  it("falls back to the volume with the most free space when the directory is unknown", () => {
    expect(pickVolumeForOutput(volumes, "Z:\\nowhere")?.mount).toBe("F:");
    expect(pickVolumeForOutput(volumes)?.mount).toBe("F:");
  });

  it("returns undefined for an empty volume list", () => {
    expect(pickVolumeForOutput([], "F:\\x")).toBeUndefined();
  });
});

// 磁盘读数未知（fsSize 返回空/异常时 systemInspector 会置 0）不能当成"空间不足"。
// 否则用户会看到「至少释放 70GB 磁盘空间」，而他的磁盘可能一块都没满——
// 假告警比不提示更误导。
describe("classifyEnvironment 磁盘读数未知", () => {
  const base = { gpus: [], memoryTotalBytes: 64 * 1024 ** 3 };

  it("diskFreeBytes = 0 时不报「释放 70GB」", () => {
    const result = classifyEnvironment({ ...base, diskFreeBytes: 0, comfyReachable: false, comfyHasH3Nodes: false });
    expect(result.recommendations.some((r) => r.includes("70GB"))).toBe(false);
  });

  it("真实空间不足（有读数但 < 70GB）时仍然告警", () => {
    const result = classifyEnvironment({ ...base, diskFreeBytes: 20 * 1024 ** 3, comfyReachable: false, comfyHasH3Nodes: false });
    expect(result.recommendations.some((r) => r.includes("70GB"))).toBe(true);
  });

  // 磁盘读不到时不能把一台够用的机器判成 D 级：C 级门槛原来直接比
  // `diskFreeBytes >= 45 GiB`，0 会把它挡在门外，结论变成"当前硬件低于量化实验配置"——
  // 硬件明明够（24GB 显存 + 64GB 内存），结论却正好相反。
  it("磁盘读数未知时仍按硬件判 C 级，并提示自行确认空间", () => {
    const result = classifyEnvironment({
      gpus: [{ vendor: "NVIDIA", model: "RTX 4090", vramBytes: 24 * 1024 ** 3 }],
      memoryTotalBytes: 64 * 1024 ** 3,
      diskFreeBytes: 0,
      comfyReachable: true,
      comfyHasH3Nodes: true
    });
    expect(result.grade).toBe("C");
    expect(result.recommendations.some((r) => r.includes("45GB"))).toBe(true);
  });
});

// 内存读数未知是同一类问题：`si.mem()` 在 Windows 上走 WMI，超时后
// `systemInspector` 的兜底会把它置 0。照常比较的话，够用的机器会被判成 D 级。
describe("classifyEnvironment 内存读数未知", () => {
  it("内存读不到时按显存仍判 C 级，并提示自行确认内存", () => {
    const result = classifyEnvironment({
      gpus: [{ vendor: "NVIDIA", model: "RTX 4090", vramBytes: 24 * 1024 ** 3 }],
      memoryTotalBytes: 0,
      diskFreeBytes: 100 * 1024 ** 3,
      comfyReachable: true,
      comfyHasH3Nodes: true
    });
    expect(result.grade).toBe("C");
    expect(result.recommendations.some((r) => r.includes("内存"))).toBe(true);
  });

  it("内存读数正常但确实不足时仍判 D 级（不误放行）", () => {
    const result = classifyEnvironment({
      gpus: [{ vendor: "NVIDIA", model: "RTX 4090", vramBytes: 24 * 1024 ** 3 }],
      memoryTotalBytes: 8 * 1024 ** 3,
      diskFreeBytes: 100 * 1024 ** 3,
      comfyReachable: true,
      comfyHasH3Nodes: true
    });
    expect(result.grade).toBe("D");
  });
});

// 显卡读不到（`si.graphics()` 走 WMI、超时兜底返回空列表）时，
// 结论不能写成「当前硬件低于量化实验配置」——那是把"没读到"当成"不够"。
describe("classifyEnvironment 显卡读数未知", () => {
  it("读不到显卡时不给出「硬件低于配置」的结论，并提示重新检测", () => {
    const result = classifyEnvironment({
      gpus: [],
      memoryTotalBytes: 64 * 1024 ** 3,
      diskFreeBytes: 100 * 1024 ** 3,
      comfyReachable: false,
      comfyHasH3Nodes: false
    });
    expect(result.verdict).not.toContain("低于量化实验配置");
    expect(result.verdict).toContain("未能读取到显卡信息");
    expect(result.recommendations.some((r) => r.includes("未能读取显卡信息"))).toBe(true);
  });

  it("有显卡读数但确实不达标时仍给「硬件低于配置」", () => {
    const result = classifyEnvironment({
      gpus: [{ vendor: "Intel", model: "UHD 630", vramBytes: 1024 ** 3 }],
      memoryTotalBytes: 16 * 1024 ** 3,
      diskFreeBytes: 100 * 1024 ** 3,
      comfyReachable: false,
      comfyHasH3Nodes: false
    });
    expect(result.verdict).toContain("当前硬件低于量化实验配置");
  });
});
