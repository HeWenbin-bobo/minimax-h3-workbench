import type { ChatMessage } from "../../shared/types";

/**
 * 历史规范化（移植 OpenAI Codex `core/src/context_manager/history.rs::normalize_history`
 * 与 `core/src/context_manager/normalize.rs`）。
 *
 * Codex 的三条不变量：
 * ① 每个 function_call 必须有配对的 function_call_output，反之亦然（孤儿调用补一条"已中止"
 *    的输出插在它后面；孤儿输出直接删；删一半要把整对删掉，不留半截）；
 * ② 不支持的非文本内容（图片/音频）在模型不支持时剥掉；
 * ③ 首条不得是工具输出。
 *
 * **哪些在本宿主真正适用**：① 不适用。我们的历史是 `ChatMessage[]`（只有 role/content/images），
 * AI SDK 的工具调用发生在 `streamText` 的步循环**内部**，从不落进我们发出去的历史——
 * 所以不存在"孤儿工具调用"这个形态。硬造一个只会是一层永不触发的死代码。
 *
 * 适用的是 ② 和 ③，且都是实测会踩的：
 * ② **不支持多模态的模型**：`images` 被映射成 image part，纯文本模型直接 400。
 *    用户上传图片时若没换模型，整个会话就卡死在报错上，而且上游那句英文 400 对用户毫无指向性。
 *    剥掉并**说清剥掉了什么**，比原样透传报错有用得多。
 * ③ 首条不得是 assistant：部分上游拒绝以 assistant 开场，而我们落盘的历史里完全可能这样
 *    （首轮失败、只剩一条助手报错消息）。
 *
 * 另补两条本宿主专属的（都是实际会出现的脏数据）：
 * - **空白消息一律丢**：流式途中关窗会留下 content 为空的残留，发上去部分上游 400
 *   （"content must not be empty"）。
 * - **剥图后内容为空要补占位**：否则这条消息又变回空 content，等于没解决。
 */

/** 模型是否支持图片输入。按模型名前缀判定——上游 /models 只给 id，拿不到能力位。 */
export function supportsImages(model: string): boolean {
  const lower = String(model || "").toLowerCase();
  // 视觉模型家族。除了主流的 vl / vision 命名，这里还收录了几类**专用视觉家族**
  // （实测漏判会让用户上传的图片被静默剥掉，只留一句"当前模型不支持图片输入"）：
  //   llava / pixtral / idefics / fuyu / molmo / cogvlm / step-1v
  // 注意 "vl" 是子串匹配：`cogvlm` 命中 "vl"，`qwen2.5-vl` 也是。
  return /vl|vision|llava|pixtral|idefics|fuyu|molmo|step-1v|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|glm-4v|internvl|minicpm-v/.test(lower);
}

export interface NormalizeResult {
  messages: ChatMessage[];
  /** 本轮据实剥掉了什么，用于如实告知用户（静默改动用户输入是不可接受的）。 */
  notes: string[];
}

/**
 * 规范化待发送的历史。纯函数，不改原数组。
 *
 * @param model 目标模型名，用于判断能否收图。
 * @param allowImages 显式允许图片（如用户当前轮刚上传）。false 时一律剥图。
 */
export function normalizeHistory(
  messages: ChatMessage[],
  options: { model: string; allowImages?: boolean }
): NormalizeResult {
  const notes: string[] = [];
  const canImage = options.allowImages !== false && supportsImages(options.model);
  let strippedImages = 0;

  const cleaned: ChatMessage[] = [];
  for (const message of messages) {
    const hasText = Boolean(message.content && message.content.trim());
    const hadImages = Boolean(message.images && message.images.length > 0);
    // 被剥图的这条消息要活下来：只有"既没文字也没图"才是真正的空残留。
    // 用 hadImages 而非剥完之后的 images 判断——否则剥图那条会连带被丢掉，
    // 占位文案永远走不到（本测试初版就是这么挂的）。
    if (!hasText && !hadImages) continue;

    if (hadImages && !canImage) strippedImages += message.images!.length;
    // 纯图片消息（无文字）需要一个非空 content，否则部分上游 400（"content must not be empty"）。
    // 占位文案必须**按模型是否真能收图**分支——视觉模型下图片会留在 images 里，
    // 再贴一句"当前模型不支持图片输入"等于当面告诉模型它看不到图（实测会让它拒答图片内容）。
    const content = hasText
      ? message.content
      : canImage
        ? "（用户只发送了图片，请直接查看并回应图片内容）"
        : "（用户发送了图片，但当前模型不支持图片输入）";
    cleaned.push({ ...message, content, images: canImage ? message.images : undefined });
  }

  // 首条不得是 assistant：部分上游拒绝以 assistant 开场。
  while (cleaned.length > 0 && cleaned[0].role === "assistant") cleaned.shift();

  if (strippedImages > 0) {
    notes.push(`当前模型（${options.model || "未配置"}）不支持图片输入，本轮已忽略 ${strippedImages} 张图片。如需看图请切换到视觉模型。`);
  }
  return { messages: cleaned, notes };
}
