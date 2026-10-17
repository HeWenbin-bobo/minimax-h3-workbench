import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiResponse, AppSettings, BackendKind, BackendTestResult, ChatMessage, ContextStatus, EnvironmentReport, GenerationMode, GenerationRequest, GenerationTask, LlmQuestion, LlmStreamEvent, LocalModelStatus, PlanStep, ResourceLink, UpdateInfo } from "../shared/types";
import { LLM_PROVIDERS, MAX_PROMPT_LENGTH } from "../shared/types";
import { parseCsvRows } from "../shared/csv";
import { estimateCloudCost, estimateLocalRuntime } from "../shared/capabilities";
import { describeError } from "../shared/errors";
import { looksLikePlan, type PlanMode } from "../shared/planMode";
import { applyTheme, loadThemeChoice, saveThemeChoice, systemPrefersDark, themeLabel, type ThemeChoice } from "./theme";
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
  // 主题三态：只存渲染端 localStorage，不进 settingsStore（见 theme.ts 的说明）。
  const [theme, setTheme] = useState<ThemeChoice>(loadThemeChoice);
  useEffect(() => {
    applyTheme(theme, systemPrefersDark());
    // 选择为 system 时要跟着系统走：系统在应用运行期间切了主题也得跟着变。
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system", media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
  const pickTheme = (choice: ThemeChoice) => { setTheme(choice); saveThemeChoice(choice); };
  const showError = (error: unknown) => setNotice({ text: describeError(error, "操作失败"), error: true });

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

  // 删除/恢复后同步渲染端任务列表：删掉的从本地 state 移除，恢复的重新并入。
  useEffect(() => {
    const onChanged = () => window.h3.listTasks().then((r) => { if (r.data) setTasks(r.data); }).catch(() => undefined);
    window.addEventListener("h3-tasks-changed", onChanged);
    return () => window.removeEventListener("h3-tasks-changed", onChanged);
  }, []);

  // 生成完成/失败系统通知：应用最小化或在后台时用户也能第一时间知道结果。
  // 只在"本会话内首次观察到该状态"时通知：历史上从没见过的任务（应用启动加载史时的记录）
  // before 为 undefined，若按"状态变成终态"判断会导致每次启动把全部历史任务重播一遍通知。
  const tasksRef = useRef<GenerationTask[]>([]);
  useEffect(() => {
    const prev = tasksRef.current;
    for (const task of tasks) {
      const before = prev.find((t) => t.id === task.id);
      if (!before) continue; // 首次见到的任务不算"刚刚完成"（历史加载 / 已在别的路径通知过）
      const entered = (status: GenerationTask["status"]) => before.status !== status && task.status === status;
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
      {/* 主题切换：三态循环（跟随系统 → 浅色 → 深色）。做成单个按钮而不是下拉，
          侧栏底部空间紧，且这个设置改一次就不动。 */}
      <button className="sidebar-theme" onClick={() => pickTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")} title="切换浅色 / 深色 / 跟随系统">
        <span className="sidebar-theme-icon">{theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}</span>
        <span>{themeLabel(theme)}</span>
      </button>
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
  // 视图分两种，互不混淆（此前两者混在一起，导致"新建 4 路"里塞进已有项目的单路结果）：
  // - 新建任务：activeProjectId 为空。结果区严格按表单的 request.count 显示占位框（待生成）。
  // - 已有任务：点某个项目 tab 进入，只显示该项目自己的结果（格子数 = 该项目任务数）。
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const activeProject = activeProjectId ? projects.find((group) => (group[0].parentId || group[0].id) === activeProjectId) : undefined;
  const isRb = request.backend === "rb";
  const rbPreset = request.preset || (request.firstFramePath && request.lastFramePath ? "tail_frame" : "reference");
  const setRbPreset = (preset: string) => setRequest({ ...request, preset, duration: clampDuration(request.duration, durationOptionsFor("rb", preset)) });
  const clampedCount = Math.max(1, Math.min(4, request.count));
  // 新建视图：request.count 个占位；项目视图：仅该项目任务，按 index 排序。
  const currentTasks: Array<GenerationTask | undefined> = useMemo(
    () => activeProject ? [...activeProject].sort((a, b) => a.index - b.index) : Array.from({ length: clampedCount }, () => undefined),
    [activeProject, clampedCount]
  );
  const shownCount = currentTasks.length;
  async function choose(kind: "image" | "video", field: keyof GenerationRequest) { const response = await window.h3.selectFile(kind); if (response.data) setRequest((r) => ({ ...r, [field]: response.data })); }
  // 同步守卫：submitting 是异步 state，同一 tick 内双击会双双读到 false → 提交两次。
  // 云端后端每次提交都**真实扣费**，重复提交等于白扣（实测 probe-studio-double-submit：
  // 双击建出 2 个项目组、ComfyUI /prompt 被命中 2 次）。
  const submittingRef = useRef(false);
  async function submit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const response = await window.h3.submitGeneration(request);
      if (!response.ok) { onError(response.message); return; }
      // 提交成功：切到新项目（submitGeneration 创建的任务组排在最前）。
      if (response.data?.[0]) setActiveProjectId(response.data[0].parentId);
      onNotice(`已创建 ${request.count} 个生成任务，可继续提交新任务并行生成`);
    } catch (error) {
      // IPC 抛异常也必须让人看见，并解锁按钮（否则再也点不动）。
      onError(error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  const rbDurationOptions = durationOptionsFor("rb", rbPreset);
  const [showTrash, setShowTrash] = useState(false);
  // 内联分类输入：window.prompt 在 Electron 中不可用（抛 "prompt() is not supported."），改用与重命名一致的输入框。
  const [catEdit, setCatEdit] = useState<{ project: boolean; value: string }>({ project: false, value: "" });
  async function commitProjectCategory() {
    if (!catEdit.project) return; // Escape 时已置 project=false：视为取消
    setCatEdit({ project: false, value: "" });
    await setProjectCategory(catEdit.value);
  }
  // 项目分类：所有项目出现过的分类 + "全部"/"未分类" 过滤；新分类在当前项目上直接输入。
  const projectCategories = useMemo(() => Array.from(new Set(tasks.map((t) => t.category).filter((c): c is string => Boolean(c)))), [tasks]);
  const [categoryFilter, setCategoryFilter] = useState<string>("全部");
  const filteredProjects = useMemo(() => {
    if (categoryFilter === "全部") return projects;
    if (categoryFilter === "未分类") return projects.filter((group) => !group[0].category);
    return projects.filter((group) => group[0].category === categoryFilter);
  }, [projects, categoryFilter]);
  async function setProjectCategory(category: string) {
    if (!activeProject) return;
    const response = await window.h3.setTaskCategory(activeProject[0].id, category);
    if (!response.ok) { onError(response.message); return; }
    onNotice(category ? `已归类到「${category}」` : "已清除分类");
  }
  async function deleteProject() {
    if (!activeProject) return;
    // 传任一真实任务 id，orchestrator 按 parentId 整组软删除。
    const response = await window.h3.deleteTasks([activeProject[0].id]);
    if (!response.ok) { onError(response.message); return; }
    setActiveProjectId(undefined);
    onNotice("已移入回收站，7 天内可恢复");
    window.dispatchEvent(new Event("h3-tasks-changed"));
  }
  return <section className="page studio-page"><div className="page-title"><div><span className="eyebrow">CREATE</span><h1>生成工作台</h1></div><div className="page-title-actions"><button className="text-button" onClick={() => setShowTrash((v) => !v)}>🗑 回收站</button><div className="backend-pill"><span />{backendLabel(request.backend)}</div></div></div>
    {projects.length > 0 && <div className="category-filter">
      {["全部", ...projectCategories, "未分类"].map((c) => <button key={c} className={categoryFilter === c ? "on" : ""} onClick={() => setCategoryFilter(c)}>{c}</button>)}
      {catEdit.project ? <input className="cat-input" autoFocus value={catEdit.value} placeholder="分类名（留空清除）"
        onChange={(e) => setCatEdit({ project: true, value: e.target.value })}
        onBlur={() => commitProjectCategory()}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setCatEdit({ project: false, value: "" }); }} />
        : <button className="text-button" title="给当前项目设置分类" disabled={!activeProject} onClick={() => { if (activeProject) setCatEdit({ project: true, value: activeProject[0].category || "" }); }}>＋ 分类</button>}
    </div>}
    <div className="project-tabs">
      <button className={`project-tab new-task${activeProjectId ? "" : " active"}`} onClick={() => setActiveProjectId(undefined)}>
        <strong>＋ 新建任务</strong><small>按下方参数生成 {clampedCount} 路</small>
      </button>
      {filteredProjects.map((group) => {
        const key = group[0].parentId || group[0].id;
        const running = group.some((t) => !["succeeded", "failed", "cancelled", "interrupted"].includes(t.status));
        const done = group.filter((t) => t.status === "succeeded").length;
        const active = activeProjectId === key;
        return <button key={key} className={`project-tab${active ? " active" : ""}`} onClick={() => setActiveProjectId(key)}>
          <strong>{group[0].prompt.slice(0, 18) || "未命名项目"}</strong>
          <small>{running ? "生成中…" : `${done}/${group.length} 完成`}{group[0].category ? ` · ${group[0].category}` : ""}</small>
          {running && <i className="dot" />}
        </button>;
      })}
    </div>
    {showTrash && <TrashPanel onError={onError} onNotice={onNotice} />}
    <div className="studio-layout"><div className="control-panel">
      {!isRb && <div className="mode-tabs">{(["text", "image", "video"] as GenerationMode[]).map((mode) => <button key={mode} className={request.mode === mode ? "active" : ""} onClick={() => setRequest({ ...request, mode })}>{mode === "text" ? "文生视频" : mode === "image" ? "图生视频" : "视频生视频"}</button>)}</div>}
      {isRb && <div className="mode-tabs">{[["reference", "贴合参考图"], ["tail_frame", "首尾过渡"], ["easy_15", "15 秒"], ["easy_30", "30 秒"], ["flashvsr_upscale", "视频变清晰"]].map(([value, label]) => <button key={value} className={rbPreset === value ? "active" : ""} onClick={() => setRbPreset(value)}>{label}</button>)}</div>}
      {isRb && rbPreset === "flashvsr_upscale"
        ? <FilePicker label="源视频（要变清晰的视频）" path={request.sourceVideoPath} onClick={() => choose("video", "sourceVideoPath")} />
        : <>
          <label>视频描述<textarea rows={7} maxLength={MAX_PROMPT_LENGTH} value={request.prompt} onChange={(e) => setRequest({ ...request, prompt: e.target.value })} placeholder="描述主体、动作、镜头、光线与风格…"/><small>{request.prompt.length} / {MAX_PROMPT_LENGTH}</small></label>
          {!isRb && request.mode === "text" && <div className="frame-row"><FilePicker label="首帧（可选）" path={request.firstFramePath} onClick={() => choose("image", "firstFramePath")} /><FilePicker label="尾帧（可选）" path={request.lastFramePath} onClick={() => choose("image", "lastFramePath")} /></div>}
          {!isRb && request.mode === "image" && <FilePicker label="参考图片" path={request.sourceImagePath} onClick={() => choose("image", "sourceImagePath")} />}
          {!isRb && request.mode === "video" && <FilePicker label="参考视频" path={request.sourceVideoPath} onClick={() => choose("video", "sourceVideoPath")} />}
          {isRb && rbPreset === "reference" && <FilePicker label="参考图片（可选，最多 8 张）" path={request.sourceImagePath} onClick={() => choose("image", "sourceImagePath")} />}
          {isRb && rbPreset === "reference" && <FilePicker label="参考视频（可选）" path={request.sourceVideoPath} onClick={() => choose("video", "sourceVideoPath")} />}
          {isRb && rbPreset === "tail_frame" && <div className="frame-row"><FilePicker label="首帧" path={request.firstFramePath} onClick={() => choose("image", "firstFramePath")} /><FilePicker label="尾帧" path={request.lastFramePath} onClick={() => choose("image", "lastFramePath")} /></div>}
        </>}
      <div className="form-grid"><label>生成后端<select value={request.backend} onChange={(e) => { const backend = e.target.value as BackendKind; const preset = undefined; setRequest({ ...request, backend, preset, duration: clampDuration(request.duration, durationOptionsFor(backend, preset)) }); }}><option value="local">本机 ComfyUI</option><option value="ssh">SSH 远程显卡</option><option value="minimax">MiniMax H3 云 API</option><option value="rb">瞬映 RB 云生成</option></select></label>
        {(!isRb || rbDurationOptions.length > 0) && <label>时长<select value={request.duration} onChange={(e) => setRequest({ ...request, duration: Number(e.target.value) })}>{(!isRb ? [4,6,8,10,12,15] : rbDurationOptions).map((x) => <option key={x} value={x}>{x} 秒</option>)}</select></label>}
        {!isRb && <label>画幅<select value={request.ratio} onChange={(e) => setRequest({ ...request, ratio: e.target.value as GenerationRequest["ratio"] })}>{["16:9","9:16","1:1","4:3","3:4","21:9","adaptive"].map((x) => <option key={x}>{x}</option>)}</select></label>}
        {!isRb && <label>分辨率<select value={request.resolution} onChange={(e) => setRequest({ ...request, resolution: e.target.value as "768P" | "2K" })}><option>768P</option><option>2K</option></select></label>}
        {isRb && (rbPreset === "reference" || rbPreset === "tail_frame") && <label>采样步数<select value={request.samplerSteps || 20} onChange={(e) => setRequest({ ...request, samplerSteps: Number(e.target.value) })}><option value={8}>8（更快）</option><option value={20}>20（更精细）</option></select></label>}
        {isRb && (rbPreset === "reference" || rbPreset === "tail_frame") && <label>补帧<select value={request.interpolate ? "on" : "off"} onChange={(e) => setRequest({ ...request, interpolate: e.target.value === "on" })}><option value="off">关闭</option><option value="on">开启（更流畅）</option></select></label>}
        <label>结果数量<select value={request.count} onChange={(e) => setRequest({ ...request, count: Number(e.target.value) })}>{[1,2,3,4].map((x) => <option key={x} value={x}>{x} 路</option>)}</select></label>
      </div>
      <label>基础随机种子<input type="number" value={request.baseSeed} onChange={(e) => setRequest({ ...request, baseSeed: Number(e.target.value) })}/></label>
      <div className="submit-area"><div>{request.backend === "minimax" ? <><span>云端估算</span><strong>约 ${estimateCloudCost(request.resolution, request.duration, request.count).toFixed(2)} / {request.count} 条</strong></> : request.backend === "rb" ? <><span>云端估算</span><strong>卡密计费 · {request.count} 条消耗 {request.count} 次</strong></> : <><span>本地生成</span><strong>不产生 API 费用</strong></>}</div><button className="primary" disabled={submitting} onClick={submit}>{submitting ? "提交中…" : `生成 ${request.count} 个结果`}</button></div>
    </div><div className="result-pane"><div className="result-pane-head">{activeProject
      ? <button className="text-button danger" onClick={deleteProject}>🗑 删除此项目</button>
      : <span className="result-pane-hint">新建任务预览 · 将生成 {clampedCount} 路结果</span>}</div><div className={`result-grid${shownCount === 1 ? " single" : ""}`}>{currentTasks.map((task, index) => <TaskCard key={task?.id || `slot-${index}`} task={task} index={index} onError={onError} />)}</div></div></div>
  </section>;
}

// 回收站面板：按项目分组展示已删除任务，支持恢复 / 彻底删除（含视频文件）。
// 删除/恢复动作广播 h3-tasks-changed 事件，本面板监听该事件实时刷新（无需关闭重开）。
function TrashPanel({ onError, onNotice }: { onError: (e: unknown) => void; onNotice: (s: string) => void }) {
  const [items, setItems] = useState<GenerationTask[]>([]);
  const [loading, setLoading] = useState(true);
  const retentionMs = 7 * 24 * 60 * 60 * 1_000;
  const refresh = useCallback(() => window.h3.listDeletedTasks().then((r) => { if (r.data) setItems(r.data); setLoading(false); }).catch(() => setLoading(false)), []);
  useEffect(() => {
    void refresh();
    window.addEventListener("h3-tasks-changed", refresh);
    return () => window.removeEventListener("h3-tasks-changed", refresh);
  }, [refresh]);
  const groups = new Map<string, GenerationTask[]>();
  for (const task of items) {
    const group = groups.get(task.parentId);
    if (group) group.push(task); else groups.set(task.parentId, [task]);
  }
  const daysLeft = (iso: string) => Math.max(0, Math.ceil((retentionMs - (Date.now() - new Date(iso).getTime())) / 86_400_000));
  const notifyChanged = () => window.dispatchEvent(new Event("h3-tasks-changed"));
  async function restore(ids: string[]) { const r = await window.h3.restoreTasks(ids); if (!r.ok) { onError(r.message); return; } onNotice("已恢复"); notifyChanged(); void refresh(); }
  async function purge(ids: string[]) { const r = await window.h3.purgeTasks(ids); if (!r.ok) { onError(r.message); return; } onNotice("已彻底删除（含视频文件）"); notifyChanged(); void refresh(); }
  return <section className="trash-panel">
    <header><strong>回收站</strong><small>项目删除后保留 7 天，到期自动清除（含视频文件）</small></header>
    {loading && <p className="footnote">加载中…</p>}
    {!loading && groups.size === 0 && <p className="footnote">回收站是空的。</p>}
    {Array.from(groups.values()).map((group) => {
      const ids = group.map((t) => t.id);
      const deletedAt = group[0].deletedAt || group[0].updatedAt;
      return <article key={group[0].parentId} className="trash-item">
        <div><strong>{group[0].prompt.slice(0, 40) || "未命名项目"}</strong>
          <small>{group.length} 条 · {daysLeft(deletedAt)} 天后自动清除</small></div>
        <div className="trash-actions">
          <button className="text-button" onClick={() => restore(ids)}>恢复</button>
          <button className="text-button danger" onClick={() => purge(ids)}>彻底删除</button>
        </div>
      </article>;
    })}
  </section>;
}

/**
 * 任务卡。
 *
 * `allowDemoPlaceholder`（默认 true）：task 为空时渲染**内置示例视频**充当占位。
 * 这只在工作台「新建任务」视图下有意义（还没提交，展示成品效果）。
 *
 * 对话气泡必须传 false：那里 task 为空意味着**任务已被删除/淘汰**，
 * 再拿示例视频顶上就是"把 demo 冒充成用户生成的结果"（实测：删除任务后气泡里
 * 出现「结果 1 · 4 秒 · 480P · 已生成 · 就绪」的假结果）。
 */
function TaskCard({ task, index, onError, allowDemoPlaceholder = true }: { task?: GenerationTask; index: number; onError: (e: unknown) => void; allowDemoPlaceholder?: boolean }) {
  const canCancel = task && !["succeeded","failed","cancelled","interrupted"].includes(task.status);
  const canRetry = task && ["failed","cancelled","interrupted"].includes(task.status);
  const showDemo = !task && allowDemoPlaceholder;
  const bundledMedia = `${import.meta.env.BASE_URL}demo-videos/showcase-0${index + 1}.mp4`;
  const bundledPoster = `${import.meta.env.BASE_URL}demo-videos/showcase-0${index + 1}.jpg`;
  const media = task?.outputPath ? `h3media://local/file?path=${encodeURIComponent(task.outputPath)}` : task ? "" : showDemo ? bundledMedia : "";
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    if (!task || retrying) return;
    setRetrying(true);
    // IPC 可能 reject（不只是返回 ok:false）。不兜住的话按钮永远停在「重试中…」。
    try {
      const response = await window.h3.retryTask(task.id);
      if (!response.ok) onError(response.message || "重试失败");
    } catch (error) {
      onError(error);
    } finally {
      setRetrying(false);
    }
  }
  if (!task && !allowDemoPlaceholder) {
    return <article className="task-card missing"><div className="task-placeholder"><span>0{index + 1}</span><i>任务已不存在</i></div><div className="task-meta"><div><strong>结果 {index + 1}</strong><small>该任务已被删除，可在工作台回收站恢复</small></div></div></article>;
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
    <ConnectionCard title="联网搜索（可选）" badge="SEARCH"><label>搜索 API 地址<input value={draft.searchApi.baseUrl} onChange={(e) => setDraft({...draft, searchApi: {baseUrl: e.target.value}})} placeholder="博查/Tavily 转接等，POST /search 返回 results 数组；留空则用免 key 抓取 Bing/搜狗"/></label><label>搜索 API Key<input type="password" value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder="已保存的密钥不会回显；留空不修改"/></label></ConnectionCard>
  </section>;
}

function ConnectionCard({ title, badge, result, onTest, testing, children }: { title: string; badge: string; result?: BackendTestResult; onTest?: () => void; testing?: boolean; children: ReactNode }) { return <article className="connection-card"><header><div><span>{badge}</span><h2>{title}</h2></div>{onTest && <button className="secondary" onClick={onTest} disabled={testing}>{testing ? "测试中…" : "测试连接"}</button>}</header><div className="connection-fields">{children}</div>{result && <div className={`test-result ${result.ok ? "ok" : "bad"}`}><strong>{result.ok ? "连接成功" : "连接失败"}</strong><span>{result.message} · {result.latencyMs}ms</span></div>}</article>; }

interface PlaygroundSession {
  id: string;
  title: string;
  messages: PlaygroundMessage[];
  createdAt: string;
  /** 最近使用时间：会话列表按它倒序，刚用过的排最前（多会话并发时能一眼看出哪几个在跑）。 */
  updatedAt?: string;
  /** 会话回收站：非空表示已删除，7 天后启动时自动清除。 */
  deletedAt?: string;
  /** 用户自定义会话分类（空 = 未分类）。 */
  category?: string;
}

// 消息可携带内嵌的视频生成任务（任务卡片随 task:update 实时刷新）。
interface PlaygroundMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  streaming?: boolean;
  /** 旧字段（扁平 id 列表）：读取时迁移为 taskGroups 单组。 */
  taskIds?: string[];
  /**
   * 智能体按工具调用轮次分组的任务卡片：一次对话里模型可能先后创建多批视频任务
   * （如"先 1 路再补 2 路"），扁平列表会丢掉"哪几路是一起提交的"这一结构。
   */
  taskGroups?: string[][];
  error?: boolean;
  /** 瞬态：智能体多步工具调用日志（"→ 正在搜索：xxx" / "✓ 找到 6 条结果"），仅流式期间存在，落盘前与读取时都剥离。
   *  多步循环每步都追加一条——用户能看到完整过程，而不是只有光标在闪。 */
  toolSteps?: string[];
  /** 计划模式下产出的方案清单（尚未执行）：渲染端据此显示「继续执行」按钮。 */
  plan?: boolean;
  /**
   * 步骤清单（update_plan 工具）：模型把任务拆解写出来，用户在气泡上看到进度。
   * 与 plan 的区别：plan 是"这一轮不动手、等你点头"，步骤清单是"正在动手、让你看得见走到哪"。
   */
  planSteps?: PlanStep[];
  /**
   * 挂起的选择题（request_user_input）：模型问了一两个关键取舍，等用户点选。
   * 渲染端据此在消息下方渲染选择卡片；用户点完后清空（工具循环那边已经拿到答案继续了）。
   */
  questions?: { requestId: string; questions: LlmQuestion[] };
  /**
   * 已落盘的产物（create_file 工具）：主进程推来的是**元数据**，内容在磁盘上。
   * 不再靠扫描消息正文里的围栏代码块来发现产物——旧做法会把整个文件内容塞进消息，
   * 导致气泡重复显示 + 内容进历史、每轮重发给模型（白烧 token）。
   */
  artifacts?: Array<{ name: string; path: string; size: number; kind: ArtifactKind }>;
  /**
   * **仅用于界面展示的系统提示**（如"上下文已压缩…"）。
   * 这类消息绝不能进历史发给模型：它会在后续每轮里被当成助手说过的话，
   * 污染上下文（实测 probe-compaction-notice-history：第二轮请求体里出现了压缩提示原文）。
   */
  notice?: boolean;
}

const pgSessionsKey = "h3-playground-sessions";

/** token 数的可读格式：12345 → "12.3k"。用于上下文占用与压缩提示。 */
function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens));
}

