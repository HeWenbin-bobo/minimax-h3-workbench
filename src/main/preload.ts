import { contextBridge, ipcRenderer } from "electron";
import type { LlmDoneEvent, LlmStreamEvent, WorkbenchApi } from "../shared/types";

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: WorkbenchApi = {
  getSettings: () => invoke("settings:get"),
  updateSettings: (patch) => invoke("settings:update", patch),
  setSecret: (name, value) => invoke("secret:set", name, value),
  hasSecret: (name) => invoke("secret:has", name),
  selectDirectory: () => invoke("dialog:directory"),
  selectFile: (kind) => invoke("dialog:file", kind),
  inspectEnvironment: () => invoke("environment:inspect"),
  checkForUpdates: () => invoke("update:check"),
  downloadAndInstallUpdate: () => invoke("update:download-install"),
  checkLocalModels: () => invoke("models:check"),
  getResourceLinks: () => invoke("resources:list"),
  testBackend: (kind) => invoke("backend:test", kind),
  listTasks: () => invoke("tasks:list"),
  submitGeneration: (request) => invoke("tasks:submit", request),
  cancelTask: (taskId) => invoke("tasks:cancel", taskId),
  retryTask: (taskId) => invoke("tasks:retry", taskId),
  setTaskCategory: (taskId, category) => invoke("tasks:setCategory", { taskId, category }),
  deleteTasks: (taskIds) => invoke("tasks:delete", taskIds),
  restoreTasks: (taskIds) => invoke("tasks:restore", taskIds),
  purgeTasks: (taskIds) => invoke("tasks:purge", taskIds),
  listDeletedTasks: () => invoke("tasks:listDeleted"),
  showItem: (filePath) => invoke("shell:showItem", filePath),
  openExternal: (url) => invoke("shell:openExternal", url),
  chatLlm: (messages, webSearch) => invoke("llm:chat", messages, webSearch),
  abortLlm: () => invoke("llm:abort"),
  readAttachment: (path) => invoke("attachment:read", path),
  listLlmModels: () => invoke("llm:models"),
  testLlm: () => invoke("llm:test"),
  onLlmChunk: (listener) => subscribe<LlmStreamEvent>("llm:chunk", listener),
  onLlmDone: (listener) => subscribe<LlmDoneEvent>("llm:done", listener),
  onTaskUpdate: (listener) => subscribe("task:update", listener)
};

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("h3", api);
