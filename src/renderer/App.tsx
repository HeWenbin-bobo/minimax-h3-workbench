import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiResponse, AppSettings, BackendKind, BackendTestResult, ChatMessage, EnvironmentReport, GenerationMode, GenerationRequest, GenerationTask, LlmStreamEvent, LocalModelStatus, ResourceLink, UpdateInfo } from "../shared/types";
import { LLM_PROVIDERS } from "../shared/types";
import { estimateCloudCost, estimateLocalRuntime } from "../shared/capabilities";
import { renderMarkdown } from "./markdown";

type Page = "ready" | "studio" | "playground" | "downloads" | "guide" | "connections";
const pages: Array<{ id: Page; label: string; eyebrow: string }> = [
  { id: "ready", label: "就绪检测", eyebrow: "CHECK" }, { id: "studio", label: "生成工作台", eyebrow: "CREATE" },
  { id: "playground", label: "游乐场", eyebrow: "PLAY" }, { id: "downloads", label: "模型下载", eyebrow: "MODELS" },
  { id: "guide", label: "配置指南", eyebrow: "GUIDE" },
  { id: "connections", label: "连接设置", eyebrow: "CONNECT" }
];
const demoPrompt = "Create a cinematic 4-second product-style video of a translucent glass sphere floating above a reflective black surface, glowing with a magenta-to-orange gradient and violet-blue rim light. The sphere slowly rotates while fine particles orbit it, then emits one soft pulse of light. Minimal futuristic studio, premium AI technology aesthetic, smooth dolly-in, crisp details, no text, no logos, no people, native ambient stereo sound.";
const initialRequest: GenerationRequest = { mode: "text", backend: "local", prompt: demoPrompt, duration: 4, ratio: "16:9", resolution: "768P", width: 1280, height: 720, count: 4, baseSeed: Math.floor(Math.random() * 1_000_000) };

export function App() {
  const [page, setPage] = useState<Page>("ready");
  const [settings, setSettings] = useState<AppSettings>();
  const [report, setReport] = useState<EnvironmentReport>();
  const [resources, setResources] = useState<ResourceLink[]>([]);
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [detecting, setDetecting] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installing, setInstalling] = useState(false);
  const showError = (error: unknown) => setNotice({ text: error instanceof Error ? error.message : String(error || "操作失败"), error: true });

  useEffect(() => {
    Promise.all([window.h3.getSettings(), window.h3.getResourceLinks(), window.h3.listTasks()])
      .then(([s, r, t]) => { if (s.data) setSettings(s.data); if (r.data) setResources(r.data); if (t.data) setTasks(t.data); }).catch(showError);
    const offTask = window.h3.onTaskUpdate((item) => setTasks((all) => upsert(all, item)));
    window.h3.checkForUpdates().then((response) => {
      if (!response.data) return;
      setUpdateInfo(response.data);
      if (response.data.updateAvailable) setNotice({ text: `发现新版本 v${response.data.latestVersion}，点击左下角“下载更新”即可安装。` });
    }).catch(() => undefined);
    return () => { offTask(); };
  }, []);

  // 生成完成/失败系统通知：应用最小化或在后台时用户也能第一时间知道结果。
  const tasksRef = useRef<GenerationTask[]>([]);
  useEffect(() => {
    const prev = tasksRef.current;
    for (const task of tasks) {
      const before = prev.find((t) => t.id === task.id);
      const entered = (status: GenerationTask["status"]) => before?.status !== status && task.status === status;
      if (entered("succeeded")) {
        const notification = new Notification("MiniMax H3", { body: `视频生成完成：${task.prompt.slice(0, 40)}` });
        notification.onclick = () => window.focus();
      } else if (entered("failed")) {
        const notification = new Notification("MiniMax H3", { body: `生成失败：${task.prompt.slice(0, 40)}（${task.message?.slice(0, 60) || "未知错误"}）` });
        notification.onclick = () => window.focus();
      }
    }
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!report) return;
    const timer = window.setTimeout(() => document.querySelector(".runtime-estimate")?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => window.clearTimeout(timer);
  }, [report]);

  async function detect() {
    setDetecting(true); const response = await window.h3.inspectEnvironment(); setDetecting(false);
    if (response.data) {
      setReport(response.data);
      setNotice({ text: `检测完成：${response.data.verdict}` });
    } else showError(response.message);
  }
  async function update() {
    if (installing) return;
    if (updateInfo?.updateAvailable) {
      setInstalling(true);
      setNotice({ text: "正在后台下载更新，完成后应用将自动重启安装…" });
      const response = await window.h3.downloadAndInstallUpdate();
      setInstalling(false);
      if (!response.ok) showError(response.message);
      return;
    }
    setCheckingUpdate(true);
    const response = await window.h3.checkForUpdates();
    setCheckingUpdate(false);
    if (!response.data) { showError(response.message); return; }
    setUpdateInfo(response.data);
    if (response.data.updateAvailable) {
      setNotice({ text: `发现新版本 v${response.data.latestVersion}，再次点击左下角即可下载。` });
    } else setNotice({ text: `当前已是最新版 v${response.data.currentVersion}` });
  }
  if (!settings) return <div className="splash"><div className="brand-mark">H3</div><p>正在启动工作台…</p></div>;
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">H3</div><div><strong>MiniMax H3</strong><span>视频生成工作台</span></div></div>
      <nav>{pages.map((item) => <button key={item.id} data-page={item.id} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)}><i>{item.eyebrow}</i><span>{item.label}</span></button>)}</nav>
      <button className={`sidebar-update ${updateInfo?.updateAvailable ? "available" : ""}`} onClick={update} disabled={checkingUpdate || installing}>
        <span className="status-dot" /><span><strong>{installing ? "正在下载更新…" : updateInfo?.updateAvailable ? "立即更新" : checkingUpdate ? "正在检查…" : "检查更新"}</strong><small>{installing ? "完成后自动重启" : updateInfo?.updateAvailable ? `v${updateInfo.latestVersion} 可安装` : `轻量版 v${updateInfo?.currentVersion || "0.1.5"}`}</small></span>
      </button></aside>
    <main className="main-area">
      {page === "ready" && <ReadyPage report={report} busy={detecting} onDetect={detect} onNavigate={setPage} />}
      {page === "studio" && <StudioPage settings={settings} tasks={tasks} onError={showError} onNotice={(text) => setNotice({ text })} />}
      {page === "playground" && <PlaygroundPage settings={settings} tasks={tasks} onError={showError} onNotice={(text) => setNotice({ text })} onNavigate={setPage} />}
      {page === "downloads" && <ResourcesPage resources={resources} settings={settings} onSettingsChange={setSettings} />}
      {page === "guide" && <GuidePage />}
      {page === "connections" && <ConnectionsPage settings={settings} setSettings={setSettings} onError={showError} onNotice={(text) => setNotice({ text })} />}
    </main>
    {notice && <button className={`toast ${notice.error ? "error" : ""}`} onClick={() => setNotice(undefined)}>{notice.text}<span>×</span></button>}
  </div>;
}