/** ISO 时间戳 → "23:07"。会话列表用；无效时间戳返回空串（不显示脏值）。 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 会话落盘上限。 */
const PG_SESSION_CAP = 50;

/** 预览面板宽度持久化键。用户拖过宽度就记住，重开沿用（注释承诺的"并记住"）。 */
const PG_PREVIEW_WIDTH_KEY = "h3-preview-width";
function loadPreviewWidth(): number | undefined {
  try {
    const raw = localStorage.getItem(PG_PREVIEW_WIDTH_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 300 ? Math.round(value) : undefined;
  } catch { return undefined; }
}
function savePreviewWidth(width: number): void {
  try { localStorage.setItem(PG_PREVIEW_WIDTH_KEY, String(Math.round(width))); } catch { /* 存不下就只在本次会话生效 */ }
}

/** 会话"最近使用"时间戳：新建会话还没用过时退回创建时间。 */
function sessionRecency(session: PlaygroundSession): string {
  return session.updatedAt || session.createdAt;
}

/**
 * 裁到上限：按最近使用保留最新的，但两类会话**不占上限名额、也不被淘汰**——
 * ① 正在生成回复的（否则并发场景下一段还在跑的对话会被静默砍掉，回复流到一半目标就没了）；
 * ② **回收站里的**（deletedAt 非空）。它们归"7 天内可恢复"的承诺管。
 *
 * 与主进程同一套语义：`GenerationOrchestrator.trimHistory` 的 MAX_TASKS 只统计**在役**任务，
 * 回收站任务刻意不参与计数；`TaskStore.write` 明确注释不按条数截断。渲染端此前漏了这一条
 * （实测 60 活跃 + 10 个 6 天前删的 → 10 个已删全被挤掉，用户点「恢复」才发现没了）。
 *
 * ⚠️ 名额只由**在役**会话竞争：若把回收站也算进 room，回收站积累到 50 条以上时
 * room 会被压成 0，**所有活跃会话反而全被淘汰**（我第一版就这么写的，实测复现）。
 * 体积仍有界：过期回收站会话由启动时的 7 天清理移除。
 *
 * ⚠️ **什么都没裁时必须返回原引用**：调用方用 `capped !== sessions` 判断要不要
 * setSessions。回收站会话让总数长期 > 上限、但一个都不该裁时，若返回新数组就会
 * 每次渲染都 setSessions → effect 重跑 → **无限渲染循环**（实测：空闲 3 秒写入 1 万次，
 * probe-cap-loop 抓到）。
 */
export function capSessions(sessions: PlaygroundSession[], generatingIds: string[]): PlaygroundSession[] {
  if (sessions.length <= PG_SESSION_CAP) return sessions;
  const exempt = (s: PlaygroundSession) => generatingIds.includes(s.id) || Boolean(s.deletedAt);
  const pinned = sessions.filter(exempt);
  const rest = sessions.filter((s) => !exempt(s)).sort((a, b) => sessionRecency(b).localeCompare(sessionRecency(a)));
  // 名额只看在役会话，与 pinned 数量无关（否则回收站一多就把活跃的清空）。
  const kept = new Set([...pinned.map((s) => s.id), ...rest.slice(0, PG_SESSION_CAP).map((s) => s.id)]);
  const next = sessions.filter((s) => kept.has(s.id));
  // 一条都没裁掉 → 原样返回（引用相同），避免调用方误判"需要更新"而陷入死循环。
  return next.length === sessions.length ? sessions : next;
}

function loadSessions(): PlaygroundSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(pgSessionsKey) || "[]") as PlaygroundSession[];
    // 归一化残留的 streaming 标记：应用在流式回复途中被关闭时，消息上的 streaming:true 会被原样存下来，
    // 而重启后并没有任何流在跑。残留标记会让两个功能失灵：
    //   1) 删除按钮被 deleteSession 的"正在生成不能删"守卫静默拦掉，点了毫无反应；
    //   2) 气泡永久显示闪烁光标，像卡在回复中。
    // 读取时就地清掉——这是唯一能把历史脏数据一次性修好的地方。
    return parsed.map((session) => ({
      ...session,
      // toolSteps 与 streaming 同理是瞬态：流式途中关闭应用会残留，读取时强制剥离。
      // 旧数据迁移：扁平 taskIds → 单组 taskGroups（旧消息没有分组结构）。
      messages: (session.messages ?? []).map((msg) => {
        // toolStatus 是更早版本的瞬态字段（现已改为 toolSteps）；旧数据可能残留，读取时一并剥离。
        const { toolStatus: _dropped, toolSteps: _dropped2, ...rest } = msg as PlaygroundMessage & { toolStatus?: unknown };
        const normalized = rest.taskGroups ?? (rest.taskIds?.length ? [rest.taskIds] : undefined);
        const migrated = { ...rest, taskGroups: normalized, taskIds: undefined };
        return migrated.streaming ? { ...migrated, streaming: false, toolSteps: undefined } : migrated;
      })
    }));
  } catch { return []; }
}

