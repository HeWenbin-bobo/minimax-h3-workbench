import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 模拟 ssh2 的 Client：真实实现同样是 EventEmitter，握手成功后仍会在连接中断时 emit 'error'。
 * 这里只保留 SshTunnel 用到的四个方法。
 */
class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  connected = false;
  ended = false;
  /** 置为 Error 时 `connect()` 立刻 emit 该错误（模拟握手失败）。 */
  static failWith?: Error;
  constructor() {
    super();
    FakeClient.instances.push(this);
  }
  connect() {
    this.connected = true;
    if (FakeClient.failWith) {
      const error = FakeClient.failWith;
      queueMicrotask(() => this.emit("error", error));
      return this;
    }
    queueMicrotask(() => this.emit("ready"));
    return this;
  }
  end() {
    this.ended = true;
  }
  exec(_command: string, callback: (error: Error | undefined, stream: unknown) => void) {
    callback(undefined, Object.assign(new EventEmitter(), { stderr: new EventEmitter() }));
  }
  forwardOut(
    _srcHost: string,
    _srcPort: number,
    _dstHost: string,
    _dstPort: number,
    callback: (error: Error | undefined, stream: unknown) => void
  ) {
    callback(undefined, new EventEmitter());
  }
}

vi.mock("ssh2", () => ({ Client: FakeClient }));

const { SshTunnel } = await import("./sshTunnel");

const config = {
  name: "测试",
  host: "example.com",
  port: 22,
  username: "root",
  privateKeyPath: "",
  hostFingerprint: "",
  remoteComfyHost: "127.0.0.1",
  remoteComfyPort: 8188,
  remoteComfyPath: "~/ComfyUI"
};

describe("SshTunnel 断线处理", () => {
  beforeEach(() => {
    FakeClient.instances = [];
  });

  // 关键回归：握手成功后必须常驻 error 监听器。
  // 旧实现只有 `once("ready").once("error", reject)`——第一次错误被那个已 resolve 的 reject 吞掉，
  // 第二次起没有监听器，EventEmitter 会抛未捕获异常，**整个主进程崩溃**。
  it("握手后 emit error 不抛未捕获异常（可连续多次）", async () => {
    const tunnel = new SshTunnel(config, "pw");
    const { url } = await tunnel.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const client = FakeClient.instances[0];
    expect(client.listenerCount("error")).toBeGreaterThan(0);

    expect(() => client.emit("error", new Error("连接中断"))).not.toThrow();
    // 第二次、第三次也不能抛——只挂一个一次性监听器正是旧 bug 的形态。
    expect(() => client.emit("error", new Error("再次中断"))).not.toThrow();
    tunnel.close();
  });

  // 断线后若仍缓存 localPort，start() 会把一个**已经死掉的**端口交出去，
  // 用户看到的是 ComfyUI "连接被拒绝"，真实原因却是 SSH 掉线。
  it("断线后再 start() 会重建连接，而不是返回已死的端口", async () => {
    const tunnel = new SshTunnel(config, "pw");
    const first = await tunnel.start();
    FakeClient.instances[0].emit("error", new Error("连接中断"));

    const second = await tunnel.start();
    expect(FakeClient.instances).toHaveLength(2);
    expect(second.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // 端口可能被系统复用，断言"确实重建了连接"比断言端口不同更可靠。
    expect(FakeClient.instances[1].connected).toBe(true);
    expect(FakeClient.instances[0].ended).toBe(true);
    expect(first.url).toBeDefined();
    tunnel.close();
  });

  it("close 后 exec 立即报中文错误（不悬挂）", async () => {
    const tunnel = new SshTunnel(config, "pw");
    await tunnel.start();
    tunnel.close();
    await expect(tunnel.exec("echo hi")).rejects.toThrow(/SSH 尚未连接/);
  });

  it("未配置主机时给出中文提示", async () => {
    const tunnel = new SshTunnel({ ...config, host: "" }, "pw");
    await expect(tunnel.start()).rejects.toThrow(/请填写 SSH 主机和用户名/);
  });

  // 握手失败是可预期路径（主机填错、网络不通）。旧实现把失败的 client 留在字段上，
  // 而它的 `once("error", reject)` 已被那次失败消耗掉——之后同一实例再 emit error
  // 就是一个无监听器的 emit（EventEmitter 会同步抛出 → 主进程退出）。
  // 这里锁定两件事：失败后状态干净、后续 start() 能重建，且遗留实例再报错不会崩。
  it("握手失败后清理 client，且遗留实例再 emit error 不抛未捕获异常", async () => {
    FakeClient.failWith = new Error("connect ECONNREFUSED");
    try {
      const tunnel = new SshTunnel(config, "pw");
      await expect(tunnel.start()).rejects.toThrow(/ECONNREFUSED/);
      const failed = FakeClient.instances[0];
      expect(failed.ended).toBe(true); // 半开连接被主动断开
      // 字段已清空 → 下一次 start() 会建**新的** client，而不是复用失败实例。
      FakeClient.failWith = undefined;
      const { url } = await tunnel.start();
      expect(FakeClient.instances).toHaveLength(2);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // 遗留实例迟到的 error 不应打崩进程（失败分支必须留常驻监听器）。
      expect(() => failed.emit("error", new Error("迟到的错误"))).not.toThrow();
      tunnel.close();
    } finally {
      FakeClient.failWith = undefined;
    }
  });
});