function ReadyPage({ report, busy, onDetect, onNavigate }: { report?: EnvironmentReport; busy: boolean; onDetect: () => void; onNavigate: (page: Page) => void }) {
  const gb = (value?: number) => value ? `${(value / 1024 ** 3).toFixed(1)} GB` : "未检测";
  const cards = [
    { name: "显卡", value: report?.gpus.map((g) => g.model).join(" / ") || "等待检测", sub: report?.gpus.map((g) => gb(g.vramBytes)).join(" / ") || "GPU 与显存" },
    { name: "内存", value: gb(report?.memoryTotalBytes), sub: report ? `可用 ${gb(report.memoryAvailableBytes)}` : "系统 RAM" },
    { name: "磁盘", value: gb(report?.diskFreeBytes), sub: "模型与输出可用空间" },
    { name: "ComfyUI", value: report?.comfyReachable ? `已连接 ${report.comfyVersion || ""}` : report ? "未连接" : "等待检测", sub: report?.comfyHasH3Nodes ? (report.comfyHasH3Models ? "H3 节点与 5 个模型均已就绪" : `H3 节点正常，缺少 ${report.comfyMissingH3Models.length} 个模型`) : "检测版本、节点与模型" }
  ];
  const runtimeEstimates = report ? estimateLocalRuntime(report) : [];
  return <section className="page ready-page"><header className="hero"><span className="eyebrow">SYSTEM READINESS</span><h1>先判断怎么跑，<br/><em>再开始生成。</em></h1><p>一次检查本机硬件、存储、FFmpeg 和 ComfyUI，给出本地、SSH 或云 API 的明确建议。</p><button className="primary large" onClick={onDetect} disabled={busy}>{busy ? "正在检测…" : "开始配置检测"}</button></header>
    <div className="readiness-grid">{cards.map((card) => <article className="metric-card" key={card.name}><span>{card.name}</span><strong>{card.value}</strong><small>{card.sub}</small></article>)}</div>
    {report && <div className={`verdict grade-${report.grade.toLowerCase()}`}><div className="grade">{report.grade}</div><div><span>{report.grade === "D" ? "本机运行建议" : "推荐路径"}</span><h2>{report.verdict}</h2><ul>{report.recommendations.map((x) => <li key={x}>{x}</li>)}</ul></div></div>}
    {report && <section className={`runtime-estimate ${report.grade === "D" ? "is-force-run" : ""}`}><header><div><span>强行本机运行 · 时间预测</span><h2>单条 5 秒视频预计耗时</h2></div><button className="secondary" onClick={() => onNavigate("studio")}>仍要强行运行</button></header><p>按 20 步、INT8 生成模型与 NVFP4/AWQ 文本编码器估算，包含模型加载与解码。区间不是完成承诺。</p><div className="runtime-estimate-grid">{runtimeEstimates.map((item) => <article key={item.resolution}><span>{item.resolution}</span><strong>{formatRuntimeRange(item.minMinutes, item.maxMinutes)}</strong><small>{item.note}</small></article>)}</div></section>}
    <div className="quick-actions"><button onClick={() => onNavigate("downloads")}><span>01</span><strong>下载模型</strong><small>点击直达官方文件下载</small></button><button onClick={() => onNavigate("connections")}><span>02</span><strong>配置连接</strong><small>本机 ComfyUI / H3 云 API / SSH</small></button><button onClick={() => onNavigate("studio")}><span>03</span><strong>开始生成</strong><small>四路结果并行管理</small></button></div>
  </section>;
}