function PlaygroundPage({ settings, tasks, onError, onNotice, onNavigate }: { settings: AppSettings; tasks: GenerationTask[]; onError: (e: unknown) => void; onNotice: (s: string) => void; onNavigate: (page: Page) => void }) {
  const [sessions, setSessions] = useState<PlaygroundSession[]>(loadSessions);
  const [activeId, setActiveId] = useState<string>(() => loadSessions().find((s) => !s.deletedAt)?.id || "");
  const active = sessions.find((s) => s.id === activeId);
  const [input, setInput] = useState("");
  // HTML 产物侧栏预览（WorkBuddy 形态）：文件卡片「预览」触发，产物落盘 userData/artifacts/。
  // 面板压缩聊天区（flex 布局挤压而非悬浮），宽度可拖拽调整并记住。
  const [preview, setPreview] = useState<ArtifactInfo>();
  // 初始宽度按窗口估个值，首次打开时按聊天容器实测校准（playground 限宽 1150，按窗口算会偏大占满）。
  // 用户拖过宽度就**记住**（localStorage），重启/重开面板都沿用——此前只是 state，关掉就丢，
  // 与上面"并记住"的注释不符。
  const [previewWidth, setPreviewWidth] = useState(() => loadPreviewWidth() ?? Math.round(window.innerWidth * 0.35));
  const previewCalibrated = useRef(false);
  useEffect(() => {
    if (!preview) return;
    // 记住的宽度必须在**当前**窗口下重新夹取：用户在大屏拖到 900px、换小窗口打开时，
    // 直接沿用会把聊天列挤没（拖拽路径有夹取，恢复路径此前没有）。
    const mainWidth = document.querySelector(".pg-main")?.getBoundingClientRect().width ?? 0;
    const clamp = (value: number) => Math.round(Math.max(360, Math.min(value, Math.max(360, mainWidth - 30))));
    const saved = loadPreviewWidth();
    if (saved !== undefined) { setPreviewWidth(clamp(saved)); return; }
    if (previewCalibrated.current) return;
    previewCalibrated.current = true;
    if (mainWidth > 700) setPreviewWidth(clamp(mainWidth * 0.55));
  }, [preview]);
  // 拖拽过程中只更新内存宽度；**落盘留到松手**。拖拽时 mousemove 每秒可达上百次，
  // 每次都同步写 localStorage 会造成明显卡顿（本修复初版就是这么写的，属自引入的性能回归）。
  const resizePreview = (width: number) => setPreviewWidth(width);
  const [attachments, setAttachments] = useState<Array<{ name: string; dataUrl?: string; text?: string }>>([]);
  const [webSearch, setWebSearch] = useState(true);
  // 「浏览器搜索」可选联网项：只用应用自带 Chromium 渲染抓取（与「联网」互斥，后端也按互斥处理）。
  const [browserSearch, setBrowserSearch] = useState(true);
  // 智能体默认开启（用户指令）；模型不支持工具时主进程自动回落普通对话，前端无感。
  const [agentMode, setAgentMode] = useState(true);
  // generating 从"全局"改为"按会话"：多会话可并发生成，每个会话各有自己的发送守卫与流缓冲。
  const [generatingIds, setGeneratingIds] = useState<string[]>([]);
  const [showVideoForm, setShowVideoForm] = useState(false);
  const [videoRequest, setVideoRequest] = useState<GenerationRequest>({ ...initialRequest, backend: settings.defaultBackend });
  // 与工作台共用同一份合法时长定义：RB 的 reference/tail_frame 只收 4/6/8 秒，
  // 若这里仍放开 10/12/15，非法 seconds+preset 组合会真的发到云端——失败也照样扣卡密次数。
  const videoDurationOptions = durationOptionsFor(videoRequest.backend, videoRequest.preset);
  // 每个会话一条流：sessionId → 累积文本 / 已收到的任务 id / 同步发送守卫。
  const streamBuffers = useRef(new Map<string, string>());
  const taskIdBuffers = useRef(new Map<string, string[]>());
  const sendingRef = useRef(new Set<string>());
  // 首条消息的会话尚未创建时的同步守卫（见 send()：active 为空时按 id 守卫会失效）。
  const creatingSessionRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户是否贴在底部：流式期间只有贴底才自动跟随。否则用户往上翻看历史时，
  // 每个 chunk 都会把他拽回底部（注释此前就写着"仅在用户接近底部时跟随"，但代码没实现）。
  const stickToBottomRef = useRef(true);
  // 存储写满只提示一次（不然每个 chunk 都会弹一次 toast）。写成功后自动复位。
  const storageWarnedRef = useRef(false);
  const searchReady = Boolean(settings.searchApi.baseUrl);
  const generating = generatingIds.includes(activeId);
  // 计划模式：下一次发送只出方案。
  const [planNext, setPlanNext] = useState(false);
  // 以 plan 语义发出的会话集合（按会话隔离，多会话并发时不串味）。
  // offDone 是订阅回调、读不到最新 state，故用 ref；由 onLlmDone 消费后自行删除。
  const planTurnRef = useRef(new Set<string>());
  // 上下文占用：分母是「模型窗口 × 80%」= 压缩触发点。按当前会话的历史轮询（主进程持有记账状态）。
  const [contextStatus, setContextStatus] = useState<ContextStatus>();
  const [compacting, setCompacting] = useState(false);
  // 轮询闭包必须读**最新**历史：effect 只依赖消息**条数**，而流式期间条数不变、内容在涨。
  // 若闭包捕获旧的 active，回复结束后 chip 仍显示开头的占用（实测：真实 59% 时 chip 停在 0%）。
  const threadRef = useRef<ChatMessage[]>([]);
  threadRef.current = active ? active.messages.filter((m) => !m.error && !m.notice).map((m) => ({ role: m.role, content: m.content, images: m.images })) : [];
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const probe = () => {
      const history = threadRef.current;
      if (!history.length) return;
      void window.h3.getContextStatus(history, activeId).then((response) => { if (!cancelled) setContextStatus(response.data); }).catch(() => {});
    };
    probe();
    // 20 秒轮询：占用是低频变化的量，没必要每渲染一次都问主进程。
    const timer = setInterval(probe, 20_000);
    return () => { cancelled = true; clearInterval(timer); };
  // 回复结束（generating 由 true→false）时补一次探测：流式期间条数没变，effect 不会重跑，
  // 不补的话 chip 要等最多 20 秒才追上真实占用。
  }, [activeId, generating]);

  // 落盘上限 50：内存态一并裁剪，否则 UI 显示得出来、重启后却凭空少几个（用户可感知的静默丢失）。
  // 按"最近使用"裁剪，且绝不丢弃正在生成回复的会话——否则一段正在跑的对话会被静默砍掉。
  useEffect(() => {
    const capped = sessions.length > PG_SESSION_CAP ? capSessions(sessions, generatingIds) : sessions;
    if (capped !== sessions) setSessions(capped);
    // 空对话不落盘：关软件即"永久删除"（用户要求——空状态只是临时草稿）；正在生成回复的空壳除外（防截断）。
    const persistable = capped.filter((s) => s.messages.length > 0 || generatingIds.includes(s.id));
    // 写盘失败必须兜住：localStorage 有配额（约 5–10MB，长会话很容易顶到）。
    // 不兜的话 effect 直接抛异常 → 整个 PlaygroundPage 崩溃、界面塌成空白，用户还不知道
    // 会话其实没存下来（实测复现）。按 CLAUDE.md「出错必须让人看见」，这里如实提示一次。
    try {
      localStorage.setItem(pgSessionsKey, JSON.stringify(persistable));
      storageWarnedRef.current = false; // 写成功即复位，下次真失败时还能再提醒一次
    } catch {
      if (!storageWarnedRef.current) {
        storageWarnedRef.current = true;
        onNotice("本地存储空间不足，最近的对话可能无法保存。建议删除一些旧会话或清空回收站。");
      }
    }
  }, [sessions, generatingIds, onNotice]);
  useEffect(() => {
    // 流式事件按事件里带的 sessionId 路由：多会话并发时各写各的气泡，不会互相覆盖。
    // 极端时序下事件可能早于 React 提交新会话+消息到达，此时把分块暂存进缓冲区，收尾时统一写回。
    const offChunk = window.h3.onLlmChunk((event: LlmStreamEvent) => {
      const targetId = event.sessionId;
      if (!targetId) return;
      streamBuffers.current.set(targetId, (streamBuffers.current.get(targetId) ?? "") + event.delta);
      const buffered = streamBuffers.current.get(targetId) ?? "";
      setSessions((all) => patchLast(all, targetId, (msg) => ({ ...msg, content: buffered })));
    });
    // 智能体多步工具日志：start 追加"→ …"，end 追加"✓ …"——用户能看到完整过程而非光标空闪。
    // 每个工具都必须有**中文名**：此前只有 web_search / generate_video / open_page 有映射，
    // create_file / update_plan / request_user_input 会直接冒出英文标识符（"→ 正在调用 create_file…"），
    // 违反「界面文案一律中文」。end 的 result 可能很长（create_file 的确认文案约百字），截断展示。
    const TOOL_LABELS: Record<string, string> = {
      web_search: "联网搜索",
      generate_video: "生成视频",
      open_page: "打开网页",
      create_file: "生成文件",
      update_plan: "更新步骤清单",
      request_user_input: "向你提问"
    };
    const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? "工具调用";
    const offTool = window.h3.onLlmTool((event) => {
      const targetId = event.sessionId;
      if (!targetId) return;
      setSessions((all) => patchLast(all, targetId, (msg) => {
        const steps = msg.toolSteps ?? [];
        const name = toolLabel(event.tool);
        const summary = (event.result ?? "完成").replace(/\s+/g, " ").trim();
        const shortSummary = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
        if ((event.phase ?? "start") === "end") {
          return { ...msg, toolSteps: [...steps, `✓ ${name}完成（${shortSummary}）`] };
        }
        const label = event.tool === "web_search" ? `→ 正在搜索：${event.input}`
          : event.tool === "generate_video" ? "→ 正在创建视频生成任务…"
            : event.tool === "open_page" ? `→ 正在打开网页：${event.input}`
              : event.tool === "create_file" ? "→ 正在生成文件…"
                : event.tool === "update_plan" ? "→ 正在更新步骤清单…"
                  : event.tool === "request_user_input" ? "→ 正在向你提问…"
                    : `→ ${name}中…`;
        return { ...msg, toolSteps: [...steps, label] };
      }));
    });
    const offDone = window.h3.onLlmDone((event) => {
      const targetId = event.sessionId;
      const buffered = targetId ? streamBuffers.current.get(targetId) ?? "" : "";
      const pendingGroups = targetId ? taskIdBuffers.current.get(targetId) ?? [] : [];
      // 本轮是否以 plan 语义发出：决定要不要给收尾消息打「待确认」标记（渲染端据此亮「继续执行」）。
      const wasPlanTurn = targetId ? planTurnRef.current.has(targetId) : false;
      if (targetId) {
        planTurnRef.current.delete(targetId);
        streamBuffers.current.delete(targetId);
        taskIdBuffers.current.delete(targetId);
      }
      if (targetId) {
        setSessions((all) => patchLast(all, targetId, (msg) => {
          // 收尾取缓冲区与消息内容的较长者：避免真实回复被空 content 覆盖（"发消息没回复"）。
          const base = buffered.length > (msg.content?.length ?? 0) ? buffered : msg.content;
          const failed = !event.ok && Boolean(event.message);
          // 收尾把缓冲里**尚未出现**的任务并入（保持"哪几路是一起提交的"）。
          //
          // **必须按 id 去重**，不能按组去重：onLlmTasks 里同一批任务既实时追加进
          // taskGroups、又写进 taskIdsBuffer，而缓冲区是**扁平累积**的——一轮里
          // generate_video 被调用两次时它是 [a,b,c]，与任何单个组都对不上，
          // 于是又多加一组（实测 groups=[2,1,3]、渲染 6 张卡片，probe-multibatch）。
          // 缓冲存在的意义只是"事件可能早于 React 提交"；已出现过的 id 一律跳过。
          const seenIds = new Set((msg.taskGroups ?? []).flat());
          const missingIds = pendingGroups.filter((id) => !seenIds.has(id));
          const mergedGroups = [...(msg.taskGroups ?? []), ...(missingIds.length ? [missingIds] : [])];
          return {
            ...msg,
            streaming: false,
            // 本轮已结束：任何挂着的选择题卡片都该摘掉。
            // 超时/跳过时 QuestionBridge 会 reject，模型按最佳判断继续并最终走到 done——
            // 不清的话卡片会永久留在已收尾的气泡上，用户再点只得到"已超时"的提示。
            questions: undefined,
            // 步骤日志完成后保留（回答旁边能看到"这条回答是怎么来的"）；仅重启时剥离（瞬态）。
            error: failed,
            taskGroups: mergedGroups.length ? mergedGroups : undefined,
            // 计划语义下拿到一份像样的清单 → 打「待确认」标记，渲染端亮「继续执行」按钮。
            // 失败或模型直接动手（不像计划）时不打标记：没有可确认的方案，按钮亮出来反而误导。
            plan: wasPlanTurn && !failed && looksLikePlan(base) ? true : undefined,
            // 失败必显文案：气泡为空写完整错误；已有内容（如回落提示）在末尾追加错误详情。
            content: failed
              ? (base ? `${base}\n\n请求失败：${event.message}` : `请求失败：${event.message}`)
              : base
          };
        }));
      }
      if (targetId) {
        setGeneratingIds((all) => all.filter((id) => id !== targetId));
        sendingRef.current.delete(targetId);
      }
      if (!event.ok && event.message) onError(new Error(event.message));
    });
    // 智能体经 generate_video 建好任务：卡片按"本次工具调用的批次"分组挂到气泡上（候选 3：多任务分组）。
    const offTasks = window.h3.onLlmTasks((event) => {
      const targetId = event.sessionId;
      if (!targetId) return;
      // 缓冲整组（事件可能早于 React 提交到达，收尾统一并入）。
      taskIdBuffers.current.set(targetId, [...(taskIdBuffers.current.get(targetId) ?? []), ...event.taskIds]);
      // 实时显示：把本次批次作为一个新组追加（工具可能在一轮里多次调用）。
      setSessions((all) => patchLast(all, targetId, (msg) => ({ ...msg, taskGroups: [...(msg.taskGroups ?? []), event.taskIds] })));
    });
    // 上下文被压缩（自动或手动）：在对话流里插一条系统提示，让用户知道历史被摘要过了。
    // 不静默——历史被改写是用户可感知的变化，必须可见（CLAUDE.md「失败必须可见」的同一条纪律）。
    // 插入位置：正在流式的助手气泡**之前**。自动压缩发生在流式开始前，若直接追加到末尾，
    // 之后每个 llm:chunk 的 patchLast 都会写进这条提示而不是回复气泡（流式内容错位）。
    const offCompaction = window.h3.onLlmCompaction((event) => {
      const targetId = event.sessionId;
      if (!targetId) return;
      const notice: PlaygroundMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        // 打上标记：这条只给用户看，不能进历史发给模型（否则后续每轮都复述这句系统提示）。
        notice: true,
        content: `（${event.reason}：上下文已从约 ${formatTokens(event.before)} 压到约 ${formatTokens(event.after)}，保留最近对话 + 交接摘要；此前细节以摘要形式保留）`
      };
      setSessions((all) => all.map((session) => {
        if (session.id !== targetId) return session;
        const messages = session.messages;
        const last = messages[messages.length - 1];
        const insertAt = last?.streaming ? messages.length - 1 : messages.length;
        return { ...session, messages: [...messages.slice(0, insertAt), notice, ...messages.slice(insertAt)] };
      }));
    });
    // 步骤清单更新（update_plan）：整份替换，不是增量。模型每完成一步就重发全量，
    // 渲染端直接覆盖即可——累积拼接会让"已完成"永远追不上实际状态。
    const offPlan = window.h3.onLlmPlan((event) => {
      const targetId = event.sessionId;
      if (!targetId) return;
      setSessions((all) => patchLast(all, targetId, (msg) => ({ ...msg, planSteps: event.plan })));
    });
    // 交互提问（request_user_input）：挂到当前气泡上渲染选择卡片。
    // 此刻主进程的工具循环正挂起等 answerLlmQuestion——用户不点，这一轮就不会往下走。
    const offQuestion = window.h3.onLlmQuestion((event) => {
      const targetId = event.sessionId;
      if (!targetId) return;
      setSessions((all) => patchLast(all, targetId, (msg) => ({
        ...msg,
        questions: { requestId: event.requestId, questions: event.questions }
      })));
    });
    // 产出文件（create_file）：只拿到元数据，内容在磁盘上。追加到当前气泡的产物列表
    // （一次回复可能产出多个文件，故用数组而不是单个字段）。
    const offArtifact = window.h3.onLlmArtifact((event) => {
      const targetId = event.sessionId;
      if (!targetId) return;
      setSessions((all) => patchLast(all, targetId, (msg) => ({
        ...msg,
        artifacts: [...(msg.artifacts ?? []), { name: event.name, path: event.path, size: event.size, kind: event.kind }]
      })));
    });
    return () => { offChunk(); offDone(); offTasks(); offTool(); offCompaction(); offPlan(); offQuestion(); offArtifact(); };
  }, []);
  // 粘底自动滚动：仅在用户接近底部时跟随。用户在流式期间往上翻看历史时，不再被每个
  // chunk 拽回底部；一旦他滚回接近底部，恢复自动跟随。
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [active?.messages.length, active?.messages[active.messages.length - 1]?.content]);
  // 切会话时回到"贴底"：新打开的会话应显示最新消息，而不是沿用上一个会话的滚动位置状态。
  useEffect(() => { stickToBottomRef.current = true; }, [activeId]);
  // 新会话创建完成后释放"正在建会话"哨兵（此时 active 已就绪，守卫由 sendingRef 接管）。
  useEffect(() => { if (activeId) creatingSessionRef.current = false; }, [activeId]);
  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 距底部 48px 内视为"贴底"（给一点容差，避免像素级抖动导致跟随断掉）。
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // 会话回收站过期清理：启动时清除超过 7 天的已删除会话。
  useEffect(() => {
    const now = Date.now();
    setSessions((all) => {
      const kept = all.filter((s) => !s.deletedAt || now - new Date(s.deletedAt).getTime() <= 7 * 86_400_000);
      return kept.length === all.length ? all : kept;
    });
  }, []);

  function patchLast(all: PlaygroundSession[], id: string, patch: (msg: PlaygroundMessage) => PlaygroundMessage): PlaygroundSession[] {
    return all.map((session) => session.id !== id ? session : { ...session, messages: session.messages.map((msg, i) => i === session.messages.length - 1 ? patch(msg) : msg) });
  }

  // 切换会话：若当前会话是空对话（没真的聊过天），切换时即永久删除——不留空壳在列表里。
  function switchSession(id: string) {
    const leavingId = active?.id;
    setSessions((all) => all.filter((s) => !(s.id === leavingId && s.id !== id && s.messages.length === 0)));
    setActiveId(id);
  }

  function newSession() {
    const session: PlaygroundSession = { id: crypto.randomUUID(), title: "新对话", messages: [], createdAt: new Date().toISOString() };
    // 空对话最多只保留一个：新建时顺手清掉已有的空会话（用户没打过字就点了"新对话"的情况）。
    setSessions((all) => [session, ...all.filter((s) => s.messages.length > 0)]);
    setActiveId(session.id);
    setInput("");
    setAttachments([]);
  }

  async function pickAttachment() {
    // IPC 可能 reject（不只是 ok:false）；不兜住的话点「附件」毫无反应。
    try {
      const response = await window.h3.selectFile("attachment");
      if (!response.data) return;
      const payload = await window.h3.readAttachment(response.data);
      if (!payload.data) { onError(new Error(payload.message || "读取附件失败")); return; }
      if (payload.data.kind === "other") { onNotice(`已添加附件 ${payload.data.name}（此类型仅作为文件名提示发送）`); }
      setAttachments((all) => [...all, { name: payload.data!.name, dataUrl: payload.data!.dataUrl, text: payload.data!.text }]);
    } catch (error) {
      onError(error);
    }
  }

  /** 当前会话传给主进程的历史（与 send() 里构造的完全一致，使压缩记账锚定同一份消息）。 */
  function activeThreadMessages(): ChatMessage[] {
    if (!active) return [];
    // notice 是纯界面提示（如"上下文已压缩"），不能进历史——否则模型会把系统提示当自己说过的话复述。
    return active.messages.filter((m) => !m.error && !m.notice).map((m) => ({ role: m.role, content: m.content, images: m.images }));
  }

  /** 手动压缩：对齐 Codex 的 Manual trigger。压缩事件由主进程推回，气泡里的提示统一样式。 */
  async function manualCompact() {
    if (!activeId || compacting || generating) return;
    setCompacting(true);
    try {
      const response = await window.h3.compactContext(activeThreadMessages(), activeId);
      if (!response.ok) throw new Error(response.message || "压缩失败");
      const refreshed = await window.h3.getContextStatus(activeThreadMessages(), activeId);
      if (refreshed.ok) setContextStatus(refreshed.data);
    } catch (error) {
      onError(error);
    } finally {
      setCompacting(false);
    }
  }

  async function send() {
    const text = input.trim();
    // generating 是异步 React state：同一 tick 内连发两次（快速连按 Enter/双击发送）会双双读到 false，
    // 于是重复落用户消息、两条流抢同一个缓冲区。用 Set 做同步守卫（按会话粒度，不影响其它会话并发）。
    //
    // ⚠️ 首条消息时会话还不存在（active 为 undefined），按会话 id 守卫会短路成 false——
    // 实测双击「新对话」的首条消息会建出**两个会话、发两次请求**（probe-single-vs-double）。
    // 故无 active 时用 creatingSessionRef 这个同步哨兵挡住第二次点击。
    if (!text && attachments.length === 0) return;
    if (active) {
      if (generatingIds.includes(active.id) || sendingRef.current.has(active.id)) return;
    } else if (creatingSessionRef.current) {
      // 第一次点击已经进入"新建会话"流程，第二次点击必须被挡住。
      // 这个哨兵要**一直保持到 activeId 真正切换**（见下面重置的 useEffect），
      // 不能在 send() 里立即复位——React 是异步提交，同 tick 内 active 仍是 undefined。
      return;
    }
    if (!settings.llm.baseUrl) { onError(new Error("请先在连接设置中配置游乐场 LLM。")); return; }
    // 无会话时先本地创建会话对象再继续（不 return），避免首条消息被丢弃。
    let session = active;
    if (!session) {
      creatingSessionRef.current = true;
      session = { id: crypto.randomUUID(), title: text.slice(0, 20) || "新对话", messages: [], createdAt: new Date().toISOString() };
      setSessions((all) => [session as PlaygroundSession, ...all]);
      setActiveId(session.id);
    }
    const sessionId = session.id;
    sendingRef.current.add(sessionId);
    const userImages = attachments.map((a) => a.dataUrl).filter((url): url is string => Boolean(url));
    const extraText = attachments.map((a) => a.text ? `\n\n--- 附件 ${a.name} ---\n${a.text}` : `\n\n（附件：${a.name}）`).join("");
    const userMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "user", content: text + extraText, images: userImages.length ? userImages : undefined };
    const assistantMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "assistant", content: "", streaming: true };
    // 计划模式（用户点了「📋 计划」）：本轮只出方案，主进程会摘掉副作用工具并注入计划提示词。
    const planArg: PlanMode = planNext ? "plan" : undefined;
    if (planArg) planTurnRef.current.add(sessionId);
    const history: ChatMessage[] = [...(session.messages).filter((m) => !m.error && !m.notice).map((m) => ({ role: m.role, content: m.content, images: m.images })), { role: "user", content: userMsg.content, images: userMsg.images }];
    setSessions((all) => all.map((s) => s.id === sessionId ? { ...s, title: s.messages.length === 0 && text ? text.slice(0, 20) : s.title, updatedAt: new Date().toISOString(), messages: [...s.messages, userMsg, assistantMsg] } : s));
    setInput(""); setAttachments([]); setPlanNext(false);
    setGeneratingIds((all) => all.includes(sessionId) ? all : [...all, sessionId]);
    streamBuffers.current.set(sessionId, "");
    taskIdBuffers.current.delete(sessionId);
    // IPC 调用本身可能**抛异常**（主进程 handler 崩了、通道被销毁），而不只是返回 ok:false。
    // 不兜住的话 sendingRef / generatingIds 永远留着 → 该会话之后再也发不出消息
    // （界面停在「停止」、发送按钮禁用，实测 probe-send-deadlock 复现）。
    try {
      const result = await window.h3.chatLlm(history, webSearch, agentMode, sessionId, browserSearch, planArg);
      if (!result.ok) {
        setGeneratingIds((all) => all.filter((id) => id !== sessionId));
        sendingRef.current.delete(sessionId);
        setSessions((all) => patchLast(all, sessionId, (msg) => ({ ...msg, streaming: false, error: true, content: msg.content || `请求失败：${result.message || "未知错误"}` })));
      }
    } catch (error) {
      // 失败必须让人看见（CLAUDE.md）：气泡里写明原因，同时把守卫清干净。
      setGeneratingIds((all) => all.filter((id) => id !== sessionId));
      sendingRef.current.delete(sessionId);
      planTurnRef.current.delete(sessionId);
      setSessions((all) => patchLast(all, sessionId, (msg) => ({ ...msg, streaming: false, error: true, content: msg.content || `请求失败：${describeError(error, "未知错误")}` })));
      onError(error);
    }
  }

  /**
   * 继续执行：把上一轮的计划当方案确认，以 execute 语义重发同一份历史。
   * 不新增用户气泡（用户并没有输入新内容）——只在发给模型的历史末尾补一句确认指令。
   */
  async function executePlan() {
    const target = active;
    if (!target || generatingIds.includes(target.id) || sendingRef.current.has(target.id)) return;
    const planMsg = [...target.messages].reverse().find((m) => m.role === "assistant" && !m.streaming && m.plan);
    if (!planMsg) return;
    sendingRef.current.add(target.id);
    const assistantMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "assistant", content: "", streaming: true };
    const history: ChatMessage[] = [
      ...target.messages.filter((m) => !m.error && !m.notice).map((m) => ({ role: m.role, content: m.content, images: m.images })),
      { role: "user", content: "按上面的计划执行。" }
    ];
    // 该计划消息去掉"待确认"标记（已确认），避免按钮重复出现。
    setSessions((all) => all.map((s) => s.id !== target.id ? s : {
      ...s,
      updatedAt: new Date().toISOString(),
      messages: [...s.messages.map((m) => m.id === planMsg.id ? { ...m, plan: undefined } : m), assistantMsg]
    }));
    setGeneratingIds((all) => all.includes(target.id) ? all : [...all, target.id]);
    streamBuffers.current.set(target.id, "");
    taskIdBuffers.current.delete(target.id);
    // 与 send() 同理：IPC 抛异常时必须清守卫，否则该会话永久发不出消息。
    try {
      const result = await window.h3.chatLlm(history, webSearch, agentMode, target.id, browserSearch, "execute");
      if (!result.ok) {
        setGeneratingIds((all) => all.filter((id) => id !== target.id));
        sendingRef.current.delete(target.id);
        setSessions((all) => patchLast(all, target.id, (msg) => ({ ...msg, streaming: false, error: true, content: msg.content || `请求失败：${result.message || "未知错误"}` })));
      }
    } catch (error) {
      setGeneratingIds((all) => all.filter((id) => id !== target.id));
      sendingRef.current.delete(target.id);
      setSessions((all) => patchLast(all, target.id, (msg) => ({ ...msg, streaming: false, error: true, content: msg.content || `请求失败：${describeError(error, "未知错误")}` })));
      onError(error);
    }
  }

  async function stop() {
    // 只中止当前会话；其它会话的生成不受影响（并发场景下不能连坐）。
    // 本地状态**无条件**清理：IPC 即使抛异常，界面也必须退出"生成中"，
    // 否则用户点了停止却仍卡在转圈（且发送按钮一直禁用）。
    try {
      await window.h3.abortLlm(activeId);
    } catch (error) {
      onError(error);
    } finally {
      setGeneratingIds((all) => all.filter((id) => id !== activeId));
      sendingRef.current.delete(activeId);
      setSessions((all) => patchLast(all, activeId, (msg) => ({ ...msg, streaming: false })));
    }
  }

  /**
   * 回传选择题答案。主进程的工具循环正挂起等这个调用。
   * 无论成功与否都把卡片摘掉：留着会让用户以为还能再答一次，而那个 requestId 早已落定。
   */
  async function answerQuestions(requestId: string, answers: Record<string, string[]>) {
    setSessions((all) => all.map((session) => session.id !== activeId ? session : {
      ...session,
      messages: session.messages.map((msg) => msg.questions?.requestId === requestId ? { ...msg, questions: undefined } : msg)
    }));
    try {
      const result = await window.h3.answerLlmQuestion(requestId, answers);
      // 返回 false 通常是超时竞态（用户点得太慢），不是错误——提示一下即可，不弹红色报错。
      if (!result.ok || !result.data) onNotice("这组问题已经超时或结束了，AI 会按最合理的方式继续。");
    } catch (error) {
      onError(error);
    }
  }

  /** 跳过整组问题：立即放行工具循环，不必干等超时。 */
  async function skipQuestions(requestId: string) {
    setSessions((all) => all.map((session) => session.id !== activeId ? session : {
      ...session,
      messages: session.messages.map((msg) => msg.questions?.requestId === requestId ? { ...msg, questions: undefined } : msg)
    }));
    try {
      await window.h3.skipLlmQuestion(requestId);
    } catch (error) {
      onError(error);
    }
  }

  async function submitVideo() {
    let session = active;
    if (!session) {
      session = { id: crypto.randomUUID(), title: "视频生成", messages: [], createdAt: new Date().toISOString() };
      setSessions((all) => [session as PlaygroundSession, ...all]);
      setActiveId(session.id);
    }
    // 表单提示词留空时用聊天框内容兜底——摘要与气泡必须用**实际提交的那个**，
    // 否则用户看到的"已提交视频生成：___"是空的，事后无法核对提交了什么（实测 probe-submit-video-prompt）。
    const effectivePrompt = videoRequest.prompt || input.trim();
    let result;
    try {
      result = await window.h3.submitGeneration({ ...videoRequest, prompt: effectivePrompt });
    } catch (error) {
      onError(error);
      return;
    }
    if (!result.ok) { onError(result.message); return; }
    const taskIds = result.data?.map((task) => task.id) ?? [];
    const summary = `已提交视频生成（${backendLabel(videoRequest.backend)}${videoRequest.preset ? ` · ${rbPresetLabel(videoRequest.preset)}` : ""}）：${effectivePrompt.slice(0, 60)}${effectivePrompt.length > 60 ? "…" : ""}`;
    const assistantMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "assistant", content: summary, taskGroups: taskIds.length ? [taskIds] : undefined };
    const stamp = new Date().toISOString();
    setSessions((all) => all.map((s) => s.id === session!.id ? { ...s, updatedAt: stamp, messages: [...s.messages, { id: crypto.randomUUID(), role: "user" as const, content: `🎬 生成视频：${effectivePrompt.slice(0, 80)}` }, assistantMsg] } : s));
    setShowVideoForm(false);
    onNotice(`已创建 ${videoRequest.count} 个生成任务`);
  }

  const activeTasks = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  // 会话回收站 + 分类：visibleSessions 只显示未删除会话；trashSessions 供回收站面板展示。
  // 排序按最近使用倒序（刚发过消息的排最前），并发时正在生成的会话自然浮到顶部。
  const visibleSessions = useMemo(() => {
    const recency = (s: PlaygroundSession) => s.updatedAt || s.createdAt;
    return sessions.filter((s) => !s.deletedAt).slice().sort((a, b) => recency(b).localeCompare(recency(a)));
  }, [sessions]);
  const trashSessions = useMemo(() => sessions.filter((s) => s.deletedAt), [sessions]);
  const categories = useMemo(() => Array.from(new Set(visibleSessions.map((s) => s.category).filter((c): c is string => Boolean(c)))), [visibleSessions]);
  const [sessionFilter, setSessionFilter] = useState<string>("全部");
  const [showPgTrash, setShowPgTrash] = useState(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const filteredSessions = sessionFilter === "全部" ? visibleSessions : visibleSessions.filter((s) => s.category === sessionFilter);
  // 「分类 > 会话」二级分组（对齐 Codex Desktop 的 项目 > 对话 层级）。
  // 只在真的有分类时才分组——全未分类时保持扁平渲染，避免凭空多一层无信息量的标题。
  // 同组内沿用 filteredSessions 的最近使用顺序，跨组顺序按分类名。
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const sessionGroups = useMemo(() => {
    const ungrouped = "未分类";
    const groups = new Map<string, PlaygroundSession[]>();
    for (const session of filteredSessions) {
      const key = session.category || ungrouped;
      const bucket = groups.get(key);
      if (bucket) bucket.push(session); else groups.set(key, [session]);
    }
    // 未分类永远排最后（有分类的先展示，符合"我分过类的是重点"的直觉）。
    return [...groups.entries()]
      .sort(([a], [b]) => (a === ungrouped ? 1 : b === ungrouped ? -1 : a.localeCompare(b)))
      .map(([label, sessions]) => ({ label, sessions }));
  }, [filteredSessions]);
  const grouped = sessionGroups.length > 1;
  // 运行面板：扁平收集当前会话的工具步骤（跨气泡、按时间顺序），最近 8 条。
  const [showRuns, setShowRuns] = useState(false);
  const recentRuns = useMemo(
    () => (active?.messages ?? []).flatMap((msg) => msg.toolSteps ?? []).slice(-8).reverse(),
    [active?.messages]
  );
  const current = visibleSessions.find((s) => s.id === activeId);
  // 当前会话被删除/过滤时自动落到列表第一个。
  useEffect(() => {
    if (activeId && !visibleSessions.some((s) => s.id === activeId)) setActiveId(visibleSessions[0]?.id || "");
  }, [visibleSessions, activeId]);
  function deleteSession(session: PlaygroundSession) {
    // 正在生成时不允许删除（否则流事件会写进已被删掉的会话）。但必须给反馈——
    // 早先这里是静默 return，用户点删除"毫无反应"，无从判断是坏了还是被拦了。
    if (generatingIds.includes(session.id)) {
      onNotice("该会话正在生成回复，请先点「停止」再删除。");
      return;
    }
    setSessions((all) => all.map((s) => s.id === session.id ? { ...s, deletedAt: new Date().toISOString() } : s));
    onNotice("会话已移入回收站，7 天内可恢复");
  }
  function restoreSession(session: PlaygroundSession) {
    setSessions((all) => all.map((s) => s.id === session.id ? { ...s, deletedAt: undefined } : s));
    setActiveId(session.id);
  }
  function purgeSession(session: PlaygroundSession) {
    setSessions((all) => all.filter((s) => s.id !== session.id));
  }
  function commitRename() {
    if (!renamingId) return;
    const title = renameDraft.trim().slice(0, 40);
    if (title) setSessions((all) => all.map((s) => s.id === renamingId ? { ...s, title } : s));
    setRenamingId(undefined);
  }
  // 会话分类：同样改为内联输入（window.prompt 在 Electron 中不可用）。
  const [catSessionId, setCatSessionId] = useState<string>();
  const [catSessionDraft, setCatSessionDraft] = useState("");
  function commitSessionCategory() {
    if (!catSessionId) return;
    const normalized = catSessionDraft.trim().slice(0, 20);
    setSessions((all) => all.map((s) => s.id === catSessionId ? { ...s, category: normalized || undefined } : s));
    setCatSessionId(undefined);
  }

  /** 单个会话条目（分组与扁平两种渲染共用，避免两处 JSX 漂移）。 */
  function renderSessionItem(session: PlaygroundSession, indented: boolean) {
    const running = generatingIds.includes(session.id);
    return <div key={session.id} className={`pg-session${session.id === activeId ? " active" : ""}${running ? " running" : ""}${indented ? " indented" : ""}`}>
      {renamingId === session.id
        ? <input className="pg-rename" autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenamingId(undefined); }} onFocus={(e) => e.target.select()} />
        : catSessionId === session.id
        ? <input className="pg-rename" autoFocus value={catSessionDraft} placeholder="分类名（留空清除）" onChange={(e) => setCatSessionDraft(e.target.value)} onBlur={commitSessionCategory} onKeyDown={(e) => { if (e.key === "Enter") commitSessionCategory(); if (e.key === "Escape") setCatSessionId(undefined); }} onFocus={(e) => e.target.select()} />
        : <button className="pg-session-body" onClick={() => { switchSession(session.id); }} onDoubleClick={() => { setRenamingId(session.id); setRenameDraft(session.title || "新对话"); }} title="双击重命名">
          <strong>{session.title || "新对话"}</strong>
          <small>
            {running && <span className="pg-dot" aria-hidden />}
            {/* 已分组时不再重复分类名（分组标题已经写了）；未分组时才带出来。 */}
            {running ? "正在回复…" : `${session.messages.length} 条消息`}{!grouped && session.category ? ` · ${session.category}` : ""}
          </small>
        </button>}
      {/* 最近使用时间：对齐 Codex 侧栏的时间戳，多会话并发时能一眼看出先后。 */}
      <time className="pg-session-time" dateTime={sessionRecency(session)}>{formatClock(sessionRecency(session))}</time>
      <div className="pg-session-tools">
        <button className="pg-tool" title="重命名" onClick={() => { setRenamingId(session.id); setRenameDraft(session.title || "新对话"); }}>✎</button>
        <button className="pg-tool" title="设置分类" onClick={() => { setCatSessionId(session.id); setCatSessionDraft(session.category || ""); }}>🏷</button>
        <button className="pg-tool" title="删除会话（可在回收站恢复 7 天）" onClick={() => deleteSession(session)}>×</button>
      </div>
    </div>;
  }

  return <section className="page playground"><div className="page-title"><div><span className="eyebrow">PLAY</span><h1>游乐场</h1></div><button className="primary" onClick={newSession}>新对话</button></div>
    <div className="playground-layout">
      <aside className="pg-sessions">
        <div className="pg-session-filter">
          <button className={sessionFilter === "全部" ? "on" : ""} onClick={() => setSessionFilter("全部")}>全部</button>
          {categories.map((c) => <button key={c} className={sessionFilter === c ? "on" : ""} onClick={() => setSessionFilter(c)}>{c}</button>)}
          <button className={sessionFilter === "__trash" ? "on" : ""} onClick={() => setShowPgTrash(true)}>🗑 回收站{trashSessions.length > 0 ? ` (${trashSessions.length})` : ""}</button>
        </div>
        {filteredSessions.length === 0 && trashSessions.length === 0 && <p className="footnote">还没有对话。点击右上角"新对话"开始。</p>}
        {sessionGroups.map(({ label, sessions: groupSessions }) => {
          const collapsed = collapsedGroups.includes(label);
          return <div key={label} className="pg-group">
            {grouped && label !== "未分类" && <button
              className={`pg-group-head${collapsed ? " collapsed" : ""}`}
              onClick={() => setCollapsedGroups((all) => all.includes(label) ? all.filter((x) => x !== label) : [...all, label])}
              title={collapsed ? "展开分组" : "收起分组"}
            ><span className="pg-group-arrow">{collapsed ? "▸" : "▾"}</span>{label}<span className="pg-group-count">{groupSessions.length}</span></button>}
            {!collapsed && groupSessions.map((session) => renderSessionItem(session, grouped && label !== "未分类"))}
          </div>;
        })}
      </aside>
      {showPgTrash && <PgTrashPanel sessions={trashSessions} onRestore={restoreSession} onPurge={purgeSession} onClose={() => setShowPgTrash(false)} retentionDays={7} />}
      <div className="pg-main">
        <div className="pg-chat">
        <div className="pg-messages" ref={scrollRef} onScroll={onMessagesScroll}>
          {!active || active.messages.length === 0 ? <div className="pg-empty"><strong>和 AI 聊聊视频创意</strong><span>让它帮你润色提示词、答疑，或直接在对话里生成视频。先到「连接设置」配置 LLM。</span></div>
            : active.messages.map((msg) => <div key={msg.id} className={`pg-msg ${msg.role}${msg.error ? " error" : ""}`}>
              {msg.role === "user" && msg.images?.map((url, i) => <img key={i} className="pg-thumb" src={url} alt="附件" />)}
              <div className="pg-bubble">{msg.toolSteps && msg.toolSteps.length > 0 && <PgToolSteps steps={msg.toolSteps} running={Boolean(msg.streaming)} />}{msg.content ? renderMarkdown(msg.content) : msg.streaming ? <span className="pg-cursor" /> : <em>（空回复）</em>}{msg.streaming && msg.content && <span className="pg-cursor" />}{(() => {
                // 优先用主进程推来的已落盘产物（元数据，内容在磁盘上）。
                // 回落到扫描正文围栏：兼容历史消息，以及模型没用工具、直接在回复里写文件内容的老路径。
                if (msg.role === "assistant" && msg.artifacts?.length) {
                  return msg.artifacts.map((a, i) => <PgArtifactCard
                    key={`${msg.id}-art-${i}`}
                    kind={a.kind}
                    saved={{ name: a.name, path: a.path, size: a.size, kind: a.kind, content: "" }}
                    sessionId={activeId}
                    onPreview={setPreview}
                    onError={onError}
                  />);
                }
                // 产物三探测（html > 表格 > 文档）：流式未结束先不亮，避免半截内容。
                const artifact = msg.role === "assistant" && !msg.streaming ? extractArtifact(msg.content) : undefined;
                return artifact && <PgArtifactCard kind={artifact.kind} content={artifact.content} sessionId={activeId} onPreview={setPreview} onError={onError} />;
              })()}</div>
              {/* 步骤清单：常驻显示（不折叠）——它是用户判断"它做得对不对"的主要依据。 */}
              {msg.planSteps && msg.planSteps.length > 0 && <PgPlanSteps steps={msg.planSteps} />}
              {/* 选择题：主进程此刻挂起等回答，所以必须给「跳过」出口。 */}
              {msg.questions && <PgQuestionCard
                questions={msg.questions.questions}
                onSubmit={(answers) => void answerQuestions(msg.questions!.requestId, answers)}
                onSkip={() => void skipQuestions(msg.questions!.requestId)}
              />}
              {/* 计划待确认：模型在计划模式下交出了一份像样的清单，用户点头才开工。
                  不自动执行——计划模式的全部意义就是把"做之前先看一眼"这个闸门交给用户。 */}
              {msg.plan && <div className="pg-plan-actions">
                <button className="pg-plan-run" disabled={generating} onClick={executePlan} title="按上面的计划开始执行（会把这份计划原样交给模型接着做）">▶ 继续执行</button>
                <span className="pg-plan-hint">确认后才会真正创建视频/文件</span>
              </div>}
              {msg.taskGroups && msg.taskGroups.length > 0 && msg.taskGroups.map((group, gi) => group.length > 0 && <div key={`${msg.id}-${gi}`} className="result-grid pg-task-grid">{group.map((taskId, i) => <TaskCard key={taskId} task={activeTasks.get(taskId)} index={i % 4} onError={onError} allowDemoPlaceholder={false} />)}</div>)}
            </div>)}
          <div ref={bottomRef} />
        </div>
        {/* 运行面板（对齐 Codex Desktop 底部可折叠面板的骨架）：默认收起，只占一行。
            数据直接复用气泡里的 toolSteps——不新增数据源，也就不会与气泡显示不一致。 */}
        <div className={`pg-runs${showRuns ? " open" : ""}`}>
          <button className="pg-runs-head" onClick={() => setShowRuns(!showRuns)} title={showRuns ? "收起运行记录" : "展开运行记录"}>
            <span className="pg-runs-arrow">{showRuns ? "▾" : "▸"}</span>
            运行面板
            {recentRuns.length > 0 && <span className="pg-runs-last">{recentRuns[recentRuns.length - 1]}</span>}
          </button>
          {showRuns && (recentRuns.length === 0
            ? <p className="pg-runs-empty">本会话还没有工具调用。开启「联网」或「智能体」后，这里会记录每一步。</p>
            : <ol className="pg-runs-list">{recentRuns.map((run, i) => <li key={`${i}-${run}`}>{run}</li>)}</ol>)}
        </div>
        <div className="pg-composer">
          {showVideoForm && <div className="pg-video-form">
            <div className="form-grid">
              <label>生成后端<select value={videoRequest.backend} onChange={(e) => { const backend = e.target.value as BackendKind; const preset = undefined; setVideoRequest({ ...videoRequest, backend, preset, duration: clampDuration(videoRequest.duration, durationOptionsFor(backend, preset)) }); }}>{(["local", "ssh", "minimax", "rb"] as BackendKind[]).map((kind) => <option key={kind} value={kind}>{backendLabel(kind)}</option>)}</select></label>
              {videoDurationOptions.length > 0 && <label>时长<select value={videoRequest.duration} onChange={(e) => setVideoRequest({ ...videoRequest, duration: Number(e.target.value) })}>{videoDurationOptions.map((x) => <option key={x} value={x}>{x} 秒</option>)}</select></label>}
              <label>结果数量<select value={videoRequest.count} onChange={(e) => setVideoRequest({ ...videoRequest, count: Number(e.target.value) })}>{[1, 2, 3, 4].map((x) => <option key={x} value={x}>{x} 路</option>)}</select></label>
            </div>
            <label>视频描述（留空则使用下方聊天输入内容）<textarea rows={2} maxLength={MAX_PROMPT_LENGTH} value={videoRequest.prompt} onChange={(e) => setVideoRequest({ ...videoRequest, prompt: e.target.value })} /></label>
            <button className="primary" onClick={submitVideo}>提交生成任务</button>
          </div>}
          {attachments.length > 0 && <div className="pg-attachments">{attachments.map((a, i) => <span key={i} className="pg-attachment">{a.dataUrl ? <img src={a.dataUrl} alt={a.name} /> : `📄 ${a.name}`}<button onClick={() => setAttachments((all) => all.filter((_, j) => j !== i))}>×</button></span>)}</div>}
          {/* 单框内嵌工具条（对齐 Codex 的 composer 形态）：输入框与发送键同框，工具 chips 在框下。
              保留 .pg-input-row / .primary 类名——E2E 与既有样式都按它们定位，改类名等于无谓的回归面。 */}
          <div className="pg-input-row">
            <textarea rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder={generating ? "AI 正在回复…" : "输入消息，Enter 发送，Shift+Enter 换行"} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <button className="primary" aria-label={generating ? "正在回复" : "发送"} title={generating ? "正在回复" : "发送（Enter）"} disabled={generating || (!input.trim() && attachments.length === 0)} onClick={send}>{generating ? "■" : "▲"}</button>
          </div>
          <div className="pg-chips">
            <button className={webSearch ? "pg-chip on" : "pg-chip"} title="联网搜索：未配置搜索 API 时自动回落到免 key 抓取 Bing/搜狗（稳定性一般，配了 API 更可靠）" onClick={() => setWebSearch(!webSearch)}>🌐 联网{searchReady ? "" : "（免 key 抓取）"}</button>
            <button className={browserSearch ? "pg-chip on" : "pg-chip"} title="浏览器搜索：用应用自带的浏览器真实打开搜索页再读取结果（最接近人工浏览，结果质量最稳，速度稍慢）；与「联网」同开时优先用浏览器渲染" onClick={() => setBrowserSearch(!browserSearch)}>🖥 浏览器搜索</button>
            <button className={agentMode ? "pg-chip on" : "pg-chip"} title="智能体模式：AI 可自主联网搜索、直接帮你提交视频生成任务（Codex/Claude Code 形态的多步工具循环）" onClick={() => setAgentMode(!agentMode)}>🤖 智能体</button>
            <button className={planNext ? "pg-chip on" : "pg-chip"} title="计划模式：本轮只出方案、不动手（生成视频与写文件两个工具本轮不下发）。看清方案后点助手消息下方的「继续执行」即可开工。" onClick={() => setPlanNext(!planNext)}>📋 计划</button>
            <button className={showVideoForm ? "pg-chip on" : "pg-chip"} onClick={() => setShowVideoForm(!showVideoForm)}>🎬 生成视频</button>
            <button className="pg-chip" onClick={pickAttachment}>📎 附件</button>
            <span className="pg-model">{settings.llm.model || "未配置模型"}{generating ? " · 生成中…" : ""}</span>
            {/* 上下文占用：分母是「模型窗口 × 80%」，100% 即自动压缩触发点。
                基线来自上游实测（server）时数字可信；纯估算（estimated）时标「估」。 */}
            {contextStatus && contextStatus.activeTokens > 0 && <button
              className={`pg-chip ctx${contextStatus.percent >= 100 ? " hot" : contextStatus.percent >= 60 ? " warm" : ""}${compacting ? " busy" : ""}`}
              title={`上下文占用约 ${formatTokens(contextStatus.activeTokens)} / ${formatTokens(contextStatus.modelLimitTokens)} token（模型窗口）${contextStatus.baselineSource === "server" ? "，数字来自上游实测" : "，数字为本地估算"}；点击立即压缩`}
              disabled={compacting || generating}
              onClick={manualCompact}
            >{compacting ? "⏳ 压缩中…" : `📦 上下文 ${contextStatus.percent}%${contextStatus.baselineSource === "server" ? "" : "（估）"}`}</button>}
            {generating && <button className="pg-chip stop" onClick={stop}>■ 停止</button>}
          </div>
        </div>
        </div>
        {preview && <PgPreviewPanel artifact={preview} onClose={() => setPreview(undefined)} width={previewWidth} onResize={resizePreview} />}
      </div>
    </div>
  </section>;
}

