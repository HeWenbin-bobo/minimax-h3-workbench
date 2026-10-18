// 网络层异常在 Node/Electron 里只有英文骨架文案（undici 的 "fetch failed"、DOMException 的 "TimeoutError"），
// 直接透传给最终用户等于没给信息。所有面向用户的错误出口统一走这里翻译成中文；
// 业务异常（本来就是中文）原样返回，不会二次包装。
const NETWORK_CODES: Record<string, string> = {
  ECONNREFUSED: "目标服务未在监听（连接被拒绝）",
  ENOTFOUND: "域名无法解析",
  EAI_AGAIN: "域名解析超时",
  ECONNRESET: "连接被对方重置",
  ETIMEDOUT: "连接超时",
  EHOSTUNREACH: "主机不可达",
  ENETUNREACH: "网络不可达",
  EPROTO: "协议协商失败（检查地址是 HTTP 还是 HTTPS）",
  CERT_HAS_EXPIRED: "TLS 证书已过期",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 证书为自签名",
  // undici（Node/Electron 内置 fetch）的码：不收录的话用户看到的就是裸英文码。
  UND_ERR_CONNECT_TIMEOUT: "连接上游超时（网络受限或服务无响应）",
  UND_ERR_HEADERS_TIMEOUT: "等待响应头超时",
  UND_ERR_BODY_TIMEOUT: "响应体传输超时",
  UND_ERR_SOCKET: "连接被提前关闭"
};

/**
 * 文件系统 errno → 中文。
 *
 * 保存产物、写设置、删回收站文件都会碰到这些；不翻译的话用户看到的是
 * "ENOSPC: no space left on device, write" 这种裸英文（实测），
 * 违反「错误提示一律中文」，而且不知道该怎么办。
 */
const FS_CODES: Record<string, string> = {
  ENOSPC: "磁盘空间不足",
  EACCES: "没有访问权限（可能被杀毒软件或其他程序占用）",
  EPERM: "操作不被允许（权限不足）",
  EBUSY: "文件正被其他程序占用",
  EISDIR: "目标是一个目录，不是文件",
  ENOTDIR: "路径中有一段不是目录",
  ENOENT: "文件或目录不存在",
  EROFS: "所在磁盘为只读",
  ENAMETOOLONG: "文件路径过长",
  EMFILE: "同时打开的文件过多，请重启应用",
  EXDEV: "跨磁盘操作不被支持"
};

const HINT = "请检查地址、端口与服务是否已启动。";

// 流式中途被对端断开时，undici 抛的 cause 是"英文短句"而不是 errno（实测中途 reset 的 cause.message = "terminated"，
// 且不带 code）——只认 cause.code 会把这类失败漏判成业务异常，界面上透出 AI SDK 的英文占位文案。
const STREAM_BROKEN_MESSAGES: Record<string, string> = {
  terminated: "连接在传输过程中被对端关闭",
  "premature close": "连接被提前关闭",
  "other side closed": "连接被对端关闭",
  aborted: "连接被中止",
  // fetch 对被禁端口（1/7/9/11/13/…/6667 等，WHATWG fetch 的 bad port 清单）直接拒绝，
  // 抛的是无 code、cause.message 为 "bad port" 的 TypeError。实测（probe-badport）
  // 未收录时界面显示「网络错误 bad port」——中英混排，且用户不知道是自己填的端口有问题。
  "bad port": "该端口被安全策略禁止访问，请换一个端口（如 8188、8080、3000）"
};

/** 网络层异常的关键词（同时用于 cause 与 AI SDK 包裹层文本）。 */
const NETWORK_HINT_RE = /fetch failed|failed to fetch|network ?error|socket hang up|other side closed|cannot connect to api|failed to process successful response|terminated|premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_/i;

/** 从异常的 cause 提取网络层信号：cause 可能是 Error（带 code/message）、字符串或普通对象，三种都要认。 */
function causeSignal(error: Error): { code?: string; message?: string } {
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "string") return { code: cause, message: cause };
  if (cause && typeof cause === "object") {
    const record = cause as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined
    };
  }
  return {};
}