function StudioPage({ settings, tasks, onError, onNotice }: { settings: AppSettings; tasks: GenerationTask[]; onError: (e: unknown) => void; onNotice: (s: string) => void }) {
  const [request, setRequest] = useState<GenerationRequest>({ ...initialRequest, backend: settings.defaultBackend });
  const [submitting, setSubmitting] = useState(false);
  // 项目化：按 parentId 分组展示历次提交（最新在前），提交后自动切到新项目；支持多项目并行生成。
  const projects = useMemo(() => {
    const groups = new Map<string, GenerationTask[]>();
    for (const task of tasks) {
      const key = task.parentId || task.id;
      const group = groups.get(key);
      if (group) group.push(task); else groups.set(key, [task]);
    }
    return Array.from(groups.values()).sort((a, b) => b[0].createdAt.localeCompare(a[0].createdAt));
  }, [tasks]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const activeProject = projects.find((group) => (group[0].parentId || group[0].id) === activeProjectId) ?? projects[0];
  const isRb = request.backend === "rb";
  const rbPreset = request.preset || (request.firstFramePath && request.lastFramePath ? "tail_frame" : "reference");
  const setRbPreset = (preset: string) => setRequest({ ...request, preset, ...(preset === "easy_15" ? { duration: 15 } : preset === "easy_30" ? { duration: 30 } : { duration: request.duration > 8 ? 8 : request.duration }) });
  // 当前项目的结果格子：格子数跟随项目实际任务数（无项目时回落到表单选择），按 index 对齐。
  const shownCount = Math.max(1, Math.min(4, activeProject?.length || request.count));
  const currentTasks = useMemo(() => {
    const group = activeProject ?? [];
    return Array.from({ length: shownCount }, (_, i) => group.find((task) => task.index === i));
  }, [activeProject, shownCount]);
  async function choose(kind: "image" | "video", field: keyof GenerationRequest) { const response = await window.h3.selectFile(kind); if (response.data) setRequest((r) => ({ ...r, [field]: response.data })); }
  async function submit() {
    setSubmitting(true);
    const response = await window.h3.submitGeneration(request);
    setSubmitting(false);
    if (!response.ok) { onError(response.message); return; }
    // 提交成功：切到新项目（submitGeneration 创建的任务组排在最前）。
    if (response.data?.[0]) setActiveProjectId(response.data[0].parentId);
    onNotice(`已创建 ${request.count} 个生成任务，可继续提交新任务并行生成`);
  }
  const rbDurationOptions = rbPreset === "reference" || rbPreset === "tail_frame" ? [4, 6, 8] : rbPreset === "easy_15" ? [15] : rbPreset === "easy_30" ? [30] : [];
  return <section className="page studio-page"><div className="page-title"><div><span className="eyebrow">CREATE</span><h1>生成工作台</h1></div><div className="backend-pill"><span />{backendLabel(request.backend)}</div></div>
    {projects.length > 0 && <div className="project-tabs">{projects.slice(0, 12).map((group) => {
      const key = group[0].parentId || group[0].id;
      const running = group.some((t) => !["succeeded", "failed", "cancelled", "interrupted"].includes(t.status));
      const done = group.filter((t) => t.status === "succeeded").length;
      const active = activeProject === group;
      return <button key={key} className={`project-tab${active ? " active" : ""}`} onClick={() => setActiveProjectId(key)}>
        <strong>{group[0].prompt.slice(0, 18) || "未命名项目"}</strong>
        <small>{running ? "生成中…" : `${done}/${group.length} 完成`}</small>
        {running && <i className="dot" />}
      </button>;
    })}</div>}
    <div className="studio-layout"><div className="control-panel">
      {!isRb && <div className="mode-tabs">{(["text", "image", "video"] as GenerationMode[]).map((mode) => <button key={mode} className={request.mode === mode ? "active" : ""} onClick={() => setRequest({ ...request, mode })}>{mode === "text" ? "文生视频" : mode === "image" ? "图生视频" : "视频生视频"}</button>)}</div>}
      {isRb && <div className="mode-tabs">{[["reference", "贴合参考图"], ["tail_frame", "首尾过渡"], ["easy_15", "15 秒"], ["easy_30", "30 秒"], ["flashvsr_upscale", "视频变清晰"]].map(([value, label]) => <button key={value} className={rbPreset === value ? "active" : ""} onClick={() => setRbPreset(value)}>{label}</button>)}</div>}
      {isRb && rbPreset === "flashvsr_upscale"
        ? <FilePicker label="源视频（要变清晰的视频）" path={request.sourceVideoPath} onClick={() => choose("video", "sourceVideoPath")} />
        : <>
          <label>视频描述<textarea rows={7} value={request.prompt} onChange={(e) => setRequest({ ...request, prompt: e.target.value })} placeholder="描述主体、动作、镜头、光线与风格…"/><small>{request.prompt.length} / 2000</small></label>
          {!isRb && request.mode === "text" && <div className="frame-row"><FilePicker label="首帧（可选）" path={request.firstFramePath} onClick={() => choose("image", "firstFramePath")} /><FilePicker label="尾帧（可选）" path={request.lastFramePath} onClick={() => choose("image", "lastFramePath")} /></div>}
          {!isRb && request.mode === "image" && <FilePicker label="参考图片" path={request.sourceImagePath} onClick={() => choose("image", "sourceImagePath")} />}
          {!isRb && request.mode === "video" && <FilePicker label="参考视频" path={request.sourceVideoPath} onClick={() => choose("video", "sourceVideoPath")} />}
          {isRb && rbPreset === "reference" && <FilePicker label="参考图片（可选，最多 8 张）" path={request.sourceImagePath} onClick={() => choose("image", "sourceImagePath")} />}
          {isRb && rbPreset === "reference" && <FilePicker label="参考视频（可选）" path={request.sourceVideoPath} onClick={() => choose("video", "sourceVideoPath")} />}
          {isRb && rbPreset === "tail_frame" && <div className="frame-row"><FilePicker label="首帧" path={request.firstFramePath} onClick={() => choose("image", "firstFramePath")} /><FilePicker label="尾帧" path={request.lastFramePath} onClick={() => choose("image", "lastFramePath")} /></div>}
        </>}
      <div className="form-grid"><label>生成后端<select value={request.backend} onChange={(e) => setRequest({ ...request, backend: e.target.value as BackendKind, preset: undefined })}><option value="local">本机 ComfyUI</option><option value="ssh">SSH 远程显卡</option><option value="minimax">MiniMax H3 云 API</option><option value="rb">瞬映 RB 云生成</option></select></label>
        {(!isRb || rbDurationOptions.length > 0) && <label>时长<select value={request.duration} onChange={(e) => setRequest({ ...request, duration: Number(e.target.value) })}>{(!isRb ? [4,6,8,10,12,15] : rbDurationOptions).map((x) => <option key={x} value={x}>{x} 秒</option>)}</select></label>}
        {!isRb && <label>画幅<select value={request.ratio} onChange={(e) => setRequest({ ...request, ratio: e.target.value as GenerationRequest["ratio"] })}>{["16:9","9:16","1:1","4:3","3:4","21:9","adaptive"].map((x) => <option key={x}>{x}</option>)}</select></label>}
        {!isRb && <label>分辨率<select value={request.resolution} onChange={(e) => setRequest({ ...request, resolution: e.target.value as "768P" | "2K" })}><option>768P</option><option>2K</option></select></label>}
        {isRb && (rbPreset === "reference" || rbPreset === "tail_frame") && <label>采样步数<select value={request.samplerSteps || 20} onChange={(e) => setRequest({ ...request, samplerSteps: Number(e.target.value) })}><option value={8}>8（更快）</option><option value={20}>20（更精细）</option></select></label>}
        {isRb && (rbPreset === "reference" || rbPreset === "tail_frame") && <label>补帧<select value={request.interpolate ? "on" : "off"} onChange={(e) => setRequest({ ...request, interpolate: e.target.value === "on" })}><option value="off">关闭</option><option value="on">开启（更流畅）</option></select></label>}
        <label>结果数量<select value={request.count} onChange={(e) => setRequest({ ...request, count: Number(e.target.value) })}>{[1,2,3,4].map((x) => <option key={x} value={x}>{x} 路</option>)}</select></label>
      </div>
      <label>基础随机种子<input type="number" value={request.baseSeed} onChange={(e) => setRequest({ ...request, baseSeed: Number(e.target.value) })}/></label>
      <div className="submit-area"><div>{request.backend === "minimax" ? <><span>云端估算</span><strong>约 ${estimateCloudCost(request.resolution, request.duration, request.count).toFixed(2)} / {request.count} 条</strong></> : request.backend === "rb" ? <><span>云端估算</span><strong>卡密计费 · {request.count} 条消耗 {request.count} 次</strong></> : <><span>本地生成</span><strong>不产生 API 费用</strong></>}</div><button className="primary" disabled={submitting} onClick={submit}>{submitting ? "提交中…" : `生成 ${request.count} 个结果`}</button></div>
    </div><div className={`result-grid${shownCount === 1 ? " single" : ""}`}>{currentTasks.map((task, index) => <TaskCard key={task?.id || index} task={task} index={index} onError={onError} />)}</div></div>
  </section>;
}

function TaskCard({ task, index, onError }: { task?: GenerationTask; index: number; onError: (e: unknown) => void }) {
  const canCancel = task && !["succeeded","failed","cancelled","interrupted"].includes(task.status);
  const canRetry = task && ["failed","cancelled","interrupted"].includes(task.status);
  const bundledMedia = `${import.meta.env.BASE_URL}demo-videos/showcase-0${index + 1}.mp4`;
  const bundledPoster = `${import.meta.env.BASE_URL}demo-videos/showcase-0${index + 1}.jpg`;
  const media = task?.outputPath ? `h3media://local/file?path=${encodeURIComponent(task.outputPath)}` : task ? "" : bundledMedia;
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    if (!task || retrying) return;
    setRetrying(true);
    const response = await window.h3.retryTask(task.id);
    setRetrying(false);
    if (!response.ok) onError(response.message || "重试失败");
  }
  return <article className={`task-card ${task?.status || "ready"}`}>{media ? <video src={media} poster={task ? undefined : bundledPoster} controls preload="metadata" /> : <div className="task-placeholder"><span>0{index + 1}</span><i>{statusLabel(task!.status)}</i></div>}<div className="task-meta"><div><strong>{task ? `Seed ${task.seed}` : `结果 ${index + 1}`}</strong><small>{task?.message || "4 秒 · 480P · 已生成"}</small></div>{task ? <em>{task.progress}%</em> : <em>就绪</em>}</div>{task && <div className="progress"><i style={{ width: `${task.progress}%` }}/></div>}{task?.outputPath && <button className="text-button" onClick={() => window.h3.showItem(task.outputPath!)}>在文件夹中显示</button>}{canRetry && <button className="cancel-button" disabled={retrying} onClick={retry}>{retrying ? "重试中…" : "重试"}</button>}{canCancel && <button className="cancel-button" onClick={() => window.h3.cancelTask(task.id)}>取消</button>}</article>;
}