function rbPresetLabel(preset: string): string {
  return ({ reference: "贴合参考图", tail_frame: "首尾过渡", easy_15: "15 秒", easy_30: "30 秒", flashvsr_upscale: "视频变清晰" } as Record<string, string>)[preset] || preset;
}

// 各后端的合法时长档位。RB 预设自带约束：easy_15/30 固定时长，flashvsr 只收源视频（无时长），
// reference/tail_frame 仅 4/6/8 秒。工作台与游乐场共用同一份定义——只改一处不会两边跑偏。
function durationOptionsFor(backend: BackendKind, preset?: string): number[] {
  if (backend !== "rb") return [4, 6, 8, 10, 12, 15];
  if (preset === "easy_15") return [15];
  if (preset === "easy_30") return [30];
  if (preset === "flashvsr_upscale") return [];
  return [4, 6, 8]; // reference / tail_frame
}

// 切换后端/预设后把时长夹回该后端的合法值域。不做这一步的话，UI 下拉会被浏览器归一化到
// 第一个选项（看着像 4 秒），而 request.duration 仍是旧值，提交时才被 validateRequest 拒绝
// （"视频时长必须在 4–15 秒之间"）——用户看到的下拉值与实际提交值不一致。
// 对云后端更糟：非法的 seconds+preset 组合会真的发到服务端，失败也照样扣费。
function clampDuration(duration: number, options: number[]): number {
  if (options.length === 0 || options.includes(duration)) return duration;
  return options.reduce((best, x) => (Math.abs(x - duration) < Math.abs(best - duration) ? x : best), options[0]);
}