export function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return typeof error === "string" && error.trim() ? error.trim() : fallback;
  }
  // AbortSignal.timeout() 抛的 DOMException：超时和"用户主动取消"要分开说。
  if (error.name === "TimeoutError") return `连接超时：目标服务未在规定时间内响应。${HINT}`;
  if (error.name === "AbortError") return "操作已取消。";
  // **地址本身写错**（漏 `http://`、多了空格、填成 `abc` 这类）：
  // undici 抛 `TypeError: Failed to parse URL from abc/v1/models`，cause 是 "Invalid URL"。
  // 不专门拦的话会走下面 causeCode 分支，拼成
  // 「网络错误 Invalid URL。请检查地址、端口与服务是否已启动。」——中英混排，
  // 而且把用户引向"检查服务有没有起来"，真实原因是他自己的地址格式不对。
  const cause = causeSignal(error);
  const invalidUrl = cause.message === "Invalid URL" || /failed to parse url/i.test(error.message);
  if (invalidUrl) {
    return "接口地址格式不正确：需要以 http:// 或 https:// 开头（例如 https://api.example.com/v1）。";
  }
  const causeCode = cause.code ?? cause.message;
  if (causeCode) return `网络连接失败：${NETWORK_CODES[causeCode] ?? STREAM_BROKEN_MESSAGES[causeCode.toLowerCase()] ?? `网络错误 ${causeCode}`}。${HINT}`;
  // AI SDK 的 APICallError 会把 errno 塞在 message 里（"Cannot connect to API: read ECONNRESET"），
  // 不设 cause.code——只认 cause 的话这类异常会以裸英文透传到界面。
  // 仅当该 token 是已收录的 errno，或整条 message 本身带网络语境时才翻译，
  // 避免把普通单词（如 "ERROR"）误判成 errno。
  const candidate = /\b(UND_ERR_[A-Z_]+|E[A-Z]{4,})\b/.exec(error.message)?.[1];
  if (candidate && (NETWORK_CODES[candidate] || /connect|socket|network|reset|refused|reach|timeout|timed out/i.test(error.message))) {
    return `网络连接失败：${NETWORK_CODES[candidate] ?? `网络错误 ${candidate}`}。${HINT}`;
  }
  // 文件系统 errno：保存产物 / 写设置 / 删回收站文件都会碰到。
  // 先查顶层 error.code（Node 的 fs 错误通常是 code 而非 cause），再查 message 里的 errno 令牌。
  const fsCode = [ (error as { code?: unknown }).code, candidate ]
    .find((value): value is string => typeof value === "string" && Boolean(FS_CODES[value]));
  if (fsCode) return `${FS_CODES[fsCode]}：${error.message.replace(/^E[A-Z]+:\s*/, "").trim() || FS_CODES[fsCode]}`;
  // 中途断开时 AI SDK 只给 "Failed to process successful response"，真正的信号在 cause.message（terminated）里，
  // 上面 causeCode 分支没命中时兜底按网络语境翻译，避免透出英文占位。
  if (NETWORK_HINT_RE.test(error.message) || NETWORK_HINT_RE.test(cause.message ?? "")) {
    return `网络连接失败：连接在传输过程中被中断。${HINT}`;
  }
  // AI SDK 的包裹层会把真实原因藏起来，直接透传等于没信息：
  // 重试失败形如 "Failed after 2 attempts. Last error: AI_APICallError: Internal Server Error"。
  const lastError = /Last error:\s*(?:AI_\w+Error:\s*)?(.+)$/is.exec(error.message)?.[1]?.trim();
  if (lastError) return `上游服务返回错误：${lastError}（已重试仍未成功）。`;
  // 流式失败且未产内容：AI SDK 只留这句占位，对用户毫无信息量。
  if (/no output generated/i.test(error.message)) return "上游未返回任何内容（可能是服务暂时异常或模型不支持当前请求方式）。";
  return error.message.trim() || fallback;
}

/**
 * 网络层异常判定（连接重置/超时/拒绝等），用于"整轮重试"这类网络专项兜底。
 * 与 describeError 分开：这里要的是布尔判断，且作用在原始异常对象上（含 AI SDK 的多层包裹）。
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  // undici/Node 的 errno（ECONNRESET 等）挂 cause.code；流式中途断开则是 cause.message = "terminated"（无 code）。
  // 两种都要认，并兼容 cause 为字符串的形态——漏判会让"整轮重试"不触发，用户直接看到回落提示。
  const cause = causeSignal(error);
  if ((cause.code && cause.code.trim()) || (cause.message && NETWORK_HINT_RE.test(cause.message))) return true;
  const wrapped = error as { lastError?: { message?: string }; errors?: Array<{ message?: string }> };
  const text = [
    error.message,
    wrapped.lastError?.message ?? "",
    ...(wrapped.errors ?? []).map((entry) => entry.message ?? "")
  ].join(" ");
  return NETWORK_HINT_RE.test(text);
}
