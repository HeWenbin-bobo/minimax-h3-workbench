import { readFile } from "node:fs/promises";
import net, { type Server } from "node:net";
import { Client, type ConnectConfig } from "ssh2";
import type { AppSettings } from "../../shared/types";

export class SshTunnel {
  private client?: Client;
  private server?: Server;
  private localPort?: number;
  private observedFingerprint = "";
  /** 本地已接受的连接：隧道断开时要把它们一起销毁，否则调用方会卡在一个不转发任何数据的死连接上。 */
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly config: AppSettings["ssh"], private readonly password: string) {}

  /** 当前连接实测到的主机指纹（hostVerifier 里记录）。未连接时为空串。 */
  get fingerprint(): string {
    return this.observedFingerprint;
  }

  async start(): Promise<{ url: string; fingerprint: string }> {
    if (this.client && this.server && this.localPort) {
      return { url: `http://127.0.0.1:${this.localPort}`, fingerprint: this.observedFingerprint };
    }
    if (!this.config.host || !this.config.username) throw new Error("请填写 SSH 主机和用户名。 ");
    // **握手失败必须把 client 清掉**。
    //
    // 旧实现在这里就 `this.client = new Client()`，而 `once("error", reject)` 在握手失败时
    // 会被这次错误**消耗掉**。于是失败后字段上留下一个"既没连上、也没有 error 监听器"的 client：
    // ① 下一次 start() 会看到 `this.client` 非空（但 server/localPort 为空，故不会误返回旧端口），
    //    于是把旧 client 覆盖掉——旧实例的后续事件没人收，但也不会崩；
    // ② 更糟的是**上次遗留的 client 仍可能在重连超时后 emit error**，
    //    而 EventEmitter 在没有监听器时会把 emit 变成同步抛出 → 主进程直接退出。
    // 连接失败本身是可预期路径（主机填错、网络不通），不该带有崩溃风险。
    // 这里先把引用存到局部变量，失败时统一 close 并清空字段。
    const client = new Client();
    this.client = client;
    try {
      const privateKey = this.config.privateKeyPath ? await readFile(this.config.privateKeyPath, "utf8") : undefined;
      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKey,
        password: privateKey ? undefined : this.password || undefined,
        readyTimeout: 15_000,
        hostHash: "sha256",
        hostVerifier: (fingerprint: string) => {
          this.observedFingerprint = fingerprint;
          return !this.config.hostFingerprint || this.config.hostFingerprint === fingerprint;
        }
      };
      await new Promise<void>((resolve, reject) => {
        // 失败分支也要**常驻**一个 error 监听器：握手失败后这个 client 仍可能再 emit error
        // （SSH 层可能先把 ECONNREFUSED 报成 error，再报 close/error），
        // 而 `once` 已被消耗 → 第二次就是未捕获异常。
        const onError = (error: Error) => { reject(error); };
        client.once("ready", resolve);
        client.on("error", onError);
        try {
          client.connect(connectConfig);
        } catch (error) {
          client.off("error", onError);
          reject(error);
        }
      });
    } catch (error) {
      // 失败收尾：断开半开连接、摘掉监听器并清空字段，让下一次 start() 从干净状态重来。
      client.end();
      this.client = undefined;
      throw error;
    }
    // ready 之后必须**常驻**一个 error 监听器。
    //
    // 握手期挂的 `onError` 已经在上面（它只会 reject 一个已 resolve 的 Promise，无副作用），
    // 而连接中途断开时 ssh2 会 emit 'error'——没有常驻监听器的话，
    // EventEmitter 会把 emit 变成同步抛出，**整个主进程直接崩掉**。
    // 实测复现过：SSH 连接中途断开即命中。
    // **监听器必须绑定到这一次的 client**：旧写法直接写 `() => this.drop()`，而 drop()
    // 作用于对象自身的字段。旧连接被 close() 之后，它的 'close' 事件（TCP FIN 是异步到达的）
    // 若在新隧道已经建好之后才到，就会把**新隧道**一起拆掉——用户看到"刚重连上又断了"，
    // 而且下一次请求拿到的是"SSH 尚未连接"。只在字段仍指向本次 client 时才收尾。
    const onDown = () => { if (this.client === client) this.drop(); };
    client.on("error", onDown);
    client.on("close", onDown);
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      // **不能在这里用 `this.client!`**。`close()` 会把字段清空，而已经进入 accept 队列
      // 的连接仍可能在此之后被回调——断言成非空的话 `forwardOut` 会抛 TypeError，
      // 且它发生在 net 的 connection 监听器里，**没有任何调用方能接住**：
      // 未捕获异常会把 Electron 主进程直接带走（实测 probe-tunnel-race：
      // 在 connection 回调里对 undefined 调方法，抛出的 TypeError 就是未处理异常）。
      const client = this.client;
      if (!client) { socket.destroy(); return; }
      client.forwardOut(
        socket.remoteAddress || "127.0.0.1",
        socket.remotePort || 0,
        this.config.remoteComfyHost,
        this.config.remoteComfyPort,
        (error, stream) => {
          if (error) return socket.destroy(error);
          stream.on("error", () => socket.destroy());
          socket.pipe(stream).pipe(socket);
        }
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject).listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("SSH 隧道未获得本地端口。 ");
    this.localPort = address.port;
    return { url: `http://127.0.0.1:${this.localPort}`, fingerprint: this.observedFingerprint };
  }

  /**
   * 在远端执行一条命令。
   *
   * **必须带超时**：readyTimeout 只管握手，不管 exec；远端命令挂住（磁盘卡死、NFS 无响应、
   * 命令等待输入）时 stream 永远不触发 close，Promise 永不落定，「测试连接」就一直转圈。
   * 超时后 reject，让调用方走既有的「SSH 不可达」错误分支。
   */
  async exec(command: string, timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
    if (!this.client) throw new Error("SSH 尚未连接。 ");
    return new Promise((resolve, reject) => {
      let settled = false;
      // 超时后必须**主动销毁远端流**。只 reject 不销毁的话，命令仍在远端跑，
      // 而 stream 上的 data 监听器会继续往两个局部字符串里追加——
      // 对 `tail -f` / `journalctl -f` 这类命令是无上限的内存增长，直到进程退出。
      // （本机的 exec 只用于 `nvidia-smi` / `free` / `df`，但命令内容由调用方决定。）
      let stream: (NodeJS.ReadableStream & { destroy?: (error?: Error) => void; stderr?: NodeJS.ReadableStream }) | undefined;
      const teardown = () => {
        try { (stream as { destroy?: (e?: Error) => void } | undefined)?.destroy?.(); } catch { /* 已断开 */ }
        stream = undefined;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        teardown();
        reject(new Error(`SSH 远端命令超过 ${Math.round(timeoutMs / 1000)} 秒未返回。`));
      }, timeoutMs);
      const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        teardown();
        if (error) reject(error);
        else resolve(result!);
      };
      this.client!.exec(command, (error, opened) => {
        if (error) return finish(error);
        stream = opened;
        let stdout = "";
        let stderr = "";
        opened.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        opened.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        opened.on("close", () => finish(undefined, { stdout, stderr }));
        opened.on("error", (streamError: Error) => finish(streamError));
      });
    });
  }

  /**
   * 隧道已断：清掉本地监听与所有挂着的连接。
   *
   * 不清理的后果：`start()` 开头会看到 client/server/localPort 都还在，直接返回那个
   * **已经死掉的**本地端口；ComfyAdapter 随后连上去只会拿到 ECONNREFUSED，
   * 用户看到的是"连接被拒绝"，而真实原因是 SSH 掉线——无从对症。
   */
  private drop(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    // close() 会同步把三个字段清空；这里复用同一套收尾，避免两处状态不一致。
    this.close();
  }

  /**
   * 关闭隧道。
   *
   * 两个细节都必须守：
   * ① **先清字段、再断开**。`client.end()` / `server.close()` 可能同步触发
   *    `close`/`error` 事件 → 监听器调 `drop()` → 再进 `close()`；
   *    若字段还在，就会重复 `end()`（重入），且有无限递归的风险。
   * ② **直接调用 close() 时也要销毁已接受的连接**。`server.close()` 只是停止
   *    接受新连接，已建立的 socket 会继续挂着——应用退出时这些连接不会自己消失。
   *    `drop()` 走的是同一函数，两边行为因此一致。
   */
  close(): void {
    const server = this.server;
    const client = this.client;
    // 先摘掉字段：之后任何由 end/close 触发的回调都会看到"已关闭"并直接返回。
    this.server = undefined;
    this.client = undefined;
    this.localPort = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    server?.close();
    client?.end();
  }
}
