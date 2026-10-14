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
          stream: true
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
  onToolEnd?: (tool: string, summary: string) => void
): Promise<{ textLength: number; toolCalls: number }> {
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
      // 「联网」开关关闭时不暴露 web_search，避免模型调用一个用户已关掉的工具。
      ...(enableWebSearch ? {
        web_search: tool({
          description: "联网搜索引擎：返回标题、摘要与链接。凡涉及实时信息（价格、新闻、版本号、时效事实）、用户提到'查一下/搜一下/最新'，或你不确定的事实，都必须先调用本工具核实，不要凭记忆作答。查询词提炼为最核心的 3–6 个词（不是整句话）；结果不相关就换词再搜一次。",
          inputSchema: z.object({ query: z.string().describe("搜索关键词（3–6 个词，如'iPhone 18 Pro 京东 价格'）") }),
          execute: async ({ query }) => {
            try {
              const results = await callbacks.webSearch(query);
              return results || "未搜索到相关内容。";
            } catch (error) {
              return `搜索失败：${describeError(error, "未知错误")}（请基于自身知识回答）`;
            }
          }
        })
      } : {}),
      generate_video: tool({
        description: "生成 AI 短视频：用户描述画面（主体、动作、风格）即调用，4–15 秒、1–4 路。这是你独有的核心能力——用户表达任何'想要个视频/做一段/生成一下'的意图时直接调用，参数从描述中提取，画面感强的英文 prompt 效果更好，无需事先确认。",
        inputSchema: z.object({
          prompt: z.string().describe("视频内容描述（画面主体、动作、镜头、光线、风格；建议英文）"),
          duration: z.number().int().min(4).max(15).describe("时长秒数，4–15"),
          count: z.number().int().min(1).max(4).describe("生成数量，1–4")
        }),
        execute: async (params) => callbacks.generateVideo(params)
      }),
      // open_page：看具体网页。搜索给了链接但要看正文/详情时用它（比搜索更精准一步）。
      open_page: tool({
        description: "打开指定网页并返回页面内容。两种场景：① 用户点名某个网站（'打开 baidu 看看/去京东查这个商品'）；② web_search 返回了链接但摘要不够，需要看正文细节。URL 必须带协议（https:// 开头）。",
        inputSchema: z.object({
          url: z.string().url().describe("要打开的完整 URL，以 https:// 开头")
        }),
        execute: async ({ url }) => {
          try {
            return await callbacks.openPage(url);
          } catch (error) {
            return `打开网页失败：${describeError(error, "渲染失败")}（可改用 web_search 搜索相关信息）`;
          }
        }
      }),
      // create_file：文件产物真工具。此前只靠提示词约定"写围栏代码块"，模型会自我怀疑"我没有文件写入工具"
      // 而道歉推脱（实测复现）——模型对工具调用的信任远高于对文字约定的信任，产物交付必须工具化。
      create_file: tool({
        description: "生成文件并保存到用户的文件产物区（聊天中自动出现文件卡片，可预览、可在文件夹中打开）。这是你生成 Excel/表格、网页、文档的标准方式——用户要任何文件时调用本工具，而不是输出代码块或道歉。kind: csv/tsv（表格→存 .xlsx，Excel 可直接打开）、html（网页/小工具/游戏）、md（Word/文档）。",
        inputSchema: z.object({
          kind: z.enum(["html", "csv", "tsv", "md"]).describe("文件类型：csv/tsv=表格(存为.xlsx)、html=网页、md=文档"),
          name: z.string().describe("文件名（不含扩展名，如'科技新闻'）"),
          content: z.string().describe("完整文件内容：csv/tsv 首行为表头；html 为完整网页；md 为 markdown 正文")
        }),
        execute: async (params) => {
          try {
            return await callbacks.createFile({ ...params, kind: params.kind === "csv" || params.kind === "tsv" ? "xlsx" : params.kind });
          } catch (error) {
            return `保存文件失败：${describeError(error, "未知错误")}（请改用围栏代码块输出内容）`;
          }
        }
      })
    },
    stopWhen: stepCountIs(10),
    // 中转/上游偶发连接重置（实测 api.jihuarst.top 会间歇性 ECONNRESET）会把智能体整轮打挂，
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
  return { textLength, toolCalls };
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
      createFile: async () => "（探测）"
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