// 游乐场会话回收站：悬浮面板展示已删除会话（保留 7 天），支持恢复 / 彻底删除。
/** 提取消息里第一个完整 HTML 代码块（```html 或以 <!DOCTYPE/或 html> 开头的围栏块）用于产物落盘与预览。 */
function extractHtmlArtifact(content: string): string | undefined {
  const fences = [...content.matchAll(/```(\w*)\r?\n([\s\S]*?)```/g)];
  for (const [, lang, body] of fences) {
    const code = body.trim();
    if (/^html$/i.test(lang) || /^<!doctype html/i.test(code) || /^<html[\s>]/i.test(code)) return code;
  }
  return undefined;
}

type ArtifactKind = "html" | "sheet" | "doc";

/** 产物统一提取：html > 表格(csv/tsv) > 文档(markdown/docx 围栏)。一次消息只出一张卡片。
 * Word 决策：模型输出本就是纯文本/markdown——落盘 .md（卡片注明 Word 可开），真 .docx 二进制留作升级（加 docx npm 包）。 */
function extractArtifact(content: string): { kind: ArtifactKind; content: string } | undefined {
  const html = extractHtmlArtifact(content);
  if (html) return { kind: "html", content: html };
  const fences = [...content.matchAll(/```(\w*)\r?\n([\s\S]*?)```/g)];
  for (const [, lang, body] of fences) {
    const code = body.trim();
    if (/^(csv|tsv|xlsx|excel)$/i.test(lang)) {
      // CSV/TSV 围栏要有结构化数据的样子（≥2 行且含分隔符），排除随手贴的单行文本。
      // xlsx/excel 别名：create_file 工具成功后回注的围栏用模型调用的 kind 命名，可能标成 xlsx。
      const sep = /tsv/i.test(lang) ? "\t" : ",";
      if (code.split("\n").length >= 2 && code.includes(sep)) return { kind: "sheet", content: code };
    }
    if (/^(markdown|docx|doc)$/i.test(lang)) return { kind: "doc", content: code };
  }
  return undefined;
}