function ResourcesPage({ resources, settings, onSettingsChange }: { resources: ResourceLink[]; settings: AppSettings; onSettingsChange: (s: AppSettings) => void }) {
  const labels: Record<ResourceLink["category"], string> = { model: "MODEL", comfyui: "APP", workflow: "JSON", docs: "DOCS" };
  const models = resources.filter((item) => item.category === "model");
  const supporting = resources.filter((item) => item.category !== "model");
  const totalSize = models.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
  const [modelStatus, setModelStatus] = useState<LocalModelStatus[]>();
  const [checking, setChecking] = useState(false);
  const root = settings.comfyuiRoot;

  // 已配置目录时进入页面自动检查一次；目录变化时重新检查。
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    setChecking(true);
    window.h3.checkLocalModels().then((response) => {
      if (!cancelled) setModelStatus(response.data ?? []);
    }).catch(() => { if (!cancelled) setModelStatus([]); }).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [root]);

  async function pickRoot() {
    const response = await window.h3.selectDirectory();
    if (!response.data) return;
    const next = { ...settings, comfyuiRoot: response.data };
    onSettingsChange(next);
    await window.h3.updateSettings({ comfyuiRoot: response.data });
    await checkRoot();
  }
  async function checkRoot() {
    setChecking(true);
    const response = await window.h3.checkLocalModels();
    setChecking(false);
    if (response.data) setModelStatus(response.data); else setModelStatus([]);
  }
  const statusById = useMemo(() => new Map((modelStatus ?? []).map((item) => [item.id, item])), [modelStatus]);

  const renderItems = (items: ResourceLink[]) => <div className="download-list">{items.map((item) => {
    const status = item.category === "model" && root ? statusById.get(item.id) : undefined;
    return <article key={item.id}><div className="download-icon">{labels[item.category]}</div><div className="download-info"><span>{item.action === "download" ? `${formatBytes(item.sizeBytes)} · ${item.targetDirectory}` : "官方外部资源"}{status && <em className={status.present ? "model-present" : "model-missing"}>{status.present ? "✓ 已就位" : "✗ 未找到"}</em>}</span><strong>{item.label}</strong><small>{status?.present ? status.fullPath : item.description}</small></div><button className="primary" onClick={() => window.h3.openExternal(item.url)}>{item.action === "download" ? "下载模型 ↓" : "打开官网 ↗"}</button></article>;
  })}</div>;
  return <section className="page"><div className="page-title"><div><span className="eyebrow">OFFICIAL MODELS</span><h1>模型下载</h1></div><button className="secondary" onClick={checkRoot} disabled={!root || checking}>{checking ? "检查中…" : "重新检查"}</button></div>
    <div className="light-note"><strong>本机 ComfyUI 目录</strong><span>指定你自己的 ComfyUI 安装目录后，这里会逐个检查 5 个模型文件是否已放到正确位置。</span></div>
    <div className="input-button comfy-root-row"><input value={root} readOnly placeholder="未指定：请选择 ComfyUI 根目录（含 models 子目录）" /><button onClick={pickRoot}>{root ? "更改目录" : "选择目录"}</button></div>
    {root && modelStatus && <p className="footnote">{modelStatus.filter((m) => m.present).length} / {modelStatus.length} 个模型已就位{modelStatus.every((m) => m.present) ? "，全部就绪 ✅" : "，缺失项点击下方“下载模型”后放入标注目录，然后完全重启 ComfyUI"}</p>}
    <div className="light-note" style={{ marginTop: 16 }}><strong>一键直达下载</strong><span>点击“下载模型”会让默认浏览器直接下载官方文件，不再停在仓库首页。完整五件套约 {formatBytes(totalSize)}，请先确认磁盘空间。</span></div>
    {renderItems(models)}
    <div className="resource-subheading"><span>SUPPORTING RESOURCES</span><h2>其他官方资源</h2></div>
    {renderItems(supporting)}
    <p className="footnote">文件由 Hugging Face 官方仓库直接提供；工作台不代理、不缓存模型。许可证、版本与流量费用以官方页面为准。</p>
  </section>;
}

