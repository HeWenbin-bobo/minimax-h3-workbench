import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiResponse, AppSettings, BackendKind, BackendTestResult, ChatMessage, ContextStatus, EnvironmentReport, GenerationMode, GenerationRequest, GenerationTask, LlmQuestion, LlmStreamEvent, LocalModelStatus, PlanStep, ResourceLink, SecretName, UpdateInfo } from "../shared/types";
import { LLM_PROVIDERS, MAX_PROMPT_LENGTH } from "../shared/types";
import { parseCsvRows } from "../shared/csv";
import { estimateCloudCost, estimateLocalRuntime } from "../shared/capabilities";
import { resolveDimensions } from "../shared/dimensions";
import { describeError } from "../shared/errors";
import { looksLikePlan, type PlanMode } from "../shared/planMode";
import { sliceSafe } from "../shared/text";
import { applyTheme, loadThemeChoice, saveThemeChoice, systemPrefersDark, themeLabel, type ThemeChoice } from "./theme";
import { renderMarkdown } from "./markdown";
import { downscaleDataUrl } from "./imageResize";

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
  // 安装包下载进度（0–100）。主进程推送 `update:progress`。
  const [updateProgress, setUpdateProgress] = useState<number>();
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
  // 提示条自动消失：此前只能手动点关闭，于是「已创建 4 个生成任务」这类
  // 一次性反馈会**永久**悬在右下角遮挡内容，直到下一次提示把它顶掉。
  // 错误给更长的时间（用户可能要读原因），普通提示 5 秒。
  // 依赖 notice 对象本身：每次 setNotice 都是新对象，effect 重跑会清掉上一个计时器，
  // 不会出现"旧提示的定时器把新提示清掉"的竞态。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), notice.error ? 12_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    Promise.all([window.h3.getSettings(), window.h3.getResourceLinks(), window.h3.listTasks()])
      .then(([s, r, t]) => {
        // `ok:false` 也要走错误路径：IPC 层把主进程异常翻成了 `{ok:false, message}`，
        // 它不是 rejection。只判 `s.data` 时，读设置失败会被静默吞掉——
        // `settings` 永远为空、界面永久停在启动页，日志里也没有任何记录。
        if (!s.data) { showError(s.message || new Error("读取设置失败。")); return; }
        setSettings(s.data);
        if (r.data) setResources(r.data);
        if (t.data) setTasks(t.data);
      }).catch(showError);
    // 任务推送：**已软删除的任务要移除，不能 upsert**。
    // 删除流程是先给 sibling 打 `deletedAt`、再 `cancel()`，而 `cancel()` 会走
    // `update()` → `listener` 推一条 `task:update`（对象里已带 deletedAt）。
    // 旧实现无条件 upsert，于是刚删掉的项目会借着这条推送"复活"回工作台列表，
    // 直到下一次 `listTasks()` 才消失——中间这段时间用户会以为删除失败又点一次。
    // 与主进程 `orchestrator.list()`（只返回未删除任务）保持同一语义。
    const offTask = window.h3.onTaskUpdate((item) => setTasks((all) => {
      if (item.deletedAt) return all.filter((task) => task.id !== item.id);
      return upsert(all, item);
    }));
    // 安装包下载进度：不订阅的话侧栏只会一直显示"正在下载更新…"，
    // 用户分不清是在走还是卡住了（100MB+ 的包按网速可能要几分钟）。
    const offProgress = window.h3.onUpdateProgress((progress) => {
      setUpdateProgress(Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : undefined);
    });
    window.h3.checkForUpdates().then((response) => {
      if (!response.data) return;
      setUpdateInfo(response.data);
      if (response.data.updateAvailable) setNotice({ text: `发现新版本 v${response.data.latestVersion}，点击左下角“下载更新”即可安装。` });
    }).catch(() => undefined);
    // 智能体框架（Vercel AI SDK）随安装包分发，版本独立于应用本体——
    // 应用不更新时也该提示框架有新版本。此前主进程与 preload 都已就绪，
    // 唯独渲染端零调用：功能存在却永远不显示（"建了模块 ≠ 接线了"）。
    window.h3.checkAgentFrameworkUpdate().then((response) => {
      if (!response.data?.updateAvailable) return;
      // 应用本身有新版时优先提示那个（一次性覆盖用户视野的提示只留一条）；
      // 框架更新会跟随应用升级一并生效，不必抢同一时刻的 toast。
      setNotice((current) => current ?? {
        text: `智能体框架有新版本 v${response.data!.latestVersion}（当前 v${response.data!.bundledVersion}），更新应用时将一并升级。`
      });
    }).catch(() => undefined);
    return () => { offTask(); offProgress(); };
  }, []);

  // 删除/恢复后同步渲染端任务列表：删掉的从本地 state 移除，恢复的重新并入。
  // 失败要报出来：用户刚点完删除/恢复，列表若保持旧值，会以为操作没生效而再点一次。
  useEffect(() => {
    const onChanged = () => window.h3.listTasks().then((r) => {
      if (r.ok && r.data) setTasks(r.data);
      else if (!r.ok) showError(r.message || "刷新任务列表失败");
    }).catch(showError);
    window.addEventListener("h3-tasks-changed", onChanged);
    return () => window.removeEventListener("h3-tasks-changed", onChanged);
  }, []);

  // 生成完成/失败系统通知：应用最小化或在后台时用户也能第一时间知道结果。
  // 只在"本会话内首次观察到该状态"时通知：历史上从没见过的任务（应用启动加载史时的记录）
  // before 为 undefined，若按"状态变成终态"判断会导致每次启动把全部历史任务重播一遍通知。
  const tasksRef = useRef<GenerationTask[]>([]);
  useEffect(() => {
    const prev = tasksRef.current;
    // 通知是**尽力而为**：`new Notification()` 在权限被拒（用户关掉了系统通知、
    // 或被策略禁用）时会按规范抛 TypeError。这行在 effect 里、没有兜底，
    // 一场任务完成就能把整个应用组件树打崩（白屏）。通知失败不该影响主流程。
    const notify = (body: string) => {
      try {
        const notification = new Notification("MiniMax H3", { body });
        // **必须走主进程**：渲染端 `window.focus()` 只能在已显示的窗口里抢焦点，
        // 窗口最小化时点了通知毫无反应（主进程 second-instance 早就用 restore/show/focus 三步）。
        notification.onclick = () => { void window.h3.focusWindow().catch(() => undefined); };
      } catch {
        // 无通知权限：界面内的任务卡片已经反映了状态，静默即可。
      }
    };
    for (const task of tasks) {
      const before = prev.find((t) => t.id === task.id);
      if (!before) continue; // 首次见到的任务不算"刚刚完成"（历史加载 / 已在别的路径通知过）
      const entered = (status: GenerationTask["status"]) => before.status !== status && task.status === status;
      if (entered("succeeded")) {
        notify(`视频生成完成：${sliceSafe(task.prompt, 40)}`);
      } else if (entered("failed")) {
        notify(`生成失败：${sliceSafe(task.prompt, 40)}（${task.message ? sliceSafe(task.message, 60) : "未知错误"}）`);
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
    setDetecting(true);
    // IPC 可能 reject（主进程 handler 异常、通道被销毁）。不兜住的话 setDetecting(false)
    // 永远不执行——按钮永久卡在「检测中…」且再也没有第二次机会（与 pickAttachment 同一类）。
    try {
      const response = await window.h3.inspectEnvironment();
      if (response.data) {
        setReport(response.data);
        setNotice({ text: `检测完成：${response.data.verdict}` });
      } else showError(response.message);
    } catch (error) {
      showError(error);
    } finally {
      setDetecting(false);
    }
  }
  async function update() {
    if (installing) return;
    if (updateInfo?.updateAvailable) {
      setInstalling(true);
      setUpdateProgress(undefined);
      setNotice({ text: "正在后台下载更新，完成后应用将自动重启安装…" });
      try {
        const response = await window.h3.downloadAndInstallUpdate();
        if (!response.ok) showError(response.message);
      } catch (error) {
        showError(error);
      } finally {
        setInstalling(false);
        setUpdateProgress(undefined);
      }
      return;
    }
    setCheckingUpdate(true);
    try {
      const response = await window.h3.checkForUpdates();
      if (!response.data) { showError(response.message); return; }
      setUpdateInfo(response.data);
      if (response.data.updateAvailable) {
        setNotice({ text: `发现新版本 v${response.data.latestVersion}，再次点击左下角即可下载。` });
      } else setNotice({ text: `当前已是最新版 v${response.data.currentVersion}` });
    } catch (error) {
      showError(error);
    } finally {
      setCheckingUpdate(false);
    }
  }
  // **启动失败必须让人看见**：`settings` 为空时界面只渲染 splash，而提示条（toast）
  // 挂在 app-shell 里、此时根本不在 DOM 中——`showError` 写进了 state 却没人显示，
  // 用户看到的是"一直在启动…"，永远等不到任何解释，也没有重试入口。
  // 这里把提示条与重试按钮一并放进 splash。
  if (!settings) return <div className="splash">
    <div className="brand-mark">H3</div>
    <p>{notice?.error ? "读取设置失败：" : "正在启动工作台…"}</p>
    {notice?.error && <>
      <p className="splash-detail">{notice.text}</p>
      <button className="primary" onClick={() => window.location.reload()}>重试</button>
    </>}
  </div>;
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
        <span className="status-dot" /><span><strong>{installing ? "正在下载更新…" : updateInfo?.updateAvailable ? "立即更新" : checkingUpdate ? "正在检查…" : "检查更新"}</strong><small>{installing ? (updateProgress === undefined ? "正在连接下载源…" : `已完成 ${updateProgress}%，完成后自动重启`) : updateInfo?.updateAvailable ? `v${updateInfo.latestVersion} 可安装` : updateInfo?.currentVersion ? `轻量版 v${updateInfo.currentVersion}` : "点击检查新版本"}</small>
          {/* 进度条要放在**文字块内部**：外层按钮是 `display:flex; align-items:center`，
              直接当第三个 flex 子元素会被排在右侧、把文字挤窄。
              文字块本身是 `display:grid`（行内再放一条即第三行，天然占满宽度）。 */}
          {installing && updateProgress !== undefined && <span className="download-progress" aria-hidden><i style={{ width: `${updateProgress}%` }} /></span>}
        </span>
      </button></aside>
    <main className="main-area">
      {page === "ready" && <ReadyPage report={report} busy={detecting} onDetect={detect} onNavigate={setPage} />}
      {page === "studio" && <StudioPage settings={settings} tasks={tasks} onError={showError} onNotice={(text) => setNotice({ text })} />}
      {page === "playground" && <PlaygroundPage settings={settings} tasks={tasks} onError={showError} onNotice={(text) => setNotice({ text })} onNavigate={setPage} />}
      {page === "downloads" && <ResourcesPage resources={resources} settings={settings} onSettingsChange={setSettings} onError={showError} />}
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
    // FFmpeg 主进程一直在检测（`hasFfmpeg`），README 与页面文案也都写着会检查，
    // 但此前**界面上从不显示**。它关系到视频后处理（抽帧、转码），缺了要让人看见。
    // 不单开一张卡（保持四卡布局与其既有断言），并入磁盘卡的副标题。
    { name: "磁盘", value: gb(report?.diskFreeBytes), sub: report ? `模型与输出可用空间 · FFmpeg ${report.ffmpegAvailable ? "已安装" : "未检测到"}` : "模型与输出可用空间" },
    { name: "ComfyUI", value: report?.comfyReachable ? `已连接 ${report.comfyVersion || ""}` : report ? "未连接" : "等待检测", sub: report?.comfyHasH3Nodes ? (report.comfyHasH3Models ? "H3 节点与 5 个模型均已就绪" : `H3 节点正常，缺少 ${report.comfyMissingH3Models.length} 个模型`) : "检测版本、节点与模型" }
  ];
  const runtimeEstimates = report ? estimateLocalRuntime(report) : [];
  return <section className="page ready-page"><header className="hero"><span className="eyebrow">SYSTEM READINESS</span><h1>先判断怎么跑，<br/><em>再开始生成。</em></h1><p>一次检查本机硬件、存储、FFmpeg 和 ComfyUI，给出本地、SSH 或云 API 的明确建议。</p><button className="primary large" onClick={onDetect} disabled={busy}>{busy ? "正在检测…" : "开始配置检测"}</button></header>
    <div className="readiness-grid">{cards.map((card) => <article className="metric-card" key={card.name}><span>{card.name}</span><strong>{card.value}</strong><small>{card.sub}</small></article>)}</div>
    {report && <div className={`verdict grade-${report.grade.toLowerCase()}`}><div className="grade">{report.grade}</div><div><span>{report.grade === "D" ? "本机运行建议" : "推荐路径"}</span><h2>{report.verdict}</h2><ul>{report.recommendations.map((x) => <li key={x}>{x}</li>)}</ul></div></div>}
    {report && <section className={`runtime-estimate ${report.grade === "D" ? "is-force-run" : ""}`}><header><div>
      {/* 文案按等级区分：只有 D 级（不建议本机运行）才叫"强行"。
          B/C 级本来就是可用的本机配置，写"强行本机运行"会让用户以为自己的机器不行
          （B 级的判定文字恰恰是"接近官方验证的本地配置"）。 */}
      <span>{report.grade === "D" ? "强行本机运行 · 时间预测" : "本机运行 · 时间预测"}</span><h2>单条 5 秒视频预计耗时</h2>
    </div><button className="secondary" onClick={() => onNavigate("studio")}>{report.grade === "D" ? "仍要强行运行" : "去工作台生成"}</button></header><p>按 20 步、INT8 生成模型与 NVFP4/AWQ 文本编码器估算，包含模型加载与解码。区间不是完成承诺。</p><div className="runtime-estimate-grid">{runtimeEstimates.map((item) => <article key={item.resolution}><span>{item.resolution}</span><strong>{formatRuntimeRange(item.minMinutes, item.maxMinutes)}</strong><small>{item.note}</small></article>)}</div></section>}
    <div className="quick-actions"><button onClick={() => onNavigate("downloads")}><span>01</span><strong>下载模型</strong><small>点击直达官方文件下载</small></button><button onClick={() => onNavigate("connections")}><span>02</span><strong>配置连接</strong><small>本机 ComfyUI / H3 云 API / SSH</small></button><button onClick={() => onNavigate("studio")}><span>03</span><strong>开始生成</strong><small>四路结果并行管理</small></button></div>
  </section>;
}

/**
 * 工作台表单草稿的模块级缓存。
 *
 * 为什么需要：`App` 用 `{page === "studio" && <StudioPage …/>}` 做页面切换，
 * 切走时组件**整个卸载**，`useState` 里的表单内容随之蒸发。
 * 用户写了一段很长的提示词、切去「模型下载」看一眼再回来，草稿就没了——
 * 而输入框里还会重新填上示例提示词，他甚至不会意识到自己写的内容已经丢失。
 * 草稿只存内存（关掉应用即丢），与"设置"是两回事，不适合进 settingsStore。
 */
let studioDraft: GenerationRequest | undefined;

function StudioPage({ settings, tasks, onError, onNotice }: { settings: AppSettings; tasks: GenerationTask[]; onError: (e: unknown) => void; onNotice: (s: string) => void }) {
  const [request, setRequest] = useState<GenerationRequest>(() => studioDraft ?? { ...initialRequest, backend: settings.defaultBackend });
  // 每次变化都写回缓存（含后端/画幅等偏好），下次挂载直接复用。
  useEffect(() => { studioDraft = request; }, [request]);
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
  // 选中值可能失效：项目被容量淘汰（MAX_TASKS）、被回收站彻底删除、
  // 或分类筛选把它隐藏后，`activeProjectId` 仍指向一个不存在的项目。
  // 此时结果区按"新建任务"渲染（`activeProject` 为空 → 占位格），
  // 但两个 tab 的选中态都靠 `activeProjectId` 判断 —— 于是**没有任何标签是高亮的**，
  // 用户不知道自己在哪个视图（与分类筛选失效那次同一类）。
  // 用派生值兜住（不做 setState 同步，避免渲染循环）：失效时视同"新建任务"。
  const activeProjectKey = activeProject ? activeProjectId : undefined;
  const isRb = request.backend === "rb";
  // 云后端（MiniMax / 瞬映）的请求体里都没有 seed 字段，由服务商自己决定随机性。
  const isCloud = request.backend === "minimax" || isRb;
  const rbPreset = request.preset || (request.firstFramePath && request.lastFramePath ? "tail_frame" : "reference");
  const setRbPreset = (preset: string) => setRequest({ ...request, preset, duration: clampDuration(request.duration, durationOptionsFor("rb", preset)) });
  const clampedCount = Math.max(1, Math.min(4, request.count));
  // 新建视图：request.count 个占位；项目视图：仅该项目任务，按 index 排序。
  const currentTasks: Array<GenerationTask | undefined> = useMemo(
    () => activeProject ? [...activeProject].sort((a, b) => a.index - b.index) : Array.from({ length: clampedCount }, () => undefined),
    [activeProject, clampedCount]
  );
  const shownCount = currentTasks.length;
  async function choose(kind: "image" | "video", field: keyof GenerationRequest) {
    // IPC 可能 reject（主进程 handler 异常、通道被销毁），也可能返回 ok:false。
    // 旧实现两者都没接：不是未处理的 rejection，就是点了「选择」毫无反应——
    // 用户分不清是没选中还是软件坏了（与 ConnectionsPage 两个选择按钮同一类，见 69028e2）。
    try {
      const response = await window.h3.selectFile(kind);
      if (!response.ok) onError(response.message || "无法打开文件选择器");
      else if (response.data) setRequest((r) => ({ ...r, [field]: response.data }));
    } catch (error) {
      onError(error);
    }
  }
  // 同步守卫：submitting 是异步 state，同一 tick 内双击会双双读到 false → 提交两次。
  // 云端后端每次提交都**真实扣费**，重复提交等于白扣（实测 probe-studio-double-submit：
  // 双击建出 2 个项目组、ComfyUI /prompt 被命中 2 次）。
  const submittingRef = useRef(false);
  async function submit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      // 画幅/分辨率必须在这里换算成实际像素：本地/SSH 的 ComfyUI 工作流与 RB 后端
      // 读的是 width/height，而两个下拉只改 ratio/resolution 字符串。不换算的话
      // 用户选 9:16 或 2K 都不生效，出片永远是初始的 1280×720（实测两个 onChange 都没碰这两个字段）。
      // 放在提交时现算而不是 onChange 里维护状态：少一处会漂移的副本，
      // 且历史任务里存的 request.width/height 与实际提交值天然一致。
      //
      // RB 固定按 768P 换算：它的界面**不显示**分辨率下拉，但 request.resolution 会保留
      // 用户在其它后端选过的值（比如 2K）。不夹的话切到 RB 会把 2560×1440 发过去，
      // 而该后端的预设只保证 4/6/8 秒、宽高可传，没有 2K 能力承诺。
      const payload = {
        ...request,
        ...resolveDimensions(request.ratio, isRb ? "768P" : request.resolution)
      };
      const response = await window.h3.submitGeneration(payload);
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
  // 筛选值可能失效：用户把最后一组改成别的分类、或整组删除后，
  // `categoryFilter` 指向的分类已不在 `projectCategories` 里——列表变空，
  // 而对应的按钮也没了，用户找不到"怎么变回去"的入口。
  // 用**派生值**兜住（不做 setState 同步，避免再引入渲染循环）：
  // 失效时按"全部"显示，筛选条的选中态也一并跟随。
  const categoryFilterValues = ["全部", ...projectCategories, "未分类"];
  const activeCategoryFilter = categoryFilterValues.includes(categoryFilter) ? categoryFilter : "全部";
  const filteredProjects = useMemo(() => {
    if (activeCategoryFilter === "全部") return projects;
    if (activeCategoryFilter === "未分类") return projects.filter((group) => !group[0].category);
    return projects.filter((group) => group[0].category === activeCategoryFilter);
  }, [projects, activeCategoryFilter]);
  async function setProjectCategory(category: string) {
    if (!activeProject) return;
    // IPC 可能 reject；不兜住会变成未处理的 Promise rejection（点了没反应也没提示）。
    try {
      const response = await window.h3.setTaskCategory(activeProject[0].id, category);
      if (!response.ok) { onError(response.message); return; }
      // 提示必须用**服务端实际存下的值**：它会 trim 并截断到 20 字。
      // 直接用入参的话，用户输入 30 字时提示写着 30 字全名，
      // 而过滤条上是 20 字截断版——两处对不上，用户以为分类没设对。
      const saved = response.data?.[0]?.category;
      onNotice(saved ? `已归类到「${saved}」` : "已清除分类");
    } catch (error) {
      onError(error);
    }
  }
  async function deleteProject() {
    if (!activeProject) return;
    // 传任一真实任务 id，orchestrator 按 parentId 整组软删除。
    try {
      const response = await window.h3.deleteTasks([activeProject[0].id]);
      if (!response.ok) { onError(response.message); return; }
      setActiveProjectId(undefined);
      onNotice("已移入回收站，7 天内可恢复");
      window.dispatchEvent(new Event("h3-tasks-changed"));
    } catch (error) {
      onError(error);
    }
  }
  return <section className="page studio-page"><div className="page-title"><div><span className="eyebrow">CREATE</span><h1>生成工作台</h1></div><div className="page-title-actions"><button className="text-button" onClick={() => setShowTrash((v) => !v)}>🗑 回收站</button><div className="backend-pill"><span />{backendLabel(request.backend)}</div></div></div>
    {projects.length > 0 && <div className="category-filter">
      {categoryFilterValues.map((c) => <button key={c} className={activeCategoryFilter === c ? "on" : ""} onClick={() => setCategoryFilter(c)}>{c}</button>)}
      {catEdit.project ? <input className="cat-input" autoFocus value={catEdit.value} placeholder="分类名（留空清除）"
        onChange={(e) => setCatEdit({ project: true, value: e.target.value })}
        onBlur={() => commitProjectCategory()}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setCatEdit({ project: false, value: "" }); }} />
        : <button className="text-button" title="给当前项目设置分类" disabled={!activeProject} onClick={() => { if (activeProject) setCatEdit({ project: true, value: activeProject[0].category || "" }); }}>＋ 分类</button>}
    </div>}
    <div className="project-tabs">
      <button className={`project-tab new-task${activeProjectKey ? "" : " active"}`} onClick={() => setActiveProjectId(undefined)}>
        <strong>＋ 新建任务</strong><small>按下方参数生成 {clampedCount} 路</small>
      </button>
      {filteredProjects.map((group) => {
        const key = group[0].parentId || group[0].id;
        const running = group.some((t) => !["succeeded", "failed", "cancelled", "interrupted"].includes(t.status));
        const done = group.filter((t) => t.status === "succeeded").length;
        const active = activeProjectKey === key;
        return <button key={key} className={`project-tab${active ? " active" : ""}`} onClick={() => setActiveProjectId(key)}>
          <strong>{sliceSafe(group[0].prompt, 18) || "未命名项目"}</strong>
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
          {isRb && rbPreset === "reference" && <FilePicker label="参考图片（可选，1 张）" path={request.sourceImagePath} onClick={() => choose("image", "sourceImagePath")} />}
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
      {/* 随机种子只有 ComfyUI（local / ssh）真的用得上：`MiniMaxAdapter` 与 `RbAdapter`
          的请求体里没有 seed 字段，云端按自己的随机策略出片。
          对这两个后端显示输入框是"UI 有选项但下游没接线"——用户改了完全无效，
          任务卡还会显示一个实际没生效的「Seed」。这里按后端隐藏，并说明原因。 */}
      {isCloud ? <p className="footnote" style={{ margin: 0 }}>该云后端由服务商自行决定随机性，不支持指定种子。</p>
        : <label>基础随机种子<input type="number" value={request.baseSeed} onChange={(e) => setRequest({ ...request, baseSeed: Number(e.target.value) })}/></label>}
      <div className="submit-area"><div>{request.backend === "minimax" ? <><span>云端估算</span><strong>约 ${estimateCloudCost(request.resolution, request.duration, request.count).toFixed(2)} / {request.count} 条</strong></> : request.backend === "rb" ? <><span>云端估算</span><strong>卡密计费 · {request.count} 条消耗 {request.count} 次</strong></> : <><span>本地生成</span><strong>不产生 API 费用</strong></>}</div><button className="primary" disabled={submitting} onClick={submit}>{submitting ? "提交中…" : `生成 ${request.count} 个结果`}</button></div>
    </div><div className="result-pane"><div className="result-pane-head">{activeProject
      ? <button className="text-button danger" onClick={deleteProject}>🗑 删除此项目</button>
      : <span className="result-pane-hint">新建任务预览 · 将生成 {clampedCount} 路结果</span>}</div><div className={`result-grid${shownCount === 1 ? " single" : ""}`}>{currentTasks.map((task, index) => <TaskCard key={task?.id || `slot-${index}`} task={task} index={index} onError={onError} onRetried={(created) => setActiveProjectId(created.parentId)} />)}</div></div></div>
  </section>;
}

// 回收站面板：按项目分组展示已删除任务，支持恢复 / 彻底删除（含视频文件）。
// 删除/恢复动作广播 h3-tasks-changed 事件，本面板监听该事件实时刷新（无需关闭重开）。
function TrashPanel({ onError, onNotice }: { onError: (e: unknown) => void; onNotice: (s: string) => void }) {
  const [items, setItems] = useState<GenerationTask[]>([]);
  const [loading, setLoading] = useState(true);
  // 正在等待二次确认的项目组（parentId）。彻底删除不可逆，不能单击即生效。
  const [confirmingGroup, setConfirmingGroup] = useState<string>();
  const retentionMs = 7 * 24 * 60 * 60 * 1_000;
  // 刷新回收站列表。**失败必须能落到界面上**（不只是"保持旧列表"）：
  // 用户刚点过「彻底删除 / 恢复」，此时刷新若失败，列表还是旧的——
  // 他会以为操作根本没生效，再去点一次（对不可逆操作是灾难性的重复确认）。
  //
  // `onError` 是父组件每次渲染新建的函数。放进依赖会让 `refresh` 每次父渲染都变，
  // 进而让下面的 effect 反复重挂 + 重复拉取（生成期间父组件每个进度事件都会渲染一次）。
  // 用 ref 持有它，让 `refresh` 保持稳定（与 PlaygroundPage 的 onNoticeRef 同一做法）。
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const refresh = useCallback(() => window.h3.listDeletedTasks().then((r) => {
    if (r.ok && r.data) setItems(r.data);
    else if (!r.ok) onErrorRef.current(r.message || "读取回收站失败");
    setLoading(false);
  }).catch((error) => { onErrorRef.current(error); setLoading(false); }), []);
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
  // **脏时间戳会显示「NaN 天后自动清除」**（实测）：`group[0].deletedAt || group[0].updatedAt`
  // 可能两者都缺（旧版本记录）、或是个解析不出来的字符串。`Math.max(0, Math.ceil(NaN))` 仍是 NaN。
  // 拿不到可信时间时返回 undefined，调用方据此不显示"还剩几天"，而不是显示一个假数字。
  const daysLeft = (iso: string | undefined): number | undefined => {
    if (!iso) return undefined;
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return undefined;
    return Math.max(0, Math.ceil((retentionMs - (Date.now() - time)) / 86_400_000));
  };
  const notifyChanged = () => window.dispatchEvent(new Event("h3-tasks-changed"));
  // 回收站两个操作同样要兜住 IPC reject：否则点了没反应，也没有任何提示。
  async function restore(ids: string[]) {
    try {
      const r = await window.h3.restoreTasks(ids);
      if (!r.ok) { onError(r.message); return; }
      onNotice("已恢复");
      notifyChanged();
      void refresh();
    } catch (error) {
      onError(error);
    }
  }
  async function purge(ids: string[]) {
    try {
      const r = await window.h3.purgeTasks(ids);
      if (!r.ok) { onError(r.message); return; }
      onNotice("已彻底删除（含视频文件）");
      notifyChanged();
      void refresh();
    } catch (error) {
      onError(error);
    }
  }
  return <section className="trash-panel">
    <header><strong>回收站</strong><small>项目删除后保留 7 天，到期自动清除（含视频文件）</small></header>
    {loading && <p className="footnote">加载中…</p>}
    {!loading && groups.size === 0 && <p className="footnote">回收站是空的。</p>}
    {Array.from(groups.values()).map((group) => {
      const ids = group.map((t) => t.id);
      const deletedAt = group[0].deletedAt || group[0].updatedAt;
      const left = daysLeft(deletedAt);
      return <article key={group[0].parentId} className="trash-item">
        <div><strong>{sliceSafe(group[0].prompt, 40) || "未命名项目"}</strong>
          <small>{group.length} 条{left === undefined ? "" : ` · ${left} 天后自动清除`}</small></div>
        <div className="trash-actions">
          <button className="text-button" onClick={() => restore(ids)}>恢复</button>
          {/* 「彻底删除」会连输出视频一起删，**不可逆**。此前是单击即生效，
              而按钮与「恢复」并排、只差一个颜色。改成内联两段式确认
              （不用 window.confirm：它会阻塞渲染进程，CDP 自动化也会被挂住）。 */}
          {confirmingGroup === group[0].parentId
            ? <>
                <button className="text-button danger" onClick={() => { setConfirmingGroup(undefined); void purge(ids); }}>确认删除</button>
                <button className="text-button" onClick={() => setConfirmingGroup(undefined)}>取消</button>
              </>
            : <button className="text-button danger" onClick={() => setConfirmingGroup(group[0].parentId)}>彻底删除</button>}
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
function TaskCard({ task, index, onError, allowDemoPlaceholder = true, onRetried }: { task?: GenerationTask; index: number; onError: (e: unknown) => void; allowDemoPlaceholder?: boolean; onRetried?: (task: GenerationTask) => void }) {
  const canCancel = task && !["succeeded","failed","cancelled","interrupted"].includes(task.status);
  const canRetry = task && ["failed","cancelled","interrupted"].includes(task.status);
  const showDemo = !task && allowDemoPlaceholder;
  const bundledMedia = `${import.meta.env.BASE_URL}demo-videos/showcase-0${index + 1}.mp4`;
  const bundledPoster = `${import.meta.env.BASE_URL}demo-videos/showcase-0${index + 1}.jpg`;
  const media = task?.outputPath ? `h3media://local/file?path=${encodeURIComponent(task.outputPath)}` : task ? "" : showDemo ? bundledMedia : "";
  const [retrying, setRetrying] = useState(false);
  // 视频加载失败（文件被手动删除、被过期清理、磁盘故障）时 <video> 只显示黑屏，
  // 用户以为"生成坏了"。这里记下失败并在原位给出可执行提示。
  const [mediaBroken, setMediaBroken] = useState(false);
  async function retry() {
    if (!task || retrying) return;
    setRetrying(true);
    // IPC 可能 reject（不只是返回 ok:false）。不兜住的话按钮永远停在「重试中…」。
    try {
      const response = await window.h3.retryTask(task.id);
      if (!response.ok) { onError(response.message || "重试失败"); return; }
      // 重试会**新建一个项目组**（新 parentId）。项目视图只显示当前组的任务，
      // 不切过去的话用户点完「重试」界面毫无变化，以为按钮坏了。
      if (response.data) onRetried?.(response.data);
    } catch (error) {
      onError(error);
    } finally {
      setRetrying(false);
    }
  }
  // 「在文件夹中显示」与「取消」此前完全忽略返回值：路径被白名单拒绝、任务已被淘汰时
  // 点了毫无反应，用户不知道是没生效还是点错了（CLAUDE.md「出错必须让人看见」）。
  async function reveal() {
    if (!task?.outputPath) return;
    try {
      const response = await window.h3.showItem(task.outputPath);
      if (!response.ok) onError(response.message || "无法打开所在文件夹");
    } catch (error) {
      onError(error);
    }
  }
  async function cancel() {
    if (!task) return;
    try {
      const response = await window.h3.cancelTask(task.id);
      if (!response.ok) onError(response.message || "取消失败");
    } catch (error) {
      onError(error);
    }
  }
  if (!task && !allowDemoPlaceholder) {
    return <article className="task-card missing"><div className="task-placeholder"><span>0{index + 1}</span><i>任务已不存在</i></div><div className="task-meta"><div><strong>结果 {index + 1}</strong><small>该任务已被删除，可在工作台回收站恢复</small></div></div></article>;
  }
  return <article className={`task-card ${task?.status || "ready"}`}>{media ? <>
    {/* 播放器**始终保留**：文件不可用时也让它自己显示媒体错误图标，
        而不是换成占位容器——占位容器会把"这是生成结果"这个语义一起抹掉，
        且卡片结构在成功/失败之间来回变（E2E 与用户都会混淆）。 */}
    <video src={media} poster={task ? undefined : bundledPoster} controls preload="metadata" onError={() => { if (task?.outputPath) setMediaBroken(true); }} />
    {mediaBroken && <p className="task-media-hint">视频文件不可用（可能已被删除或移动）。可点「重试」重新生成。</p>}
  </> : <div className="task-placeholder"><span>0{index + 1}</span><i>{statusLabel(task!.status)}</i></div>}<div className="task-meta"><div><strong>{task ? `Seed ${task.seed}` : `结果 ${index + 1}`}</strong><small>{mediaBroken ? "生成结果文件已不在原路径，可点「重试」重新生成" : task?.message || "4 秒 · 480P · 已生成"}</small></div>{task ? <em>{task.progress}%</em> : <em>就绪</em>}</div>{task && <div className="progress"><i style={{ width: `${task.progress}%` }}/></div>}{task?.outputPath && <button className="text-button" onClick={reveal}>在文件夹中显示</button>}{canRetry && <button className="cancel-button" disabled={retrying} onClick={retry}>{retrying ? "重试中…" : "重试"}</button>}{canCancel && <button className="cancel-button" onClick={cancel}>取消</button>}</article>;
}

function ResourcesPage({ resources, settings, onSettingsChange, onError }: { resources: ResourceLink[]; settings: AppSettings; onSettingsChange: (s: AppSettings) => void; onError: (e: unknown) => void }) {
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
      // `ok:false` 与 reject 都按"读不到清单"处理（显示为 []，界面会给出
      // 「未能读取模型清单」而不是「全部就绪」）。旧写法只判 `data ?? []`，
      // 失败时静默得到空数组、也没有任何提示——用户以为是"目录里没有模型"。
      if (cancelled) return;
      if (response.ok && response.data) setModelStatus(response.data);
      else { setModelStatus([]); if (!response.ok) onError(response.message || "读取模型清单失败"); }
    }).catch((error) => { if (!cancelled) { setModelStatus([]); onError(error); } }).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [root]);

  async function pickRoot() {
    // 选择目录、保存设置、重新检查三步都可能抛异常；不兜住的话「选择目录」点了没反应。
    //
    // **顺序必须是"先落盘、再改本地 state"**：旧写法先 `onSettingsChange(next)` 再 await 保存，
    // 保存被拒（`ok:false`）或抛错时本地已是新目录、磁盘还是旧值——
    // 界面显示"已选好目录"、检查按钮按新目录去读，重启后却又变回旧目录。
    try {
      const response = await window.h3.selectDirectory();
      // `ok:false` 也要报出来：对话框打不开（主进程 handler 异常、窗口已销毁）时
      // 只判 `data` 会静默 return——用户点了「选择目录」毫无反应，
      // 与连接页那个「选择」按钮踩过的是同一个坑（那边已经判了 ok）。
      if (!response.ok) { onError(response.message || "无法打开目录选择器"); return; }
      if (!response.data) return;
      const saved = await window.h3.updateSettings({ comfyuiRoot: response.data });
      if (!saved.ok) { onError(saved.message || "保存目录失败"); return; }
      // 用服务端回读值（已归一化），而不是自己拼的对象——与「设置存了什么就显示什么」一致。
      onSettingsChange(saved.data ?? { ...settings, comfyuiRoot: response.data });
      await checkRoot();
    } catch (error) {
      onError(error);
    }
  }
  async function checkRoot() {
    setChecking(true);
    // 同 detect()/test()：IPC reject 时 setChecking(false) 不执行 → 按钮永久卡在「检查中…」。
    try {
      const response = await window.h3.checkLocalModels();
      // 与上面自动检查的 effect 同一口径：`ok:false` 要报出来，
      // 否则「重新检查」失败时界面只是变成空清单，用户以为是"目录里没有模型"。
      if (response.ok && response.data) setModelStatus(response.data);
      else { setModelStatus([]); if (!response.ok) onError(response.message || "读取模型清单失败"); }
    } catch (error) {
      onError(error);
      setModelStatus([]);
    } finally {
      setChecking(false);
    }
  }
  // 打开外链可能被主进程拒绝（只允许 HTTPS）或失败；不兜住的话按钮点了毫无反应。
  async function open(url: string) {
    try {
      const response = await window.h3.openExternal(url);
      if (!response.ok) onError(response.message || "无法打开链接");
    } catch (error) {
      onError(error);
    }
  }
  const statusById = useMemo(() => new Map((modelStatus ?? []).map((item) => [item.id, item])), [modelStatus]);

  const renderItems = (items: ResourceLink[]) => <div className="download-list">{items.map((item) => {
    const status = item.category === "model" && root ? statusById.get(item.id) : undefined;
    return <article key={item.id}><div className="download-icon">{labels[item.category]}</div><div className="download-info"><span>{item.action === "download" ? `${formatBytes(item.sizeBytes)} · ${item.targetDirectory}` : "官方外部资源"}{status && <em className={status.present ? "model-present" : "model-missing"}>{status.present ? "✓ 已就位" : "✗ 未找到"}</em>}</span><strong>{item.label}</strong><small>{status?.present ? status.fullPath : item.description}</small></div><button className="primary" onClick={() => open(item.url)}>{item.action === "download" ? "下载模型 ↓" : "打开官网 ↗"}</button></article>;
  })}</div>;
  return <section className="page"><div className="page-title"><div><span className="eyebrow">OFFICIAL MODELS</span><h1>模型下载</h1></div><button className="secondary" onClick={checkRoot} disabled={!root || checking}>{checking ? "检查中…" : "重新检查"}</button></div>
    <div className="light-note"><strong>本机 ComfyUI 目录</strong><span>指定你自己的 ComfyUI 安装目录后，这里会逐个检查 5 个模型文件是否已放到正确位置。</span></div>
    <div className="input-button comfy-root-row"><input value={root} readOnly placeholder="未指定：请选择 ComfyUI 根目录（含 models 子目录）" /><button onClick={pickRoot}>{root ? "更改目录" : "选择目录"}</button></div>
    {/* 空数组不能显示"全部就绪"：`[].every(...)` 恒为 true，检查失败/目录异常时
        会给出「0 / 0 个模型已就位，全部就绪 ✅」这种假绿结论（用户以为装好了）。 */}
    {root && modelStatus && (modelStatus.length === 0
      ? <p className="footnote">未能读取模型清单（目录不可访问或检查失败），请重新选择 ComfyUI 根目录后再试。</p>
      : <p className="footnote">{modelStatus.filter((m) => m.present).length} / {modelStatus.length} 个模型已就位{modelStatus.every((m) => m.present) ? "，全部就绪 ✅" : "，缺失项点击下方“下载模型”后放入标注目录，然后完全重启 ComfyUI"}</p>)}
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
  // 各密钥是否**真的**已保存（`hasSecret` 会实际尝试解密：换机器/Local State 丢失后
  // 密文仍在但解不开，此时报 false——这正是我们要的语义）。
  //
  // 为什么需要：输入框的占位文案一直写死「已保存的密钥不会回显；留空不修改」。
  // 全新用户根本没保存过任何密钥，却看到这句，会以为自己已经配好了、跳过填写，
  // 然后在生成时才撞上「请先保存 API Key」。
  const [secretState, setSecretState] = useState<Partial<Record<SecretName, boolean>>>({});
  const refreshSecrets = useCallback(() => {
    const names: SecretName[] = ["minimaxApiKey", "sshPassword", "rbCardCode", "llmApiKey", "searchApiKey"];
    void Promise.all(names.map(async (name) => {
      const response = await window.h3.hasSecret(name).catch(() => undefined);
      return [name, response?.data === true] as const;
    })).then((entries) => setSecretState(Object.fromEntries(entries) as Partial<Record<SecretName, boolean>>));
  }, []);
  useEffect(() => { refreshSecrets(); }, [refreshSecrets]);
  /** 密钥输入框的占位文案：区分「还没保存过」与「已保存，留空不修改」。 */
  const secretPlaceholder = (name: SecretName, hint = "") => {
    const saved = secretState[name] === true;
    const suffix = hint ? `（${hint}）` : "";
    return saved
      ? `已保存的密钥不会回显；留空不修改${suffix}`
      : `尚未保存，请在此填写${hint ? `（${hint}）` : ""}`;
  };
  const setSsh = (patch: Partial<AppSettings["ssh"]>) => setDraft({ ...draft, ssh: { ...draft.ssh, ...patch } });
  const setLlm = (patch: Partial<AppSettings["llm"]>) => setDraft({ ...draft, llm: { ...draft.llm, ...patch } });
  const setLlmProvider = (provider: string) => {
    const preset = LLM_PROVIDERS.find((p) => p.id === provider);
    // 对话端点由主进程按域名运行时推导（api.minimax.io → 官方私有端点，其余标准 /chat/completions），设置里不存储。
    setDraft({ ...draft, llm: { ...draft.llm, provider, ...(preset && provider !== "custom" ? { baseUrl: preset.baseUrl, model: preset.model } : { baseUrl: preset ? "" : draft.llm.baseUrl }) } });
    setLlmModels(undefined);
  };
  async function save() {
    try {
      const saved = await must(window.h3.updateSettings(draft));
      // **设置一落盘就同步给父组件**：后面五步是逐个保存密钥，任何一步失败都会跳到 catch。
      // 旧写法把 `setSettings(saved)` 放在最后，于是"设置已保存、某个密钥没存上"时
      // 界面仍显示旧配置（与磁盘不一致），用户重开页面才发现其实已经存了。
      // 与 pickRoot() 同一口径：存了什么就显示什么。
      setSettings(saved);
      // `draft` 也要跟着换成**主进程归一化后**的值。`draft` 只在挂载时从 props 初始化，
      // 不写回的话表单会一直显示用户原始输入：例如端口填 99999 被归一成 22、
      // 空的服务地址被回落成默认值——表单显示 A、磁盘是 B，且切页回来又变回 B，
      // 用户完全无法判断哪个才是真的生效值。
      setDraft(saved);
      if (apiKey) await must(window.h3.setSecret("minimaxApiKey", apiKey));
      if (sshPassword) await must(window.h3.setSecret("sshPassword", sshPassword));
      if (rbCardCode) await must(window.h3.setSecret("rbCardCode", rbCardCode));
      if (llmKey) await must(window.h3.setSecret("llmApiKey", llmKey));
      if (searchKey) await must(window.h3.setSecret("searchApiKey", searchKey));
      // 密钥输入框只在**全部成功**后清空：中途失败时保留用户刚输入的内容，
      // 否则他得重新贴一遍（而失败原因可能只是某个通道暂时不可用）。
      setApiKey(""); setSshPassword(""); setRbCardCode(""); setLlmKey(""); setSearchKey("");
      // 刷新「是否已保存」状态，让占位文案从「尚未保存」变成「已保存…」。
      refreshSecrets();
      onNotice("连接设置已安全保存");
    } catch (e) {
      onError(e);
    }
  }
  async function test(kind: BackendKind) {
    setTesting(kind);
    // 同 detect()/update()：IPC reject 时 setTesting(undefined) 不执行 → 按钮永久卡在「测试中…」。
    try {
      // **必须先用当前草稿落盘再测**。主进程的 `backend:test` 读的是已保存的设置，
      // 而这张卡片上的地址/端口/目录都是本地 draft。不先保存的话，
      // 用户改了地址再点「测试连接」，测到的永远是**旧地址**——
      // 他以为新地址可用（或不可用），结论与刚填的内容无关。
      // 与下面 `testLlm()` / `fetchModels()` 同一口径（它们早就这么做了）。
      //
      // 落盘后要把**归一化后的值**写回草稿（与 save() 同一口径）：
      // 主进程会纠正非法输入（端口 99999 → 22、空地址 → 默认值），
      // 只更新 settings 不回写 draft 的话，表单会一直显示用户原始输入——
      // 测试明明通过了，地址栏却还挂着一个磁盘上并不存在的值。
      // 用 `current === draft` 守卫：用户在这几百毫秒里继续输入时，不覆盖他的新内容。
      const saved = await must(window.h3.updateSettings(draft));
      setSettings(saved);
      setDraft((current) => (current === draft ? saved : current));
      // 同一张卡片上刚输入的密钥也要先落盘：用户换了 Key 再点测试，
      // 测到旧 Key 会给出"鉴权失败"这种与当前输入无关的结论。
      // 规则与 save() 一致——**留空表示不修改**，只写非空值。
      if (kind === "minimax" && apiKey) await must(window.h3.setSecret("minimaxApiKey", apiKey));
      if (kind === "ssh" && sshPassword) await must(window.h3.setSecret("sshPassword", sshPassword));
      if (kind === "rb" && rbCardCode) await must(window.h3.setSecret("rbCardCode", rbCardCode));
      const result = await window.h3.testBackend(kind);
      if (result.data) setResults((r) => ({ ...r, [kind]: result.data }));
      else onError(result.message);
    } catch (error) {
      onError(error);
    } finally {
      setTesting(undefined);
    }
  }
  // LLM 测试：先保存当前草稿（含可能刚输入的 Key），再发最小对话验证全链路。
  async function testLlm() {
    setLlmTesting(true); setLlmResult(undefined);
    try {
      // 这两处同样是"先把草稿落盘"，必须把回读值同步给父组件与草稿：
      // 否则切到别的页面再回来，`useState(settings)` 会按旧值重建表单，
      // 用户看到刚填的地址/模型"又变回去了"（实际磁盘上已经是新的）。
      const saved = await must(window.h3.updateSettings(draft));
      setSettings(saved);
      setDraft((current) => (current === draft ? saved : current));
      if (llmKey) await must(window.h3.setSecret("llmApiKey", llmKey));
      const result = await window.h3.testLlm();
      if (result.data) setLlmResult(result.data); else onError(result.message);
    } catch (e) { onError(e); } finally { setLlmTesting(false); }
  }
  // 从上游拉取模型列表：同样先保存草稿与 Key（列表接口需要鉴权）。
  async function fetchModels() {
    setFetchingModels(true);
    try {
      const saved = await must(window.h3.updateSettings(draft));
      setSettings(saved);
      setDraft((current) => (current === draft ? saved : current));
      if (llmKey) await must(window.h3.setSecret("llmApiKey", llmKey));
      const response = await window.h3.listLlmModels();
      if (response.data?.ok) { setLlmModels(response.data.models); onNotice(response.data.message); }
      else onError(new Error(response.data?.message || response.message || "获取模型列表失败"));
    } catch (e) { onError(e); } finally { setFetchingModels(false); }
  }
  // 两处「选择」按钮此前直接把 IPC 的 Promise 丢掉：抛异常时变成未处理的 rejection，
  // 点了没有任何反馈（同 7492191 / 69028e2 那批）。
  // 补 try/catch 后仍只判 `data`：`ok:false`（主进程 handler 抛错，如对话框无法打开）
  // 依然表现为"点了没反应"，所以这里同时判 ok。
  async function pickOutputDirectory() {
    try {
      const x = await window.h3.selectDirectory();
      if (!x.ok) onError(x.message || "无法打开目录选择器");
      else if (x.data) setDraft({ ...draft, outputDirectory: x.data });
    } catch (e) { onError(e); }
  }
  async function pickPrivateKey() {
    try {
      const x = await window.h3.selectFile("key");
      if (!x.ok) onError(x.message || "无法打开文件选择器");
      else if (x.data) setSsh({ privateKeyPath: x.data });
    } catch (e) { onError(e); }
  }
  return <section className="page connections"><div className="page-title"><div><span className="eyebrow">CONNECT</span><h1>连接设置</h1></div><button className="primary" onClick={save}>保存全部设置</button></div>
    <ConnectionCard title="本机 ComfyUI" badge="LOCAL" result={results.local} onTest={() => test("local")} testing={testing === "local"}><label>服务地址<input value={draft.localComfyUrl} onChange={(e) => setDraft({...draft,localComfyUrl:e.target.value})}/></label><label>输出目录<div className="input-button"><input value={draft.outputDirectory} onChange={(e) => setDraft({...draft,outputDirectory:e.target.value})}/><button onClick={pickOutputDirectory}>选择</button></div></label></ConnectionCard>
    <ConnectionCard title="MiniMax 云 API" badge="CLOUD" result={results.minimax} onTest={() => test("minimax")} testing={testing === "minimax"}><label>API 地址<input value={draft.minimaxBaseUrl} onChange={(e) => setDraft({...draft,minimaxBaseUrl:e.target.value})}/></label><label>API Key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={secretPlaceholder("minimaxApiKey")}/></label></ConnectionCard>
    <ConnectionCard title="瞬映 RB 云生成" badge="RB-CLOUD" result={results.rb} onTest={() => test("rb")} testing={testing === "rb"}><label>API 地址<input value={draft.rbBaseUrl} onChange={(e) => setDraft({...draft,rbBaseUrl:e.target.value})}/></label><label>瞬映卡密<input type="password" value={rbCardCode} onChange={(e) => setRbCardCode(e.target.value)} placeholder={secretPlaceholder("rbCardCode")}/></label></ConnectionCard>
    <ConnectionCard title="SSH 远程显卡" badge="REMOTE" result={results.ssh} onTest={() => test("ssh")} testing={testing === "ssh"}><div className="form-grid"><label>主机<input value={draft.ssh.host} onChange={(e)=>setSsh({host:e.target.value})} placeholder="gpu.example.com"/></label><label>端口<input type="number" value={draft.ssh.port} onChange={(e)=>setSsh({port:Number(e.target.value)})}/></label><label>用户名<input value={draft.ssh.username} onChange={(e)=>setSsh({username:e.target.value})}/></label><label>远端 ComfyUI 端口<input type="number" value={draft.ssh.remoteComfyPort} onChange={(e)=>setSsh({remoteComfyPort:Number(e.target.value)})}/></label></div><label>私钥路径<div className="input-button"><input value={draft.ssh.privateKeyPath} onChange={(e)=>setSsh({privateKeyPath:e.target.value})}/><button onClick={pickPrivateKey}>选择</button></div></label><label>SSH 密码（仅无私钥时）<input type="password" value={sshPassword} onChange={(e)=>setSshPassword(e.target.value)} placeholder="使用系统安全存储"/></label><label>主机 SHA-256 指纹<input value={draft.ssh.hostFingerprint} onChange={(e)=>setSsh({hostFingerprint:e.target.value})} placeholder="首次测试确认后填入"/></label></ConnectionCard>
    <ConnectionCard title="游乐场 LLM（OpenAI 兼容）" badge="PLAY" result={llmResult} onTest={testLlm} testing={llmTesting}><div className="form-grid"><label>提供商<select value={draft.llm.provider} onChange={(e) => setLlmProvider(e.target.value)}>{LLM_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label><label>API 地址<input value={draft.llm.baseUrl} onChange={(e) => setLlm({baseUrl: e.target.value})} placeholder="https://api.example.com/v1"/></label><label>模型名称<div className="input-button"><input value={draft.llm.model} onChange={(e) => setLlm({model: e.target.value})} placeholder="deepseek-chat"/>{llmModels && llmModels.length > 0 && <select className="pg-model-select" value="" onChange={(e) => { if (e.target.value) setLlm({model: e.target.value}); }}><option value="">从列表选择…</option>{llmModels.map((m) => <option key={m} value={m}>{m}</option>)}</select>}<button onClick={fetchModels} disabled={fetchingModels}>{fetchingModels ? "获取中…" : "获取列表"}</button></div></label></div><label>API Key<input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} placeholder={secretPlaceholder("llmApiKey", "Ollama 本机可留空")}/></label><label>系统提示词（可选）<input value={draft.llm.systemPrompt} onChange={(e) => setLlm({systemPrompt: e.target.value})} placeholder="例如：你是视频创作助手，帮我润色视频描述。"/></label><p className="footnote">测试连接优先拉取上游模型列表验证连通性（不发对话、不消耗额度），不支持列表接口的服务商回退发一条最小对话。改 API 地址为第三方中转时自动使用标准 /chat/completions 端点。</p></ConnectionCard>
    <ConnectionCard title="联网搜索（可选）" badge="SEARCH"><label>搜索 API 地址<input value={draft.searchApi.baseUrl} onChange={(e) => setDraft({...draft, searchApi: {baseUrl: e.target.value}})} placeholder="博查/Tavily 转接等，POST /search 返回 results 数组；留空则用免 key 抓取 Bing/搜狗"/></label><label>搜索 API Key<input type="password" value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder={secretPlaceholder("searchApiKey")}/></label></ConnectionCard>
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

/**
 * 软删除时间的归一化。
 *
 * `deletedAt` 参与两处计算：回收站每项的「N 天后自动清除」与启动时的 7 天过期清理。
 * 非法值（非字符串、空串、`"abc"`）会让 `new Date(...)` 得到 Invalid Date：
 * - 界面上显示「NaN 天后自动清除」
 * - `Date.now() - NaN > 7 天` 恒为 false → 这条记录**永远不会被清理**
 *   （白占 localStorage 配额，配额满了之后所有会话都存不进去）
 * 这里把非法值视为"刚删除"，让 7 天计时正常走完。
 */
function normalizeDeletedAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) return value;
  return new Date().toISOString();
}

/** 读盘后的会话归一化。**导出以便单测**：坏元素的容错逻辑读代码看不出来，必须能断言。 */
export function normalizeStoredSessions(raw: unknown): PlaygroundSession[] {
  if (!Array.isArray(raw)) return [];
  // 逐条容错：一条坏数据不该让**全部**会话消失。
  // 旧实现直接 `parsed.map(...)` 并靠外层 catch 兜底，只要数组中有一个 null/非对象
  // （半截写入、手改、旧版本遗留），`session.messages` 就抛错，外层 catch 返回 [] ——
  // 用户精心攒下的全部对话一次性清空（实测探针 sessions-bad-element 复现）。
  //
  // **id 必须去重**：重复 id 不是理论问题——并发写盘、手改、从别的窗口导入都可能造出来。
  // 它带来的后果都在"按 id 操作"的地方：
  // ① `key={session.id}` / `key={msg.id}` 重复 → React 复用错元素，列表里出现串行状态；
  // ② 删除/恢复/patchLast 全是 `filter(s => s.id !== id)` / `map` → **一次操作作用到两条**。
  // 保留**第一条**（磁盘顺序即写入顺序，先出现的通常才是用户真正在用的那条）。
  const seenSessions = new Set<string>();
  const unique = raw.filter((session): session is PlaygroundSession => {
    if (!session || typeof session !== "object") return false;
    const id = (session as PlaygroundSession).id;
    if (typeof id !== "string" || seenSessions.has(id)) return false;
    seenSessions.add(id);
    return true;
  });
  return unique.map((session) => ({
    ...session,
    // `title` 必须归成字符串：它直接进 JSX（`{session.title || "新对话"}`）。
    // 若磁盘上是对象/数组，React 会抛 "Objects are not valid as a React child"
    // ——整个游乐场页白屏（与 content 那批同一类，但这条路径此前漏了）。
    title: typeof session.title === "string" ? session.title : "",
    // `createdAt` / `updatedAt` 必须是字符串：会话列表用
    // `sessionRecency(...).localeCompare(...)` 排序，数字（时间戳）会抛
    // "recency(...).localeCompare is not a function" —— 整个会话列表打不开。
    // 缺失或脏值统一归一成当前时刻（至少排在合理位置，而不是崩溃）。
    createdAt: typeof session.createdAt === "string" && session.createdAt ? session.createdAt : new Date().toISOString(),
    updatedAt: typeof session.updatedAt === "string" && session.updatedAt ? session.updatedAt : undefined,
    // `category` 参与分组排序（`a.localeCompare(b)`）与过滤比较，
    // 非字符串会让分组排序抛 "a.localeCompare is not a function"（实测：
    // 数字分类排在字母分类之前时会命中）。空串沿用"未分类"语义。
    category: typeof session.category === "string" && session.category ? session.category : undefined,
    // `deletedAt` 必须是可解析的时间串：非法值会让回收站显示「NaN 天后自动清除」，
    // 且 `Date.now() - NaN > 7 天` 恒为 false —— 这条记录**永远不会被过期清理掉**，
    // 白占 localStorage 配额（配额满了之后所有会话都存不进去）。
    // 非法值一律视为"刚删除"，让 7 天计时正常走完。
    deletedAt: normalizeDeletedAt(session.deletedAt),
    // toolSteps 与 streaming 同理是瞬态：流式途中关闭应用会残留，读取时强制剥离。
    // 旧数据迁移：扁平 taskIds → 单组 taskGroups（旧消息没有分组结构）。
    // `filter(Boolean)` 只挡 null/undefined/0/""：字符串与数字仍会通过，
    // 而下面 `{ ...msg }` 对字符串是**按字符展开**（"hi" → {0:"h",1:"i"}），
    // 最终变成一条 role/content 都缺失的垃圾消息（界面显示「（空回复）」，
    // 且 `key={msg.id}` 为 undefined，多条时报 key 重复）。
    // 与主进程 `safeMessages` 同一口径：必须是对象。
    messages: (Array.isArray(session.messages) ? session.messages : [])
      .filter((msg): msg is PlaygroundMessage => Boolean(msg) && typeof msg === "object")
      // **消息 id 也要去重**：渲染端用 `key={msg.id}`，重复 id 会让 React 复用错元素
      // （气泡内容/流式光标串到别的消息上）；`patchLast` 之类按位置操作虽不受影响，
      // 但删除单条消息、定位 questions 卡片都按 id 匹配，重复时会同时命中两条。
      // 缺 id 的也补一个（旧版本可能没写），否则 key 变成 undefined。
      .map((msg, index) => {
        const id = typeof (msg as { id?: unknown }).id === "string" && (msg as { id: string }).id
          ? (msg as { id: string }).id
          : `legacy-${session.id}-${index}`;
        return { ...(msg as PlaygroundMessage), id };
      })
      .filter((msg, index, all) => all.findIndex((entry) => entry.id === msg.id) === index)
      .map((msg) => {
      const { toolStatus: _dropped, toolSteps: _dropped2, ...rest } = msg as PlaygroundMessage & { toolStatus?: unknown };
      // content 必须是字符串：主进程的 normalizeHistory 会调 `.trim()`、上下文估算会调 `.match()`，
      // 非字符串（手改、旧版本写脏）会抛 "text.trim is not a function" 这类英文技术错误，
      // 用户完全无法对症。在这里兜住，比在每个下游都判类型便宜得多。
      const content = typeof rest.content === "string" ? rest.content : String(rest.content ?? "");
      // 数组字段必须真的是数组：渲染端对它们一律直接 `.map()` / `.filter()`，
      // 非数组（手改、旧版本写脏、或未来某处写入 bug）会抛
      // "xxx.map is not a function" —— 整个会话列表打不开。
      const asArray = <T,>(value: unknown): T[] | undefined =>
        Array.isArray(value) ? (value as T[]) : undefined;
      const normalized = asArray<string[]>(rest.taskGroups)?.filter((group) => Array.isArray(group) && group.length > 0)?.map((group) => group.filter((id) => typeof id === "string"))
        // `taskIds` 是更早版本的扁平字段：**必须先确认它真是数组**。
        // 旧写法 `rest.taskIds?.length ? [rest.taskIds] : undefined` 只判了 truthy——
        // 若磁盘上是字符串（手改 / 旧版本写脏），`[ "abc" ]` 会变成"一组里装了一个字符串"，
        // 而渲染端 `group.map(...)` 对字符串调用 map → TypeError → **整个游乐场页白屏**。
        ?? (asArray<string>(rest.taskIds)?.length ? [asArray<string>(rest.taskIds)!] : undefined);
      const migrated = {
        ...rest,
        content,
        taskGroups: normalized,
        taskIds: undefined,
        // images 也直接进 <img src> 与发给模型的多模态载荷，非字符串项要剔掉。
        images: asArray<string>(rest.images)?.filter((url) => typeof url === "string"),
        // planSteps / artifacts 也要**逐元素**过滤：只判"是不是数组"不够——
        // 元素是字符串/数字时，`entry.status` / `a.name` 访问得到 undefined，
        // 但 `{entry.step}` 若拿到对象就会抛
        // "Objects are not valid as a React child"（整页白屏）。
        // 与 messages 那批同一口径：渲染端直接映射的数组，元素类型也要保证。
        planSteps: asArray<PlanStep>(rest.planSteps)?.filter(
          (entry): entry is PlanStep => Boolean(entry) && typeof entry === "object" && typeof (entry as PlanStep).step === "string"
        ),
        artifacts: asArray<NonNullable<PlaygroundMessage["artifacts"]>[number]>(rest.artifacts)?.filter(
          (a) => Boolean(a) && typeof a === "object" && typeof (a as { name?: unknown }).name === "string"
            && typeof (a as { path?: unknown }).path === "string"
        )
      };
      // `questions`（挂起的选择题）同样不能跨重启保留：它靠主进程内存里的
      // `questionBridge` 兑现，重启后 requestId 全部失效——卡片还在、点了永远无效。
      // 旧版本已经把这种数据写进过 localStorage，故读取侧也要剥。
      return migrated.streaming || migrated.questions
        ? { ...migrated, streaming: false, toolSteps: undefined, questions: undefined }
        : migrated;
    })
  }));
}

/**
 * 落盘前剥掉**瞬态字段**（`toolSteps` / `streaming`）。
 *
 * 读取侧（`normalizeStoredSessions`）本来就会强制剥离这两项，但**写入侧一直没剥**——
 * 于是每条消息的工具日志（一次多步任务能攒二三十行）被原样写进 localStorage。
 * 配额只有 5–10MB，长会话里工具日志是纯浪费：读回来立刻被丢掉，却先占了一次配额，
 * 顶到上限时用户看到的是"本地存储空间不足，最近的对话可能无法保存"。
 *
 * 内存态**不动**（界面还要显示步骤条），只影响写到磁盘的那份拷贝。
 *
 * **`questions` 也必须剥掉**（实测复现的形状）：挂起的选择题靠主进程内存里的
 * `questionBridge` 兑现，重启后那批 requestId 全部失效。卡片留在界面上，
 * 用户点「确认」只会得到"这组问题已经超时或结束了"，然后卡片才消失——
 * 一个永远点不动的控件比没有更糟。读取侧（`normalizeStoredSessions`）也会再兜一次，
 * 兼容旧版本已经写进去的数据。
 */
export function stripTransientForPersist(sessions: PlaygroundSession[]): PlaygroundSession[] {
  return sessions.map((session) => ({
    ...session,
    messages: session.messages.map((msg) => {
      if (!msg.streaming && !msg.toolSteps && !msg.questions) return msg;
      const { toolSteps: _steps, streaming: _streaming, questions: _questions, ...rest } = msg;
      return rest;
    })
  }));
}

function loadSessions(): PlaygroundSession[] {
  try {
    return normalizeStoredSessions(JSON.parse(localStorage.getItem(pgSessionsKey) || "[]"));
  } catch { return []; }
}

/**
 * 消息正文的 markdown 渲染（**必须 memo**）。
 *
 * 流式期间每个 chunk 都会 `setSessions` 改最后一条消息，但父组件重渲染时
 * `<div className="pg-bubble">` 里的 `renderMarkdown(msg.content)` 会给**所有**
 * 历史气泡重新跑一遍解析（含表格、代码块切分）。长会话（几十上百条）时
 * 每帧都在做全量解析，明显拖慢流式观感。
 * memo 之后，内容没变的历史消息直接复用上一次的元素树。
 */
const PgMarkdown = memo(function PgMarkdown({ content }: { content: string }) {
  return <>{renderMarkdown(content)}</>;
});

/**
 * 游乐场输入区草稿的模块级缓存。
 *
 * 与工作台 `studioDraft` 同一理由：`App` 用 `{page === "playground" && <PlaygroundPage …/>}`
 * 切页，切走时组件**整个卸载**，`useState` 里的输入框、附件、视频表单随之蒸发。
 * 用户写了一段很长的提问、切去「模型设置」看一眼再回来，内容就没了（实测复现）。
 * 只存内存，关掉应用即丢——草稿与"会话记录"是两回事，不进 localStorage。
 */
interface PlaygroundDraft {
  input: string;
  attachments: Array<{ name: string; dataUrl?: string; text?: string }>;
  videoRequest?: GenerationRequest;
  planNext: boolean;
  /**
   * 工具条上的四个开关。**同样必须随切页保留**：
   * 它们是"本轮怎么干"的意图，不是一次性动作——
   * 用户特意关掉「联网」（不想让模型烧搜索额度）后去连接页看一眼再回来，
   * 开关又静默变回打开，下一次提问就带着联网发出去了。
   * 与草稿同一套语义：只存内存，关掉应用即丢。
   */
  webSearch?: boolean;
  browserSearch?: boolean;
  agentMode?: boolean;
  showVideoForm?: boolean;
}
let playgroundDraft: PlaygroundDraft | undefined;

function PlaygroundPage({ settings, tasks, onError, onNotice, onNavigate }: { settings: AppSettings; tasks: GenerationTask[]; onError: (e: unknown) => void; onNotice: (s: string) => void; onNavigate: (page: Page) => void }) {
  // **只解析一次 localStorage**：此前 `useState(loadSessions)` 与
  // `useState(() => loadSessions().find(...))` 各读一遍，等于把整份会话
  // （带图时可达 2MB+）JSON.parse 两次、还多构造一整份对象树。
  const [initial] = useState(() => {
    const loaded = loadSessions();
    return { sessions: loaded, activeId: loaded.find((s) => !s.deletedAt)?.id || "" };
  });
  const [sessions, setSessions] = useState<PlaygroundSession[]>(initial.sessions);
  const [activeId, setActiveId] = useState<string>(initial.activeId);
  const active = sessions.find((s) => s.id === activeId);
  // 输入框 / 附件 / 计划开关 / 视频表单都从模块级草稿恢复（切页会卸载本组件）。
  const [input, setInput] = useState(() => playgroundDraft?.input ?? "");
  const [attachments, setAttachments] = useState<Array<{ name: string; dataUrl?: string; text?: string }>>(
    () => playgroundDraft?.attachments ?? []
  );
  const [planNext, setPlanNext] = useState(() => playgroundDraft?.planNext ?? false);
  const [videoRequest, setVideoRequest] = useState<GenerationRequest>(
    () => playgroundDraft?.videoRequest ?? { ...initialRequest, prompt: "", backend: settings.defaultBackend }
  );
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
  // 窗口缩放时重新夹取。面板宽度只在"打开那一刻"按容器量过一次；
  // 之后把窗口拉小，`flex: none` 的面板会直接把 `flex:1; min-width:0` 的聊天列压到 0
  // （用户点开文件后再拖动窗口，聊天区就"消失"了）。
  // 用函数式更新：值没变时 React 会 bail out，不会引发多余渲染。
  useEffect(() => {
    if (!preview) return;
    const onResize = () => {
      const mainWidth = document.querySelector(".pg-main")?.getBoundingClientRect().width ?? 0;
      if (mainWidth <= 0) return;
      setPreviewWidth((current) => Math.round(Math.max(360, Math.min(current, Math.max(360, mainWidth - 30)))));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [preview]);
  // 拖拽过程中只更新内存宽度；**落盘留到松手**。拖拽时 mousemove 每秒可达上百次，
  // 每次都同步写 localStorage 会造成明显卡顿（本修复初版就是这么写的，属自引入的性能回归）。
  const resizePreview = (width: number) => setPreviewWidth(width);
  const [webSearch, setWebSearch] = useState(() => playgroundDraft?.webSearch ?? true);
  // 「浏览器搜索」可选联网项：只用应用自带 Chromium 渲染抓取（与「联网」互斥，后端也按互斥处理）。
  const [browserSearch, setBrowserSearch] = useState(() => playgroundDraft?.browserSearch ?? true);
  // 智能体默认开启（用户指令）；模型不支持工具时主进程自动回落普通对话，前端无感。
  const [agentMode, setAgentMode] = useState(() => playgroundDraft?.agentMode ?? true);
  // generating 从"全局"改为"按会话"：多会话可并发生成，每个会话各有自己的发送守卫与流缓冲。
  const [generatingIds, setGeneratingIds] = useState<string[]>([]);
  const [showVideoForm, setShowVideoForm] = useState(() => playgroundDraft?.showVideoForm ?? false);
  // 任何一处草稿变化都写回缓存；卸载时不必额外处理（引用一直是最新的）。
  // 必须放在上面所有 `useState(() => playgroundDraft?.x)` 之后——否则初始化表达式
  // 引用的变量还没声明（TS 会在编译期直接报 "used before its declaration"）。
  useEffect(() => {
    playgroundDraft = { input, attachments, videoRequest, planNext, webSearch, browserSearch, agentMode, showVideoForm };
  }, [input, attachments, videoRequest, planNext, webSearch, browserSearch, agentMode, showVideoForm]);
  // 与工作台共用同一份合法时长定义：RB 的 reference/tail_frame 只收 4/6/8 秒，
  // 若这里仍放开 10/12/15，非法 seconds+preset 组合会真的发到云端——失败也照样扣卡密次数。
  const videoDurationOptions = durationOptionsFor(videoRequest.backend, videoRequest.preset);
  // 每个会话一条流：sessionId → 累积文本 / 已收到的任务 id / 同步发送守卫。
  const streamBuffers = useRef(new Map<string, string>());
  const taskIdBuffers = useRef(new Map<string, string[]>());
  const sendingRef = useRef(new Set<string>());
  // 「提交生成任务」的同步守卫：同一 tick 内连点两次会读到两次 false，
  // 于是创建两组任务（RB 后端每次提交都扣卡密次数，等于重复扣费）。
  const videoSubmittingRef = useRef(false);
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
  // 以 plan 语义发出的会话集合（按会话隔离，多会话并发时不串味）。
  // offDone 是订阅回调、读不到最新 state，故用 ref；由 onLlmDone 消费后自行删除。
  const planTurnRef = useRef(new Set<string>());
  // 上下文占用：分母是「模型窗口 × 80%」= 压缩触发点。按当前会话的历史轮询（主进程持有记账状态）。
  const [contextStatus, setContextStatus] = useState<ContextStatus>();
  const [compacting, setCompacting] = useState(false);
  // 轮询闭包必须读**最新**历史：effect 只依赖消息**条数**，而流式期间条数不变、内容在涨。
  // 若闭包捕获旧的 active，回复结束后 chip 仍显示开头的占用（实测：真实 59% 时 chip 停在 0%）。
  //
  // 注意这里只存**会话引用**（一次赋值），历史在 probe 里现算：
  // 若每次渲染都 filter+map 整个消息列表，流式期间每秒几十次渲染、几百条消息，
  // 会持续产生大量临时对象（我第一版就是这么写的，属自引入的性能回归）。
  const activeRef = useRef(active);
  activeRef.current = active;
  // 启动时的一次性清理 effect 需要读当前会话快照，但不能把副作用写进 setSessions 的 updater。
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const threadRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    // 没有活动会话时要**清空**占用：直接 return 的话，把最后一个会话删掉后
    // 顶部仍显示上一个会话的「📦 上下文 59%」（那个数字属于已经不存在的会话）。
    // 与下面 `if (!history.length)` 同一理由，只是这条路径此前漏了。
    if (!activeId) { setContextStatus(undefined); return; }
    let cancelled = false;
    const probe = () => {
      // notice 是纯界面提示（如"上下文已压缩"），不能进历史——否则模型会把系统提示当自己说过的话复述。
      const current = activeRef.current;
      threadRef.current = current
        ? current.messages.filter((m) => !m.error && !m.notice).map((m) => ({ role: m.role, content: m.content, images: m.images }))
        : [];
      const history = threadRef.current;
      // 空会话要**清空**占用：直接 return 的话会保留上一个会话的数值，
      // 切到新对话时顶部仍显示「📦 上下文 59%」——那个数字属于别的会话（实测复现）。
      if (!history.length) { if (!cancelled) setContextStatus(undefined); return; }
      void window.h3.getContextStatus(history, activeId).then((response) => { if (!cancelled) setContextStatus(response.data); }).catch(() => {});
    };
    probe();
    // 20 秒轮询：占用是低频变化的量，没必要每渲染一次都问主进程。
    const timer = setInterval(probe, 20_000);
    return () => { cancelled = true; clearInterval(timer); };
  // 回复结束（generating 由 true→false）时补一次探测：流式期间条数没变，effect 不会重跑，
  // 不补的话 chip 要等最多 20 秒才追上真实占用。
  }, [activeId, generating]);

  // 落盘节流：流式回复期间每个 chunk 都会改 sessions，而每次写盘都要把**全部会话**
  // stringify 一遍（实测 10 个会话 + 2 张 1MB 图 ≈ 2.2MB / 每次 2.9ms）。
  // 不节流时每秒 20 个 chunk 就是约 44MB/秒的同步写盘 + 主线程持续占用，
  // 长会话带图时会明显卡顿。
  // 400ms 足够短（异常退出最多丢 0.4 秒内容），又能把写盘次数压下一个量级。
  const persistPendingRef = useRef<PlaygroundSession[] | undefined>(undefined);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // onNotice 是父组件每次渲染新建的函数，用 ref 持有以免它变化就重建 flush。
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = undefined;
    }
    const data = persistPendingRef.current;
    if (!data) return;
    persistPendingRef.current = undefined;
    // 写盘失败必须兜住：localStorage 有配额（约 5–10MB，长会话很容易顶到）。
    // 不兜的话 effect 直接抛异常 → 整个 PlaygroundPage 崩溃、界面塌成空白，
    // 用户还不知道会话其实没存下来（实测复现）。
    try {
      localStorage.setItem(pgSessionsKey, JSON.stringify(stripTransientForPersist(data)));
      storageWarnedRef.current = false; // 写成功即复位，下次真失败时还能再提醒一次
    } catch {
      if (!storageWarnedRef.current) {
        storageWarnedRef.current = true;
        onNoticeRef.current("本地存储空间不足，最近的对话可能无法保存。建议删除一些旧会话或清空回收站。");
      }
    }
  }, []);
  // 卸载前把待写数据落盘，否则最后 400ms 的回复会丢（用户关掉游乐场页就消失）。
  useEffect(() => () => flushPersist(), [flushPersist]);
  // 落盘上限 50：内存态一并裁剪，否则 UI 显示得出来、重启后却凭空少几个（用户可感知的静默丢失）。
  // 按"最近使用"裁剪，且绝不丢弃正在生成回复的会话——否则一段正在跑的对话会被静默砍掉。
  useEffect(() => {
    const capped = sessions.length > PG_SESSION_CAP ? capSessions(sessions, generatingIds) : sessions;
    if (capped !== sessions) setSessions(capped);
    // 空对话不落盘：关软件即"永久删除"（用户要求——空状态只是临时草稿）；正在生成回复的空壳除外（防截断）。
    persistPendingRef.current = capped.filter((s) => s.messages.length > 0 || generatingIds.includes(s.id));
    // 已有排期就只更新待写数据（run-once timer），避免每个 chunk 都重置计时器
    // 导致流式期间永远写不下去。
    if (persistTimerRef.current) return;
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = undefined;
      flushPersist();
    }, 400);
  }, [sessions, generatingIds, flushPersist]);
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
      inspect_artifact: "自检页面",
      read_artifact: "读取文件",
      edit_artifact: "修改文件",
      edit_artifact_batch: "批量修改文件",
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
        const shortSummary = summary.length > 60 ? `${sliceSafe(summary, 60)}…` : summary;
        if ((event.phase ?? "start") === "end") {
          // 成败用结构化字段，不靠摘要文本猜："完成"指工具调用结束，不代表操作成功。
          // 实测踩到：edit_artifact 拒绝歧义编辑时曾渲染成 `✓ 修改文件完成（oldText 出现了 2 次…）`。
          // **失败时不要再加"失败"前缀**：摘要本身已经是"修改文件失败：…"，
          // 再包一层就成了 `✕ 修改文件失败（修改文件失败：…）`（探针里看到的重复）。
          // 缺省视为成功（兼容没有该字段的旧事件）。
          return { ...msg, toolSteps: [...steps, event.ok === false ? `✕ ${shortSummary}` : `✓ ${name}完成（${shortSummary}）`] };
        }
        const label = event.tool === "web_search" ? `→ 正在搜索：${event.input}`
          : event.tool === "generate_video" ? "→ 正在创建视频生成任务…"
            : event.tool === "open_page" ? `→ 正在打开网页：${event.input}`
              : event.tool === "create_file" ? "→ 正在生成文件…"
                : event.tool === "inspect_artifact" ? `→ 正在运行页面自检：${event.input}`
                  : event.tool === "read_artifact" ? `→ 正在读取文件：${event.input}`
                    : event.tool === "edit_artifact" ? `→ 正在修改文件：${event.input}`
                      : event.tool === "edit_artifact_batch" ? `→ 正在批量修改：${event.input}`
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
      // **更新要扫整个会话，不能只看最后一条消息**：
      // 模型在**新一轮**里改上一轮产出的文件时（"把刚才那个页面再改一下"），
      // 那张卡片挂在更早的助手消息上。若仍用 patchLast，map 找不到匹配项 →
      // 静默什么都不做，旧卡片永远停在旧大小。新建才追加到当前（最后一条）消息。
      if (event.updated) {
        setSessions((all) => all.map((session) => session.id !== targetId ? session : {
          ...session,
          messages: session.messages.map((msg) => {
            const existing = msg.artifacts ?? [];
            if (!existing.some((a) => a.path === event.path)) return msg;
            return {
              ...msg,
              artifacts: existing.map((a) => a.path === event.path
                ? { ...a, name: event.name, size: event.size, kind: event.kind }
                : a)
            };
          })
        }));
      } else {
        setSessions((all) => patchLast(all, targetId, (msg) => ({
          ...msg,
          artifacts: [...(msg.artifacts ?? []), { name: event.name, path: event.path, size: event.size, kind: event.kind }]
        })));
      }
      // 已打开的预览面板同步换一份引用：html 走 URL 加载，path 不变就**不会重载**，
      // 用户会继续看到改动前的旧画面（真机上会误判"还是坏的"）。
      if (event.updated) {
        setPreview((current) => current && current.path === event.path
          ? { ...current, name: event.name, size: event.size, revision: (current.revision ?? 0) + 1 }
          : current);
      }
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
  // 切换会话时关掉产物预览：`preview` 存的是上一个会话的文件路径，
  // 留着会让右侧面板继续显示别的会话的产物（用户以为那是当前会话生成的东西）。
  useEffect(() => { setPreview(undefined); }, [activeId]);
  // 新会话创建完成后释放"正在建会话"哨兵（此时 active 已就绪，守卫由 sendingRef 接管）。
  useEffect(() => { if (activeId) creatingSessionRef.current = false; }, [activeId]);
  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 距底部 48px 内视为"贴底"（给一点容差，避免像素级抖动导致跟随断掉）。
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // 会话回收站过期清理：启动时清除超过 7 天的已删除会话，**并删掉它们的产物目录**。
  // 只删会话记录的话，userData/artifacts/<sessionId>/ 会永久留盘：
  // 界面里再也看不到、也无法重新打开，但磁盘上那些 HTML/Excel/文档一直在。
  //
  // 注意 updater 必须是**纯函数**：React 在开发模式会重复调用它，
  // 把 IPC 写在 `setSessions(all => …)` 里会重复发起删除请求。
  // 所以先基于当前快照算出过期名单，再分别做「删记录」与「删目录」两件事。
  useEffect(() => {
    const now = Date.now();
    const expired = sessionsRef.current.filter((s) => s.deletedAt && now - new Date(s.deletedAt).getTime() > 7 * 86_400_000);
    if (expired.length === 0) return;
    const ids = new Set(expired.map((s) => s.id));
    setSessions((all) => all.filter((s) => !ids.has(s.id)));
    for (const session of expired) {
      // 失败不该打断清理：目录可能本就不存在（从没生成过产物）。
      void window.h3.purgeSessionArtifacts(session.id).catch(() => undefined);
    }
  }, []);

  function patchLast(all: PlaygroundSession[], id: string, patch: (msg: PlaygroundMessage) => PlaygroundMessage): PlaygroundSession[] {
    return all.map((session) => session.id !== id ? session : { ...session, messages: session.messages.map((msg, i) => i === session.messages.length - 1 ? patch(msg) : msg) });
  }

  // 切换会话：若当前会话是空对话（没真的聊过天），切换时即永久删除——不留空壳在列表里。
  function switchSession(id: string) {
    const leavingId = active?.id;
    setSessions((all) => all.filter((s) => !(s.id === leavingId && s.id !== id && s.messages.length === 0)));
    setActiveId(id);
    // 草稿是本会话的：输入框、附件、计划开关都是**组件级** state，不随会话切换重置。
    // 不清的话，在 A 里选好的图片会跟着带进 B —— 用户点发送时看到的是 B 的气泡，
    // 但实际发出去的内容里带着 A 的附件（跨会话串台，且用户完全没察觉）。
    setInput("");
    setAttachments([]);
    setPlanNext(false);
    // 「生成视频」表单里的**描述文本**同样是本会话草稿：不清的话，在 A 里写好的
    // 一段描述会跟着进入 B，在 B 点提交时发出去的却是 A 的内容（与输入框/附件同一类串台）。
    // 后端/时长/数量是**用户偏好**，跨会话保留更合理，所以只清 prompt。
    setVideoRequest((current) => (current.prompt ? { ...current, prompt: "" } : current));
  }

  function newSession() {
    const session: PlaygroundSession = { id: crypto.randomUUID(), title: "新对话", messages: [], createdAt: new Date().toISOString() };
    // 空对话最多只保留一个：新建时顺手清掉已有的空会话（用户没打过字就点了"新对话"的情况）。
    setSessions((all) => [session, ...all.filter((s) => s.messages.length > 0)]);
    setActiveId(session.id);
    // **与 switchSession 同一套清理**：输入框、附件、计划开关都是组件级 state。
    // 「新对话」不改清的话，在 A 里写了一半的文字/选好的图片会跟着进入全新会话——
    // 用户看到的是空白对话，点发送却把上一段草稿发了出去（跨会话串台）。
    setInput("");
    setAttachments([]);
    setPlanNext(false);
    // 与 switchSession 同一套清理（含视频描述草稿），避免跨会话串台。
    setVideoRequest((current) => (current.prompt ? { ...current, prompt: "" } : current));
  }

  async function pickAttachment() {
    // IPC 可能 reject（不只是 ok:false）；不兜住的话点「附件」毫无反应。
    try {
      const response = await window.h3.selectFile("attachment");
      // `ok:false`（主进程打开对话框失败）也要报出来：只判 `data` 时与旧 bug 表现一致——
      // 点了没反应，用户无从判断是没选中还是坏了（同连接页两个「选择」按钮那批）。
      if (!response.ok) { onError(response.message || "无法打开文件选择器"); return; }
      if (!response.data) return;
      const payload = await window.h3.readAttachment(response.data);
      if (!payload.data) { onError(new Error(payload.message || "读取附件失败")); return; }
      if (payload.data.kind === "other") { onNotice(`已添加附件 ${payload.data.name}（此类型仅作为文件名提示发送）`); }
      // 截断必须告诉用户：主进程只取前 10 万字符，不提示的话用户以为整份文件都进了对话。
      if (payload.data.truncated) { onNotice(`${payload.data.name} 内容较长，只发送了前 10 万字符（超出部分未包含）。`); }
      // 图片必须先压缩再进会话：主进程允许 15MB，base64 后约 20MB，
      // 而会话整体写进 localStorage（配额 5–10MB）——一张照片就会让之后所有会话
      // 持久化失败，重启后整段对话丢失。压缩后通常降到数百 KB。
      const dataUrl = payload.data.dataUrl
        ? await downscaleDataUrl(payload.data.dataUrl)
        : undefined;
      setAttachments((all) => [...all, { name: payload.data!.name, dataUrl, text: payload.data!.text }]);
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
      session = { id: crypto.randomUUID(), title: sliceSafe(text, 20) || "新对话", messages: [], createdAt: new Date().toISOString() };
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
    setSessions((all) => all.map((s) => s.id === sessionId ? { ...s, title: s.messages.length === 0 && text ? sliceSafe(text, 20) : s.title, updatedAt: new Date().toISOString(), messages: [...s.messages, userMsg, assistantMsg] } : s));
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
        // 计划轮次标记也要清：主进程 handler 抛错时**不会**推 llm:done，
        // 那个负责清理的回调永远不会跑。留着的话下一轮会被误判成"计划轮"，
        // 收尾时给普通回答也亮出「继续执行」按钮。
        planTurnRef.current.delete(sessionId);
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
    // 双击「提交生成任务」会创建**两组**任务。工作台侧早就用 submittingRef 同步守卫挡过
    // （React state 在同一 tick 内读到两次 false），游乐场这处漏了：RB 后端每次提交都扣卡密
    // 次数，重复提交等于直接重复扣费；云后端同理。
    if (videoSubmittingRef.current) return;
    videoSubmittingRef.current = true;
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
    } finally {
      videoSubmittingRef.current = false;
    }
    if (!result.ok) { onError(result.message); return; }
    const taskIds = result.data?.map((task) => task.id) ?? [];
    const summary = `已提交视频生成（${backendLabel(videoRequest.backend)}${videoRequest.preset ? ` · ${rbPresetLabel(videoRequest.preset)}` : ""}）：${sliceSafe(effectivePrompt, 60)}${effectivePrompt.length > 60 ? "…" : ""}`;
    const assistantMsg: PlaygroundMessage = { id: crypto.randomUUID(), role: "assistant", content: summary, taskGroups: taskIds.length ? [taskIds] : undefined };
    const stamp = new Date().toISOString();
    setSessions((all) => all.map((s) => s.id === session!.id ? { ...s, updatedAt: stamp, messages: [...s.messages, { id: crypto.randomUUID(), role: "user" as const, content: `🎬 生成视频：${sliceSafe(effectivePrompt, 80)}` }, assistantMsg] } : s));
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
  // 筛选值可能失效：把最后一个属于该分类的会话删掉/改分类后，
  // `sessionFilter` 指向的分类已不在 `categories` 里——列表变空，而对应的筛选按钮
  // 也没了，用户找不到"怎么变回去"的入口（工作台的分类筛选踩过同一次，见 activeCategoryFilter）。
  // 用**派生值**兜住（不做 setState 同步，避免引入渲染循环）：失效时按"全部"显示。
  const activeSessionFilter = sessionFilter === "全部" || categories.includes(sessionFilter) ? sessionFilter : "全部";
  const filteredSessions = activeSessionFilter === "全部" ? visibleSessions : visibleSessions.filter((s) => s.category === activeSessionFilter);
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
  // **新→旧**排列（reverse 之后），所以收起态摘要要取 `[0]` 才是"最新一步"。
  const [showRuns, setShowRuns] = useState(false);
  const recentRuns = useMemo(
    () => (active?.messages ?? []).flatMap((msg) => msg.toolSteps ?? []).slice(-8).reverse(),
    [active?.messages]
  );
  const current = visibleSessions.find((s) => s.id === activeId);
  // 当前会话被删除/过滤时自动落到列表第一个。
  //
  // **落位时要按"切会话"同一套清理**：这条路径绕过了 `switchSession()`，
  // 不清理的话，在 A 里写了一半的文字/选好的图片会跟着落到 B——
  // 用户看到的是 B 的气泡，点发送却把 A 的草稿发了出去（与 switchSession 那处同类串台）。
  useEffect(() => {
    if (activeId && !visibleSessions.some((s) => s.id === activeId)) {
      setActiveId(visibleSessions[0]?.id || "");
      setInput("");
      setAttachments([]);
      setPlanNext(false);
      setVideoRequest((current) => (current.prompt ? { ...current, prompt: "" } : current));
    }
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
    // 从回收站恢复后会**切到该会话**，与 switchSession 同一套清理必须跟上：
    // 否则在 A 里写了一半的文字/附件会跟着落到恢复出来的 B（跨会话串台）。
    setInput("");
    setAttachments([]);
    setPlanNext(false);
    setVideoRequest((current) => (current.prompt ? { ...current, prompt: "" } : current));
  }
  function purgeSession(session: PlaygroundSession) {
    setSessions((all) => all.filter((s) => s.id !== session.id));
    // 顺带清掉磁盘上的产物目录：会话记录一删，那些产物在界面里再也打不开，
    // 却会一直占着 userData/artifacts/<sessionId>/（模型生成一份 3D 页面就是几百 KB）。
    // 失败不打断删除动作——目录可能本就不存在。
    void window.h3.purgeSessionArtifacts(session.id).catch(() => undefined);
  }
  function commitRename() {
    if (!renamingId) return;
    const title = sliceSafe(renameDraft.trim(), 40);
    if (title) setSessions((all) => all.map((s) => s.id === renamingId ? { ...s, title } : s));
    setRenamingId(undefined);
  }
  // 会话分类：同样改为内联输入（window.prompt 在 Electron 中不可用）。
  const [catSessionId, setCatSessionId] = useState<string>();
  const [catSessionDraft, setCatSessionDraft] = useState("");
  function commitSessionCategory() {
    if (!catSessionId) return;
    const normalized = sliceSafe(catSessionDraft.trim(), 20);
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
          <button className={activeSessionFilter === "全部" ? "on" : ""} onClick={() => setSessionFilter("全部")}>全部</button>
          {categories.map((c) => <button key={c} className={activeSessionFilter === c ? "on" : ""} onClick={() => setSessionFilter(c)}>{c}</button>)}
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
              <div className="pg-bubble">{msg.toolSteps && msg.toolSteps.length > 0 && <PgToolSteps steps={msg.toolSteps} running={Boolean(msg.streaming)} />}{msg.content ? <PgMarkdown content={msg.content} /> : msg.streaming ? <span className="pg-cursor" /> : <em>（空回复）</em>}{msg.streaming && msg.content && <span className="pg-cursor" />}{(() => {
                // 优先用主进程推来的已落盘产物（元数据，内容在磁盘上）。
                // 回落到扫描正文围栏：兼容历史消息，以及模型没用工具、直接在回复里写文件内容的老路径。
                if (msg.role === "assistant" && msg.artifacts?.length) {
                  return <PgArtifactList
                    items={msg.artifacts}
                    sessionId={activeId}
                    onPreview={setPreview}
                    onError={onError}
                  />;
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
              {/* 重试会新建一个任务组（不同 parentId），而气泡只渲染自己 taskGroups 里的 id。
                  不把新任务并进来，用户点完「重试」在这个会话里**看不到任何变化**——
                  新任务在任何界面都不显示（游乐场不展示全局任务列表）。
                  做法：把新任务 id 追加到本次工具调用的那个组里（原失败卡仍在，便于对照）。 */}
              {msg.taskGroups && msg.taskGroups.length > 0 && msg.taskGroups.map((group, gi) => group.length > 0 && <div key={`${msg.id}-${gi}`} className="result-grid pg-task-grid">{group.map((taskId, i) => <TaskCard key={taskId} task={activeTasks.get(taskId)} index={i % 4} onError={onError} allowDemoPlaceholder={false} onRetried={(created) => {
                setSessions((all) => all.map((session) => session.id !== activeId ? session : {
                  ...session,
                  messages: session.messages.map((message) => message.id !== msg.id ? message : {
                    ...message,
                    taskGroups: (message.taskGroups ?? []).map((entry, index) => index === gi && !entry.includes(created.id) ? [...entry, created.id] : entry)
                  })
                }));
                onNotice(`已重新提交，新任务已加入本组（${sliceSafe(created.prompt, 20)}）`);
              }} />)}</div>)}
            </div>)}
          <div ref={bottomRef} />
        </div>
        {/* 运行面板（对齐 Codex Desktop 底部可折叠面板的骨架）：默认收起，只占一行。
            数据直接复用气泡里的 toolSteps——不新增数据源，也就不会与气泡显示不一致。 */}
        <div className={`pg-runs${showRuns ? " open" : ""}`}>
          <button className="pg-runs-head" onClick={() => setShowRuns(!showRuns)} title={showRuns ? "收起运行记录" : "展开运行记录"}>
            <span className="pg-runs-arrow">{showRuns ? "▾" : "▸"}</span>
            运行面板
            {/* 收起态摘要要显示**最新一步**：recentRuns 已是新→旧，取 [0]。
                取 [length-1] 会显示这一批里最旧的一条（用户看到的进度是反的）。 */}
            {recentRuns.length > 0 && <span className="pg-runs-last">{recentRuns[0]}</span>}
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
            {/* 这个方形键在生成中就是停止键：图标已经是 ■，却还 disabled（灰掉、点了没反应），
                用户只能去下面 chips 里找「■ 停止」。图标语义已经说明它是停止，就让它真能停。 */}
            <button className="primary" aria-label={generating ? "停止生成" : "发送"} title={generating ? "停止生成" : "发送（Enter）"} disabled={!generating && !input.trim() && attachments.length === 0} onClick={generating ? stop : send}>{generating ? "■" : "▲"}</button>
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
        {preview && <PgPreviewPanel artifact={preview} onClose={() => setPreview(undefined)} width={previewWidth} onResize={resizePreview} onError={onError} />}
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
export function extractArtifact(content: string): { kind: ArtifactKind; content: string } | undefined {
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
    // `md` 必须收下：它正是 create_file 的 kind 枚举值之一（html/csv/tsv/md），
    // 模型自己写围栏时也最常用它。漏掉这条时，```md 的文档**一张卡片都挂不上**——
    // 文件其实能落盘（走工具路径），但"模型直接在回复里给文档"的老路径静默失效，
    // 用户只看到一大段代码块，和补 xlsx 别名之前那次是同一类问题。
    if (/^(markdown|md|docx|doc)$/i.test(lang)) return { kind: "doc", content: code };
  }
  return undefined;
}

interface ArtifactInfo {
  name: string;
  path: string;
  size: number;
  kind: ArtifactKind;
  content: string;
  /**
   * 修订号：文件被 edit_artifact 改写过一次就换一个值。
   *
   * 为什么不能只靠 path：预览 iframe 走 `h3preview:` **按 URL 加载**，
   * path 没变就不会重新请求，用户会一直看到改动前的旧画面
   * （真机上这会让人误判"模型没改好"）。把它放进 iframe 的 key 与读取依赖里。
   */
  revision?: number;
}

/**
 * 同名产物的多个版本折叠成「最新一版 + 旧版本」。
 *
 * 为什么会有多版：模型按 `inspect_artifact` 的报错修 bug 时会**整份重写**，
 * 而 `uniqueArtifactPath`（main.ts）刻意不覆盖同名文件，于是依次落成
 * `名字.html` → `名字 (2).html` → `名字 (3).html`。一次请求能留下 3–5 张卡片，
 * 用户得读回复去猜哪张才是最终版——实测真机里模型自己写着
 * "请用鹈鹕骑自行车_3D (2).html，前面的是废弃初版，可以删掉"。
 *
 * 判定"同一份文件的不同版本"只靠命名约定：去掉 ` (n)` 后缀后主名 + 扩展名相同。
 * 这是 `uniqueArtifactPath` 唯一的产出形状，不做更花哨的相似度猜测
 * （同名但用户真要两份并存的情况，展开后照旧都在）。
 *
 * 返回顺序按各版本**首次出现**的位置，卡片位置不会因后续版本出现而跳动。
 */
export function foldArtifactVersions<T extends { name: string }>(items: readonly T[]): Array<{ latest: T; older: T[] }> {
  // 主名：`鹈鹕 (2).html` → `鹈鹕.html`。只剥末尾的 ` (数字)`，中间的括号是文件名的一部分。
  const stemOf = (name: string) => name.replace(/ \(\d+\)(?=\.[^.]+$|$)/, "");
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = stemOf(item.name);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  // Map 保持插入顺序 = 首次出现顺序。
  return Array.from(groups.values()).map((bucket) => ({ latest: bucket[bucket.length - 1], older: bucket.slice(0, -1) }));
}

/**
 * 产物卡片列表：每个主名只默认展示**最新一版**，旧版本收在一个小按钮后面。
 * 只影响展示，磁盘上每一版都还在（用户想比对时可以展开）。
 */
function PgArtifactList({ items, sessionId, onPreview, onError }: {
  items: NonNullable<PlaygroundMessage["artifacts"]>;
  sessionId: string;
  onPreview: (artifact: ArtifactInfo) => void;
  onError: (e: unknown) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const groups = foldArtifactVersions(items);
  return <>{groups.map(({ latest, older }) => {
    const open = expanded.has(latest.path);
    const visible = open ? [...older, latest] : [latest];
    return <div key={latest.path} className="pg-artifact-group">
      {visible.map((a, i) => <PgArtifactCard
        key={`${a.path}-${i}`}
        kind={a.kind}
        saved={{ name: a.name, path: a.path, size: a.size, kind: a.kind, content: "" }}
        sessionId={sessionId}
        onPreview={onPreview}
        onError={onError}
      />)}
      {older.length > 0 && <button
        className="pg-artifact-versions"
        title={open ? "只看最新一版" : "展开这次请求留下的所有版本"}
        onClick={() => setExpanded((all) => {
          const next = new Set(all);
          if (open) next.delete(latest.path); else next.add(latest.path);
          return next;
        })}
      >{open ? "收起旧版本" : `另有 ${older.length} 个旧版本`}</button>}
    </div>;
  })}</>;
}

/** 产物文件卡片：图标 + 文件名 + 大小 + 预览/打开文件夹（WorkBuddy 形态）。
 * 两种来源：① 主进程 create_file 推来的**已落盘**元数据（saved 有值，直接可用）；
 * ② 旧路径——从消息正文的围栏代码块扫出来的内容（懒落盘，首次点「预览」才写文件）。 */
function PgArtifactCard({ kind, content, saved, sessionId, onPreview, onError }: { kind: ArtifactKind; content?: string; saved?: ArtifactInfo; sessionId: string; onPreview: (artifact: ArtifactInfo) => void; onError: (e: unknown) => void }) {
  // 懒落盘（旧路径：从消息正文围栏扫出来的内容）的结果。**不能把 saved 也塞进 state**：
  // `useState(saved)` 只快照第一次渲染的值，之后父组件推送"产物已更新"事件时
  // size 变了、卡片却仍显示旧值（实测：模型改完文件，卡片大小纹丝不动）。
  // 现在 saved 每次渲染直接参与计算，始终是最新元数据。
  const [savedLocally, setSavedLocally] = useState<ArtifactInfo | undefined>(undefined);
  const artifact: ArtifactInfo | undefined = saved
    ? { ...saved, content: saved.content || savedLocally?.content || "" }
    : savedLocally;
  // 懒落盘的去重：`artifact` 是派生值，同一 tick 内连点两次「预览」会双双读到 undefined，
  // 各自调一次 saveArtifact —— 落盘两次、生成两个内容相同的文件（`报告.md` 与 `报告 (2).md`），
  // 用户却在卡片上只看到一张。用同步 ref 兜住。
  const savingRef = useRef<Promise<ArtifactInfo | undefined> | undefined>(undefined);
  // **脏数据会渲染出「NaN KB」**（实测）：`size` 来自 IPC/旧版本 localStorage，
  // 缺失、null、非数字都可能出现——`undefined / 1024` 就是 NaN，
  // `Math.round(NaN)` 还是 NaN，于是卡片上显示一个尺寸"NaN KB"。
  // 拿不到可信数字时不显示尺寸，比显示一个假的数字好（用户会以为文件坏了）。
  const sizeLabel = (bytes: unknown) => {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };
  // 表格产物存 .xlsx（Excel 双击可开，主进程 SheetJS 转换）；文档存 .md；网页存 .html。
  const ext = kind === "html" ? ".html" : kind === "sheet" ? ".xlsx" : ".md";
  const label = kind === "html" ? "HTML 文件" : kind === "sheet" ? "Excel 表格" : "Markdown 文档 · Word 可打开";
  async function ensureSaved(): Promise<ArtifactInfo | undefined> {
    if (artifact) return artifact;
    if (content === undefined) return undefined; // 既没落盘元数据也没内容：无从保存
    // 已有一次保存在进行中：直接复用那个 Promise，不再发第二次 IPC。
    if (savingRef.current) return savingRef.current;
    const name = `artifact-${Date.now()}${ext}`;
    const saveKind = kind === "sheet" ? "xlsx" : kind === "doc" ? "md" : "html";
    // IPC 也可能**抛异常**（不只是返回 ok:false）。不兜住的话点「预览」毫无反应、
    // 也没有任何提示（与 send()/executePlan() 同一类问题）。
    const task = (async (): Promise<ArtifactInfo | undefined> => {
      try {
        const response = await window.h3.saveArtifact(sessionId, name, content, saveKind);
        if (!response.data) { onError(response.message); return undefined; }
        const info = { ...response.data, kind, content };
        setSavedLocally(info);
        return info;
      } catch (error) {
        onError(error);
        return undefined;
      } finally {
        // 无论成败都释放：失败后用户再点一次应当能重试，不能被一个陈旧的空结果卡住。
        savingRef.current = undefined;
      }
    })();
    savingRef.current = task;
    return task;
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
function PgPreviewPanel({ artifact, onClose, width, onResize, onError }: { artifact: ArtifactInfo; onClose: () => void; width: number; onResize: (width: number) => void; onError: (e: unknown) => void }) {
  const [nonce, setNonce] = useState(0);
  const [diskContent, setDiskContent] = useState<string>();
  // 主进程的截断说明（"文件较大，仅显示前 1MB" 等）。**必须与正文分开存**：
  // 表格预览把正文直接喂 `parseCsvRows`，说明拼进去会变成一行假数据。
  const [readNote, setReadNote] = useState<string>();
  // 表格的**真实总行数**（主进程只回前 2000 行的正文）。表格下方的"共 N 行"
  // 必须用它，否则用户会同时看到 note 里的"共 5001 行"和表下方的"共 2000 行"（实测矛盾）。
  const [totalRows, setTotalRows] = useState<number>();
  const [readError, setReadError] = useState<string>();
  // 是否已读完（内容可能是合法的空串）。不区分的话，空文件会永远显示"（正在读取…）"。
  const [loaded, setLoaded] = useState(false);
  const needsContent = artifact.kind !== "html" && !artifact.content;
  useEffect(() => {
    // **换产物时必须清掉上一份的读取结果**：组件是按位置复用的（同一 <PgPreviewPanel>），
    // 只清 loaded / readError 不够——`content = artifact.content || diskContent` 里的
    // diskContent 仍是上一份文件的内容，读新文件的几百毫秒里面板会显示**旧产物**，
    // 用户以为点错了。
    setDiskContent(undefined);
    setReadNote(undefined);
    setReadError(undefined);
    setTotalRows(undefined);
    if (!needsContent) { setLoaded(true); return; }
    let cancelled = false;
    setLoaded(false);
    void window.h3.readArtifactText(artifact.path).then((r) => {
      if (cancelled) return;
      // 读取失败必须让人看见（CLAUDE.md「出错必须让人看见」）——否则面板永远停在
      // "（正在读取…）"，看起来像卡住，实际是读文件报错了（xlsx 预览整片失效就是这样被掩盖的）。
      if (r.data !== undefined) {
        setDiskContent(r.data.text);
        setReadNote(r.data.note);
        setTotalRows(r.data.totalRows);
      } else setReadError(r.message || "读取产物内容失败。");
      setLoaded(true);
    }).catch((e) => { if (!cancelled) { setReadError(describeError(e, "读取产物内容失败。")); setLoaded(true); } });
    return () => { cancelled = true; };
    // 依赖里带 nonce：点「↻ 重新加载」时要**真的重新读盘**。
    // 此前 nonce 只用于重挂载 DOM，表格/文档读到的是 state 里的旧内容——按钮点了像没反应
    // （只有 html 分支因为 iframe 重新加载才真的刷新）。
    // **revision**：文件被 edit_artifact 改写后，path 不变但内容变了，必须重读。
  }, [artifact.path, artifact.revision, needsContent, nonce]);
  const content = artifact.content || diskContent || "";
  const dragRef = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  // 拖拽中的最新宽度：松手时用它落盘（不依赖闭包里过期的 width）。
  const latestWidthRef = useRef(width);
  latestWidthRef.current = width;
  // 拖拽期间挂在 window 上的清理函数。组件在拖拽途中被卸载（切会话会关预览、
  // 也可能直接点关闭）时 mouseup 永远不会触发，监听器会永久残留：
  // 之后每次鼠标移动都在对一个已卸载组件的 setState 里跑，且拖拽状态永远不复位。
  const dragCleanupRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = undefined;
  }, []);
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
    const detach = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      dragCleanupRef.current = undefined;
    };
    const up = () => {
      dragRef.current = undefined;
      // 松手时才写盘：拖拽时 mousemove 每秒上百次，逐次同步写 localStorage 会卡。
      savePreviewWidth(latestWidthRef.current);
      detach();
    };
    // 重复触发 onDragStart（前一次还没松手）时先摘掉旧监听器，避免叠多份。
    dragCleanupRef.current?.();
    dragCleanupRef.current = detach;
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
        <button className="pg-tool" title="在文件夹中显示" onClick={() => window.h3.showItem(artifact.path).then((r) => { if (!r.ok) onError(r.message || "无法打开所在文件夹"); }).catch(onError)}>📁</button>
        <button className="pg-tool" title="关闭预览" onClick={onClose}>×</button>
      </span>
    </div>
    {/* HTML 预览走 h3preview: 协议**按 URL 加载**，不用 srcDoc——srcdoc iframe 会继承宿主 CSP，
        预览页的内联脚本会被拦掉（游戏跑不起来）。sandbox 保持 allow-scripts：不透明源，
        拿不到宿主 DOM 与 window.h3.* 的 IPC 面。 */}
    {artifact.kind === "html" && <iframe
      key={`${nonce}:${artifact.revision ?? 0}`}
      ref={frameRef}
      className="pg-preview-frame"
      sandbox="allow-scripts"
      src={`h3preview://artifact/?path=${encodeURIComponent(artifact.path)}`}
      onLoad={focusFrame}
      title={artifact.name}
    />}
    {artifact.kind === "sheet" && <div className="pg-preview-doc" key={nonce}>{readError ? <p className="pg-preview-doc-empty">读取失败：{readError}</p> : !loaded ? <p className="pg-preview-doc-empty">（正在读取…）</p> : content ? <><SheetTable csv={content} totalRows={totalRows} />{readNote && <p className="pg-preview-doc-empty">{readNote}</p>}</> : <p className="pg-preview-doc-empty">（这个表格没有任何内容）</p>}</div>}
    {artifact.kind === "doc" && <div className="pg-preview-doc" key={nonce}>{readError ? <p className="pg-preview-doc-empty">读取失败：{readError}</p> : !loaded ? <p className="pg-preview-doc-empty">（正在读取…）</p> : content ? <>{renderMarkdown(content)}{readNote && <p className="pg-preview-doc-empty">{readNote}</p>}</> : <p className="pg-preview-doc-empty">（这个文档没有任何内容）</p>}</div>}
  </aside>;
}

/** CSV/TSV 文本 → 表格渲染（首行表头）。渲染端简单解析，不引解析库。
 * 表格字段含逗号时，SheetJS 的 sheet_to_csv 会输出引号包裹的 CSV（如 `a,"b,c",d`）；
 * 含**换行**的字段还会变成跨行引号字段。parseCsvRows 同时处理这两种情况。
 *
 * **行数上限**：预览是只读展示用途，一次性铺开全部行会把主线程占满——
 * 5 万行 × 3 列 ≈ 20 万个 DOM 节点，实测级别的卡顿。
 * 超过 `MAX_PREVIEW_ROWS` 只渲染前若干行并明确告知（不静默少给）。 */
const MAX_PREVIEW_ROWS = 500;

function SheetTable({ csv, totalRows }: { csv: string; totalRows?: number }) {
  // 解析结果必须记住：拖拽面板宽度时父组件每帧都在 setState，本组件随之重渲染，
  // 而 `parseCsvRows` 是逐字符扫描整段 CSV（预览上限 1MB）——不 memo 的话
  // 拖一次面板会做上百次全量解析，界面明显发涩。
  const rows = useMemo(() => parseCsvRows(csv), [csv]);
  if (rows.length === 0) return <p className="pg-preview-doc-empty">（空表格）</p>;
  const [header, ...allBody] = rows;
  const body = allBody.slice(0, MAX_PREVIEW_ROWS);
  const hidden = allBody.length - body.length;
  // 显示的行数用**文件真实总行数**（主进程只回前 2000 行正文）。
  // 只看 `allBody.length` 会与上方 note 里的"表格共 5001 行"打架（实测）。
  const totalForDisplay = totalRows && totalRows > allBody.length ? totalRows : allBody.length;
  return <>
    <table className="pg-sheet-table">
      <thead><tr>{header.map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead>
      <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {hidden > 0 && <p className="pg-preview-doc-empty">（共 {totalForDisplay} 行，预览仅显示前 {MAX_PREVIEW_ROWS} 行；完整内容请在文件夹中打开）</p>}
  </>;
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
  // 数的是**工具调用次数**（每次调用追加两条：start 的 "→ …" 与 end 的 "✓ …"）。
  // 直接 steps.length 会把 1 次 create_file 说成 2 步（实测）。
  //
  // 措辞用「次」而不是「步」（实测矛盾）：主进程的 `stepCountIs(20)` 数的是**模型步**，
  // 而一步里可能并行多个工具调用。真实一轮出现过「已执行 28 步工具调用」+「已达 20 步上限」
  // 同屏——两个数字都"对"，单位却不同，用户只会觉得软件在胡言乱语。
  const callCount = steps.filter((step) => step.startsWith("→")).length;
  return <div className="pg-tool-steps-wrap">
    {!running && <button className="pg-tool-steps-toggle" onClick={() => setOpen((v) => !v)} title={expanded ? "收起执行过程" : "展开执行过程"}>
      <span className="pg-tool-steps-arrow">{expanded ? "▾" : "▸"}</span>已执行 {callCount || steps.length} 次工具调用<span className="pg-tool-steps-last">· {last.length > 40 ? `${sliceSafe(last, 40)}…` : last}</span>
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
  // 二次确认用**内联两段式**而不是 window.confirm：
  // confirm 在 Electron 里会弹阻塞式原生对话框，且自动化（CDP）会被挂住；
  // 本项目对 prompt 已有同样教训（"prompt() is not supported"），统一步调。
  const [confirmingId, setConfirmingId] = useState<string>();
  return <div className="pg-trash-overlay" onClick={onClose}>
    <section className="pg-trash" onClick={(e) => e.stopPropagation()}>
      <header><strong>会话回收站</strong><small>删除的会话保留 {retentionDays} 天，到期自动清除</small><button className="text-button" onClick={onClose}>关闭</button></header>
      {sessions.length === 0 && <p className="footnote">回收站是空的。</p>}
      {sessions.map((session) => <article key={session.id} className="trash-item">
        <div><strong>{session.title || "新对话"}</strong>
          <small>{session.messages.length} 条消息 · {session.deletedAt ? `${daysLeft(session.deletedAt)} 天后自动清除` : ""}</small></div>
        <div className="trash-actions">
          <button className="text-button" onClick={() => onRestore(session)}>恢复</button>
          {/* 彻底删除不可逆（会话记录 + 产物目录一起删）。第一次点击变成确认态，
              避免误触后没有挽回途径；点别处或再点「取消」即退出确认态。 */}
          {confirmingId === session.id
            ? <>
                <button className="text-button danger" onClick={() => { setConfirmingId(undefined); onPurge(session); }}>确认删除</button>
                <button className="text-button" onClick={() => setConfirmingId(undefined)}>取消</button>
              </>
            : <button className="text-button danger" onClick={() => setConfirmingId(session.id)}>彻底删除</button>}
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
