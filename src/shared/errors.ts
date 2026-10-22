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

/**
 * cause 里的 code / message 是不是**确凿的**网络信号（已收录的 errno 或流中断短句）。
 *
 * 为什么需要这层判定（实测缺口）：`cause` 不是网络异常的专利——
 * 业务代码常用 `new Error(msg, { cause })`，AI SDK 的 `JSONParseError` 也把
 * `SyntaxError` 塞在 cause 里。旧实现只要 `cause.code ?? cause.message` 非空就当网络错误：
 * - `{ cause: { code: "ERR_QUOTA" } }` → 「网络连接失败：网络错误 ERR_QUOTA。请检查地址、端口与服务是否已启动。」；
 * - 上游返回 HTML 错误页 → 「网络错误 Unexpected token '<'。请检查地址…」。
 * 用户被引去查端口，真实原因（配额用尽、被网关拦截）一个字都看不到。
 */
function isKnownNetworkCause(value: string): boolean {
  return Boolean(NETWORK_CODES[value] ?? STREAM_BROKEN_MESSAGES[value.toLowerCase()]);
}

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
  // **上游返回的不是 JSON**：网关/代理拦截、地址指到了网页而不是 API 根路径时，
  // 对端回的是 HTML 错误页。AI SDK 抛 `AI_JSONParseError`，message 里只有一句英文
  // 加一段截断的原文（实测：「JSON parsing failed: Text: <html><body>502 Bad Gateway」）。
  // 直接透传既违反"错误提示一律中文"，也没告诉用户该查什么。
  if (error.name === "AI_JSONParseError" || /json parsing failed/i.test(error.message)) {
    return "上游返回的不是 JSON（常见于网关拦截、地址指到了网页而不是 API 接口）。请确认接口地址以 /v1 之类的 API 路径结尾，并检查服务商控制台是否有告警。";
  }

  // **只有确凿的网络信号才拼成网络错误**：业务异常的 `cause` 会带自己的 code
  // （`ERR_QUOTA`/`ERR_PARSE`）或任意 message，AI SDK 的 JSONParseError 更是把
  // `SyntaxError: Unexpected token '<'` 放在 cause 里（上游返回 HTML 错误页时）。
  // 旧实现见码就报网络错误，把用户引去查端口，真实原因全被盖掉。
  if (causeCode && isKnownNetworkCause(causeCode)) {
    return `网络连接失败：${NETWORK_CODES[causeCode] ?? STREAM_BROKEN_MESSAGES[causeCode.toLowerCase()] ?? `网络错误 ${causeCode}`}。${HINT}`;
  }
  // 未收录的 errno：**只有外层本身就是网络语境**（undici 的 `fetch failed`）时才接管，
  // 这样 `EWEIRD` 这类新码仍给中文骨架（不吐裸英文）；而 `ERR_QUOTA` 这种业务码不会被误包装。
  if (causeCode && NETWORK_HINT_RE.test(error.message)) {
    return `网络连接失败：网络错误 ${causeCode}。${HINT}`;
  }
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
 * "页面加载被中途打断"这类错误能否直接重试。
 *
 * 只认 `ERR_ABORTED (-3)`：它的语义是**这次导航被取消**，而不是文件不存在（-6）。
 * 实测（本机 Electron 43，同一份 dist/index.html）：加载发起后 30ms 再发起一次导航，
 * 首次 `loadFile` 立刻以 `ERR_ABORTED (-3) loading 'file:///…/dist/index.html'` 失败，
 * 紧接着重试一次就成功——用户看到的却是「工作台启动失败」弹窗并被挡在门外。
 *
 * 为什么单独抽成纯函数：`loadApp` 在 main.ts 里依赖 BrowserWindow，没法直接单测；
 * 判定规则放这里就能用普通对象覆盖全部错误码。
 *
 * 为什么只认这一个码：其它码重试无益甚至有害——`-6` 说明文件真的不在
 * （`npm run build` 的 `clean` 正在跑），重试只会让用户多等一会儿才看到正确提示；
 * 权限/崩溃同理。错误码优先于文案（文案随 Chromium 版本变化，code 才是稳定契约），
 * 但 Electron 某些路径只把码塞进 message，故两者都看。
 */
