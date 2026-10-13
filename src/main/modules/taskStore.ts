import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationTask } from "../../shared/types";

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

export class TaskStore {
  private readonly filePath = path.join(app.getPath("userData"), "tasks.json");
  // 进度更新高频触发 save；串行化写入链，避免并发原子写同一 .tmp 文件在 Windows 上互撞。
  private pending: Promise<void> = Promise.resolve();

  async load(): Promise<GenerationTask[]> {
    try {
      const tasks = JSON.parse(await readFile(this.filePath, "utf8")) as GenerationTask[];
      let changed = false;
      const recovered = tasks.map((task) => {
        if (terminal.has(task.status)) return task;
        changed = true;
        return {
          ...task,
          status: "interrupted" as const,
          updatedAt: new Date().toISOString(),
          message: "应用上次退出时任务尚未完成，请重新提交。"
        };
      });
      if (changed) await this.save(recovered);
      return recovered;
    } catch {
      return [];
    }
  }

  async save(tasks: GenerationTask[]): Promise<void> {
    this.pending = this.pending.then(() => this.write(tasks)).catch(() => undefined);
    return this.pending;
  }

  private async write(tasks: GenerationTask[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    // 这里不按条数截断：淘汰归 GenerationOrchestrator.trimHistory 管（按项目整组淘汰，
    // 且刻意让回收站任务不参与计数以保住"7 天可恢复"承诺）。此处再硬截一次会与那套策略打架——
    // 实测内存 300 条（200 在役 + 100 回收站）只落盘 200 条，重启后 100 条任务凭空消失。
    // 体积上界由 trimHistory（在役 ≤200）与 purgeExpired（回收站 7 天）共同约束。
    await writeFile(temporary, JSON.stringify(tasks, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
