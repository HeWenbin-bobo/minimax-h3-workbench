import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateInfo } from "../../shared/types";

export interface DownloadProgressInfo {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
}

type ProgressListener = (info: DownloadProgressInfo) => void;

const listeners = new Set<ProgressListener>();

let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false; // 用户点“立即更新”才开始下载，避免后台偷偷拉 100MB+ 安装包
  // **必须常驻 error 监听器**：electron-updater 的 `dispatchError()` 走的是
  // `this.emit("error", e, …)`。EventEmitter 在没有任何 error 监听器时会把 emit 变成
  // 同步抛出——而 `checkForUpdates()` 的 catch 里就调它（AppUpdater.js:271），
  // `doInstall()` 也在 try/catch 外调。那等于把"更新检查失败"升级成未捕获异常。
  // 这里只记录，真正的错误仍由各调用点的返回值/异常路径呈现给用户。
  autoUpdater.on("error", (error) => {
    console.warn("[update] 更新器错误：", error instanceof Error ? error.message : String(error));
  });
  autoUpdater.on("download-progress", (progress) => {
    const info = { percent: progress.percent, transferredBytes: progress.transferred, totalBytes: progress.total };
    for (const listener of listeners) listener(info);
  });
}

export function onDownloadProgress(listener: ProgressListener): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// electron-updater 直接读取 GitHub Releases（package.json 的 build.win.publish 配置），
// 与 updateChecker.checkForUpdates 共用同一个仓库地址。
export async function downloadAndInstall(): Promise<void> {
  if (!app.isPackaged) throw new Error("开发模式下不支持应用内更新，请运行 npm run package:win 打包后测试。");
  wire();
  const checked = await autoUpdater.checkForUpdates(); // 先取 latest.yml 缓存，downloadUpdate 才有目标
  // `checkForUpdates()` 在"已是最新版本"时返回 null。此时继续 downloadUpdate 会抛
  // electron-updater 的英文内部错误 "Please check update first"——用户看到的是
  // 一句与当前动作完全对不上的技术文案（他明明点的是"立即更新"）。
  if (!checked) throw new Error("当前已是最新版本，无需更新。");
  await autoUpdater.downloadUpdate();
  autoUpdater.quitAndInstall(false, true); // isSilent=false 保留安装向导；isForceRunAfter=true 装完自动启动
}

export function currentAppVersion(): string {
  return autoUpdater.currentVersion?.format() ?? "";
}

export type { UpdateInfo };