function GuidePage() { const guides = [
  ["准备 ComfyUI", <>安装或更新到包含 MiniMax H3 原生节点的版本，启动时加入 <code>--listen 127.0.0.1 --port 8188</code>。不要把端口直接暴露到公网。</>],
  ["安装模型", <>在“模型下载”页下载五个官方文件，并按每项标注手动放入 <code>models/diffusion_models</code>、<code>models/text_encoders</code> 或 <code>models/vae</code>，然后完全重启 ComfyUI。</>],
  ["本机连接", <>默认地址为 <code>http://127.0.0.1:8188</code>。先启动 ComfyUI，再测试连接；工作台会同时检查 H3 节点和五个模型文件。</>],
  ["租用显卡 / SSH", <>远端 ComfyUI 监听回环地址。填写主机、账号和私钥；确认并记录 SHA-256 主机指纹。</>],
  ["MiniMax 云 API", <>从 MiniMax 开放平台创建 API Key。密钥只保存在操作系统安全存储中；提交前会显示费用估算。</>],
  ["首尾帧控制", <>文生视频可用提示词、首帧或首尾帧；图生视频需要参考图；视频生视频需要参考视频。</>]
  ]; return <section className="page guide"><div className="page-title"><div><span className="eyebrow">HANDBOOK</span><h1>配置指南</h1></div></div><div className="guide-grid">{guides.map(([title, body], i) => <article key={String(title)}><span>0{i+1}</span><h2>{title}</h2><p>{body}</p></article>)}</div><div className="callout"><strong>遇到 OOM？</strong><span>降低分辨率或时长，关闭其他占显存程序；单卡不足时优先使用 SSH 多卡主机或 MiniMax 云 API。</span></div></section>; }

function ConnectionsPage({ settings, setSettings, onError, onNotice }: { settings: AppSettings; setSettings: (s: AppSettings) => void; onError: (e: unknown) => void; onNotice: (s: string) => void }) {
  const [draft, setDraft] = useState(settings); const [apiKey, setApiKey] = useState(""); const [sshPassword, setSshPassword] = useState(""); const [rbCardCode, setRbCardCode] = useState(""); const [llmKey, setLlmKey] = useState(""); const [searchKey, setSearchKey] = useState(""); const [testing, setTesting] = useState<BackendKind>(); const [results, setResults] = useState<Partial<Record<BackendKind, BackendTestResult>>>({}); const [llmResult, setLlmResult] = useState<BackendTestResult>(); const [llmTesting, setLlmTesting] = useState(false); const [llmModels, setLlmModels] = useState<string[]>(); const [fetchingModels, setFetchingModels] = useState(false);
  const setSsh = (patch: Partial<AppSettings["ssh"]>) => setDraft({ ...draft, ssh: { ...draft.ssh, ...patch } });
  const setLlm = (patch: Partial<AppSettings["llm"]>) => setDraft({ ...draft, llm: { ...draft.llm, ...patch } });
  const setLlmProvider = (provider: string) => {
    const preset = LLM_PROVIDERS.find((p) => p.id === provider);
    // 对话端点由主进程按域名运行时推导（api.minimax.io → 官方私有端点，其余标准 /chat/completions），设置里不存储。
    setDraft({ ...draft, llm: { ...draft.llm, provider, ...(preset && provider !== "custom" ? { baseUrl: preset.baseUrl, model: preset.model } : { baseUrl: preset ? "" : draft.llm.baseUrl }) } });
    setLlmModels(undefined);
  };
  async function save() { try { const saved = await must(window.h3.updateSettings(draft)); if (apiKey) await must(window.h3.setSecret("minimaxApiKey", apiKey)); if (sshPassword) await must(window.h3.setSecret("sshPassword", sshPassword)); if (rbCardCode) await must(window.h3.setSecret("rbCardCode", rbCardCode)); if (llmKey) await must(window.h3.setSecret("llmApiKey", llmKey)); if (searchKey) await must(window.h3.setSecret("searchApiKey", searchKey)); setSettings(saved); setApiKey(""); setSshPassword(""); setRbCardCode(""); setLlmKey(""); setSearchKey(""); onNotice("连接设置已安全保存"); } catch (e) { onError(e); } }
  async function test(kind: BackendKind) { setTesting(kind); const result = await window.h3.testBackend(kind); setTesting(undefined); if (result.data) setResults((r) => ({...r,[kind]:result.data})); else onError(result.message); }
  // LLM 测试：先保存当前草稿（含可能刚输入的 Key），再发最小对话验证全链路。
  async function testLlm() {
    setLlmTesting(true); setLlmResult(undefined);
    try {
      await must(window.h3.updateSettings(draft));
      if (llmKey) await must(window.h3.setSecret("llmApiKey", llmKey));
      const result = await window.h3.testLlm();
      if (result.data) setLlmResult(result.data); else onError(result.message);
    } catch (e) { onError(e); } finally { setLlmTesting(false); }
  }
  // 从上游拉取模型列表：同样先保存草稿与 Key（列表接口需要鉴权）。
  async function fetchModels() {
    setFetchingModels(true);
    try {
      await must(window.h3.updateSettings(draft));
      if (llmKey) await must(window.h3.setSecret("llmApiKey", llmKey));
      const response = await window.h3.listLlmModels();
      if (response.data?.ok) { setLlmModels(response.data.models); onNotice(response.data.message); }
      else onError(new Error(response.data?.message || response.message || "获取模型列表失败"));
    } catch (e) { onError(e); } finally { setFetchingModels(false); }
  }
  return <section className="page connections"><div className="page-title"><div><span className="eyebrow">CONNECT</span><h1>连接设置</h1></div><button className="primary" onClick={save}>保存全部设置</button></div>
    <ConnectionCard title="本机 ComfyUI" badge="LOCAL" result={results.local} onTest={() => test("local")} testing={testing === "local"}><label>服务地址<input value={draft.localComfyUrl} onChange={(e) => setDraft({...draft,localComfyUrl:e.target.value})}/></label><label>输出目录<div className="input-button"><input value={draft.outputDirectory} onChange={(e) => setDraft({...draft,outputDirectory:e.target.value})}/><button onClick={async () => { const x=await window.h3.selectDirectory(); if(x.data)setDraft({...draft,outputDirectory:x.data}); }}>选择</button></div></label></ConnectionCard>
    <ConnectionCard title="MiniMax 云 API" badge="CLOUD" result={results.minimax} onTest={() => test("minimax")} testing={testing === "minimax"}><label>API 地址<input value={draft.minimaxBaseUrl} onChange={(e) => setDraft({...draft,minimaxBaseUrl:e.target.value})}/></label><label>API Key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="已保存的密钥不会回显；留空不修改"/></label></ConnectionCard>
    <ConnectionCard title="瞬映 RB 云生成" badge="RB-CLOUD" result={results.rb} onTest={() => test("rb")} testing={testing === "rb"}><label>API 地址<input value={draft.rbBaseUrl} onChange={(e) => setDraft({...draft,rbBaseUrl:e.target.value})}/></label><label>瞬映卡密<input type="password" value={rbCardCode} onChange={(e) => setRbCardCode(e.target.value)} placeholder="已保存的卡密不会回显；留空不修改"/></label></ConnectionCard>
    <ConnectionCard title="SSH 远程显卡" badge="REMOTE" result={results.ssh} onTest={() => test("ssh")} testing={testing === "ssh"}><div className="form-grid"><label>主机<input value={draft.ssh.host} onChange={(e)=>setSsh({host:e.target.value})} placeholder="gpu.example.com"/></label><label>端口<input type="number" value={draft.ssh.port} onChange={(e)=>setSsh({port:Number(e.target.value)})}/></label><label>用户名<input value={draft.ssh.username} onChange={(e)=>setSsh({username:e.target.value})}/></label><label>远端 ComfyUI 端口<input type="number" value={draft.ssh.remoteComfyPort} onChange={(e)=>setSsh({remoteComfyPort:Number(e.target.value)})}/></label></div><label>私钥路径<div className="input-button"><input value={draft.ssh.privateKeyPath} onChange={(e)=>setSsh({privateKeyPath:e.target.value})}/><button onClick={async()=>{const x=await window.h3.selectFile("key");if(x.data)setSsh({privateKeyPath:x.data});}}>选择</button></div></label><label>SSH 密码（仅无私钥时）<input type="password" value={sshPassword} onChange={(e)=>setSshPassword(e.target.value)} placeholder="使用系统安全存储"/></label><label>主机 SHA-256 指纹<input value={draft.ssh.hostFingerprint} onChange={(e)=>setSsh({hostFingerprint:e.target.value})} placeholder="首次测试确认后填入"/></label></ConnectionCard>
    <ConnectionCard title="游乐场 LLM（OpenAI 兼容）" badge="PLAY" result={llmResult} onTest={testLlm} testing={llmTesting}><div className="form-grid"><label>提供商<select value={draft.llm.provider} onChange={(e) => setLlmProvider(e.target.value)}>{LLM_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label><label>API 地址<input value={draft.llm.baseUrl} onChange={(e) => setLlm({baseUrl: e.target.value})} placeholder="https://api.example.com/v1"/></label><label>模型名称<div className="input-button"><input value={draft.llm.model} onChange={(e) => setLlm({model: e.target.value})} placeholder="deepseek-chat"/>{llmModels && llmModels.length > 0 && <select className="pg-model-select" value="" onChange={(e) => { if (e.target.value) setLlm({model: e.target.value}); }}><option value="">从列表选择…</option>{llmModels.map((m) => <option key={m} value={m}>{m}</option>)}</select>}<button onClick={fetchModels} disabled={fetchingModels}>{fetchingModels ? "获取中…" : "获取列表"}</button></div></label></div><label>API Key<input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} placeholder="已保存的密钥不会回显；留空不修改（Ollama 本机可留空）"/></label><label>系统提示词（可选）<input value={draft.llm.systemPrompt} onChange={(e) => setLlm({systemPrompt: e.target.value})} placeholder="例如：你是视频创作助手，帮我润色视频描述。"/></label><p className="footnote">测试连接优先拉取上游模型列表验证连通性（不发对话、不消耗额度），不支持列表接口的服务商回退发一条最小对话。改 API 地址为第三方中转时自动使用标准 /chat/completions 端点。</p></ConnectionCard>
    <ConnectionCard title="联网搜索（可选）" badge="SEARCH"><label>搜索 API 地址<input value={draft.searchApi.baseUrl} onChange={(e) => setDraft({...draft, searchApi: {baseUrl: e.target.value}})} placeholder="博查/Tavily 转接等，POST /search 返回 results 数组；留空隐藏搜索开关"/></label><label>搜索 API Key<input type="password" value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder="已保存的密钥不会回显；留空不修改"/></label></ConnectionCard>
  </section>;
}

function ConnectionCard({ title, badge, result, onTest, testing, children }: { title: string; badge: string; result?: BackendTestResult; onTest?: () => void; testing?: boolean; children: ReactNode }) { return <article className="connection-card"><header><div><span>{badge}</span><h2>{title}</h2></div>{onTest && <button className="secondary" onClick={onTest} disabled={testing}>{testing ? "测试中…" : "测试连接"}</button>}</header><div className="connection-fields">{children}</div>{result && <div className={`test-result ${result.ok ? "ok" : "bad"}`}><strong>{result.ok ? "连接成功" : "连接失败"}</strong><span>{result.message} · {result.latencyMs}ms</span></div>}</article>; }

interface PlaygroundSession {
  id: string;
  title: string;
  messages: PlaygroundMessage[];
  createdAt: string;
}

// 消息可携带内嵌的视频生成任务（任务卡片随 task:update 实时刷新）。
interface PlaygroundMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  streaming?: boolean;
  taskIds?: string[];
  error?: boolean;
}

