import { describe, expect, it } from "vitest";
import { resolveDimensions } from "./dimensions";

describe("resolveDimensions", () => {
  // 回归护栏：此前 width/height 自初始值 1280×720 起再没变过，
  // 界面选 9:16 或 2K 都不生效（两个下拉只改 ratio/resolution 字符串）。
  it("768P 常用画幅按短边 720 计算", () => {
    expect(resolveDimensions("16:9", "768P")).toEqual({ width: 1280, height: 720 });
    expect(resolveDimensions("4:3", "768P")).toEqual({ width: 960, height: 720 });
    expect(resolveDimensions("1:1", "768P")).toEqual({ width: 720, height: 720 });
  });

  it("竖屏画幅把短边放在宽度上", () => {
    expect(resolveDimensions("9:16", "768P")).toEqual({ width: 720, height: 1280 });
    expect(resolveDimensions("3:4", "768P")).toEqual({ width: 720, height: 960 });
  });

  it("2K 使用短边 1440", () => {
    expect(resolveDimensions("16:9", "2K")).toEqual({ width: 2560, height: 1440 });
    expect(resolveDimensions("9:16", "2K")).toEqual({ width: 1440, height: 2560 });
  });

  it("宽高始终是 8 的倍数（视频模型的对齐要求）", () => {
    for (const ratio of ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] as const) {
      for (const resolution of ["768P", "2K"] as const) {
        const { width, height } = resolveDimensions(ratio, resolution);
        expect(width % 8, `${ratio}@${resolution} width=${width}`).toBe(0);
        expect(height % 8, `${ratio}@${resolution} height=${height}`).toBe(0);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
      }
    }
  });

  // adaptive 是 MiniMax 云端"跟随素材"的语义；本地工作流没有这个能力，
  // 落到最常用的 16:9 而不是算出 NaN。
  it("adaptive 回落 16:9", () => {
    expect(resolveDimensions("adaptive", "768P")).toEqual({ width: 1280, height: 720 });
  });

  it("21:9 不会算出小于短边的边长", () => {
    const { width, height } = resolveDimensions("21:9", "768P");
    expect(height).toBe(720);
    expect(width).toBeGreaterThan(1280);
  });
});
