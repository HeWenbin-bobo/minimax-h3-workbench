import type { ChatMessage, LlmStreamEvent } from "../../shared/types";

export interface LlmServiceOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  searchBaseUrl?: string;
  searchApiKey?: string;
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

  async chat(messages: ChatMessage[], webSearch: boolean, send: ChunkSender): Promise<void> {
    if (this.busy) throw new Error("上一轮对话还在进行中，请先停止或等待完成。");
    if (!this.options.apiKey && !/127\.0\.0\.1|localhost/.test(this.baseUrl)) {
      throw new Error("请先在连接设置中保存游乐场 LLM 的 API Key。");
    }
    const payload = await this.buildPayload(messages, webSearch);
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
        if (!received) throw new Error("服务商未返回任何内容（响应为空或格式不兼容），请检查模型名称是否正确。");
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
      return { ok: false, models: [], message: error instanceof Error ? error.message : "无法连接服务商" };
    }
  }

  // 联网搜索：OpenAI 兼容搜索 API（博查/Tavily 转接形态：POST /search 返回结果数组）。
  // 可选功能——未配置时抛错由 UI 隐藏入口；结果拼接为参考段落注入本轮 system 消息。
  private async search(query: string): Promise<string> {
    if (!this.options.searchBaseUrl) throw new Error("尚未配置搜索 API。");
    const base = this.options.searchBaseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.searchApiKey ? { Authorization: `Bearer ${this.options.searchApiKey}` } : {})
      },
      body: JSON.stringify({ query, count: 6 }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`搜索请求失败：${response.status}`);
    const payload = (await response.json().catch(() => ({}))) as {
      results?: Array<{ name?: string; title?: string; url?: string; snippet?: string; content?: string }>;
    };
    const items = payload.results ?? [];
    return items
      .map((item, index) => `[${index + 1}] ${item.title || item.name || ""}\n${item.url || ""}\n${item.snippet || item.content || ""}`)
      .join("\n\n");
  }

  private async buildPayload(messages: ChatMessage[], webSearch: boolean): Promise<Array<Record<string, unknown>>> {
    const system: Record<string, unknown> = {
      role: "system",
      content: this.options.systemPrompt || "你是 MiniMax H3 视频工作台内置的智能助手。"
    };
    if (webSearch && messages.length > 0) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser?.content) {
        try {
          const results = await this.search(lastUser.content.slice(0, 200));
          if (results) system.content = `${system.content}\n\n以下是网络搜索结果，回答时可引用：\n${results}`;
        } catch (error) {
          system.content = `${system.content}\n\n（联网搜索失败：${error instanceof Error ? error.message : "未知错误"}，请基于自身知识回答。）`;
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
