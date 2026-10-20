import { describeError } from "../../shared/errors";
import type { ChatMessage, LlmStreamEvent } from "../../shared/types";
import { sliceSafe } from "../../shared/text";
import { searchWeb } from "./webSearch";

export interface LlmServiceOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  searchBaseUrl?: string;
  searchApiKey?: string;
  /**
   * 搜索的浏览器渲染回退（由主进程注入；模块本身不 import electron，保持可单测）。
   * 带 `signal`：用户点「停止」时要能立刻中断渲染——浏览器渲染最长 25 秒，
   * 不接取消信号的话停止按钮看起来毫无反应。
   */
  searchRenderHtml?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** 智能体模式（chatAgent）使用的框架版本——由 updateChecker 独立检查更新。 */
  frameworkVersion?: string;
  /**
   * 「等响应头」的超时（默认 120 秒，与 `consumeSse` 的空闲超时同口径）。
   * 只给单测缩短用——产品里不必配。
   */
  headerTimeoutMs?: number;
}

export type ChunkSender = (event: LlmStreamEvent) => void;

// OpenAI 兼容 /chat/completions 流式对话 + SSE 解析。无 SDK，纯 fetch。
export class LlmService {
  private readonly baseUrl: string;
  private controller?: AbortController;

  constructor(private readonly options: LlmServiceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  get busy(): boolean {
    return Boolean(this.controller);
  }

  abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** browserOnly=true 走「浏览器搜索」：搜索只用应用自带 Chromium 渲染（游乐场的可选联网项）。 */
  async chat(messages: ChatMessage[], webSearch: boolean, send: ChunkSender, browserOnly = false): Promise<void> {
    if (this.busy) throw new Error("上一轮对话还在进行中，请先停止或等待完成。");
    if (!this.options.apiKey && !/127\.0\.0\.1|localhost/.test(this.baseUrl)) {
      throw new Error("请先在连接设置中保存游乐场 LLM 的 API Key。");
    }
    // 控制器必须**先建**再准备载荷：`buildPayload` 里含联网搜索（浏览器渲染可达数十秒），
    // 期间若 busy 仍是 false，同会话并发守卫失效（用户能再发一条，两股流抢同一个气泡）；
    // 用户点「停止」也没有 controller 可中止，只能干等搜索跑完。
    const controller = new AbortController();
    this.controller = controller;
    try {
      const payload = await this.buildPayload(messages, webSearch, browserOnly, controller.signal);
      // **等响应头也要有超时**。
      //
      // `consumeSse` 的空闲超时只在**已经拿到响应头**之后才生效；上游若接受 TCP 连接
      // 却永不回响应头（网关卡死、中间层黑洞、服务半开），`fetch` 会一直挂着，
      // 而这里传的是用户取消信号（本身永不到期）——整轮对话永久卡住，
      // 「停止」按钮点了也只是 abort 一个已经在等的 promise（其实能救，但用户不知道要等多久）。
      // 实测（probe-chat-headers，本机起一个只接受连接不回头的 server）：8 秒后仍未落定。
      //
      // 单独计时而不是给 fetch 加 `AbortSignal.timeout`：那样会连**整个流式读取**一起限时，
      // 长回答（几十秒到几分钟）会被误杀。拿到响应头就立刻 clear。
      let headerTimedOut = false;
      const HEADER_TIMEOUT_MS = this.options.headerTimeoutMs ?? 120_000; // 与 consumeSse 的空闲超时同口径
      const headerTimer = setTimeout(() => {
        headerTimedOut = true;
        controller.abort();
      }, HEADER_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${resolveChatPath(this.baseUrl)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {})
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: payload,
            stream: true,
            // 与智能体路径同一个理由：不设就用上游默认（实测该中转约 4096 tokens），
            // 普通对话里让模型写长内容（长文档、长代码）同样会被静默截断。
            max_tokens: 64_000
          }),
          signal: controller.signal
        });
      } catch (error) {
        // 区分"我们等不到响应头"与"用户点了停止"——后者是正常收尾，不该报超时。
        if (headerTimedOut) {
          throw new Error(`服务商超过 ${HEADER_TIMEOUT_MS / 1000} 秒没有返回响应（地址可能填错、服务卡死或被网络中间层拦截）。请检查连接设置后重试。`);
        }
        throw error;
      } finally {
        clearTimeout(headerTimer);
      }
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(httpFailureMessage(response.status, detail));
      }
      // 流式响应走 SSE 解析；服务商忽略 stream:true 返回完整 JSON 时，从非流式结构取内容。
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const received = await consumeSse(response.body, send);
        if (!received) {
          // 流式 200 却零内容（部分中转/模型的已知毛病）：自动降级发一次非流式请求，而不是直接报错。
          // 把本轮 controller 显式传进去，**不能让它读 `this.controller`**：
          // 用户在"流式读完了但没内容"的那一刻点「停止」时，`abort()` 会把字段置空，
          // 于是补发请求只带超时信号、仍然真的发出去（最长 120 秒），
          // 回来后还会把内容推进一个用户以为已经停掉的气泡。
          const fallback = await this.nonstreamChat(payload, controller);
          if (fallback) send({ seq: 1, delta: fallback });
          else throw new Error("服务商未返回任何内容（流式与非流式均为空），请检查模型名称或更换服务商。");
        }
      } else {
        const full = (await response.json().catch(() => ({}))) as {
          choices?: Array<{ message?: { content?: string }; delta?: { content?: string }; text?: string }>;
          content?: string;
          base_resp?: { status_msg?: string };
        };
        // **不能用 `??` 链**：`??` 只在 null/undefined 时回退，空串是"有值"。
        // 上游常见形态是 `choices[0].message.content` 为空串、真正内容在 `delta.content`
        // 或顶层 `content` 里——用 `??` 会选中空串，然后把"明明有内容"报成
        // "服务商未返回内容"。这里取第一个**非空**字符串。
        const text = firstNonEmpty(full.choices?.[0]?.message?.content, full.choices?.[0]?.delta?.content, full.choices?.[0]?.text, full.content);
        if (text) send({ seq: 1, delta: text });
        else throw new Error(`服务商未返回内容：${full.base_resp?.status_msg || JSON.stringify(full).slice(0, 200)}`);
      }
    } finally {
      // 只清自己的那份：`abort()` 与下一轮可能已经换上了新 controller，
      // 无条件清会把新一轮的停止能力抹掉。
      if (this.controller === controller) this.controller = undefined;
    }
  }

  // 非流式补发：流式空回复时的一次自动降级重试（同样载荷，stream:false）。
  // @param turn 本轮自己的 controller。**不能省略、也不要读 `this.controller`**——
  //   后者可能已被 `abort()` 置空（用户点停止）或被下一轮换掉，两种情况都会让这次补发
  //   失去取消能力（最长白跑 120 秒，返回后还会写进一个用户以为已停止的气泡）。
  private async nonstreamChat(payload: Array<Record<string, unknown>>, turn: AbortController): Promise<string | undefined> {
    try {
      // 必须带超时并合并取消信号。这里是"流式已经失败一次"之后的补发，
      // 上游此时往往正处于异常状态；裸 fetch 一挂住，`chat()` 就永不返回，
      // 该会话的 `busy` 与取消器一直被占着——用户点了「停止」也只能等，
      // 之后这条会话再也发不出消息（同会话并发守卫会一直拒绝）。
      const timeout = AbortSignal.timeout(120_000);
      const response = await fetch(`${this.baseUrl}${resolveChatPath(this.baseUrl)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: payload,
          stream: false,
          // 与流式路径同一理由：不设就用上游默认（实测约 4096 token），长回答会被静默截断。
          max_tokens: 64_000
        }),
        signal: AbortSignal.any([turn.signal, timeout])
      });
      if (!response.ok) return undefined;
      const full = (await response.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string }; text?: string }>;
        content?: string;
      };
      // 与流式空回复分支同一理由：`??` 不会跳过空串，取第一个非空值。
      return firstNonEmpty(full.choices?.[0]?.message?.content, full.choices?.[0]?.text, full.content);
    } catch (error) {
      // 用户取消必须**向上抛**：调用方按 `AbortError` 识别取消并静默收尾。
      // 若在这里吞成 `undefined`，上层会抛"服务商未返回任何内容"——用户明明
      // 点的是停止，却看到一条红色失败提示（与本轮修的"取消被当成搜索失败"同类）。
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (turn.signal.aborted) throw new DOMException("对话已取消", "AbortError");
      return undefined;
    }
  }

  // 模型列表（OpenAI 兼容 GET /models）。部分服务商不支持——返回 ok=false 且提示手动填写。
  async listModels(): Promise<{ ok: boolean; models: string[]; message: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        return { ok: false, models: [], message: `该服务商不支持模型列表接口（HTTP ${response.status}），请手动填写模型名。` };
      }
      const payload = (await response.json().catch(() => ({}))) as { data?: unknown };
      // `data` 必须是数组：部分中转在出错时返回 `{data:"..."}` 或 `{data:{...}}`，
      // 不判的话 `(...).map is not a function` 会以英文技术错误透出，而这个按钮
      // 只是"获取模型列表"的便利功能，失败应稳定落到"请手动填写"。
      const entries = Array.isArray(payload.data) ? payload.data : [];
      const models = entries
        .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string" && Boolean(id))
        .sort();
      if (models.length === 0) return { ok: false, models: [], message: "服务商返回了空模型列表，请手动填写模型名。" };
      return { ok: true, models, message: `获取到 ${models.length} 个模型。` };
    } catch (error) {
      return { ok: false, models: [], message: describeError(error, "无法连接服务商") };
    }
  }

  // 联网搜索：优先用户配置的搜索 API；未配置时由 searchWeb 回落免 key 直抓 Bing/搜狗。
  // browserOnly=true 走「浏览器搜索」：只用应用自带 Chromium 渲染，跳过 API 与 HTTP 直抓。
  // 结果拼接为参考段落注入本轮 system 消息。
  private async search(query: string, browserOnly = false, signal?: AbortSignal): Promise<string> {
    return searchWeb(query, {
      apiBaseUrl: this.options.searchBaseUrl,
      apiKey: this.options.searchApiKey,
      renderHtml: this.options.searchRenderHtml,
      browserOnly
    }, signal);
  }

  private async buildPayload(messages: ChatMessage[], webSearch: boolean, browserOnly = false, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const system: Record<string, unknown> = {
      role: "system",
      content: this.options.systemPrompt || "你是 MiniMax H3 视频工作台内置的智能助手。"
    };
    if (webSearch && messages.length > 0) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser?.content) {
        try {
          // 把本轮取消信号透给搜索：否则用户点「停止」后，搜索仍会跑完
          // （浏览器渲染可达数十秒）才轮到下面的 fetch —— 停止看起来没反应。
          const results = await this.search(lastUser.content.slice(0, 200), browserOnly, signal);
          // **中止要立即向上抛，不能被下面的 catch 吞掉**：那个 catch 的语义是
          // "搜索失败 → 基于自身知识回答"，把取消当失败会让用户点了停止后仍继续发请求。
          if (signal?.aborted) throw new DOMException("对话已取消", "AbortError");
          // 空串（配置了搜索 API 但对端返回 0 条）必须**明确告知**，不能什么都不追加。
          // 不告知的话模型以为自己检索过了，直接凭训练知识作答——正是本项目反复踩到的
          // "凭旧知识回答实时问题"。免 key 路径在没有结果时会抛错走下面的 catch，
          // API 路径原本是静默返回空串，两条路径行为不一致（实测 probe-search-empty）。
          system.content = results
            ? `${system.content}\n\n以下是网络搜索结果，回答时可引用：\n${results}`
            : `${system.content}\n\n（联网搜索已执行但未返回任何结果。涉及实时信息时请如实说明本次未能检索到，不要凭记忆给出具体数字或日期；可建议用户换个关键词或稍后再问。）`;
        } catch (error) {
          // 取消不是"搜索失败"：原样抛给调用方，走既有的 AbortError 分支。
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          if (signal?.aborted) throw new DOMException("对话已取消", "AbortError");
          system.content = `${system.content}\n\n（联网搜索失败：${describeError(error, "未知错误")}，请基于自身知识回答。）`;
        }
      }
    }
    const payload: Array<Record<string, unknown>> = [system];
    for (const message of messages) {
      if (message.images?.length) {
        payload.push({
          role: message.role,
          content: [
            { type: "text", text: message.content || "请看这张图片。" },
            ...message.images.map((url) => ({ type: "image_url", image_url: { url } }))
          ]
        });
      } else {
        payload.push({ role: message.role, content: message.content });
      }
    }
    return payload;
  }
}

// 对话端点按域名运行时推导：MiniMax 官方域名走其私有端点，其余（中转/自定义）一律标准 OpenAI 路径。
// 不存储在设置里——彻底避免改 baseUrl 后残留旧端点的脏状态。
//
// 官方有两个域名：国际站 api.minimax.io、中国站 api.minimaxi.com，两者都用 /text/chatcompletion_v2。
// 只认 .io 会让中国站用户走 /chat/completions（该站不存在此路径 → 404）。
// 用 hostname 精确比对，避免 api.minimax.io.evil.com 这类相似域名误命中。
export function resolveChatPath(baseUrl: string): string {
  let host = "";
  try {
    // **必须去掉尾点**：`api.minimax.io.` 是 FQDN 根锚定写法，DNS 解析与无尾点完全等价，
    // 官方接口照样能通。这里若只比字面量，同一个服务会走错端点（→ 404），
    // 而用户在「连接设置」里完全看不出两者有什么区别。与 `assertPublicHost` 同一口径。
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "");
  } catch { host = ""; }
  const isOfficialMinimax = host === "api.minimax.io" || host === "api.minimaxi.com";
  return isOfficialMinimax ? "/text/chatcompletion_v2" : "/chat/completions";
}

/**
 * 取第一个**非空**字符串。
 *
 * 为什么不能用 `a ?? b ?? c`：`??` 只跳过 null/undefined，**空串是有值**。
 * 上游常见形态是 `choices[0].message.content === ""`、真正内容在 `delta.content`
 * 或顶层 `content` 里；用 `??` 会选中空串，把"明明有内容"报成"服务商未返回内容"。
 */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * HTTP 失败 → 给用户看的中文错误。
 *
 * 不能直接把响应体拼进去：反向代理/网关出错时返回的是 **HTML 错误页**，
 * 实测（probe-http-error）上游 502 时界面显示的是
 * `LLM 请求失败：502 <!DOCTYPE html><html><head><title>502 Bad Gateway</title>…`
 * ——整段标签糊在气泡里，用户既读不出信息，也不知道该做什么。
 *
 * 这里按状态码给可执行的结论，只在响应体**看起来是 JSON**（即服务商自己的错误对象）
 * 时才截取其中的 message。HTML / 空体一律不回显。
 */
function httpFailureMessage(status: number, body: string): string {
  const hint = status === 401 || status === 403 ? "请到「连接设置」检查 API Key 是否正确、是否已过期。"
    : status === 404 ? "请检查 API 地址与模型名（有些服务商的路径不是 /v1）。"
      : status === 429 ? "请求过于频繁或额度已用尽，请稍后重试。"
        : status >= 500 ? "服务商侧异常（可能是临时故障或网关错误），请稍后重试。"
          : "请检查连接设置中的地址、Key 与模型名。";
  const detail = extractApiErrorMessage(body);
  return `LLM 请求失败（HTTP ${status}）。${hint}${detail ? `\n服务商说明：${detail}` : ""}`;
}

/** 从错误响应体里取服务商自己写的 message。非 JSON（HTML 错误页等）一律返回空串。 */
function extractApiErrorMessage(body: string): string {
  const text = String(body || "").trim();
  if (!text || text.startsWith("<")) return "";
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      base_resp?: { status_msg?: unknown };
    };
    const candidates = [
      typeof payload.error === "string" ? payload.error : payload.error?.message,
      payload.message,
      payload.base_resp?.status_msg
    ];
    const found = candidates.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    // 上限 200：服务商的 message 偶尔会把整段堆栈塞进来。
    return found ? sliceSafe(found.trim(), 200) : "";
  } catch {
    return "";
  }
}

// ---------- 智能体模式（Vercel AI SDK 工具循环，Codex/Claude Code 形态） ----------

/**
 * 把模型给的"数字"收敛成有限数。**不能只靠 `z.coerce.number()`**（实测缺口）：
 * `Number("8 秒")` / `Number("8s")` / `Number("六秒")` 全是 `NaN`，
 * 而 zod 的 `number()` 会直接拒掉 `NaN` → `parseToolCall` 抛 `InvalidToolInputError`
 * → 整个调用被**静默跳过**（收不到回执 → 反复重试 → 20 步烧光）。
 * 探针实测：`duration: "8 秒"` 让 generate_video 连续 20 次没执行。
 *
 * 这些值下游本来就会夹取（`clampDurationForBackend` 先 `Math.round` 再夹 4–15；
 * `sliceWithLineNumbers` 也会夹紧），所以这里"能读出来就用，读不出才当没给"。
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  // 取第一个数字（含小数）：`"8 秒"` → 8、`"约 6.5s"` → 6.5、`"2 路"` → 2。
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 保证一道选择题的 id 在本轮内唯一（见 `request_user_input` 里那段说明）。
 *
 * 重复时追加 `_2` / `_3`…（仍冲突就一路加上去）。只在**同一轮**内保证唯一即可——
 * 答案回传按 requestId + id 查表，跨轮不会串。
 */
function uniqueQuestionId(id: string, used: Set<string>, index: number): string {
  let candidate = id;
  let suffix = 2;
  // 上限只是防御：每轮最多 3 个问题，碰不到。
  while (used.has(candidate) && suffix < 100) candidate = `${id}_${suffix++}`;
  // 完全空白的 id 也要能落地（`q${index+1}` 已被调用方兜过，这里只防极端）。
  if (!candidate) candidate = `q${index + 1}`;
  used.add(candidate);
  return candidate;
}

export interface AgentToolCallbacks {
  /** 联网搜索工具：返回参考段落（未配置搜索 API 时抛错）。 */
  webSearch: (query: string) => Promise<string>;
  /** 视频生成工具：提交生成任务并返回给用户的说明文本。 */
  generateVideo: (params: { prompt: string; duration: number; count: number; backend?: string }) => Promise<string>;
  /** 打开网页工具（open_page）：用应用自带 Chromium 渲染指定 URL 并返回**可见正文**（innerText），让模型能真正"打开浏览器"。 */
  openPage: (url: string) => Promise<string>;
  /** 文件产物工具（create_file）：把内容保存为文件并返回给模型的确认文本。 */
  createFile: (params: { kind: "html" | "csv" | "tsv" | "md" | "xlsx"; name: string; content: string }) => Promise<string>;
  /**
   * 产物自检工具（inspect_artifact）：把**已落盘**的 HTML 产物在应用自带 Chromium 里真跑一遍，
   * 返回控制台报错与画布状态。这是"写 → 跑 → 看错误 → 修"闭环里缺的那一环——
   * 没有它，模型只能对用户说"我没法运行，你自己看"（实测真机复现，见 browserFetch 的 probeHtmlArtifact）。
   * 只接受文件名（会话内解析），不接受任意路径。
   */
  inspectArtifact: (params: { name: string }) => Promise<string>;
  /**
   * 产物读取工具（read_artifact）：把已落盘的产物按行读回来（带行号）。
   *
   * 实测动机（鹈鹕案例真机）：模型改完一处 bug 后无法核对"我到底改到没有"，
   * 只能凭记忆断言；后来甚至怀疑自检工具加载了缓存。给它读回能力，它才能真正自证。
   * 只接受文件名（会话内解析），不接受任意路径。
   */
  readArtifact: (params: { name: string; startLine?: number; endLine?: number; keyword?: string }) => Promise<string>;
  /**
   * 产物局部编辑工具（edit_artifact）：按上下文精确替换一处，写回**同一个文件**。
   *
   * 对齐 Codex `apply_patch` 的两条硬约束：精确匹配、必须唯一。
   * 动机同 readArtifact——整份重写 40KB 只为改 3 个字符，且模型无法确认改成没有。
   */
  editArtifact: (params: { name: string; oldText: string; newText: string }) => Promise<string>;
  /**
   * 批量局部编辑（edit_artifact_batch）：一次应用多处修改，**全部成功才写盘**。
   *
   * 对齐 Codex `apply_patch` 一次提交多个 hunk。实测动因：模型一次修 5 处 bug，
   * 单处编辑吃 5 步工具预算，叠加 `stepCountIs(10)` 后任务被打断。
   */
  editArtifactBatch: (params: { name: string; edits: Array<{ oldText: string; newText: string }> }) => Promise<string>;
  /** 步骤清单工具（update_plan）：把进度推给渲染端，返回给模型的确认文本。 */
  updatePlan: (params: { explanation?: string; plan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> }) => Promise<string>;
  /**
   * 交互提问工具（request_user_input）：把选择题推给渲染端并**等待**用户回答。
   * 实现方必须带超时，且超时时 reject（不是 resolve 空值）——这样模型能区分"用户选了跳过"
   * 与"拿到了答案"，从而按最佳判断继续而不是以为用户什么都没选。
   */
  requestUserInput: (params: { questions: AgentQuestion[] }) => Promise<string>;
}

/** 交互提问的一道题。与 Codex `request_user_input` 的 schema 一致。 */
export interface AgentQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ id: string; label: string; description: string }>;
}

/** 从打包产物读取智能体框架版本（agentVersion.ts 由构建脚本从 node_modules/ai 同步）。 */
export async function bundledFrameworkVersion(): Promise<string> {
  const { frameworkVersion } = await import("../../shared/agentVersion.js");
  return frameworkVersion;
}

/**
 * 一轮智能体对话允许的最大工具步数。
 *
 * **单一真源**：配置（`stopWhen`）与用户可见文案（"已达 N 步上限"）都读这里。
 * 上一版在 `main.ts` 里把数字写死成 10，改预算时文案就会撒谎。
 *
 * 从 10 提到 20 的实测依据：一整轮"写 → 自检 → 读回 → 批量改 → 再自检"闭环要 5–6 步，
 * 模型通常修 2–3 轮。2026-10-19 连续 7 次真机跑鹈鹕案例，**4 次撞在 10 步上限**。
 * 这是自引入的矛盾：加 `inspect_artifact` 时要求"生成 html 后必须自检、有报错就改到没有"，
 * 每个修复循环固定多吃 2–3 步，却没跟着调预算。
 *
 * 为什么不设成无限：无上限时模型会在同一任务里无限打磨，持续烧 token 而用户拿不到更多东西。
 * 20 步 ≈ 3–4 个完整修复循环，够用且有界。
 */
export const MAX_AGENT_STEPS = 20;

/**
 * AI SDK 多步智能体对话：模型可自主调用 web_search / generate_video 工具，
 * 最多 `MAX_AGENT_STEPS` 步。AI SDK 是 ESM-only——主进程 CJS 产物用动态 import 加载；
 * model 经 createOpenAICompatible 注入（复用连接设置里的 baseUrl/Key/模型名）。
 * 返回 { textLength, toolCalls }：调用方据此判断"模型不支持工具"（0 文本 0 工具调用）
 * 并自动回落普通对话——这正是工具支持检测的运行时落地。
 */
/**
 * 工具返回的文本是否代表**这次操作失败**。
 *
 * 我们的工具有意"失败也返回文本而不是抛异常"（抛出去会让 AI SDK 把整轮判为失败、
 * 主进程回落普通对话，用户的请求直接丢失）。代价是调用方无法从异常判断成败。
 * 实测踩到：`edit_artifact` 拒绝歧义编辑时渲染端拼出 `✓ 修改文件完成（oldText 出现了 2 次…）`，
 * 打勾与"失败"同屏。
 *
 * 判定只认**开头**的失败标记（各工具的错误文案都以"…失败"开头），
 * 不做全文搜索——正文里出现"失败"二字（比如模型生成的页面里有个错误提示）不算。
 */
export function isToolFailure(output: unknown): boolean {
  if (typeof output !== "string") return false;
  // **先跳过开头的"名字回落"说明行**。
  // read/edit 系列在名字对不上时会先回一行 `（你点名的「a.html」…实际读的是「a (2).html」）`，
  // 真正的结果在**下一行**。只取第一句的话，keyword 未命中的 `没有找到` 会被这行说明挡住，
  // 步骤条于是打勾（本会话自引入，实测复现）。
  // 只跳"位于开头、以换行结尾的括号说明"，不会吃掉正文里同形的括号。
  const body = output.replace(/^(?:（[^）]*）\s*\n)+/, "");
  // 只看**第一小句**（到第一个冒号/句号/换行为止）。
  // 用"前 N 个字符"不够：实测 `已读取 500 字正文。页面内容：加载失败时请重试。`
  // 在前 24 字里就出现了"失败"，会被误判成工具失败——而它是一段正常的页面正文。
  //
  // **第一小句本身也要有长度上限**：`read_artifact(keyword)` 未命中时回的是
  // "在 很长的文件名.html（共 2118 行）里没有找到「…」。…"，句号在很后面；
  // 若先按 40 字截再切句，长文件名会把判定标记挤出去（实测 40 字刚好切在「没有找到」前面）。
  const firstSentence = body.split(/[。\n]/, 1)[0] ?? "";
  const head = firstSentence.split(/[：:]/, 1)[0] ?? "";
  // `没有找到` 是 read_artifact(keyword) 的"没命中"，不是失败调用，但对用户是
  // 「这次没找到」——打勾会让人以为读到了内容（实测渲染成 `✓ 读取文件完成（共 2118 行）`）。
  //
  // **"可纠正的拒绝"也算未成功**（本会话放宽 schema 后新增的一类回执）：
  // 参数空/缺时工具**什么都没做**，只回一句让模型改正的话，例如
  // 「搜索关键词是空的。…」「步骤清单是空的：…」「没有要问的问题（questions 是空的）。…」
  // 「没有可应用的修改：edits 是空的。…」。它们不含"失败"二字，旧判定一律打勾，
  // 步骤条于是显示 `✓ 更新步骤清单完成（步骤清单已更新）`——而清单根本没变。
  // 判据放在 `head`（第一小句）上：这些回执的第一句就点明了"是空的 / 没有…"。
  if (REJECTION_RE.test(head)) return true;
  return /失败|未获得用户回答|没有找到/.test(sliceSafe(head, 160));
}

/**
 * 「可纠正的拒绝」的第一小句特征：参数为空/缺失，工具**没有执行任何操作**。
 *
 * 与"失败"分开列，是因为它们的语义不同（失败=做了一半或做不了，
 * 拒绝=你先给我像样的参数），但对用户都一样：**这一下没有产出**，不能打勾。
 *
 * **必须锚定我们自己的回执开头**（实测误报）：早先写成裸的
 * `/是空的|没有要问的问题|…/`，于是搜索引擎返回的**标题**只要含这几个字
 * （`[1] 为什么杯子是空的`）就会被判成工具失败——步骤条打 ✕、摘要只剩标题一行。
 * 现在逐条对齐各工具拒绝文案的**起始形态**（都紧跟"工具名 + 冒号/空格"这类前缀）：
 * - `web_search`：`搜索关键词是空的。`
 * - `update_plan`：`步骤清单是空的：`
 * - `request_user_input`：`没有要问的问题（questions 是空的）。` / `第 N 个问题没有任何选项。`
 * - `edit_artifact_batch`：`没有可应用的修改：edits 是空的。`
 * - `create_file`：`保存文件失败：content 是空的。`（已由"失败"覆盖，这里不重复）
 */
const REJECTION_RE = /^(?:搜索关键词是空的|步骤清单是空的|没有要问的问题|没有可应用的修改|第\s*\d+\s*个问题没有任何选项|请给出至少一步)/;

/**
 * 工具执行结果 → 给用户看的摘要（显示在气泡的步骤条里）。
 *
 * **不能直接展示 output**：工具返回的文本是**写给模型看的**，里面混着大量行为指令。
 * 实测（鹈鹕案例真机）步骤条上出现过：
 * `✓ 更新步骤清单完成（步骤清单已更新（0/4 已完成），用户能在对话里看到。继续执行下一步，
 *   不要在回复里重复整个清单。）`
 * 后半句是给模型的约束，用户读到只会莫名其妙。
 *
 * 旧实现靠 `output.length > 60 ? "完成" : output` 判定——48 字的指令刚好漏过去，
 * 于是"漏不漏"取决于文案长度这种偶然因素。改成**按工具构造**：每个工具只取它对用户
 * 有意义的那部分，未知工具一律"完成"，宁可少说也不泄漏指令。
 */
export function humanizeToolOutput(toolName: string, output: unknown): string {
  if (typeof output !== "string" || !output) return "完成";
  // 失败文案的第一句对用户有意义（"保存文件失败：不支持的产物类型…"），保留但剥掉后续指令。
  if (/失败/.test(output.slice(0, 12))) return sliceSafe(output.split(/。(?=\S|$)/)[0], 80);
  // **"可纠正的拒绝"要原样说出第一句**（实测缺口，放宽 schema 后新增的一类回执）：
  // 这类回执不含"失败"，落到下面的 switch 会按工具类型编出成功文案——
  // `update_plan` 显示「步骤清单已更新」（实际一条都没更新）、
  // `request_user_input` 显示「已收到你的回答」（实际没问出去）、
  // `web_search` 显示「未找到结果」（实际根本没搜）、`edit_artifact_batch` 显示「完成」。
  // 用户看到的是"做成了"，而工具什么都没做。第一句本身就是给人看的指令，直接用。
  if (REJECTION_RE.test(output.split(/[。\n]/, 1)[0] ?? "")) {
    // 只取**冒号之前**那段：冒号后面跟着的是给模型的改正指令
    // （`步骤清单是空的：请给出至少一步（每步写清要做什么 + 当前 status）`），
    // 用户不需要读到"写清要做什么 + 当前 status"这种内部约定。
    const first = String(output).split(/[。\n]/, 1)[0] ?? "";
    const short = first.split(/[：:]/, 1)[0] ?? first;
    return sliceSafe(short.trim() || first, 80);
  }
  switch (toolName) {
    case "web_search": {
      const count = (output.match(/^\[\d+\]/gm) || []).length;
      return count > 0 ? `找到 ${count} 条结果` : "未找到结果";
    }
    case "generate_video": {
      const count = /已创建\s*(\d+)\s*个视频生成任务/.exec(output)?.[1];
      return count ? `已创建 ${count} 个视频任务` : "已创建视频任务";
    }
    case "create_file": {
      // 右边界必须锚到**尺寸标记**，不能锚到括号：重名文件是 `名字 (2).html`，
      // ASCII `(` 会被当成"名字结束"提前截断 → 用户看到 `已保存 鹈鹕骑自行车_3D`
      // （后缀和扩展名全丢，两张卡片显示成同一个文件）。实测真机踩到。
      const name = /文件已生成并保存：(.+?)（\d+(?:\.\d+)?(?:KB|MB|字节)）/.exec(output)?.[1]?.trim();
      return name ? `已保存 ${sliceSafe(name, 40)}` : "已生成文件";
    }
    case "read_artifact": {
      // 只说"读了多少"：正文是给模型看的，贴进步骤条会把气泡撑爆。
      // **不再重复动词**：渲染端已经拼了 `✓ 读取文件完成（…）`，
      // 摘要再写"读取了文件"就成了"读取文件完成（读取了文件（共 2118 行））"（真机看到的）。
      //
      // 两个分支的措辞不同，必须分别匹配（实测真机）：keyword 版回的是
      // "在 X 里找到 N 处「…」"、不含"共 N 行"，只匹配行数就会掉进兜底显示成「完成」。
      const found = /找到\s*(\d+)\s*处/.exec(output)?.[1];
      if (found) return `定位到 ${found} 处`;
      // 没命中：必须先判，否则会掉到下面的"共 N 行"分支，
      // 摘要写成"共 2118 行"——用户看到的是一个打了叉的数字，读不出"没找到"。
      if (/没有找到/.test(output)) return "没有找到该片段";
      const range = /共\s*(\d+)\s*行/.exec(output)?.[1];
      return range ? `共 ${range} 行` : "完成";
    }
    case "edit_artifact": {
      const line = /第\s*(\d+)\s*行/.exec(output)?.[1];
      return line ? `第 ${line} 行` : "完成";
    }
    case "edit_artifact_batch": {
      const count = /已应用\s*(\d+)\s*处修改/.exec(output)?.[1];
      return count ? `${count} 处` : "完成";
    }
    case "inspect_artifact": {
      if (/^自检失败/.test(output)) return "自检失败（页面没能加载）";
      // 空画面必须排在"无报错"**之前**判：这一分支的正文写的是
      // "控制台没有 error/warning，但…屏幕是空的"，用"没有任何 error/warning"匹配会漏掉，
      // 于是落进兜底的「自检完成」——把"什么都没画出来"说成平平无奇的完成（真机踩到）。
      if (/什么都没画出来/.test(output)) return "自检发现画面是空的";
      // **既没有画布也没有文本**：脚本多半压根没跑起来，不能算通过（本会话实测：
      // 3 个元素 / 0 字文本 / 无画布，报告原文是"页面既没有画布也没有可见文本"，
      // 摘要却落进"自检通过，无报错"）。
      if (/既没有画布也没有可见文本/.test(output)) return "自检发现页面没有内容（脚本可能没跑）";
      // 正则匹配"运行时报错 / 运行时警告 / 运行时问题"三种措辞（实测：只有一条警告时
      // 报告写的是"运行时警告（…共 N 条"）。注意**不能跨括号**匹配：
      // `运行时警告（没有 error，只有 warning；共 1 条…` 里的说明本身带分号，
      // 故这里只取"运行时X（…共 N 条"这一段，用 [^）]* 限制在同一层括号内。
      const errors = /运行时(?:报错|警告|问题)（[^）]*?共\s*(\d+)\s*条/.exec(output)?.[1];
      if (errors) {
        // **截断且前几条全是警告时不能替其余部分下结论**（与报告正文同一处坑）：
        // 报告正文已改写成"其中可能有报错"，摘要若仍写"40 条警告（无报错）"，
        // 用户和模型看到的结论又回到"只是警告"——等于把刚修好的矛盾搬到摘要层。
        if (/可能有报错/.test(output)) return `自检发现 ${errors} 条控制台问题（前几条是警告，其余可能含报错）`;
        // 只有警告时不该说"发现 N 条报错"——模型会去改一条不阻断运行的警告。
        return /运行时警告/.test(output) ? `自检发现 ${errors} 条警告（无报错）` : `自检发现 ${errors} 条报错`;
      }
      // 拿不到截图采样时也不能说"通过"：那种情况我们无从判断画面。
      if (/未能取得画面采样/.test(output)) return "自检完成，但没拿到画面采样（无法判断是否空白）";
      // 采样是纯色、但元素太少（≤1）没能走"什么都没画出来"那一支：
      // 也**不能**说成平淡的"自检完成"——纯色本身就是个信号。
      if (/是同一种颜色/.test(output)) return "自检完成，但画面是纯色（可能没画出来）";
      return /没有任何 error\/warning/.test(output) ? "自检通过，无报错" : "自检完成";
    }
    case "update_plan": {
      const done = /（(\d+)\/(\d+)\s*已完成）/.exec(output);
      return done ? `步骤 ${done[1]}/${done[2]} 已完成` : "步骤清单已更新";
    }
    case "open_page": {
      // 正文长度比正文本身有用：用户只想知道"读到了没有、读了多少"。
      //
      // **不能用 `output.length`**（实测）：正文过短时工具回的是
      // "已打开该网页，但只提取到 35 字正文（可能是登录墙…）。以下是提取到的全部内容：\n\nxxx"，
      // 整段说明 + 正文共 133 字，摘要于是显示"已读取 133 字正文"——
      // 而用户真正关心的是"只拿到 35 字"，那才是它该去换链接的理由。
      const short = /只提取到\s*(\d+)\s*字正文/.exec(output)?.[1];
      if (short) return `只提取到 ${short} 字正文（可能被登录墙/反爬挡住）`;
      if (/没有可提取的正文/.test(output)) return "页面上没有可提取的正文";
      // 截断说明是附加在正文末尾的，长度不能算进去。
      const body = output.replace(/\n\n（页面过长已截断）$/, "");
      return `已读取 ${body.length} 字正文${/已截断/.test(output) ? "（已截断）" : ""}`;
    }
    case "request_user_input":
      return /未获得用户回答/.test(output) ? "用户未回答，按默认继续" : "已收到你的回答";
    default:
      return "完成";
  }
}

/** 工具调用入参的人类可读摘要：状态条展示用，别把原始 JSON 糊到用户脸上。 */
export function humanizeToolInput(toolName: string, input: unknown): string {
  if (input == null) return "";
  // 全部走 `sliceSafe`：这些摘要会显示在气泡的步骤日志里（"→ 正在搜索：…"），
  // 裸 slice 切在 emoji 代理对中间会渲染成 `�`（与渲染端那批截断同一处理）。
  if (typeof input === "string") return sliceSafe(input, 120);
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (toolName === "web_search" && typeof record.query === "string") return sliceSafe(record.query, 120);
    if (toolName === "inspect_artifact" && typeof record.name === "string") return sliceSafe(record.name, 120);
    // read/edit 系列只显示文件名；`edit_artifact_batch` 还要带上改几处——
    // 否则会落到兜底 `JSON.stringify(input)`，把整段 edits 数组糊到步骤条上
    // （实测：`→ 正在批量修改：{"name":"…","edits":[{"oldText":…` 一直拖到被截断）。
    if (toolName === "edit_artifact_batch" && typeof record.name === "string") {
      const count = Array.isArray(record.edits) ? record.edits.length : 0;
      return count > 0 ? `${sliceSafe(record.name, 80)}（${count} 处）` : sliceSafe(record.name, 120);
    }
    if ((toolName === "read_artifact" || toolName === "edit_artifact") && typeof record.name === "string") {
      return sliceSafe(record.name, 120);
    }
    // open_page 只显示域名+路径，别把整个 JSON 糊到步骤条上。
    // 实测真机：`→ 正在打开网页：{"url":"https://post.smzdm.com/p/awwnml6g/"}`，用户看到的是代码。
    if (toolName === "open_page" && typeof record.url === "string") {
      return sliceSafe(record.url.replace(/^https?:\/\//, ""), 120);
    }
    if (toolName === "generate_video") {
      const prompt = typeof record.prompt === "string" ? sliceSafe(record.prompt, 80) : "";
      // 走 `toFiniteNumber`：模型现在允许把时长/数量写成 `"8 秒"` / `"2 路"`
      // （见 schema 处说明），只判 `typeof === "number"` 会让这两个值**从步骤条上消失**——
      // 而"这一轮到底生成几秒、几条"正是用户在步骤条上最想确认的东西。
      const durationValue = toFiniteNumber(record.duration);
      const countValue = toFiniteNumber(record.count);
      const duration = durationValue === undefined ? "" : `${durationValue} 秒`;
      const count = countValue === undefined ? "" : `${countValue} 路`;
      return [prompt, duration, count].filter(Boolean).join(" · ");
    }
    return sliceSafe(JSON.stringify(input), 120);
  }
  return sliceSafe(String(input), 120);
}

/** 一轮智能体对话的收尾统计。usage 供上下文压缩记账；拿不到时调用方回落到字符估算。 */
export interface AgentRunResult {
  textLength: number;
  toolCalls: number;
  /**
   * 本轮是否**撞上了工具步数上限**（`stepCountIs`）而被迫中断。
   *
   * 为什么必须区分（实测 probe-step-limit，mock 让模型无限调工具）：
   * 打满上限（`MAX_AGENT_STEPS`）时循环直接停下，最终气泡是模型**话说到一半**的正文，界面没有任何提示。
   * 用户看到的是一段戛然而止的回答，会以为软件卡住或者模型答完了。
   * 判定依据是最后一步的 `finishReason === "tool-calls"`：模型还想继续调工具，
   * 是步数上限把它掐断的（自然收尾会是 `stop`）。
   */
  hitStepLimit: boolean;
  /**
   * 本轮有多少次工具调用**根本没有被执行**（参数 JSON 解析失败/被硬截断）。
   *
   * 实测（probe-truncated-toolcall）：上游连续返回断成半截的参数时，SDK 只把
   * toolCall 记进历史、**不执行**它——`onToolExecutionStart/End` 都不触发，
   * 于是界面上"工具步骤"一片空白、20 步预算全部耗尽，
   * 用户最后只看到一句"本轮工具调用已结束，没有产生可展示的产物"。
   * 模型那边则以为"内容太长被截断"，反复重写、越写越短。
   * 调用方据此给出可行动提示（而不是让用户对着空白猜）。
   */
  skippedToolCalls: number;
  /**
   * 被跳过的工具名（去重）。调用方据此把"是哪个工具的参数不对"说出来——
   * 只说一个总数时，模型下一轮不知道该改哪一处。
   */
  skippedToolNames?: string[];
  usage?: { inputTokens: number };
}

/**
 * 把 AI SDK 拼出的对话 URL 改写成该上游真正使用的端点。
 *
 * SDK 固定拼 `baseURL + /chat/completions`；MiniMax 官方却是 `/text/chatcompletion_v2`。
 * 普通对话路径早按 resolveChatPath 推导，智能体此前没有 → 同一 baseUrl 下两条路径打到
 * 不同端点（实测 probe-agent-endpoint），用 MiniMax 官方预设开智能体必然 404。
 * 只改末尾端点、保留查询串；非默认路径时才调用（默认路径无需改写）。
 */
export function rewriteChatEndpoint(url: string, baseUrl: string): string {
  const chatPath = resolveChatPath(baseUrl);
  if (chatPath === "/chat/completions") return url;
  return url.replace(/\/chat\/completions(?=\?|$)/, chatPath);
}

export async function chatAgent(
  options: LlmServiceOptions,
  messages: ChatMessage[],
  callbacks: AgentToolCallbacks,
  send: ChunkSender,
  signal: AbortSignal,
  /** 「联网」开关：关闭时不把 web_search 工具下发给模型（否则开关形同虚设）。 */
  enableWebSearch = false,
  /** 工具调用开始回调：渲染端据此在气泡上实时显示"正在搜索/正在生成视频"（透明度）。 */
  onToolStart?: (tool: string, input: string) => void,
  /** 工具执行完成回调：渲染端显示结果摘要（"找到 N 条结果"/"已建 N 个任务"），工具全链路透明。 */
  onToolEnd?: (tool: string, summary: string, ok: boolean) => void,
  /**
   * 计划模式：**不把产生副作用的工具下发给模型**。
   * 只靠提示词要求"别调工具"不够——模型对工具是否存在的信任远高于对文字约定的信任
   * （CLAUDE.md 已记该规律：产物能力当初就是因此必须工具化）。所以这里从工具表层面摘掉，
   * 而不是写一句"本轮不要调用"。
   */
  planMode = false
): Promise<AgentRunResult> {
  const [{ streamText, tool, stepCountIs }, { createOpenAICompatible }, { z }] = await Promise.all([
    import("ai"),
    import("@ai-sdk/openai-compatible"),
    import("zod")
  ] as const);
  // 智能体路径的对话端点：AI SDK 固定拼 `baseURL + /chat/completions`，
  // 但部分上游并不用这个路径（MiniMax 官方是 /text/chatcompletion_v2）。
  // 普通对话早已按 resolveChatPath 推导，智能体此前没有——同一个 baseUrl 下
  // 两条路径打到**不同端点**（实测 probe-agent-endpoint），用 MiniMax 官方预设
  // 开智能体必然 404。SDK 没有自定义 path 的选项，故用 fetch 中间件改写。
  const provider = createOpenAICompatible({
    name: "workbench-llm",
    baseURL: options.baseUrl,
    apiKey: options.apiKey || undefined,
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined,
    ...(resolveChatPath(options.baseUrl) === "/chat/completions"
      ? {}
      : {
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            return fetch(rewriteChatEndpoint(url, options.baseUrl!), init);
          }
        })
  });
  const model = provider.chatModel(options.model);
  const toModelMessages = (list: ChatMessage[]) => list.map((message) => {
    if (message.role === "system") return { role: "system" as const, content: message.content };
    if (message.role === "assistant") return { role: "assistant" as const, content: message.content };
    return {
      role: "user" as const,
      content: message.images?.length
        ? [{ type: "text" as const, text: message.content || "请看这张图片。" }, ...message.images.map((url) => ({ type: "image" as const, image: url }))]
        : message.content
    };
  });
  // AI SDK 的 RetryError 会被包成 "No output generated. Check the stream for errors."（cause 为 null），
  // 直接透传等于没信息——用 onError 捕获底层真实错误（HTTP 500 / 连接重置等），收尾时拼进抛出的异常。
  let underlyingError: Error | undefined;
  const stream = streamText({
    model,
    system: options.systemPrompt || "你是 MiniMax H3 视频工作台内置的智能助手，可以联网搜索资料，也可以直接调用 generate_video 工具为用户生成视频。",
    messages: toModelMessages(messages),
    tools: {
      // 工具描述一律按 Codex `*_spec.rs` 的写法组织：先讲"什么时候用"、再讲"什么时候不用"，
      // 参数约束下沉到 schema（enum / min / max / describe），不在描述里重复一遍。
      // 这样做的理由是实测教训：描述写得含糊时模型会凭训练知识作答，而不是先调工具核实。
      // 「联网」开关关闭时不暴露 web_search，避免模型调用一个用户已关掉的工具。
      ...(enableWebSearch ? {
        web_search: tool({
          description: `联网搜索引擎：返回标题、摘要与链接。

何时使用：涉及实时信息（价格、新闻、版本号、发布时间、时效事实）、用户说"查一下/搜一下/最新/现在多少钱"，或你对某个具体事实没有把握时——先搜索核实，不要凭记忆作答。

何时不用：纯创作、代码、数学、翻译，或用户明确说"不用联网/凭你自己知道的说"。这些情况直接回答更快。

查询词提炼为最核心的 3–6 个词（不是整句话，也不要加"请帮我搜索"之类的礼貌语）。结果不相关就换一组词再搜一次；连续两次不相关就如实告知，不要反复搜同一个词。`,
          // 同样不做 `.min(1)` 硬校验：空 query 时让工具层回一句可纠正的说明，
          // 而不是在 `parseToolCall` 阶段把整个调用丢掉（那一丢就是"收不到回执 → 反复重试"）。
          // **`.nullish()` 也不可少**（实测同类坑第十八处）：`query` **整个键缺失**时，
          // `z.string()` 同样在 `parseToolCall` 阶段被拒——空串与缺键是两条不同的路径，
          // 只修前者照样静默跳过。下面对每个工具都按"缺键"复核过一遍。
          inputSchema: z.object({ query: z.string().nullish().describe("搜索关键词，3–6 个词，如'iPhone 18 Pro 京东 价格'。不要写整句话。") }),
          execute: async ({ query }) => {
            const text = String(query ?? "").trim();
            if (!text) {
              return "搜索关键词是空的。请给出 3–6 个具体的词（如'iPhone 18 Pro 京东 价格'），不要写整句话。";
            }
            try {
              const results = await callbacks.webSearch(text);
              return results || "未搜索到相关内容。可换一组关键词重试，或改用 open_page 打开已知的站点。";
            } catch (error) {
              return `搜索失败：${describeError(error, "未知错误")}。可以基于自身知识回答，但要如实说明这部分未经联网核实。`;
            }
          }
        })
      } : {}),
      // generate_video 与 create_file 在计划模式下整体摘除——它们是"产生副作用"的工具，
      // 而计划模式的本轮产出应该只是一份清单。open_page 保留：它只读，看不到就写不出靠谱的计划。
      ...(planMode ? {} : {
      generate_video: tool({
        description: `生成 AI 短视频，并直接提交为后台任务（4–15 秒、1–4 路）。

何时使用：**用户要的就是视频本身**——说"生成一段视频/做个短片/来几条视频"，或描述了想拍的画面并明确要视频。

**开工前必须先问清三件事**（用 request_user_input，一次调用问完；用户点「跳过，你决定」才自行取默认）：
1. **用哪个后端生成**——本机 ComfyUI / SSH 远程显卡 / 瞬映 RB / MiniMax 云 API。花费与耗时差别很大
   （本机不额外计费但要本地显卡、云 API 真实扣费、RB 扣卡密次数），**不能让用户默认撞上**。
   只有「连接设置」里已配好凭据的后端才是可选项；只有一个可用时也要用一句话说明"这轮只能走它"。
2. **时长**（秒）——按后端合法档位给选项。
3. **数量**（几路）——1–4 路，云端按路计费。
用户已在原话里给过的（例如"来 3 条 8 秒的"）就不用再问，直接照做；只有明确缺少的才问。

何时不用（这条最容易搞错，请务必对照）：
- 用户要的是**网页/页面/小工具/游戏/3D 场景** → 用 create_file(kind=html)，**不是**视频。
- 用户要的是**表格/Excel/文档/报告** → 用 create_file，**不是**视频。
- 用户只是在聊创意、问概念、要文字方案 → 直接回答。
- 用户说"把所有能力都用上/做全一点" → 那是要求把**他要的那个产物**做得更扎实，**不是**让你额外补一段视频。

"画面描述"出现在请求里**不等于**用户要视频——他可能在描述一个要用网页画出来的场景。

调用后任务卡片会实时显示在对话下方，完成后用户可预览与下载。画面感强的英文 prompt 效果更好。这是**消耗资源**的操作（真实扣费、耗时数十秒），用户没要就别调——同一轮里也不要为同一个意图重复调用。`,
        inputSchema: z.object({
          // **`.min(1)` 同样不要**（同一类坑第十一处）：空 prompt 会让整个调用在
          // `parseToolCall` 阶段被拒、静默跳过。下游 `validateRequest` 本就有
          // 「请输入视频描述。」这条中文提示，让它来回答比让 SDK 静默丢弃有用得多。
          // **`.nullish()` 同样必须有**（缺键与空串是两条不同路径）。
          prompt: z.string().nullish().describe("视频内容描述：画面主体、动作、镜头运动、光线、风格。建议英文，越具体越好。不能为空。"),
          // **不要在这里做范围硬校验**（实测踩到，与 `edit_artifact_batch` 的 min(2) 同一个坑）：
          // 参数越界时 AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
          // **整个调用被静默跳过**（toolCall 记进历史但不执行）——模型看不到任何回执，
          // 只会重试同一条，20 步预算全烧光，而界面把原因归成"参数被上游截断"。
          //
          // 下游本来就会夹取（`clampDurationForBackend`：先夹 4–15，RB 再吸附到 4/6/8；
          // count 也是 `Math.max(1, Math.min(4, …))`），所以放宽 schema 不会产生非法请求。
          // 建议范围写在 describe 里，让模型看到；越界值由代码兜住而不是让整轮失败。
          // 连 `.int()` 也不加：模型给 6.5 秒同样会被 `parseToolCall` 拒掉并静默跳过，
          // 而下游 `Math.round` 本来就会处理小数。
          // **不要写成 `z.coerce.number()`**（实测同一类坑第十三处）：`Number("8 秒")` 是 NaN，
          // zod 直接拒掉 NaN → 整个调用被静默跳过。探针实测 `duration: "8 秒"` 让
          // generate_video 连续 20 次没执行、20 步预算烧光。下游 `clampDurationForBackend`
          // 本来就会 Math.round + 夹取，所以这里只要能收下字符串，值交给 `toFiniteNumber` 归一。
          duration: z.union([z.number(), z.string()]).describe("时长秒数，建议 4–15（越界会被自动夹到合法值）。用户没说就按 6。"),
          count: z.union([z.number(), z.string()]).describe("生成数量，建议 1–4（越界会被自动夹到合法值）。用户没说就按 1。"),
          // **用哪个后端生成**。用普通字符串而不是 `z.enum`：模型写「本机」「ComfyUI」「comfy」
          // 这类口语时，枚举会在 `parseToolCall` 阶段拒掉整个调用（本会话已修 19 处同类坑）。
          // 认不出来的值由执行侧回一句"可选后端是哪些"，不会让整轮报废。
          backend: z.string().nullish().describe("生成后端：local（本机 ComfyUI）/ ssh（SSH 远程显卡）/ minimax（MiniMax 云 API）/ rb（瞬映 RB 云生成）。**先问过用户再填**；省略则用「连接设置」里的默认后端。")
        }),
        // 与其他工具一致：失败要变成**给模型的说明**，而不是抛出。
        // `orchestrator.submit` 会做参数校验并抛中文错误（未保存卡密、RB 预设只收 4/6/8 秒、
        // 图生视频缺参考图…）。抛出去的话 AI SDK 会把整轮判为失败，主进程随即
        // "回落普通对话"——而普通对话没有生成工具，用户的视频请求直接丢失，
        // 看到的还是一句"智能体模式请求失败"。返回文本则模型能据实告诉用户该去补什么。
        execute: async (params) => {
          try {
            // 字符串数字（`"8 秒"` / `"2 路"`）在这里归一；读不出就按"没给"，
            // 由下游 `clampDurationForBackend` 用自己的默认值（6 秒 / 1 路）。
            const duration = toFiniteNumber(params.duration);
            const count = toFiniteNumber(params.count);
            // `prompt` 缺省（nullish）时传空串：`validateRequest` 本就有
            // 「请输入视频描述。」这条中文提示，交给它回答比在这里编一句更准。
            // `backend` 同理交给下游解析：认不出来时 `main.ts` 会回一句"可选后端是哪些"，
            // 而不是在这里 reject（本会话已修 19 处"schema 硬校验静默打死整轮"）。
            const backend = typeof params.backend === "string" ? params.backend.trim() : "";
            return await callbacks.generateVideo({
              prompt: String(params.prompt ?? ""),
              duration: duration ?? 6,
              count: count ?? 1,
              ...(backend ? { backend } : {})
            });
          } catch (error) {
            return `创建视频任务失败：${describeError(error, "未知错误")}。请如实告诉用户失败原因和需要先补什么（例如到「连接设置」保存对应后端的密钥/卡密），不要假装任务已创建，也不要重复调用本工具重试。`;
          }
        }
      })
      }),
      // open_page：看具体网页。搜索给了链接但要看正文/详情时用它（比搜索更精准一步）。
      // 计划模式**保留**：它只读，没有副作用；模型看不到实际情况就写不出靠谱的计划。
      open_page: tool({
        description: `打开指定网页，返回渲染后的页面正文。

何时使用：① 用户点名某个网站（"打开百度看看/去京东查这个商品"）；② web_search 返回了链接，但摘要不足以回答，需要看正文细节。

何时不用：你只是想找信息、还不知道哪个页面有——那是 web_search 的活。另外不要打开搜索结果页本身（那是搜索引擎的界面，不是内容），要打开结果里的具体链接。`,
        inputSchema: z.object({
          // **不要用 `z.string().url()`**（实测，与 `edit_artifact_batch` 的 min(2)、
          // video 的 min/max 同一个坑）：模型只给 `example.com/foo`（不带协议）时，
          // AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
          // **整个调用被静默跳过**——模型收不到回执，只会反复重试，20 步预算全烧光，
          // 而界面把原因归成"参数被上游截断"。
          //
          // 改成普通字符串，缺协议时在执行侧补 `https://` 再交给
          // `assertPublicHttpUrlResolved`——那道校验（含 DNS 落点检查）一个字没动，
          // 安全边界不变，只是把"格式瑕疵"从"整轮报废"降级成"自动补全或一条中文错误"。
          // **`.min(1)` 也不要**（同一类坑第十五处）：模型偶尔会把 url 传成空串
          // （"打开刚才那个链接"这类指代），`.min(1)` 让 AI SDK 在 `parseToolCall`
          // 阶段直接拒掉、**整个调用被静默跳过**。空值交给 execute 回一句可纠正的说明。
          // **`.nullish()` 同样必须有**（缺键与空串是两条不同路径）。
          url: z.string().nullish().describe("要打开的网页地址，建议带协议（https:// 开头）；不带协议时会自动按 https 补全。不能为空。")
        }),
        execute: async ({ url }) => {
          try {
            const trimmed = String(url || "").trim();
            if (!trimmed) {
              return "打开网页失败：url 是空的。请填上要打开的具体网址（可带 https://，不带也能自动补全）；如果还不知道该打开哪个页面，先用 web_search 搜一下。";
            }
            // 补协议：`example.com/a` → `https://example.com/a`。
            // 只认"看起来是域名"的形态（含点、无空白、不以 / 开头），避免把
            // `about:blank` 之类的意外输入硬编码成 https。
            const normalized = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("/") || !/^[^\s/]+\.[^\s/]+/.test(trimmed)
              ? trimmed
              : `https://${trimmed}`;
            return await callbacks.openPage(normalized);
          } catch (error) {
            return `打开网页失败：${describeError(error, "渲染失败")}。可改用 web_search 搜索相关信息，或换一个更直接的链接。`;
          }
        }
      }),
      // read_artifact：只读，**计划模式保留**（与 open_page 同理）——写计划前得看得见现状。
      // 「写 → 自检 → 读回 → 精确改 → 再自检」这条闭环里，它是"读回"那一环。
      read_artifact: tool({
        description: `按行读回你在本会话里生成的产物文件（带行号）。改代码之前先读，别凭记忆改。

何时使用：① 准备修改一个已生成的文件（尤其超过几十行）之前，先读相关片段确认现状；
② 自检报错后，用它定位报错对应的那一行；③ 想确认上一次 edit_artifact 是否真的改到了。

何时不用：还没生成过文件；或者你只是想看看文件大小/是否存在——那直接看 create_file 的返回即可。

提示：一次别读整个 40KB 文件。**知道要找什么（函数名、报错里的标识符）时优先用 keyword**——
一步定位到命中行及上下文；只有想通读结构时才用 startLine/endLine 分段读。`,
        inputSchema: z.object({
          // **不要 `.min(1)`**（实测同类坑第十二处）：模型说"刚才那个文件"时会把 name 留空，
          // `.min(1)` 让 AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
          // 调用被**静默跳过**——实测复现：1 次 create_file + **19 次空转**，
          // 20 步预算全烧光、步骤条一片空白，界面还归因成"参数被上游截断"。
          // 空值交给 execute 回一句可纠正的说明（见下）。
          // **`.nullish()` 同样必须有**（缺键与空串是两条不同路径）。
          name: z.string().nullish().describe("产物文件名，带扩展名（如「鹈鹕骑自行车_3D.html」）。不能为空。"),
          // **空串 / null 也要收**（实测同类坑第九处）：模型"不用关键词、只想按行读"时
          // 常显式传 `keyword: ""` 或 `null`，`z.string().min(1).optional()` 会在
          // `parseToolCall` 阶段拒掉 → 整个调用被**静默跳过**（收不到回执 → 反复重试）。
          // 这里用 `.nullish()` + 执行侧归一：空值等价于"没给"。
          keyword: z.string().nullish().describe("要定位的字面文本（区分大小写），如报错里出现的标识符、函数名。给了它就不用再分段读全文。不用时省略或留空。"),
          // **不要 `.int().min(1)`**（实测同类坑第四次）：模型按 0 起算给 `startLine: 0`、
          // 或给个小数时，AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
          // 整个调用被**静默跳过**（收不到回执 → 反复重试 → 步数烧光）。
          // 而 `sliceWithLineNumbers` 本来就会夹紧（0 → 1、小数 → 向下取整、越界 → 文件末尾），
          // 所以这里只需要"能收 null 的数字"；"1 起算"写进 describe 即可。
          // **不要 `z.coerce.number()`**（与 duration 同一处实测缺口）：`"第 3 行"` / `"3-5"`
          // 会让 Number() 得到 NaN，zod 拒掉 NaN → 整个调用静默跳过。
          // 收字符串 + `toFiniteNumber` 归一（`sliceWithLineNumbers` 本来就会夹紧）。
          startLine: z.union([z.number(), z.string()]).nullish().describe("起始行（1 起算，含；越界会被夹紧）。省略则从第 1 行开始。"),
          endLine: z.union([z.number(), z.string()]).nullish().describe("结束行（含；越界会被夹紧）。省略则读到文件末尾。一次建议不超过 400 行。")
        }),
        execute: async (params) => {
          // 空文件名：**回一句可纠正的说明**，不要让整轮失效（见 schema 处说明）。
          // 说清可用的名字——模型手里往往只有"刚才那个文件"这种指代。
          if (!String(params.name ?? "").trim()) {
            return "读取产物失败：name 是空的。请填上本会话已产出的文件名（带扩展名），可以先看世界状态里的「本会话已产出的文件」清单。";
          }
          try {
            // 归一：空串 / null → 不给（"没指定"而不是"指定成空"）。
            const keyword = typeof params.keyword === "string" && params.keyword.trim() ? params.keyword : undefined;
            return await callbacks.readArtifact({
              // `name` 缺省（nullish）时传空串：各工具层已有「name 是空的」的中文说明，
              // 再往前一步就由 `main.ts` 里那句「本会话里找不到产物「」」兜住。
              name: String(params.name ?? ""),
              keyword,
              // 行号同理：`"第 3 行"` / `"3-100"` 也要能读成一个数（见 schema 处说明）。
              startLine: toFiniteNumber(params.startLine),
              endLine: toFiniteNumber(params.endLine)
            });
          } catch (error) {
            return `读取产物失败：${describeError(error, "未知错误")}。可以先确认文件名（带扩展名）是否与 create_file 生成的一致。`;
          }
        }
      }),
      // create_file：文件产物真工具。此前只靠提示词约定"写围栏代码块"，模型会自我怀疑"我没有文件写入工具"
      // 而道歉推脱（实测复现）——模型对工具调用的信任远高于对文字约定的信任，产物交付必须工具化。
      ...(planMode ? {} : {
      create_file: tool({
        description: `生成文件并保存到用户的文件产物区。保存后对话里会出现文件卡片，用户可点「预览」查看、可在文件夹中打开。

何时使用：用户要任何形式的**文件产物**——网页/页面/小工具/游戏/3D 场景、表格/Excel、文档/报告/Word。这是产出文件的标准方式，也是**"帮我做个 X"这类请求的默认答案**。
（注意"页面"属于本工具，**不是** generate_video——哪怕用户描述了一个具体画面，只要他要的是"页面/网页"，就该用它把那个画面画出来。）

何时不用：用户只是想要一段可以直接读的文字回答（那就直接在回复里写），或只是问个问题。不要为了"显得专业"而把普通回答塞进文件。

类型选择：结构化数据用 csv/tsv（首行是表头，保存为 .xlsx，Excel 可直接打开）；可交互的网页、小工具、游戏、3D 场景用 html（要完整，含 <!DOCTYPE html>）；纯文本报告用 md。

用户要文件时**直接生成完整内容**——不要道歉、不要教他自己去做、不要只给示例、不要把内容同时贴在回复里（文件卡片已经承载了内容，重复一遍是浪费）。

**一次只写一个文件，且必须自包含**（实测踩过）：
- 网页/游戏/3D 场景要把 HTML、CSS、JS **全部写在同一个文件里**（内联 <style> 与 <script>）。
  不要拆成 .html + .js + .css 多个文件——预览只加载那一个文件，拆开后页面是坏的。
- 不要因为"内容太长"而分片多次调用本工具试图拼接：多次调用会生成**多个独立文件**，
  它们不会自动合并。一次写完整；确实写不下就先精简功能，保证这一个文件能跑。
- 需要第三方库（如 three.js）时**不要用 CDN**：预览沙箱禁止外发网络，外链加载不到。
  用原生 Canvas/WebGL/CSS 自己实现，或把必要的少量代码内联进来。`,
        inputSchema: z.object({
          // **不要用 z.enum**（实测同类坑第六处）：模型写 `excel` / `word` / `xlsx`
          // 这种常见叫法时，AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
          // 整个调用被**静默跳过** → 收不到回执 → 反复重试 → 20 步预算烧光，
          // 探针实测「20 步、0 产物」。改成字符串 + 执行侧归一。
          // **三个字段都允许缺省**（实测同类坑第十六处）：模型偶尔只给
          // `{ kind, name }`（"先建个空文件、下一步再写"的思路），或干脆省略 `name`。
          // 必填时 AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
          // **整个调用被静默跳过**——探针实测 create_file 连续 20 次没执行，
          // 气泡只剩「本轮工具调用已结束，没有产生可展示的产物」。
          // 缺省值在 execute 里补（content 为空会给一句可纠正的说明，见下）。
          kind: z.string().nullish().describe("文件类型：html（网页/小工具/游戏）、csv 或 tsv（结构化数据，存为 .xlsx）、md（文档/报告）。常见别名（excel/xlsx/word/doc/markdown）也会被识别。"),
          name: z.string().nullish().describe("文件名。带不带扩展名都行（如「科技新闻」或「科技新闻.html」）——扩展名会按 kind 自动补齐/纠正；留空时会自动命名。"),
          content: z.string().nullish().describe("完整文件内容。csv/tsv 首行为表头；html 为完整网页（含 <!DOCTYPE html>）；md 为 markdown 正文。不能为空。")
        }),
        execute: async (params) => {
          // **内容为空要说清楚**（而不是让 schema 拒掉整个调用）：模型偶尔会在
          // "先建个空文件、再去写"的思路下传空串，直接拒会让它收不到回执、反复重试。
          if (!String(params.content ?? "").trim()) {
            return "保存文件失败：content 是空的。请把完整文件内容一次性写在 content 里（csv 首行是表头，html 要含 <!DOCTYPE html>），不要分多次调用。";
          }
          // **kind 归一**（见 schema 处说明）：把模型的口语化叫法映射到四种规范值。
          // 认不出来时**不在这里拒绝**——交给 `saveArtifactFile` 抛中文错误并回给模型
          // （工具层返回文本比抛异常好：抛出去会让 AI SDK 判整轮失败、回落普通对话）。
          // `kind` 缺省时按内容猜：含 `<!DOCTYPE`/`<html` → html，含逗号或制表的多行 → xlsx，
          // 其余按 md——总比落成一个"未知类型"卡片强。
          const rawKind = String(params.kind ?? "").trim().toLowerCase();
          const body = String(params.content ?? "");
          const guessed = /<!doctype|<html[\s>]/i.test(body)
            ? "html"
            : body.split("\n").length >= 2 && /[,\t]/.test(body)
              ? "xlsx"
              : "md";
          // 类型上仍是四种规范值 + 未知原样（未知走 `saveArtifactFile` 的中文报错）。
          const kind = (/^(html?|web|page|网页|页面)$/.test(rawKind) ? "html"
            : /^(csv|tsv|xlsx?|excel|sheet|table|表格)$/.test(rawKind) ? "xlsx"
              : /^(md|markdown|docx?|word|text|文档|报告)$/.test(rawKind) ? "md"
                : rawKind || guessed) as "html" | "csv" | "tsv" | "md" | "xlsx";
          try {
            // `name` 缺省时传空串：`saveArtifactFile` 会落到 `artifact` 这个兜底名。
            return await callbacks.createFile({ kind, name: String(params.name ?? ""), content: body });
          } catch (error) {
            return `保存文件失败：${describeError(error, "未知错误")}。请把内容改写成围栏代码块直接输出，并在回复里说明文件未能保存。`;
          }
        }
      }),
      // inspect_artifact：把刚写好的网页**真的跑一遍**，拿回控制台报错。
      //
      // 没有这个工具时（实测真机 probe-video-intent，鹈鹕骑自行车案例）：模型写出 53KB 的手写
      // WebGL 页面，然后如实告诉用户"我没有在浏览器里运行过这个文件，如果报着色器错误请告诉我"。
      // 它没说谎——应用确实没有任何让它验证产物的手段。Codex 的循环是"写 → 跑 → 看错误 → 修"，
      // 缺了"跑"，第一版永远是没验证过的黑盒，返工全压在用户身上。
      inspect_artifact: tool({
        description: `在应用自带的浏览器里**真实运行**刚生成的网页产物，返回控制台报错、画布尺寸与 WebGL 上下文状态。

何时使用：**每次用 create_file 生成 html 产物之后**（尤其是游戏、3D 场景、Canvas 动画、任何带 <script> 的页面）。写完后先自检一次，有报错就改，改完再生成、再自检，直到没有报错为止。

何时不用：csv/tsv/md 产物（没有可运行的脚本）；或者你在本轮压根没生成过文件。

注意：它给你的是**运行状态**（有没有报错、画布多大、WebGL 通没通），**不是截图**——你仍然看不到画面长什么样、构图好不好看。自检通过 ≠ 视觉效果符合预期，如实说明这个区别，不要宣称"我看过效果"。`,
        inputSchema: z.object({
          // 同 read_artifact：`.min(1)` 会让空名字**静默跳过整个调用**（实测复现 19 次空转）。
          // **`.nullish()` 同样必须有**（缺键与空串是两条不同路径）。
          name: z.string().nullish().describe("要自检的产物文件名，带扩展名（如「鹈鹕骑自行车_3D.html」）。必须是用 create_file 在本会话里生成过的文件。不能为空。")
        }),
        execute: async ({ name }) => {
          const safeName = String(name ?? "");
          if (!safeName.trim()) {
            return "自检失败：name 是空的。请填上要自检的 html 文件名（带扩展名），可以先看世界状态里的「本会话已产出的文件」清单。";
          }
          try {
            return await callbacks.inspectArtifact({ name: safeName });
          } catch (error) {
            return `自检失败：${describeError(error, "未知错误")}。这通常说明文件没能加载起来（路径不对或文件已删除）。可以继续用 create_file 重新生成一份完整体，再试一次自检。`;
          }
        }
      }),
      // edit_artifact：**改之前先读，改的时候只改那一处**。
      //
      // 真机证据（鹈鹕案例）：模型为改一行 `M.identity`→`M.ident`，把 40KB 文件整份重写，
      // 结果新文件里**仍然留着那一处**（原文件 2 处、"修好版"还有 1 处），
      // 而它随后断言"我重写后的文件里并没有这个写法"，把锅推给了自检工具。
      // 三个能力缺口叠在一起：
      // ① 读不回自己的文件 → 无法核对改没改到；
      // ② 只能整份重写 → 输出 40KB 换 3 个字符，重排中还容易引入新 bug；
      // ③ 没有"改动是否唯一"的保护 → 改错地方也不会有人提醒。
      // 这一对工具对齐 Codex 的 `apply_patch`：先给行号让人看得见，再要求**精确且唯一**地替换。
      // （read_artifact 是只读的，放在 open_page 旁、计划模式保留。）
      edit_artifact: tool({
        description: `精确替换产物文件里的**一处**内容，写回同一个文件（不会另存新版本）。

何时使用：修 bug、改数值、调措辞——**只要不是整份重写**，就用它而不是再调一次 create_file。
典型场景：自检报出某一行有错，你读回那一段，然后用 edit_artifact 把这一个标识符/一行改掉。

用法要求（不满足会被拒绝，且会告诉你原因）：
- \`oldText\` 必须与文件里的内容**逐字符一致**（含缩进）。建议连同上下各一行一起贴进去，保证唯一。
- 它在文件里必须**只出现一次**。出现多次会被拒绝并返回所有命中的行号——那时请把 oldText 扩到能唯一定位为止。
- 找不到会被拒绝：先用 read_artifact 读到原文，不要凭记忆猜。

何时不用：要改的地方超过全文一半、或要整体重构时，重新 create_file 一次写完整更省事。

改完如果改的是 **html 产物**，建议立刻 inspect_artifact 自检一次，确认没有引入新报错；
md/xlsx 不能自检（inspect_artifact 只跑网页），改完用 read_artifact 复核即可。`,
        inputSchema: z.object({
          // 同 read_artifact：`.min(1)` 会让空名字**静默跳过整个调用**（实测复现 19 次空转）。
          // **`.nullish()` 同样必须有**（缺键与空串是两条不同路径）。
          name: z.string().nullish().describe("要修改的产物文件名，带扩展名。必须是本会话里已存在的文件。不能为空。"),
          // **不要 `.min(1)`**（实测同类坑第七处）：模型给空 oldText 时，
          // AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，调用被**静默跳过**——
          // 而 `main.ts` 里那段"oldText 不能为空。"的提示**永远执行不到**，
          // 模型只会反复重试空串。改成普通字符串，空值交给工具层回一句可纠正的说明。
          oldText: z.string().nullish().describe("被替换的原文，必须与文件中逐字符一致且全文件唯一。建议带上上下各一行以保证唯一。不能为空。"),
          newText: z.string().nullish().describe("替换成的新内容。允许为空字符串（表示删除这段）。")
        }),
        execute: async (params) => {
          const safeName = String(params.name ?? "");
          if (!safeName.trim()) {
            return "修改文件失败：name 是空的。请填上要修改的文件名（带扩展名），可以先看世界状态里的「本会话已产出的文件」清单。";
          }
          try {
            // `oldText` / `newText` 缺省时补空串：`applyExactEdit` 对空 oldText
            // 本就有「oldText 不能为空。」的中文说明（那是可纠正的），比 schema 静默拒掉好。
            return await callbacks.editArtifact({
              name: safeName,
              oldText: String(params.oldText ?? ""),
              newText: String(params.newText ?? "")
            });
          } catch (error) {
            return `修改文件失败：${describeError(error, "未知错误")}。可以用 read_artifact 读回原文后再试，或改用 create_file 整份重写。`;
          }
        }
      }),
      // edit_artifact_batch（对齐 Codex `apply_patch` 一次提交多个 hunk）：
      //
      // 实测动因：模型一次要修 5 处 bug，单处 edit 消耗 5 步，叠加步数上限后任务被打断
      // （真机那一轮最后一句就是"本轮工具调用已达上限"）。合成一次调用后，
      // 同样的工作只占 1 步，剩下的预算能留给自检与验证。
      edit_artifact_batch: tool({
        description: `一次修改产物文件里的**多处**内容，全部成功才写盘（原子操作）。

何时使用：你有 2 处以上独立的修改要落到同一个文件里时，**优先用它**而不是连续调多次 edit_artifact。
典型场景：自检报了多个问题、或你复查代码时发现好几处 bug，一次全部改掉。

用法要求（与 edit_artifact 相同，且更严）：
- 每条 oldText 必须逐字符一致、且在**应用前序修改之后**的文本里唯一。
- **任意一条失败则整批不写入**，并告诉你是第几条失败、为什么失败——文件不会停在"改了一半"的状态。
- 顺序应用：后一条基于前一条改过的文本匹配，所以相邻改动可以拆成多条，不用手工合并。

何时不用：只有一处要改（用 edit_artifact 更直接）；或要改的地方超过全文一半（重新 create_file）。`,
        inputSchema: z.object({
          // 同 read_artifact：`.min(1)` 会让空名字**静默跳过整个调用**（实测复现 19 次空转）。
          name: z.string().nullish().describe("要修改的产物文件名，带扩展名。不能为空。"),
          // **`.nullish()` 同样必须有**（实测同类坑第十八处）：`edits` **整个键缺失**时
          // `z.array()` 会拒掉整个调用，和空数组是两条不同路径。两者都交到 execute 里说。
          edits: z.array(z.object({
            // **同单处编辑**：`.min(1)` 会让空串在 `parseToolCall` 阶段被拒、
            // 整个调用被静默跳过；而工具层对空 oldText 本就有「第 N 条修改的 oldText 为空」的说明。
            oldText: z.string().nullish().describe("被替换的原文，逐字符一致且在（前序修改后的）文件中唯一。不能为空。"),
            newText: z.string().nullish().describe("替换成的新内容。允许为空字符串（删除）。")
          // **下限必须是 1**（实测踩到）：原来写 `min(2)`，模型只给 1 条时
          // AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
          // **整个调用被静默跳过**（toolCall 记进历史但不执行）——
          // 模型看不到任何回执，会一直重试同一条，20 步预算全烧光，
          // 而界面把原因归成"参数被上游截断"（完全误导）。
          //
          // 而且这条约束本来就没有依据：`applyExactEdits` 对 1 条编辑照常工作，
          // "2 条以上才值得批量"是给模型的**建议**，不该做成硬校验。
          // **上限也不要写成 `.max(20)`**（实测同类坑第十处）：模型一次给 25 条时同样会在
          // `parseToolCall` 阶段被拒、整个调用被静默跳过。改在 execute 里截断（保留前 20 条）
          // 并把"只应用了前 N 条"如实告知——少改几处总比整轮报废好。
          })).describe("修改列表，建议 1–20 条（超过 20 条只应用前 20 条）。按数组顺序依次应用。").min(0).nullish()
        }),
        execute: async (params) => {
          const safeName = String(params.name ?? "");
          if (!safeName.trim()) {
            return "批量修改失败：name 是空的。请填上要修改的文件名（带扩展名），可以先看世界状态里的「本会话已产出的文件」清单。";
          }
          // 缺键与空数组是同一件事的两种写法（`edits` 已放宽为 nullish）：
          // 都回一句可纠正的说明，而不是让 SDK 静默拒掉整个调用。
          const rawEdits = Array.isArray(params.edits) ? params.edits : [];
          if (rawEdits.length === 0) {
            return "没有可应用的修改：edits 是空的。请把要改的内容写成至少一条 {oldText, newText}。";
          }
          // `oldText` / `newText` 缺省（nullish）时补空串：`applyExactEdits` 对空 oldText
          // 本就有「第 N 条修改的 oldText 为空」的中文说明——那是可纠正的，
          // 比 schema 层静默拒掉整个调用好（本会话已修 17 处同一类坑）。
          const edits = rawEdits.slice(0, 20).map((edit) => ({
            oldText: String(edit.oldText ?? ""),
            newText: String(edit.newText ?? "")
          }));
          try {
            const result = await callbacks.editArtifactBatch({ name: safeName, edits });
            // 截断要明说：否则模型以为 25 条都改了，后面自检会对着"没改的部分"困惑。
            if (rawEdits.length > edits.length) {
              return `${result}\n（你给了 ${rawEdits.length} 条修改，本次只应用了前 ${edits.length} 条。剩下的请再调用一次。）`;
            }
            return result;
          } catch (error) {
            return `批量修改失败：${describeError(error, "未知错误")}（文件未被改动）。可以先用 read_artifact 读回原文核对后再试。`;
          }
        }
      })
      }),
      // update_plan（对齐 Codex `plan_spec.rs` 的 update_plan）：把任务拆解**写出来**。
      // 不是计划模式——计划模式是"这一轮不动手"，本工具是"动手期间让用户看得见进展"。
      // 工具化的理由同 create_file：靠提示词要求"先说步骤"模型会跳过，给它一个工具才会用。
      //
      // **计划模式下一并摘掉**（对齐 Codex 的 `update_plan_enabled == false` →
      // `without_update_plan_instructions`：整段移除，而不是留一句"本轮别用"）。
      // 它本身无害，但语义与"本轮只出方案"冲突——留着会让模型去更新清单而不是写方案。
      ...(planMode ? {} : {
      update_plan: tool({
        description: `更新当前任务的步骤清单，让用户看到你打算怎么做、现在走到哪一步。

何时使用：任务需要 3 步以上、或要连续调用多个工具时，**在开始动手前先列一遍**，之后每完成一步就更新一次状态。

何时不用：一步就能做完的任务（直接做，别为了列清单而列清单）；也不要用它代替正常回答——清单是给用户看进度的，不是回答本身。

规则：整个清单里最多一项是 in_progress。步骤写完就不要改措辞（用户会对照着看），只改 status。`,
        inputSchema: z.object({
          // **`.optional()` 只允许 undefined，不允许 null**（实测同类坑第十九处）：
          // 模型把可选字段写成 `explanation: null` 时，zod 会拒掉**整个对象**，
          // `parseToolCall` 抛错 → 调用被静默跳过（与必填字段缺失同一后果）。
          // 用 `.nullish()` 收下，再在 execute 里把 null 归一成 undefined。
          explanation: z.string().nullish().describe("一句话说明这次更新的原因（如'已完成搜索，开始整理数据'）。仅当状态变化需要解释时才写。"),
          plan: z.array(z.object({
            // **`step` / `status` 也必须是可选**（实测同类坑第十七处）：
            // 模型很自然只写 `{ plan: [{ step: "搜索资料" }] }`——省略 status。
            // 必填时 AI SDK 在 `parseToolCall` 阶段抛错，调用被**静默跳过**。
            // 探针实测 `update_plan` 连续 20 次没执行、步骤清单卡片一次都没渲染出来；
            // 而这个工具几乎每步都会被调用，等于把整轮的进度可视化全部废掉。
            step: z.string().nullish().describe("步骤描述，写清要做什么，如'搜索 2025 年国产显卡价格'。"),
            // **不要用 z.enum**（同一类坑第八处）：模型常写 `done` / `in-progress` / `doing`，
            // 枚举一拒，AI SDK 在 `parseToolCall` 阶段抛错、**整个调用被静默跳过**——
            // 而 update_plan 几乎每步都调，等于把整轮的进度可视化全部废掉，
            // 还白白烧步数。改在 execute 里归一（见下）。
            status: z.string().nullish().describe("步骤状态：pending（未开始）/ in_progress（进行中，全清单最多一项）/ completed（已完成）。")
          // **`.min(1)` 也不要**：模型偶尔会给空数组（"这轮没步骤"），
          // schema 一拒就是整个调用被静默跳过。空清单在 execute 里回一句说明即可。
          // **`.nullish()` 同样必须有**（实测同类坑第十八处）：整个 `plan` 键缺失
          // 与"给了空数组"是两条不同路径，只修后者仍会静默跳过。
          })).describe("完整步骤清单（每次调用都要给全量，而不是只给变化的那几步）。").nullish()
        }),
        execute: async (params) => {
          // `plan` 已放宽为 nullish（见 schema 处说明）：缺键与空数组是同一件事，
          // 都回一句可纠正的说明，而不是让 SDK 静默拒掉整个调用。
          const rawPlan = Array.isArray(params.plan) ? params.plan : [];
          if (rawPlan.length === 0) {
            return "步骤清单是空的：请给出至少一步（每步写清要做什么 + 当前 status）。如果这轮不需要清单，就不用调用本工具。";
          }
          // status 归一：把模型的口语化写法映射到三个规范值。
          // 认不出来的一律按 pending（宁可显示"未开始"，也不能让整次清单更新被拒）。
          const normalizeStatus = (raw: unknown): "pending" | "in_progress" | "completed" => {
            const text = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
            if (["completed", "complete", "done", "finished", "已完", "已完成"].includes(text)) return "completed";
            if (["in_progress", "inprogress", "doing", "running", "active", "进行中", "进行"].includes(text)) return "in_progress";
            return "pending";
          };
          // **最多一项 in_progress**：模型常说"全都进行中"，渲染端的语义是"最多一个"。
          // 多出来的降级为 pending（不丢步骤，只修状态）。
          // `step` 缺省时补一个占位：schema 已放宽为可选（见上），但下游 `PlanStep`
          // 要求它必须是字符串——空串会让清单里出现一行没有任何文字的条目，
          // 所以给「步骤 N」而不是 ""。
          let sawInProgress = false;
          const plan = rawPlan.map((entry, index) => {
            const step = String(entry.step ?? "").trim() || `步骤 ${index + 1}`;
            const status = normalizeStatus(entry.status);
            if (status !== "in_progress") return { step, status };
            if (sawInProgress) return { step, status: "pending" as const };
            sawInProgress = true;
            return { step, status };
          });
          try {
            // `explanation` 要原样带上去：渲染端会显示"为什么更新这一步"。
            // schema 放宽成 nullish 后，`null` 在这里归一成 `undefined`
            // （下游类型是 `explanation?: string`，塞 null 会让界面渲染出 "null"）。
            return await callbacks.updatePlan({ plan, explanation: params.explanation ?? undefined });
          } catch (error) {
            return `步骤清单更新失败：${describeError(error, "未知错误")}（不影响任务继续，请直接用文字说明进度）`;
          }
        }
      })
      }),
      // request_user_input（对齐 Codex `request_user_input_spec.rs`）：把选择题做成工具，
      // 而不是让模型在回复里手写 A/B/C 等用户打字——手写选项用户得自己复述，容易理解错。
      // 主进程会挂起等渲染端回答，超时则按"无回答、按最佳判断继续"收尾。
      request_user_input: tool({
        description: `向用户提一个选择题，拿到答复后再继续。这是唯一会真正等到用户回答的交互方式。

何时使用：卡在**一两个关键取舍**上、且不同选择会导致明显不同的产出一一例如视频时长、文件格式、风格方向、要不要包含某类内容。这时问清楚比猜一个再做要省事。

何时不用：能从上下文或历史习惯合理推断的（那就直接做，按 CLAUDE.md 的工作方式第 1 条：能动手就不问）；也不要一次问一串问题——最多 3 个，且每个都要有"我推荐哪个"的隐含信息。

一次调用最多 3 个问题，每个问题 2–4 个选项。用户可以选择不回答（超时或跳过），此时你必须按自己认为最合理的方式继续，不要卡住不动。`,
        inputSchema: z.object({
          questions: z.array(z.object({
            // **这几个字段一律可选**（实测同类坑第十四处）：模型很自然只写
            // `{ id, question, options }`，省掉 `header`，或选项只给 `{ id, label }`
            // 不给 `description`。必填时 AI SDK 在 `parseToolCall` 阶段抛
            // `InvalidToolInputError`，整个调用被**静默跳过**——探针实测
            // request_user_input 连续 20 次没执行，界面上连选择题卡片都不出现，
            // 用户只看到「本轮工具调用已结束，没有产生可展示的产物」。
            // 缺的值在 execute 里补默认（`formatAnswers` 本来也对缺字段做了兜底）。
            id: z.string().nullish().describe("问题标识（英文短名，如'video_duration'），用于回传答案时对应。"),
            header: z.string().nullish().describe("很短的中文标签，最多 12 个字（如'视频时长'）。"),
            question: z.string().nullish().describe("完整问题，一句话说清要用户在什么之间做选择。"),
            // **`.optional()` 只允许 undefined，不允许 null**（同类坑第十九处）：
            // 模型写 `multiSelect: null` 时 zod 会拒掉整个对象 → 调用被静默跳过。
            multiSelect: z.boolean().nullish().describe("是否允许多选。只有确实可以同时选多个时才设为 true。"),
            // **不要在这里写 min(2).max(4)**（实测同类坑第五处）：模型只给 1 个选项时，
            // AI SDK 在 `parseToolCall` 阶段抛 `InvalidToolInputError`，
            // 整个调用被**静默跳过** → 模型收不到回执 → 反复重试 → 20 步预算烧光。
            // 数量约束改在 execute 里夹取（见下），越界只会少一两个选项，不会让整轮失效。
            // **空数组也收**（同类坑的收尾）：`questions: []` / `options: []` 在 schema 层
            // 被拒会让整个调用静默跳过；这些交到 execute 里给一句可纠正的说明更合适。
            options: z.array(z.object({
              id: z.string().nullish().describe("选项标识（英文短名）。"),
              label: z.string().nullish().describe("选项显示文字，简短（如'8 秒'）。"),
              description: z.string().nullish().describe("这个选项意味着什么，一句话。")
            })).describe("互斥选项，建议 2–4 个。").nullish()
          })).describe("问题清单，建议 1–3 个。").nullish()
        }),
        execute: async (params) => {
          // `questions` / `options` 已放宽为 nullish（见 schema 处说明）：
          // **缺键与空数组是同一件事的两种写法**，都回一句可纠正的说明，
          // 而不是让 SDK 静默拒掉整个调用。
          const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
          if (rawQuestions.length === 0) {
            return "没有要问的问题（questions 是空的）。如果确实需要用户拍板，请给出 1–3 个问题、每题 2–4 个选项；否则直接按最合理的方式继续。";
          }
          const emptyOptions = rawQuestions.findIndex((question) => !Array.isArray(question.options) || question.options.length === 0);
          if (emptyOptions >= 0) {
            return `第 ${emptyOptions + 1} 个问题没有任何选项。请为它提供 2–4 个互斥选项（每个带 label 与 description），再调用一次；不需要问的话就直接继续。`;
          }
          // **夹取而不是拒绝**（见 schema 处的说明）：渲染端能正常画 1 个选项的卡片，
          // 超过 3 个问题/4 个选项则截断——少问一个总比整轮报废好。
          //
          // 缺字段在这里补默认（schema 已放宽为可选，见上面的说明）：
          // - `id` 缺失时按下标生成，否则回传答案时对不上题（`formatAnswers` 按 id 匹配）；
          // - `header` / `label` 缺失时退回「问题 N」/ 选项 id——渲染端会画出一个空标签的芯片；
          // - `question` 缺失时用 header 顶上，总比一张只有标签的空卡片强。
          //
          // **id 必须去重**（实测缺陷）：模型偶尔把两个问题都写成同一个 id（复制粘贴、
          // 或干脆都写 `q`）。而答案回传是按 id 查表的（`formatAnswers` 里
          // `answers[question.id]`），同 id 会让**后一题顶用前一题的答案**——
          // 用户只答了"时长 6 秒"，回执里"画幅"也变成"用户选择：横屏"
          // （其实是第一题被选中的那个选项在第二题里的同名 id）。
          // 渲染端与 formatAnswers 用的都是这份 `clipped`，在源头改一次即可。
          const usedIds = new Set<string>();
          const clipped = {
            questions: rawQuestions.slice(0, 3).map((question, index) => ({
              id: uniqueQuestionId(question.id?.trim() || `q${index + 1}`, usedIds, index),
              header: question.header?.trim() || `问题 ${index + 1}`,
              question: question.question?.trim() || question.header?.trim() || `请选择第 ${index + 1} 项的取值`,
              // `boolean | null` → `boolean | undefined`：下游 `AgentQuestion.multiSelect?: boolean`
              // 与 `PgQuestionCard` 都按三态之外的二态判断，塞 null 会走"非 true"分支（能跑），
              // 但类型上不干净，且在 IPC 里会序列化成 `null`。统一归成 undefined。
              multiSelect: question.multiSelect ?? undefined,
              options: (question.options ?? []).slice(0, 4).map((option, optionIndex) => ({
                id: option.id?.trim() || `opt${optionIndex + 1}`,
                label: option.label?.trim() || option.id?.trim() || `选项 ${optionIndex + 1}`,
                description: option.description?.trim() || ""
              }))
            }))
          };
          try {
            return await callbacks.requestUserInput(clipped);
          } catch (error) {
            // 用户没回答不算失败：必须让模型继续，而不是让它在这里死等或反复重试。
            return `未获得用户回答（${describeError(error, "用户选择了跳过或未在时限内回答")}）。请按你认为最合理的方式继续执行，并在回复里说明你做了哪些默认假设。`;
          }
        }
      })
    },
    // 工具步数预算。
    //
    // **从 10 提到 20**（实测依据）：一整轮"写 → 自检 → 读回 → 批量改 → 再自检"的
    // 闭环本身就要 5–6 步，而模型通常会修 2–3 轮。2026-10-19 连续 7 次真机跑鹈鹕案例，
    // **4 次撞在 10 步上限**（界面显示"已执行 10 步"、回复戛然而止）。
    // 这是自引入的矛盾：加 `inspect_artifact` 时要求"生成 html 后必须自检、有报错就改到没有"，
    // 每个修复循环固定多吃 2–3 步，却没跟着调预算。
    //
    // 为什么不设成无限：无上限时模型会在同一个任务里无限打磨（真机见过它反复重写同一段），
    // 持续烧 token 而用户拿不到更多东西。20 步 ≈ 3–4 个完整修复循环，够用且有界。
    // 撞上限时仍会明确告知用户（见 main.ts 的 hitStepLimit 提示）。
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    // **每步告知剩余预算**（实测依据，2026-10-19 真机跑表格案例）：
    // 模型为了凑一份显卡对比表，连续搜了 20 多次、打开 6 个网页，**最终一个文件都没产出**，
    // 22 步全部耗在"再搜一次可能更准"上。它并不知道自己只剩几步——
    // 每搜一次都看到"找到 6 条结果"，就以为还来得及。
    //
    // 载体必须是 **user 消息**（对齐 worldState 的结论：拼进 system 的指令会被无视）。
    //
    // **必须用参数里的 `messages`，不能用闭包外层的 `messages`**（实测踩到，且是严重 bug）：
    // 外层那个是 `chatAgent` 的入参 = **初始历史**。而 `prepareStep` 返回的 messages
    // 会 carry forward 到后续步骤，于是第 16 步的消息数从 31 条**骤降到 4 条**——
    // 前面 15 步搜到的资料、读过的网页全被抹掉，模型在"该收敛"的那一刻正好失忆。
    // 探针 `_scratch/probe-preparestep-history.mjs` 抓到了这个形状。
    //
    // 只在**恰好跨过阈值**的那一步注入一次（返回的覆盖会 carry forward），
    // 每步都注入会让提示层层累积。
    // 只在**恰好跨过阈值**的那一步注入一次（返回的覆盖会 carry forward），
    // 每步都注入会让提示层层累积。
    //
    // 措辞必须**始终成立**：这条消息会一路带到本轮结束。写死"只剩 5 步"的话，
    // 到最后一步它仍在说"剩约 5 步"——过时的数字比没有更误导。故用"已不足 N 步"。
    prepareStep: ({ stepNumber, messages: stepMessages }) => {
      const threshold = Math.max(1, Math.floor(MAX_AGENT_STEPS / 4));
      if (MAX_AGENT_STEPS - stepNumber !== threshold) return {};
      return {
        messages: [
          ...stepMessages,
          {
            role: "user" as const,
            content: `# 剩余预算\n本轮的 ${MAX_AGENT_STEPS} 步工具预算**已不足 ${threshold + 1} 步**。请**立刻收敛**：优先把已有的东西交付出来（该出文件就出文件），不要再展开新的搜索或调研。如果确实没做完，就在回复里说明还差什么。`
          }
        ]
      };
    },
    // 输出上限：**必须显式设置**，否则用上游默认值（实测该中转默认约 4096 tokens）。
    // 后果很隐蔽：模型写大文件（单文件 3D 页面/游戏常 >20k 字符）时输出被硬截断，
    // 工具入参 JSON 断在半截 → 解析失败 → 模型误以为是"内容太长"，反复重写、越写越短、
    // 最终放弃（实测复现：模型自述"每次都在约 18k 字符处被截断"）。
    // 64000 tokens ≈ 25 万字符，足够容纳完整单文件产物；上游不支持时会明确报错而非静默截断。
    maxOutputTokens: 64_000,
    // 中转/上游偶发连接重置（实测该中转会间歇性 ECONNRESET）会把智能体整轮打挂，
    // 触发主进程"回落普通对话"并丢失视频生成意图。实测瞬时失败后第一次重试即可恢复，故只放 1 次
    // （SDK 的退避是指数的，放 2 次会把 500 这类真错误拖到 6 秒以上才回落，用户感知是"卡住"）。
    maxRetries: 1,
    // 超时兜底：分块间隔超 2 分钟视为服务商卡死（抛错触发回落），整轮上限 10 分钟——
    // 否则"没收到回复"会表现为永远转圈。
    timeout: { chunkMs: 120_000, totalMs: 600_000 },
    abortSignal: signal,
    onError: ({ error }) => { underlyingError = error as Error; },
    // 工具执行开始即回调（SDK 在 execute 运行前触发）：把"正在搜索/正在生成视频"实时透给渲染端，
    // 否则多步工具调用期间（实测一轮可达 15–25 秒）气泡全黑，用户只能干等。
    onToolExecutionStart: (event) => {
      if (!onToolStart || !event) return;
      const toolName = String(event.toolCall.toolName ?? "");
      onToolStart(toolName, humanizeToolInput(toolName, event.toolCall.input));
    },
    // 工具执行完成：渲染端显示结果摘要，工具全链路可见（开始 → 完成）。
    onToolExecutionEnd: (event) => {
      if (!onToolEnd || !event) return;
      const toolName = String(event.toolCall.toolName ?? "");
      // **`execute` 抛异常时 SDK 给的是 `tool-error`**（不是 `tool-result`），
      // 它的 `.output` 上什么都没有——只读 `.output` 会拿到 undefined，
      // 摘要于是变成「✓ 名称完成（完成）」：打勾 + 一句废话，而工具其实炸了。
      // 我们的工具大多自己 catch 并返回文本，但 `execute` 之外的失败
      // （schema 里 `z.string().url()` 拒绝、回调里未捕获的异常）走的就是这条路。
      const toolOutput = (event as { toolOutput?: { type?: string; output?: unknown; error?: unknown } }).toolOutput;
      const failed = toolOutput?.type === "tool-error";
      const output = failed ? toolOutput?.error : toolOutput?.output;
      // 成败必须显式传：我们的工具失败也返回文本（见 isToolFailure），
      // 渲染端没法从摘要里可靠区分"完成"与"失败"。
      const summary = failed
        ? `工具执行失败：${describeError(output, "未知错误")}`
        : humanizeToolOutput(toolName, output);
      onToolEnd(toolName, summary, !failed && !isToolFailure(output));
    }
  });
  let seq = 0;
  let textLength = 0;
  let toolCalls = 0;
  for await (const part of stream.textStream) {
    if (part) {
      textLength += part.length;
      send({ seq: (seq += 1), delta: part });
    }
  }
  let lastFinishReason: string | undefined;
  /** 被 SDK **跳过**的工具调用数：调用了，但参数解析失败 → 根本没执行。 */
  let skippedToolCalls = 0;
  /**
   * 被跳过的工具**名字**（去重）。只说"有 N 次没执行"时，用户和模型都无从下手；
   * 说出是哪个工具，模型下一轮就能只改那一个参数（实测：本会话遇到的跳过
   * 全是"某个工具的参数不满足 schema"，而非输出截断）。
   */
  const skippedToolNames: string[] = [];
  try {
    // ai v7 的 steps 是 PromiseLike<Array<StepResult>>——await 后按步累计工具调用数。
    const steps = await stream.steps;
    for (const step of steps) {
      toolCalls += step.toolCalls.length;
      lastFinishReason = step.finishReason;
      // **参数 JSON 断在半截 / 不满足 schema 时，SDK 只记录 toolCall、不执行它**
      // （没有 toolResult），于是 onToolExecutionStart/End 都不触发。实测：
      // 上游连续 20 步都返回坏参数 → 界面**工具步骤一片空白**、步数全部耗尽，
      // 用户只看到"没有产生可展示的产物"。
      //
      // **`toolResults` 可能整个缺失**（部分 provider 组合不产出它）——那时按"都执行了"算，
      // 只在**有明确证据**（toolResults 存在但少于 toolCalls）时才报"被跳过"，
      // 不能因为字段不存在就误报一批"没有真正执行"（单测已抓到过这个错）。
      const results = (step as { toolResults?: unknown[] }).toolResults;
      if (Array.isArray(results)) {
        const missing = step.toolCalls.length - results.length;
        if (missing > 0) {
          skippedToolCalls += missing;
          // 按 toolCallId 差集找出**具体是哪几个**，把名字记下来给文案用。
          const done = new Set(results.map((entry) => String((entry as { toolCallId?: unknown })?.toolCallId ?? "")));
          for (const call of step.toolCalls) {
            const name = String((call as { toolName?: unknown }).toolName ?? "");
            if (!name || done.has(String((call as { toolCallId?: unknown }).toolCallId ?? ""))) continue;
            if (!skippedToolNames.includes(name)) skippedToolNames.push(name);
          }
        }
      }
    }
  } catch {
    // steps 不可用时按 0 计（部分 provider 组合不产 steps）。
  }
  // 工具调用全程在 streamText 内部完成；这里只等最终收尾。
  try {
    await stream.finishReason;
  } catch (error) {
    // 有底层错误就抛它（调用方才能按"网络失败"还是"模型不支持工具"分流并给出可行动的中文提示）；
    // 没有则原样抛 AI SDK 的占位错误。
    throw underlyingError ?? error;
  }
  // usage 用于上下文压缩的基线记账（inputTokens 是"本窗口的输入起点"）。
  // 上游不返回 usage 时字段为 undefined——调用方回落字符估算，不能当成 0。
  let usage: { inputTokens: number } | undefined;
  try {
    const measured = await stream.usage;
    if (typeof measured?.inputTokens === "number") usage = { inputTokens: measured.inputTokens };
  } catch {
    // usage 不可用不影响本轮结果。
  }
  return { textLength, toolCalls, hitStepLimit: lastFinishReason === "tool-calls", skippedToolCalls, skippedToolNames, usage };
}

