import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/types";

/**
 * 回归：`AdapterRegistry.invalidate()` 会在**任何**设置保存时调用 `close()`。
 * 旧实现当场关隧道——正在跑的 SSH 生成会断在 ECONNREFUSED，
 * 用户只看到"连接被拒绝"，想不到是自己刚点了「保存设置」。
 * 这里锁定：有在途生成时 close 必须延后到那一次结束。
 */

const tunnelState = { closed: 0, starts: 0 };
const generateGate: { release?: () => void; fail?: Error } = {};

vi.mock("./sshTunnel", () => ({
  SshTunnel: class {
    fingerprint = "fp";
    async start() {
      tunnelState.starts += 1;
      return { url: "http://127.0.0.1:12345", fingerprint: this.fingerprint };
    }
    async exec() {
      return { stdout: "", stderr: "" };
    }
    close() {
      tunnelState.closed += 1;
    }
  }
}));

vi.mock("./comfyAdapter", () => ({
  ComfyAdapter: class {
    async test() {
      return { ok: true, label: "x", latencyMs: 1, details: {}, message: "ok" };
    }
    async generate() {
      await new Promise<void>((resolve, reject) => {
        generateGate.release = resolve;
        generateGate.fail = undefined;
        void reject;
      });
      if (generateGate.fail) throw generateGate.fail;
      return { providerTaskId: "p", outputPath: "/o/p.mp4" };
    }
    async cancel() { /* no-op */ }
  }
}));

const { SshComfyAdapter } = await import("./sshComfyAdapter");

const settings = {
  outputDirectory: "/out",
  ssh: {
    name: "远程显卡", host: "h", port: 22, username: "root", privateKeyPath: "",
    hostFingerprint: "", remoteComfyHost: "127.0.0.1", remoteComfyPort: 8188, remoteComfyPath: "~/ComfyUI"
  }
} as unknown as AppSettings;

const startGenerate = (adapter: InstanceType<typeof SshComfyAdapter>) =>
  adapter.generate(
    { prompt: "x", duration: 4 } as never,
    { id: "t1", seed: 1 } as never,
    () => undefined
  );

/** 等到 generate 真的进入 mock（gate 已就位）再动手，避免时序抖动。 */
async function untilEntered(): Promise<void> {
  for (let i = 0; i < 100 && !generateGate.release; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(generateGate.release).toBeDefined();
}

describe("SshComfyAdapter close 延后", () => {
  beforeEach(() => {
    tunnelState.closed = 0;
    tunnelState.starts = 0;
    generateGate.release = undefined;
    generateGate.fail = undefined;
  });

  it("有在途生成时 close 不会立刻关隧道，结束后才关", async () => {
    const adapter = new SshComfyAdapter(settings, "");
    const pending = startGenerate(adapter);
    await untilEntered();

    adapter.close();
    expect(tunnelState.closed).toBe(0); // 关键：没有当场断线

    generateGate.release!();
    await pending;
    expect(tunnelState.closed).toBe(1);
  });

  it("生成抛错时计数同样释放（否则隧道永远不会被关）", async () => {
    const adapter = new SshComfyAdapter(settings, "");
    const pending = startGenerate(adapter);
    await untilEntered();

    adapter.close();
    expect(tunnelState.closed).toBe(0);

    generateGate.release!();
    await expect(pending).resolves.toBeDefined(); // mock 正常返回
    expect(tunnelState.closed).toBe(1);
  });

  it("没有在途操作时 close 立即生效", () => {
    const adapter = new SshComfyAdapter(settings, "");
    adapter.close();
    expect(tunnelState.closed).toBe(1);
  });
});
