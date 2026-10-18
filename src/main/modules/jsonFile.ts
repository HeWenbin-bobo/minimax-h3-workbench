import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 「读-改-写」类配置文件的读取与损坏备份。
 *
 * 三条纪律（都是实测/安全审查踩出来的）：
 *
 * ① **读取失败要先重试**。Windows 上杀毒软件扫描新写入的文件会短暂持有句柄，
 *    此时 `readFile` 抛 `EBUSY`/`EACCES`/`EPERM`，几十毫秒后即可正常读取。
 *    不重试就会把"一次瞬时占用"升级成"配置读不到"。
 *
 * ② **重试仍失败必须备份，不能只返回默认值**。调用方（`SettingsStore.get/update`、
 *    `TaskStore.load/save`）都是读-改-写：读失败返回默认值后，下一次写盘会把
 *    「默认值 + 本次改动」整份落盘，**用户原有的配置/任务历史/密钥被永久抹掉**。
 *    把原文件改名成 `<文件名>.corrupt-<时间戳>` 既保住数据，也让下次启动不再踩同一个坏文件。
 *
 * ③ **ENOENT 不备份**。文件本来就不存在才是"确实没有配置"，此时改名毫无意义。
 */

const IO_ERROR_CODES = new Set(["EBUSY", "EACCES", "EPERM", "EMFILE", "ENFILE"]);

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 读取并解析 JSON 文件。
 *
 * @param attempts I/O 类错误的尝试次数（含首次）。默认 3 次，间隔 60ms。
 *                 **解析错误（SyntaxError）不重试**——内容坏了，重试不会变好。
 */
export async function readJsonFile<T>(filePath: string, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error) {
      const code = errnoOf(error);
      const retryable = code !== undefined && IO_ERROR_CODES.has(code) && attempt < attempts;
      if (!retryable) throw error;
      await delay(60);
    }
  }
}

/**
 * 读取失败后的收尾：非 ENOENT 一律备份原文件并记录日志。
 *
 * 不管是"内容损坏（SyntaxError）"还是"重试后仍读不到（I/O 错误）"，
 * 只要读不出来就不能让后续写盘覆盖它——两种情况都备份。
 */
export async function backupCorruptFile(filePath: string, error: unknown, tag: string): Promise<void> {
  if (errnoOf(error) === "ENOENT") return;
  const backup = `${filePath}.corrupt-${Date.now()}`;
  const renamed = await rename(filePath, backup).then(() => true, () => false);
  console.error(
    `[${tag}] ${path.basename(filePath)} 读取失败${renamed ? `，已备份为 ${path.basename(backup)}` : "（备份失败，未改动原文件）"}：`,
    error instanceof Error ? error.message : error
  );
}
