import { describeError } from "../../shared/errors";
import type { ChatMessage, LlmStreamEvent } from "../../shared/types";
import { searchWeb } from "./webSearch";

export interface LlmServiceOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  searchBaseUrl?: string;
  searchApiKey?: string;
  /** 搜索的浏览器渲染回退（由主进程注入；模块本身不 import electron，保持可单测）。 */
  searchRenderHtml?: (url: string) => Promise<string>;
  /** 智能体模式（chatAgent）使用的框架版本——由 updateChecker 独立检查更新。 */
  frameworkVersion?: string;
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
    const payload = await this.buildPayload(messages, webSearch, browserOnly);
    this.controller = new AbortController();
    try {
      const response = await fetch(`${this.baseUrl}${resolveChatPath(this.baseUrl)}`, {
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
        signal: this.controller.signal
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(`LLM 请求失败：${response.status} ${detail.slice(0, 200)}`);
      }
      // 流式响应走 SSE 解析；服务商忽略 stream:true 返回完整 JSON 时，从非流式结构取内容。
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const received = await consumeSse(response.body, send);
        if (!received) {
          // 流式 200 却零内容（部分中转/模型的已知毛病）：自动降级发一次非流式请求，而不是直接报错。
          const fallback = await this.nonstreamChat(payload);
          if (fallback) send({ seq: 1, delta: fallback });
          else throw new Error("服务商未返回任何内容（流式与非流式均为空），请检查模型名称或更换服务商。");
        }
      } else {
        const full = (await response.json().catch(() => ({}))) as {
          choices?: Array<{ message?: { content?: string }; delta?: { content?: string }; text?: string }>;
          content?: string;
          base_resp?: { status_msg?: string };
        };
        const text = full.choices?.[0]?.message?.content ?? full.choices?.[0]?.delta?.content ?? full.choices?.[0]?.text ?? full.content;
        if (text) send({ seq: 1, delta: text });
        else throw new Error(`服务商未返回内容：${full.base_resp?.status_msg || JSON.stringify(full).slice(0, 200)}`);
      }
    } finally {
      this.controller = undefined;
    }
  }

  // 非流式补发：流式空回复时的一次自动降级重试（同样载荷，stream:false）。
  private async nonstreamChat(payload: Array<Record<string, unknown>>): Promise<string | undefined> {
    try {
      const response = await fetch(`${this.baseUrl}${resolveChatPath(this.baseUrl)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.options.model, messages: payload, stream: false })
      });
      if (!response.ok) return undefined;
      const full = (await response.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string }; text?: string }>;
        content?: string;
      };
      return full.choices?.[0]?.message?.content ?? full.choices?.[0]?.text ?? full.content ?? undefined;
    } catch {
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
      const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
      const models = (payload.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)).sort();
      if (models.length === 0) return { ok: false, models: [], message: "服务商返回了空模型列表，请手动填写模型名。" };
      return { ok: true, models, message: `获取到 ${models.length} 个模型。` };
    } catch (error) {
      return { ok: false, models: [], message: describeError(error, "无法连接服务商") };
    }
  }

  // 联网搜索：优先用户配置的搜索 API；未配置时由 searchWeb 回落免 key 直抓 Bing/搜狗。
  // browserOnly=true 走「浏览器搜索」：只用应用自带 Chromium 渲染，跳过 API 与 HTTP 直抓。
  // 结果拼接为参考段落注入本轮 system 消息。
  private async search(query: string, browserOnly = false): Promise<string> {
    return searchWeb(query, {
      apiBaseUrl: this.options.searchBaseUrl,
      apiKey: this.options.searchApiKey,
      renderHtml: this.options.searchRenderHtml,
      browserOnly
    });
  }

  private async buildPayload(messages: ChatMessage[], webSearch: boolean, browserOnly = false): Promise<Array<Record<string, unknown>>> {
    const system: Record<string, unknown> = {
      role: "system",
      content: this.options.systemPrompt || "你是 MiniMax H3 视频工作台内置的智能助手。"
    };
    if (webSearch && messages.length > 0) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser?.content) {
        try {
          const results = await this.search(lastUser.content.slice(0, 200), browserOnly);
          if (results) system.content = `${system.content}\n\n以下是网络搜索结果，回答时可引用：\n${results}`;
        } catch (error) {
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
export function resolveChatPath(baseUrl: string): string {
  return /api\.minimax\.io/i.test(baseUrl) ? "/text/chatcompletion_v2" : "/chat/completions";
}

// ---------- 智能体模式（Vercel AI SDK 工具循环，Codex/Claude Code 形态） ----------

export interface AgentToolCallbacks {
  /** 联网搜索工具：返回参考段落（未配置搜索 API 时抛错）。 */
  webSearch: (query: string) => Promise<string>;
  /** 视频生成工具：提交生成任务并返回给用户的说明文本。 */
  generateVideo: (params: { prompt: string; duration: number; count: number }) => Promise<string>;
  /** 打开网页工具（open_page）：用应用自带 Chromium 渲染指定 URL 并返回 HTML，让模型能真正"打开浏览器"。 */
  openPage: (url: string) => Promise<string>;
  /** 文件产物工具（create_file）：把内容保存为文件并返回给模型的确认文本。 */
  createFile: (params: { kind: "html" | "csv" | "tsv" | "md" | "xlsx"; name: string; content: string }) => Promise<string>;
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
 * AI SDK 多步智能体对话：模型可自主调用 web_search / generate_video 工具，
 * 最多 10 步。AI SDK 是 ESM-only——主进程 CJS 产物用动态 import 加载；
 * model 经 createOpenAICompatible 注入（复用连接设置里的 baseUrl/Key/模型名）。
 * 返回 { textLength, toolCalls }：调用方据此判断"模型不支持工具"（0 文本 0 工具调用）
 * 并自动回落普通对话——这正是工具支持检测的运行时落地。
 */
/** 工具执行结果的人类可读摘要（onToolExecutionEnd 的 toolOutput.output 形态随工具而异）。 */
function humanizeToolOutput(toolName: string, output: unknown): string {
  if (output == null) return "完成";
  if (typeof output === "string") {
    // web_search 返回 "[n] 标题…" 格式的参考段落：数条目数给用户确定感。
    if (toolName === "web_search") {
      const count = (output.match(/^\[\d+\]/gm) || []).length;
      return count > 0 ? `找到 ${count} 条结果` : "未找到结果";
    }
    return output.length > 60 ? "完成" : output;
  }
  return "完成";
}

/** 工具调用入参的人类可读摘要：状态条展示用，别把原始 JSON 糊到用户脸上。 */
function humanizeToolInput(toolName: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 120);
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (toolName === "web_search" && typeof record.query === "string") return record.query.slice(0, 120);
    if (toolName === "generate_video") {
      const prompt = typeof record.prompt === "string" ? record.prompt.slice(0, 80) : "";
      const duration = typeof record.duration === "number" ? `${record.duration} 秒` : "";
      const count = typeof record.count === "number" ? `${record.count} 路` : "";
      return [prompt, duration, count].filter(Boolean).join(" · ");
    }
    return JSON.stringify(input).slice(0, 120);
  }
  return String(input).slice(0, 120);
}

/** 一轮智能体对话的收尾统计。usage 供上下文压缩记账；拿不到时调用方回落到字符估算。 */
export interface AgentRunResult {
  textLength: number;
  toolCalls: number;
  usage?: { inputTokens: number };
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
  onToolEnd?: (tool: string, summary: string) => void,
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
  const provider = createOpenAICompatible({
    name: "workbench-llm",
    baseURL: options.baseUrl,
    apiKey: options.apiKey || undefined,
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined
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
          inputSchema: z.object({ query: z.string().min(1).describe("搜索关键词，3–6 个词，如'iPhone 18 Pro 京东 价格'。不要写整句话。") }),
          execute: async ({ query }) => {
            try {
              const results = await callbacks.webSearch(query);
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

何时使用：**用户要的就是视频本身**——说"生成一段视频/做个短片/来几条视频"，或描述了想拍的画面并明确要视频。参数从用户的描述里提取即可，不需要事先反问确认。

何时不用（这条最容易搞错，请务必对照）：
- 用户要的是**网页/页面/小工具/游戏/3D 场景** → 用 create_file(kind=html)，**不是**视频。
- 用户要的是**表格/Excel/文档/报告** → 用 create_file，**不是**视频。
- 用户只是在聊创意、问概念、要文字方案 → 直接回答。
- 用户说"把所有能力都用上/做全一点" → 那是要求把**他要的那个产物**做得更扎实，**不是**让你额外补一段视频。

"画面描述"出现在请求里**不等于**用户要视频——他可能在描述一个要用网页画出来的场景。

调用后任务卡片会实时显示在对话下方，完成后用户可预览与下载。画面感强的英文 prompt 效果更好。这是**消耗资源**的操作（真实扣费、耗时数十秒），用户没要就别调——同一轮里也不要为同一个意图重复调用。`,
        inputSchema: z.object({
          prompt: z.string().min(1).describe("视频内容描述：画面主体、动作、镜头运动、光线、风格。建议英文，越具体越好。"),
          duration: z.number().int().min(4).max(15).describe("时长秒数，4–15 之间的整数。用户没说就按 6。"),
          count: z.number().int().min(1).max(4).describe("生成数量，1–4 之间的整数。用户没说就按 1。")
        }),
        execute: async (params) => callbacks.generateVideo(params)
      })
      }),
      // open_page：看具体网页。搜索给了链接但要看正文/详情时用它（比搜索更精准一步）。
      // 计划模式**保留**：它只读，没有副作用；模型看不到实际情况就写不出靠谱的计划。
      open_page: tool({
        description: `打开指定网页，返回渲染后的页面正文。

何时使用：① 用户点名某个网站（"打开百度看看/去京东查这个商品"）；② web_search 返回了链接，但摘要不足以回答，需要看正文细节。

何时不用：你只是想找信息、还不知道哪个页面有——那是 web_search 的活。另外不要打开搜索结果页本身（那是搜索引擎的界面，不是内容），要打开结果里的具体链接。`,
        inputSchema: z.object({
          url: z.string().url().describe("要打开的完整 URL，必须带协议（https:// 开头）。")
        }),
        execute: async ({ url }) => {
          try {
            return await callbacks.openPage(url);
          } catch (error) {
            return `打开网页失败：${describeError(error, "渲染失败")}。可改用 web_search 搜索相关信息，或换一个更直接的链接。`;
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

类型选择：结构化数据用 csv/tsv（首行是表头，保存为 .xlsx，Excel 可直接打开）；可交互的网页、小工具、游戏、3D 场景用 html（要完整，含 <!DOCTYPE html>；3D 可用 three.js 等 CDN，但注意预览沙箱禁止外发网络，CDN 需内联或改用纯 CSS/canvas 实现）；纯文本报告用 md。

用户要文件时**直接生成完整内容**——不要道歉、不要教他自己去做、不要只给示例、不要把内容同时贴在回复里（文件卡片已经承载了内容，重复一遍是浪费）。

**一次只写一个文件，且必须自包含**（实测踩过）：
- 网页/游戏/3D 场景要把 HTML、CSS、JS **全部写在同一个文件里**（内联 <style> 与 <script>）。
  不要拆成 .html + .js + .css 多个文件——预览只加载那一个文件，拆开后页面是坏的。
- 不要因为"内容太长"而分片多次调用本工具试图拼接：多次调用会生成**多个独立文件**，
  它们不会自动合并。一次写完整；确实写不下就先精简功能，保证这一个文件能跑。
- 需要第三方库（如 three.js）时**不要用 CDN**：预览沙箱禁止外发网络，外链加载不到。
  用原生 Canvas/WebGL/CSS 自己实现，或把必要的少量代码内联进来。`,
        inputSchema: z.object({
          kind: z.enum(["html", "csv", "tsv", "md"]).describe("文件类型。csv/tsv=结构化数据（存为 .xlsx）；html=网页/小工具/游戏；md=文档/报告。"),
          name: z.string().min(1).describe("文件名，不含扩展名（如'科技新闻'）。不要带 .xlsx / .html 等后缀。"),
          content: z.string().min(1).describe("完整文件内容。csv/tsv 首行为表头；html 为完整网页（含 <!DOCTYPE html>）；md 为 markdown 正文。")
        }),
        execute: async (params) => {
          try {
            return await callbacks.createFile({ ...params, kind: params.kind === "csv" || params.kind === "tsv" ? "xlsx" : params.kind });
          } catch (error) {
            return `保存文件失败：${describeError(error, "未知错误")}。请把内容改写成围栏代码块直接输出，并在回复里说明文件未能保存。`;
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
          explanation: z.string().describe("一句话说明这次更新的原因（如'已完成搜索，开始整理数据'）。仅当状态变化需要解释时才写。").optional(),
          plan: z.array(z.object({
            step: z.string().describe("步骤描述，写清要做什么，如'搜索 2025 年国产显卡价格'。"),
            status: z.enum(["pending", "in_progress", "completed"]).describe("步骤状态。pending=未开始，in_progress=进行中（全清单最多一项），completed=已完成。")
          })).min(1).describe("完整步骤清单（每次调用都要给全量，而不是只给变化的那几步）。")
        }),
        execute: async (params) => {
          try {
            return await callbacks.updatePlan(params);
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
            id: z.string().describe("问题标识（英文短名，如'video_duration'），用于回传答案时对应。"),
            header: z.string().describe("很短的中文标签，最多 12 个字（如'视频时长'）。"),
            question: z.string().describe("完整问题，一句话说清要用户在什么之间做选择。"),
            multiSelect: z.boolean().describe("是否允许多选。只有确实可以同时选多个时才设为 true。").optional(),
            options: z.array(z.object({
              id: z.string().describe("选项标识（英文短名）。"),
              label: z.string().describe("选项显示文字，简短（如'8 秒'）。"),
              description: z.string().describe("这个选项意味着什么，一句话。")
            })).min(2).max(4).describe("2–4 个互斥选项。")
          })).min(1).max(3).describe("1–3 个问题。")
        }),
        execute: async (params) => {
          try {
            return await callbacks.requestUserInput(params);
          } catch (error) {
            // 用户没回答不算失败：必须让模型继续，而不是让它在这里死等或反复重试。
            return `未获得用户回答（${describeError(error, "用户选择了跳过或未在时限内回答")}）。请按你认为最合理的方式继续执行，并在回复里说明你做了哪些默认假设。`;
          }
        }
      })
    },
    stopWhen: stepCountIs(10),
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
      onToolEnd(toolName, humanizeToolOutput(toolName, (event as { toolOutput?: { output?: unknown } }).toolOutput?.output));
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
  try {
    // ai v7 的 steps 是 PromiseLike<Array<StepResult>>——await 后按步累计工具调用数。
    for (const step of await stream.steps) {
      toolCalls += step.toolCalls.length;
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
  return { textLength, toolCalls, usage };
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
export async function consumeSse(body: ReadableStream<Uint8Array>, send: ChunkSender): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let seq = 0;
  let received = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return received;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            received = true;
            send({ seq: (seq += 1), delta });
          }
        } catch {
          // 忽略不完整/非 JSON 行（如注释心跳）。
        }
      }
    }
    return received;
  } finally {
    reader.releaseLock();
  }
}