/**
 * 工具支持探测：发一条带工具定义的最小对话，看模型是否回工具调用（或至少正常回话）。
 * 返回 supported=false 时 UI 应提示该模型/中转不支持智能体模式。
 * 注意区分两种"不支持"：模型正常回话但没调工具（真不支持）与请求本身失败（网络/服务异常）——
 * 后者不能混为一谈，否则会给出误导性的"该模型不支持工具"结论。
 */
export async function probeToolSupport(options: LlmServiceOptions): Promise<{ supported: boolean; message: string }> {
  const probeMessages: ChatMessage[] = [{ role: "user", content: "回复：好" }];
  let sent = 0;
  try {
    const result = await chatAgent(options, probeMessages, {
      webSearch: async () => "（探测）",
      generateVideo: async () => "（探测）",
      openPage: async () => "（探测）",
      createFile: async () => "（探测）",
      // 探测不需要真的跑浏览器 / 读写产物：给个无害的返回值即可。
      inspectArtifact: async () => "（探测）",
      readArtifact: async () => "（探测）",
      editArtifact: async () => "（探测）",
      editArtifactBatch: async () => "（探测）",
      // 探测不需要真的弹选择题/改清单：给个无害的返回值即可。
      updatePlan: async () => "（探测）",
      requestUserInput: async () => "（探测）"
    }, () => { sent += 1; }, AbortSignal.timeout(60_000));
    const supported = result.toolCalls > 0 || result.textLength > 0;
    if (!supported) return { supported: false, message: "模型未返回任何内容，可能不支持工具调用（智能体模式不可用），将自动改用普通对话。" };
    return {
      supported,
      message: result.toolCalls > 0 ? "模型支持工具调用，智能体模式完全可用。" : "模型可正常对话（未主动触发工具，但智能体模式可用）。"
    };
  } catch (error) {
    // 请求失败 ≠ 模型不支持工具：如实报告为服务异常，别据此给出误导性的能力结论。
    return { supported: false, message: `工具支持探测失败：${describeError(error, "未知错误")}（非模型能力问题，稍后重试即可）` };
  }
}