interface ArtifactInfo { name: string; path: string; size: number; kind: ArtifactKind; content: string }

/** 产物文件卡片：图标 + 文件名 + 大小 + 预览/打开文件夹（WorkBuddy 形态）。
 * 两种来源：① 主进程 create_file 推来的**已落盘**元数据（saved 有值，直接可用）；
 * ② 旧路径——从消息正文的围栏代码块扫出来的内容（懒落盘，首次点「预览」才写文件）。 */
function PgArtifactCard({ kind, content, saved, sessionId, onPreview, onError }: { kind: ArtifactKind; content?: string; saved?: ArtifactInfo; sessionId: string; onPreview: (artifact: ArtifactInfo) => void; onError: (e: unknown) => void }) {
  const [artifact, setArtifact] = useState<ArtifactInfo | undefined>(saved);
  const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  // 表格产物存 .xlsx（Excel 双击可开，主进程 SheetJS 转换）；文档存 .md；网页存 .html。
  const ext = kind === "html" ? ".html" : kind === "sheet" ? ".xlsx" : ".md";
  const label = kind === "html" ? "HTML 文件" : kind === "sheet" ? "Excel 表格" : "Markdown 文档 · Word 可打开";
  async function ensureSaved(): Promise<ArtifactInfo | undefined> {
    if (artifact) return artifact;
    if (content === undefined) return undefined; // 既没落盘元数据也没内容：无从保存
    const name = `artifact-${Date.now()}${ext}`;
    const saveKind = kind === "sheet" ? "xlsx" : kind === "doc" ? "md" : "html";
    // IPC 也可能**抛异常**（不只是返回 ok:false）。不兜住的话点「预览」毫无反应、
    // 也没有任何提示（与 send()/executePlan() 同一类问题）。
    try {
      const response = await window.h3.saveArtifact(sessionId, name, content, saveKind);
      if (!response.data) { onError(response.message); return undefined; }
      const info = { ...response.data, kind, content };
      setArtifact(info);
      return info;
    } catch (error) {
      onError(error);
      return undefined;
    }
  }
  return <div className="pg-artifact-card">
    <span className="pg-artifact-icon">{kind === "sheet" ? "📊" : kind === "doc" ? "📝" : "📄"}</span>
    <span className="pg-artifact-name">{artifact?.name || label}<small>{artifact ? sizeLabel(artifact.size) : `${label} · 预览时自动保存`}</small></span>
    <button title="在侧栏预览" onClick={async () => { const info = await ensureSaved(); if (info) onPreview(info); }}>预览</button>
    {artifact && <button title="在文件夹中显示" onClick={() => window.h3.showItem(artifact.path).then((r) => { if (!r.ok) onError(r.message); }).catch(onError)}>📁</button>}
  </div>;
}