const pgSessionsKey = "h3-playground-sessions";

function loadSessions(): PlaygroundSession[] {
  try { return JSON.parse(localStorage.getItem(pgSessionsKey) || "[]") as PlaygroundSession[]; } catch { return []; }
}

function PlaygroundPage({ settings, tasks, onError, onNotice, onNavigate }: { settings: AppSettings; tasks: GenerationTask[]; onError: (e: unknown) => void; onNotice: (s: string) => void; onNavigate: (page: Page) => void }) {
  const [sessions, setSessions] = useState<PlaygroundSession[]>(loadSessions);
  const [activeId, setActiveId] = useState<string>(() => loadSessions()[0]?.id || "");
  const active = sessions.find((s) => s.id === activeId);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Array<{ name: string; dataUrl?: string; text?: string }>>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showVideoForm, setShowVideoForm] = useState(false);
  const [videoRequest, setVideoRequest] = useState<GenerationRequest>({ ...initialRequest, backend: settings.defaultBackend });
  const streamBuffer = useRef("");
  const streamingSessionId = useRef("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchReady = Boolean(settings.searchApi.baseUrl);

  useEffect(() => { localStorage.setItem(pgSessionsKey, JSON.stringify(sessions.slice(0, 50))); }, [sessions]);
  useEffect(() => {
    // 流式事件只写入发起本轮对话的会话——期间切换会话不会污染其他会话的消息。
    const offChunk = window.h3.onLlmChunk((event: LlmStreamEvent) => {
      if (!streamingSessionId.current) return;
      streamBuffer.current += event.delta;
      const targetId = streamingSessionId.current;
      setSessions((all) => patchLast(all, targetId, (msg) => ({ ...msg, content: streamBuffer.current })));
    });
    const offDone = window.h3.onLlmDone((event) => {
      const targetId = streamingSessionId.current;
      streamingSessionId.current = "";
      if (!targetId) return;
      setSessions((all) => patchLast(all, targetId, (msg) => ({
        ...msg,
        streaming: false,
        error: !event.ok && Boolean(event.message),
        // 失败且气泡为空时写入错误文案——空回复永远是"显示出来的错误"，绝不静默。
        content: !event.ok && event.message && !msg.content ? `请求失败：${event.message}` : msg.content
      })));
      streamBuffer.current = "";
      setGenerating(false);
      if (!event.ok && event.message) onError(new Error(event.message));
    });
    return () => { offChunk(); offDone(); };
  }, []);
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  // 粘底自动滚动：仅在用户接近底部时跟随。
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [active?.messages.length, active?.messages[active.messages.length - 1]?.content]);

  function patchLast(all: PlaygroundSession[], id: string, patch: (msg: PlaygroundMessage) => PlaygroundMessage): PlaygroundSession[] {
    return all.map((session) => session.id !== id ? session : { ...session, messages: session.messages.map((msg, i) => i === session.messages.length - 1 ? patch(msg) : msg) });
  }

  function newSession() {
    const session: PlaygroundSession = { id: crypto.randomUUID(), title: "新对话", messages: [], createdAt: new Date().toISOString() };
    setSessions((all) => [session, ...all]);
    setActiveId(session.id);
    setInput("");
    setAttachments([]);
  }

  async function pickAttachment() {
    const response = await window.h3.selectFile("image");
    if (!response.data) return;
    const payload = await window.h3.readAttachment(response.data);
    if (!payload.data) { onError(new Error(payload.message || "读取附件失败")); return; }
    if (payload.data.kind === "other") { onNotice(`已添加附件 ${payload.data.name}（此类型仅作为文件名提示发送）`); }
    setAttachments((all) => [...all, { name: payload.data!.name, dataUrl: payload.data!.dataUrl, text: payload.data!.text }]);
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || generating) return;
    if (!settings.llm.baseUrl) { onError(new Error("请先在连接设置中配置游乐场 LLM。")); return; }
    // 无会话时先本地创建会话对象再继续（不 return），避免首条消息被丢弃。
    let session = active;
    if (!session) {
      session = { id: crypto.randomUUID(), title: text.slice(0, 20) || "新对话", messages: [], createdAt: new Date().toISOString() };
      setSessions((all) => [session as PlaygroundSession, ...all]);
      setActiveId(session.id);
    }
    const userImages = attachments.map((a) => a.dataUrl).filter((url): url is string => Boolean(url));
    const extraText = attachments.map((a) => a.text ? `\n\n--- 附件 ${a.name} ---\n${a.text}` : `\n\n（附件：${a.name}）`).join("");
    const userMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "user", content: text + extraText, images: userImages.length ? userImages : undefined };
    const assistantMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "assistant", content: "", streaming: true };
    const history: ChatMessage[] = [...(session.messages).filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content, images: m.images })), { role: "user", content: userMsg.content, images: userMsg.images }];
    setSessions((all) => all.map((s) => s.id === session!.id ? { ...s, title: s.messages.length === 0 && text ? text.slice(0, 20) : s.title, messages: [...s.messages, userMsg, assistantMsg] } : s));
    setInput(""); setAttachments([]); setGenerating(true); streamBuffer.current = ""; streamingSessionId.current = session.id;
    const result = await window.h3.chatLlm(history, webSearch);
    if (!result.ok) {
      setGenerating(false);
      setSessions((all) => patchLast(all, session!.id, (msg) => ({ ...msg, streaming: false, error: true, content: msg.content || `请求失败：${result.message || "未知错误"}` })));
    }
  }

  async function stop() {
    await window.h3.abortLlm();
    setGenerating(false);
    setSessions((all) => patchLast(all, activeIdRef.current, (msg) => ({ ...msg, streaming: false })));
  }

  async function submitVideo() {
    let session = active;
    if (!session) {
      session = { id: crypto.randomUUID(), title: "视频生成", messages: [], createdAt: new Date().toISOString() };
      setSessions((all) => [session as PlaygroundSession, ...all]);
      setActiveId(session.id);
    }
    const result = await window.h3.submitGeneration({ ...videoRequest, prompt: videoRequest.prompt || input.trim() });
    if (!result.ok) { onError(result.message); return; }
    const taskIds = result.data?.map((task) => task.id) ?? [];
    const summary = `已提交视频生成（${backendLabel(videoRequest.backend)}${videoRequest.preset ? ` · ${rbPresetLabel(videoRequest.preset)}` : ""}）：${videoRequest.prompt.slice(0, 60)}${videoRequest.prompt.length > 60 ? "…" : ""}`;
    const assistantMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "assistant", content: summary, taskIds };
    setSessions((all) => all.map((s) => s.id === session!.id ? { ...s, messages: [...s.messages, { id: crypto.randomUUID(), role: "user" as const, content: `🎬 生成视频：${videoRequest.prompt.slice(0, 80)}` }, assistantMsg] } : s));
    setShowVideoForm(false);
    onNotice(`已创建 ${videoRequest.count} 个生成任务`);
  }

  const activeTasks = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  return <section className="page playground"><div className="page-title"><div><span className="eyebrow">PLAY</span><h1>游乐场</h1></div><button className="primary" onClick={newSession}>新对话</button></div>
    <div className="playground-layout">
      <aside className="pg-sessions">
        {sessions.length === 0 && <p className="footnote">还没有对话。点击右上角"新对话"开始。</p>}
        {sessions.map((session) => <button key={session.id} className={session.id === activeId ? "pg-session active" : "pg-session"} onClick={() => setActiveId(session.id)}><strong>{session.title || "新对话"}</strong><small>{session.messages.length} 条消息</small></button>)}
      </aside>
      <div className="pg-main">
        <div className="pg-messages">
          {!active || active.messages.length === 0 ? <div className="pg-empty"><strong>和 AI 聊聊视频创意</strong><span>让它帮你润色提示词、答疑，或直接在对话里生成视频。先到「连接设置」配置 LLM。</span></div>
            : active.messages.map((msg) => <div key={msg.id} className={`pg-msg ${msg.role}${msg.error ? " error" : ""}`}>
              {msg.role === "user" && msg.images?.map((url, i) => <img key={i} className="pg-thumb" src={url} alt="附件" />)}
              <div className="pg-bubble">{msg.content ? renderMarkdown(msg.content) : msg.streaming ? <span className="pg-cursor" /> : <em>（空回复）</em>}{msg.streaming && msg.content && <span className="pg-cursor" />}</div>
              {msg.taskIds && msg.taskIds.length > 0 && <div className="result-grid pg-task-grid">{msg.taskIds.map((taskId, i) => <TaskCard key={taskId} task={activeTasks.get(taskId)} index={i % 4} onError={onError} />)}</div>}
            </div>)}
          <div ref={bottomRef} />
        </div>
        <div className="pg-composer">
          <div className="pg-chips">
            <button className={webSearch ? "pg-chip on" : "pg-chip"} onClick={() => { if (!searchReady && !webSearch) { onNotice("联网搜索需要先在连接设置配置搜索 API；若 LLM 自带联网也可不接。"); } setWebSearch(!webSearch); }}>🌐 联网{searchReady ? "" : "（未配置 API）"}</button>
            <button className={showVideoForm ? "pg-chip on" : "pg-chip"} onClick={() => setShowVideoForm(!showVideoForm)}>🎬 生成视频</button>
            <button className="pg-chip" onClick={pickAttachment}>📎 附件</button>
            <span className="pg-model">{settings.llm.model || "未配置模型"}{generating ? " · 生成中…" : ""}</span>
            {generating && <button className="pg-chip stop" onClick={stop}>■ 停止</button>}
          </div>
          {showVideoForm && <div className="pg-video-form">
            <div className="form-grid">
              <label>生成后端<select value={videoRequest.backend} onChange={(e) => setVideoRequest({ ...videoRequest, backend: e.target.value as BackendKind, preset: undefined })}>{(["local", "ssh", "minimax", "rb"] as BackendKind[]).map((kind) => <option key={kind} value={kind}>{backendLabel(kind)}</option>)}</select></label>
              <label>时长<select value={videoRequest.duration} onChange={(e) => setVideoRequest({ ...videoRequest, duration: Number(e.target.value) })}>{[4, 6, 8, 10, 12, 15].map((x) => <option key={x} value={x}>{x} 秒</option>)}</select></label>
              <label>结果数量<select value={videoRequest.count} onChange={(e) => setVideoRequest({ ...videoRequest, count: Number(e.target.value) })}>{[1, 2, 3, 4].map((x) => <option key={x} value={x}>{x} 路</option>)}</select></label>
            </div>
            <label>视频描述（留空则使用下方聊天输入内容）<textarea rows={2} value={videoRequest.prompt} onChange={(e) => setVideoRequest({ ...videoRequest, prompt: e.target.value })} /></label>
            <button className="primary" onClick={submitVideo}>提交生成任务</button>
          </div>}
          {attachments.length > 0 && <div className="pg-attachments">{attachments.map((a, i) => <span key={i} className="pg-attachment">{a.dataUrl ? <img src={a.dataUrl} alt={a.name} /> : `📄 ${a.name}`}<button onClick={() => setAttachments((all) => all.filter((_, j) => j !== i))}>×</button></span>)}</div>}
          <div className="pg-input-row">
            <textarea rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder={generating ? "AI 正在回复…" : "输入消息，Enter 发送，Shift+Enter 换行"} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <button className="primary" disabled={generating || (!input.trim() && attachments.length === 0)} onClick={send}>{generating ? "回复中…" : "发送"}</button>
          </div>
        </div>
      </div>
    </div>
  </section>;
}