// 解析 SSE 流：按行拆 data: 载荷，提取 choices[0].delta.content；残行跨 chunk 缓存。
// 返回是否收到过任何内容——零内容时调用方报错（空回复检测）。
//
// **必须带空闲超时**：`reader.read()` 在上游卡住（连接半开、网关挂起、模型停在那不吐字）
// 时会永远不返回。智能体路径（chatAgent）有 `timeout.chunkMs` 兜着，普通对话这条没有——
// 用户看到的是光标一直闪、点「停止」前一秒和十秒都没区别。120 秒沿用智能体的分块间隔标准。
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  send: ChunkSender,
  idleTimeoutMs = 120_000
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let seq = 0;
  let received = false;
  // 处理一行 data: 载荷。返回 true 表示遇到 [DONE]（调用方应结束）。
  const handleLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return true;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      const raw = parsed.choices?.[0]?.delta?.content;
      // **只接受字符串**（实测缺口）：上游/中转偶尔把 `content` 写成数字或对象
      // （`{"content":{"text":"你好"}}`）。旧实现原样 `send` 下去，渲染端把它拼进
      // 气泡字符串 → 用户读到 `[object Object]`，而模型那边其实有内容。
      // 非字符串一律当"这一帧没有正文"跳过（与 `content: null` 的工具调用帧同一处理）。
      const delta = typeof raw === "string" ? raw : "";
      if (delta) {
        received = true;
        send({ seq: (seq += 1), delta });
      }
    } catch {
      // 忽略不完整/非 JSON 行（如注释心跳）。
    }
    return false;
  };
  try {
    // **[DONE] 之后必须主动取消流**：`releaseLock()` 只放读锁，**不会断开底层连接**。
    // 实测（probe-sse-done，本机起一个发完 `[DONE]` 但不断开连接的 SSE 服务）：
    // 连跑 3 轮后仍有 3 条 socket 开着、一条都没关。部分中转正是这种形态
    // （回答给完就静默挂着），长会话下来累积成连接泄漏，最终撞上游的连接数上限。
    // 正常读到流结束（done=true）时不必取消——那时连接已经关了，取消是无害的空操作。
    const finish = async (): Promise<boolean> => {
      await reader.cancel().catch(() => undefined);
      return received;
    };
    for (;;) {
      // 给每次读取加空闲超时：`reader.read()` 在上游卡住时永不返回。
      // 超时后主动 cancel 流并抛中文错误，让调用方按"连接中断"处理并释放 busy。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`服务商超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有继续返回内容，连接可能已中断。`)),
          idleTimeoutMs
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      const readPromise = reader.read();
      try {
        chunk = await Promise.race([readPromise, idle]);
      } catch (error) {
        // 超时：**必须先把挂起的 read 处理掉再抛**。
        // 挂起的 `reader.read()` 一旦因为超时被放弃，后续 `releaseLock()` 会让它
        // reject 成 `ERR_INVALID_STATE: Releasing reader` —— 那是个没人接的 rejection，
        // 在 Electron 主进程里足以把进程带走（与 abort 回调那次同类）。
        // 正确顺序：cancel 流（让挂起的 read 以 done/abort 落定）→ 吞掉它的结果 → 抛中文错误。
        await reader.cancel().catch(() => undefined);
        void readPromise.catch(() => undefined);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (handleLine(line)) return await finish();
      }
    }
    // 流结束：缓冲区里可能还剩**最后一行/半行**（服务端最后一帧之后不带换行）。
    // 旧实现直接丢弃 → 最后一帧内容丢失（实测复现：含单帧数据的流返回空内容）。
    // 先冲刷解码器的残留字节（多字节字符被切断时），再把残余当一行处理。
    buffer += decoder.decode();
    if (buffer.trim() && handleLine(buffer)) return await finish();
    return received;
  } finally {
    reader.releaseLock();
  }
}