export function isRetriableLoadAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === "ERR_ABORTED") return true;
  return /ERR_ABORTED/.test(String(record.message ?? ""));
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
  //
  // **但 cause 非空不等于网络错误**（实测缺口）：业务异常 `new Error(msg, { cause })`、
  // AI SDK 的 JSONParseError（cause 是 SyntaxError）都会带 cause。旧实现见 cause.code 就
  // 判 true，`cause: { code: "ERR_QUOTA" }` 会被当成网络故障——main.ts 据此白重试 3 轮，
  // 每一轮都注定失败，用户干等多倍时间才看到真正的错误。只认确凿信号。
  const cause = causeSignal(error);
  if (cause.code && isKnownNetworkCause(cause.code)) return true;
  if (cause.message && NETWORK_HINT_RE.test(cause.message)) return true;
  // cause.code 未收录时，仍可能整条 message 本身是网络语境（"terminated: other side closed"），
  // 交给下面的 NETWORK_HINT_RE 统一判断，不再单凭 cause 存在就下结论。
  const wrapped = error as { lastError?: { message?: string }; errors?: Array<{ message?: string }> };
  const text = [
    error.message,
    wrapped.lastError?.message ?? "",
    ...(wrapped.errors ?? []).map((entry) => entry.message ?? "")
  ].join(" ");
  return NETWORK_HINT_RE.test(text);
}

/**
 * 从异常里挖出 HTTP 状态码。找不到返回 undefined。
 *
 * **必须下钻包裹果**（实测 2026-10-22）：AI SDK 的 `maxRetries` 用尽后抛的不是
 * `APICallError` 而是 `AI_RetryError`，它自己**没有** `statusCode` / `status`，
 * 真实信息在 `lastError`（最后一次的 APICallError）与 `errors[]` 里。
 * 只在顶层找会得到 undefined —— 于是"429 该重试"这个判断永远不成立。
 * 实测形状（`/tmp/sdk-err-shape.mjs` 直连 SDK 复现）：
 *   name=AI_RetryError, statusCode=undefined,
 *   lastError={ name:"AI_APICallError", statusCode:429,
 *               responseHeaders:{ "retry-after":"2", … } }
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    lastError?: unknown;
    errors?: unknown;
  };
  if (typeof record.status === "number") return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  // 包裹果：取最后一次失败（`lastError` 优先，其次 errors 的末项）。
  const nested = record.lastError
    ?? (Array.isArray(record.errors) ? record.errors[record.errors.length - 1] : undefined);
  if (nested && nested !== error) return httpStatusOf(nested);
  return undefined;
}

/**
 * HTTP 状态码是否"值得再试一次"：限流（429）与服务端临时故障（5xx）。
 *
 * 为什么与 `isNetworkError` 分开（实测缺口 2026-10-22）：普通对话与智能体两条重试路径
 * 原先都只判 `isNetworkError`，于是上游明确回 `429 + retry-after: 2` 时**一次都不等就失败**——
 * 明明等两秒就能成功。`errorRecovery.retryDelayMs`（对齐 Codex `responses_retry.rs`）
 * 早就实现好了，却因为判据不放行而从未被调用。
 *
 * 反过来**必须排除** 401/403/404/400：这些重试必然同样失败，只会让用户白等一轮。
 * 400 里还有一类是"模型不收图片"，重试同样无效。
 *
 * 状态码来源两处都要认：`llmService.chatOnce` 把 `response.status` 挂在抛出的 Error 上；
 * 智能体路径拿到的是 SDK 的 `AI_RetryError`，状态码藏在 `lastError` 里（见 `httpStatusOf`）。
 */
export function isRetriableHttpStatus(error: unknown): boolean {
  const raw = httpStatusOf(error);
  if (raw === undefined) return false;
  return raw === 429 || raw >= 500;
}

/**
 * 从异常里挖出 `retry-after` 头（**含包裹果**）。找不到返回 undefined。
 *
 * `errorRecovery.parseRetryAfter` 只读顶层 `responseHeaders`，而智能体路径拿到的是
 * `AI_RetryError`（顶层的 `responseHeaders` 是 undefined，真实头在 `lastError` 上）。
 * 见 `httpStatusOf` 的实测形状说明。
 */
export function retryAfterHeaderOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    responseHeaders?: Record<string, string>;
    lastError?: unknown;
    errors?: unknown;
  };
  const headers = record.responseHeaders;
  if (headers) {
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (raw !== undefined) return raw;
  }
  const nested = record.lastError
    ?? (Array.isArray(record.errors) ? record.errors[record.errors.length - 1] : undefined);
  if (nested && nested !== error) return retryAfterHeaderOf(nested);
  return undefined;
}
