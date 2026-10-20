import { contextBridge, ipcRenderer } from "electron";
import type { CompactionEvent, LlmArtifactEvent, LlmDoneEvent, LlmPlanEvent, LlmQuestionEvent, LlmStreamEvent, LlmTasksEvent, LlmToolEvent, WorkbenchApi } from "../shared/types";

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
  saveArtifact: (sessionId, name, content, kind) => invoke("artifact:save", { sessionId, name, content, kind }),
  readArtifactText: (filePath) => invoke("artifact:read", filePath),
  purgeSessionArtifacts: (sessionId) => invoke("artifact:purgeSession", sessionId),
  openExternal: (url) => invoke("shell:openExternal", url),
  focusWindow: () => invoke("window:focus"),
  chatLlm: (messages, webSearch, agent, sessionId, browserSearch, planMode) => invoke("llm:chat", messages, webSearch, Boolean(agent), String(sessionId || ""), Boolean(browserSearch), planMode),
  checkAgentFrameworkUpdate: () => invoke("update:checkFramework"),
  abortLlm: (sessionId) => invoke("llm:abort", sessionId),
  readAttachment: (path) => invoke("attachment:read", path),
  getContextStatus: (messages, sessionId) => invoke("llm:context-status", messages, sessionId),
  compactContext: (messages, sessionId) => invoke("llm:compact", messages, sessionId),
  listLlmModels: () => invoke("llm:models"),
  testLlm: () => invoke("llm:test"),
  onLlmChunk: (listener) => subscribe<LlmStreamEvent>("llm:chunk", listener),
  onLlmDone: (listener) => subscribe<LlmDoneEvent>("llm:done", listener),
  onLlmTasks: (listener) => subscribe<LlmTasksEvent>("llm:tasks", listener),
  onLlmTool: (listener) => subscribe<LlmToolEvent>("llm:tool", listener),
  onLlmCompaction: (listener) => subscribe<CompactionEvent>("llm:compaction", listener),
  onLlmPlan: (listener) => subscribe<LlmPlanEvent>("llm:plan", listener),
  onLlmArtifact: (listener) => subscribe<LlmArtifactEvent>("llm:artifact", listener),
  onLlmQuestion: (listener) => subscribe<LlmQuestionEvent>("llm:question", listener),
  answerLlmQuestion: (requestId, answers) => invoke("llm:answer", requestId, answers),
  skipLlmQuestion: (requestId) => invoke("llm:skip-question", requestId),
  pendingQuestion: (sessionId) => invoke("llm:pending-question", sessionId),
  onUpdateProgress: (listener) => subscribe("update:progress", listener),
  onTaskUpdate: (listener) => subscribe("task:update", listener)
};

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("h3", api);