function rbPresetLabel(preset: string): string {
  return ({ reference: "贴合参考图", tail_frame: "首尾过渡", easy_15: "15 秒", easy_30: "30 秒", flashvsr_upscale: "视频变清晰" } as Record<string, string>)[preset] || preset;
}

function FilePicker({ label, path, onClick }: { label: string; path?: string; onClick: () => void }) { return <button className={`file-picker ${path ? "picked" : ""}`} onClick={onClick}><span>{path ? "✓" : "+"}</span><strong>{label}</strong><small>{path ? path.split(/[\\/]/).pop() : "点击选择文件"}</small></button>; }
function upsert<T extends { id: string }>(items: T[], item: T): T[] { const index=items.findIndex((x)=>x.id===item.id); if(index<0)return[item,...items];const copy=[...items];copy[index]=item;return copy; }
async function must<T>(promise: Promise<ApiResponse<T>>): Promise<T> { const result=await promise;if(!result.ok)throw new Error(result.message||"操作失败");return result.data as T; }
function backendLabel(kind: BackendKind) { return kind === "local" ? "本机 ComfyUI" : kind === "ssh" ? "SSH 远程显卡" : kind === "rb" ? "瞬映 RB 云生成" : "MiniMax H3 云 API"; }
function statusLabel(status: GenerationTask["status"]) { return ({draft:"草稿",validating:"校验中",uploading:"上传中",queued:"排队中",running:"生成中",decoding:"解码中",downloading:"保存中",succeeded:"已完成",failed:"失败",cancelled:"已取消",interrupted:"已中断"} as const)[status]; }
function formatRuntimeRange(minMinutes: number, maxMinutes: number) { const format=(minutes:number)=>minutes>=120?`${Number((minutes/60).toFixed(minutes%60===0?0:1))} 小时`:`${minutes} 分钟`;return `${format(minMinutes)}–${format(maxMinutes)}`; }
function formatBytes(bytes?: number) { if (!bytes) return "体积未知"; return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }
