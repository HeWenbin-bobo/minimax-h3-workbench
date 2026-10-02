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
  await autoUpdater.checkForUpdates(); // 先取 latest.yml 缓存，downloadUpdate 才有目标
  await autoUpdater.downloadUpdate();
  autoUpdater.quitAndInstall(false, true); // isSilent=false 保留安装向导；isForceRunAfter=true 装完自动启动
}

export function currentAppVersion(): string {
  return autoUpdater.currentVersion?.format() ?? "";
}

export type { UpdateInfo };