/** 产物侧栏预览：占位压缩聊天区（非悬浮），左缘拖拽条可调宽度。渲染区按 kind 分支：
 * html→沙箱 iframe（走协议按路径加载，内容不进渲染端）；sheet→CSV 渲染表格；doc→renderMarkdown 文档排版。
 * sheet/doc 需要文本内容：metadata 路径下 content 为空，故按需从磁盘读（受主进程路径白名单约束）。 */
function PgPreviewPanel({ artifact, onClose, width, onResize }: { artifact: ArtifactInfo; onClose: () => void; width: number; onResize: (width: number) => void }) {
  const [nonce, setNonce] = useState(0);
  const [diskContent, setDiskContent] = useState<string>();
  const [readError, setReadError] = useState<string>();
  // 是否已读完（内容可能是合法的空串）。不区分的话，空文件会永远显示"（正在读取…）"。
  const [loaded, setLoaded] = useState(false);
  const needsContent = artifact.kind !== "html" && !artifact.content;
  useEffect(() => {
    if (!needsContent) { setLoaded(true); return; }
    let cancelled = false;
    setReadError(undefined);
    setLoaded(false);
    void window.h3.readArtifactText(artifact.path).then((r) => {
      if (cancelled) return;
      // 读取失败必须让人看见（CLAUDE.md「出错必须让人看见」）——否则面板永远停在
      // "（正在读取…）"，看起来像卡住，实际是读文件报错了（xlsx 预览整片失效就是这样被掩盖的）。
      if (r.data !== undefined) setDiskContent(r.data);
      else setReadError(r.message || "读取产物内容失败。");
      setLoaded(true);
    }).catch((e) => { if (!cancelled) { setReadError(describeError(e, "读取产物内容失败。")); setLoaded(true); } });
    return () => { cancelled = true; };
    // 依赖里带 nonce：点「↻ 重新加载」时要**真的重新读盘**。
    // 此前 nonce 只用于重挂载 DOM，表格/文档读到的是 state 里的旧内容——按钮点了像没反应
    // （只有 html 分支因为 iframe 重新加载才真的刷新）。
  }, [artifact.path, needsContent, nonce]);
  const content = artifact.content || diskContent || "";
  const dragRef = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  // 拖拽中的最新宽度：松手时用它落盘（不依赖闭包里过期的 width）。
  const latestWidthRef = useRef(width);
  latestWidthRef.current = width;
  function onDragStart(e: React.MouseEvent) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      // 向左拖增宽：面板在右侧，宽度 = 起点 + (起点X - 当前X)。
      const available = dragRef.current.startWidth + (dragRef.current.startX - ev.clientX);
      // 聊天列保底 30px：面板最宽 = pg-main 总宽 - 30，拖到底聊天列只留一线但不出"只剩弹窗"的错觉。
      const mainWidth = document.querySelector(".pg-main")?.getBoundingClientRect().width ?? 0;
      onResize(Math.max(360, Math.min(available, Math.max(360, mainWidth - 30))));
    };
    const up = () => {
      dragRef.current = undefined;
      // 松手时才写盘：拖拽时 mousemove 每秒上百次，逐次同步写 localStorage 会卡。
      savePreviewWidth(latestWidthRef.current);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  // 键盘可达性：iframe 内的游戏要能直接玩，靠两点——
  // ① 预览页必须**真的在跑**。此前用 srcDoc，而 srcdoc iframe 会继承宿主 CSP
  //    （script-src 'self'，无 unsafe-inline）→ 预览页里的内联 <script> 被拦、游戏压根没运行。
  //    这才是"不能直接玩"的真正原因（实测：摘掉宿主 CSP 后脚本立刻跑起来）。现改走 h3preview: 协议。
  // ② mount / 重载后把焦点交给 iframe：不交的话方向键落在聊天区，游戏收不到。
  //    注意 iframe.focus() 只移动**宿主侧**焦点，不等于 iframe 文档拿到焦点，
  //    故文档就绪后再补一次（早于 load 的 focus 会落空）。
  const frameRef = useRef<HTMLIFrameElement>(null);
  const focusFrame = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.focus();
    // 跨源（sandbox 不透明源）时 contentWindow.focus() 可能抛错，包起来。
    try { frame.contentWindow?.focus(); } catch { /* 不透明源不可访问；宿主侧 focus 已足够 */ }
  }, []);
  useEffect(() => { focusFrame(); }, [focusFrame, nonce]);
  const icon = artifact.kind === "sheet" ? "📊" : artifact.kind === "doc" ? "📝" : "🌐";
  return <aside className="pg-preview" style={{ width }}>
    <div className="pg-preview-drag" onMouseDown={onDragStart} title="拖动调整宽度" />
    <div className="pg-preview-bar">
      <span className="pg-preview-tab">{icon} {artifact.name}</span>
      <span className="pg-preview-actions">
        <button className="pg-tool" title="重新加载" onClick={() => setNonce((n) => n + 1)}>↻</button>
        <button className="pg-tool" title="在文件夹中显示" onClick={() => window.h3.showItem(artifact.path).catch(() => undefined)}>📁</button>
        <button className="pg-tool" title="关闭预览" onClick={onClose}>×</button>
      </span>
    </div>
    {/* HTML 预览走 h3preview: 协议**按 URL 加载**，不用 srcDoc——srcdoc iframe 会继承宿主 CSP，
        预览页的内联脚本会被拦掉（游戏跑不起来）。sandbox 保持 allow-scripts：不透明源，
        拿不到宿主 DOM 与 window.h3.* 的 IPC 面。 */}
    {artifact.kind === "html" && <iframe
      key={nonce}
      ref={frameRef}
      className="pg-preview-frame"
      sandbox="allow-scripts"
      src={`h3preview://artifact/?path=${encodeURIComponent(artifact.path)}`}
      onLoad={focusFrame}
      title={artifact.name}
    />}
    {artifact.kind === "sheet" && <div className="pg-preview-doc" key={nonce}>{readError ? <p className="pg-preview-doc-empty">读取失败：{readError}</p> : !loaded ? <p className="pg-preview-doc-empty">（正在读取…）</p> : content ? <SheetTable csv={content} /> : <p className="pg-preview-doc-empty">（这个表格没有任何内容）</p>}</div>}
    {artifact.kind === "doc" && <div className="pg-preview-doc" key={nonce}>{readError ? <p className="pg-preview-doc-empty">读取失败：{readError}</p> : !loaded ? <p className="pg-preview-doc-empty">（正在读取…）</p> : content ? renderMarkdown(content) : <p className="pg-preview-doc-empty">（这个文档没有任何内容）</p>}</div>}
  </aside>;
}

/** CSV/TSV 文本 → 表格渲染（首行表头）。渲染端简单解析，不引解析库。
 * 表格字段含逗号时，SheetJS 的 sheet_to_csv 会输出引号包裹的 CSV（如 `a,"b,c",d`）；
 * 含**换行**的字段还会变成跨行引号字段。parseCsvRows 同时处理这两种情况。 */
function SheetTable({ csv }: { csv: string }) {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) return <p className="pg-preview-doc-empty">（空表格）</p>;
  const [header, ...body] = rows;
  return <table className="pg-sheet-table">
    <thead><tr>{header.map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead>
    <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}</tbody>
  </table>;
}

/**
 * 步骤清单（update_plan 工具）：模型把任务拆解写出来，让用户看到走到哪了。
 * 与「计划模式」的区别见 PlaygroundMessage.planSteps 的注释——这里只是进度展示，不拦执行。
 * 全展开不折叠：清单通常 3–7 行，是用户判断"它做得对不对"的主要依据，藏起来就失去意义。
 */
function PgPlanSteps({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((entry) => entry.status === "completed").length;
  const icon = (status: PlanStep["status"]) => status === "completed" ? "✓" : status === "in_progress" ? "◐" : "○";
  return <div className="pg-plan-steps">
    <div className="pg-plan-steps-head">执行清单<span className="pg-plan-progress">{done}/{steps.length}</span></div>
    <ol>
      {steps.map((entry, i) => <li key={i} className={`pg-plan-step ${entry.status}`}>
        <span className="pg-plan-step-icon">{icon(entry.status)}</span>{entry.step}
      </li>)}
    </ol>
  </div>;
}

/**
 * 选择题卡片（request_user_input 工具）：模型中途问 1–3 个关键取舍。
 * 主进程此刻正挂起等回答——所以这里必须给"跳过"出口，否则用户不想答时只能干等超时（3 分钟）。
 * 单选点一下即提交（少一次点击）；多选靠复选框 + 确认按钮。
 */
function PgQuestionCard({ questions, onSubmit, onSkip }: {
  questions: LlmQuestion[];
  onSubmit: (answers: Record<string, string[]>) => void;
  onSkip: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const toggle = (question: LlmQuestion, optionId: string) => {
    setPicked((all) => {
      const current = all[question.id] ?? [];
      if (!question.multiSelect) return { ...all, [question.id]: [optionId] };
      return { ...all, [question.id]: current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId] };
    });
    // 单选：点完立刻提交这一题（只有一道题时就是提交全部，多道题时逐题落定）。
    if (!question.multiSelect && questions.length === 1) onSubmit({ [question.id]: [optionId] });
  };
  return <div className="pg-question-card">
    <div className="pg-question-head">AI 想先确认几件事</div>
    {questions.map((question) => <div key={question.id} className="pg-question">
      <div className="pg-question-title">{question.header && <span className="pg-question-chip">{question.header}</span>}{question.question}</div>
      <div className="pg-question-options">
        {question.options.map((option) => <button
          key={option.id}
          className={`pg-question-option${(picked[question.id] ?? []).includes(option.id) ? " picked" : ""}`}
          onClick={() => toggle(question, option.id)}
        >
          <strong>{option.label}</strong>
          <small>{option.description}</small>
        </button>)}
      </div>
    </div>)}
    <div className="pg-question-actions">
      {/* 多选或有多个问题时需要显式提交；单选单题已在点选时直接提交，这里不重复渲染按钮。 */}
      {!(questions.length === 1 && !questions[0].multiSelect) && <button className="pg-plan-run" onClick={() => onSubmit(picked)}>确认</button>}
      <button className="pg-question-skip" onClick={onSkip} title="不回答，让 AI 自己按最合理的方式做">跳过，你决定</button>
    </div>
  </div>;
}

/** 工具调用步骤日志（可折叠）：生成中默认展开（实时透明），完成后默认折叠为一行摘要——对标 WorkBuddy，
 * 执行细节收起来，气泡里只剩最终回答与产物文件；点摘要可随时展开回看全过程。 */
function PgToolSteps({ steps, running }: { steps: string[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  // streaming 期间强制展开（实时过程可见）；结束后用户自己控制折叠。
  const expanded = running ? true : open;
  const last = steps[steps.length - 1] || "";
  return <div className="pg-tool-steps-wrap">
    {!running && <button className="pg-tool-steps-toggle" onClick={() => setOpen((v) => !v)} title={expanded ? "收起执行过程" : "展开执行过程"}>
      <span className="pg-tool-steps-arrow">{expanded ? "▾" : "▸"}</span>已执行 {steps.length} 步工具调用<span className="pg-tool-steps-last">· {last.length > 40 ? `${last.slice(0, 40)}…` : last}</span>
    </button>}
    {expanded && <div className="pg-tool-steps">{steps.map((step, i) => <div key={i} className="pg-tool-step">{step}</div>)}</div>}
  </div>;
}

function PgTrashPanel({ sessions, onRestore, onPurge, onClose, retentionDays }: {
  sessions: PlaygroundSession[];
  onRestore: (session: PlaygroundSession) => void;
  onPurge: (session: PlaygroundSession) => void;
  onClose: () => void;
  retentionDays: number;
}) {
  const daysLeft = (iso: string) => Math.max(0, Math.ceil((retentionDays * 86_400_000 - (Date.now() - new Date(iso).getTime())) / 86_400_000));
  return <div className="pg-trash-overlay" onClick={onClose}>
    <section className="pg-trash" onClick={(e) => e.stopPropagation()}>
      <header><strong>会话回收站</strong><small>删除的会话保留 {retentionDays} 天，到期自动清除</small><button className="text-button" onClick={onClose}>关闭</button></header>
      {sessions.length === 0 && <p className="footnote">回收站是空的。</p>}
      {sessions.map((session) => <article key={session.id} className="trash-item">
        <div><strong>{session.title || "新对话"}</strong>
          <small>{session.messages.length} 条消息 · {session.deletedAt ? `${daysLeft(session.deletedAt)} 天后自动清除` : ""}</small></div>
        <div className="trash-actions">
          <button className="text-button" onClick={() => onRestore(session)}>恢复</button>
          <button className="text-button danger" onClick={() => onPurge(session)}>彻底删除</button>
        </div>
      </article>)}
    </section>
  </div>;
}

function FilePicker({ label, path, onClick }: { label: string; path?: string; onClick: () => void }) { return <button className={`file-picker ${path ? "picked" : ""}`} onClick={onClick}><span>{path ? "✓" : "+"}</span><strong>{label}</strong><small>{path ? path.split(/[\\/]/).pop() : "点击选择文件"}</small></button>; }
function upsert<T extends { id: string }>(items: T[], item: T): T[] { const index=items.findIndex((x)=>x.id===item.id); if(index<0)return[item,...items];const copy=[...items];copy[index]=item;return copy; }
async function must<T>(promise: Promise<ApiResponse<T>>): Promise<T> { const result=await promise;if(!result.ok)throw new Error(result.message||"操作失败");return result.data as T; }
function backendLabel(kind: BackendKind) { return kind === "local" ? "本机 ComfyUI" : kind === "ssh" ? "SSH 远程显卡" : kind === "rb" ? "瞬映 RB 云生成" : "MiniMax H3 云 API"; }
function statusLabel(status: GenerationTask["status"]) { return ({draft:"草稿",validating:"校验中",uploading:"上传中",queued:"排队中",running:"生成中",decoding:"解码中",downloading:"保存中",succeeded:"已完成",failed:"失败",cancelled:"已取消",interrupted:"已中断"} as const)[status]; }
function formatRuntimeRange(minMinutes: number, maxMinutes: number) { const format=(minutes:number)=>minutes>=120?`${Number((minutes/60).toFixed(minutes%60===0?0:1))} 小时`:`${minutes} 分钟`;return `${format(minMinutes)}–${format(maxMinutes)}`; }
function formatBytes(bytes?: number) { if (!bytes) return "体积未知"; return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }
