/**
 * 交互提问桥（`request_user_input` 的宿主侧，对齐 Codex `request_user_input_spec.rs`）。
 *
 * 问题：工具循环跑在主进程，而选择题必须由渲染端弹给用户。AI SDK 的 `execute` 是个 Promise，
 * 只要不 resolve 就会一直等——所以这里挂一张"待答"登记表：`execute` 创建 Promise 并把 resolver
 * 存进来，渲染端回答后经 IPC 取出 resolver 手动 resolve。这就是全部机制。
 *
 * 三条必须守住的纪律（少一条就会出线上事故）：
 * ① **必须有超时**。没有超时的话用户关窗走开，工具循环会永久挂住——该会话的取消器一直被占着，
 *    之后那条会话再也发不出消息（同会话并发守卫会一直拒绝）。
 * ② **超时必须 reject，不能 resolve 空值**。模型要能区分"用户选了跳过"与"拿到了答复"，
 *    否则它会以为选了个空选项、把空串当答案用。reject 文案里写明"按最佳判断继续"。
 * ③ **必须带 sessionId**。多会话可并发，两个会话同时提问时答案不能串到对方那里。
 */

import type { AgentQuestion } from "./llmService";

export interface PendingQuestion {
  sessionId: string;
  questions: AgentQuestion[];
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** abort 监听器与其所属 signal：`answer`/`skip` 路径也要能把它摘掉。 */
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** 默认等待时长。够用户看清题目并点选，又不至于把工具循环卡到"像是死了"。 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 180_000;

/** 用户选好答案后回传给模型的文本。把选项 id 换成人话描述，省得模型再猜 id 的含义。 */
export function formatAnswers(
  questions: AgentQuestion[],
  answers: Record<string, string[]>
): string {
  if (questions.length === 0) return "未获得用户回答。";
  const lines: string[] = [];
  for (const question of questions) {
    // `answers` 来自 IPC（`llm:answer`），值类型没有保证：可能是字符串、数字或对象。
    // 旧实现直接 `picked.map(...)`，非数组会抛 "picked.map is not a function"——
    // 而这里跑在工具循环的 resolve 路径上，抛错会让整轮对话挂掉（实测确认）。
    const raw = (answers as Record<string, unknown> | undefined)?.[question.id];
    const picked = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string")
      : typeof raw === "string"
        ? [raw]
        : [];
    if (picked.length === 0) {
      // 单题未答：如实说，让模型对这道题按最佳判断继续，而不是替用户编一个答案。
      lines.push(`【${question.header}】用户未作答——请按你认为最合理的方式处理，并说明你采用的默认值。`);
      continue;
    }
    const labels = picked.map((id) => {
      // `question.options` 也必须兜底：题目对象来自主进程的 `request_user_input` 入参，
      // 而它最终由**模型**生成（AI SDK 只校验 schema 里有的字段，历史/老版本数据可能缺）。
      // 缺 `options` 时 `.find` 直接抛 TypeError——**这里跑在工具循环的 resolve 路径上**，
      // 抛错会让整轮对话挂掉（与上面 `picked.map` 那条同一类后果，实测 probe-more 复现）。
      const option = Array.isArray(question.options)
        ? question.options.find((entry) => entry?.id === id)
        : undefined;
      if (!option) return id;
      // label / description 也可能缺失：`${undefined}（${undefined}）` 会把
      // "undefined（undefined）" 原样发给模型，看起来像用户选了这么个选项。
      const label = typeof option.label === "string" && option.label ? option.label : id;
      return typeof option.description === "string" && option.description
        ? `${label}（${option.description}）`
        : label;
    });
    lines.push(`【${question.header}】用户选择：${labels.join("、")}`);
  }
  return `用户已回答：\n${lines.join("\n")}`;
}

export class QuestionBridge {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(private readonly timeoutMs: number = DEFAULT_QUESTION_TIMEOUT_MS) {}

  /**
   * 登记项的统一收尾：清定时器、摘 abort 监听器、从表里删除。
   * `finish`（超时/中止）、`answer`、`skip`、`cancelSession` 四条路径共用。
   */
  private settle(requestId: string): PendingQuestion | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    return entry;
  }

  /**
   * 挂起一组问题，等渲染端回答。
   * 由 `answer()` / `skip()` / `cancelSession()` 或超时定时器让其落定。**只落定一次**——
   * 超时后用户再点选是正常竞态，不得二次 resolve（Promise 虽然会忽略，但登记表会漏删）。
   */
  ask(sessionId: string, requestId: string, questions: AgentQuestion[], signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const finish = (run: () => void) => {
        if (!this.settle(requestId)) return; // 已被超时/回答/取消清掉
        run();
      };
      const onAbort = () => finish(() => reject(new Error("用户停止了本轮对话。")));
      // 已中止就直接结束，别把 resolver 挂进表里等一个不会到达的回答。
      if (signal?.aborted) {
        reject(new Error("用户停止了本轮对话。"));
        return;
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error("用户未在时限内回答。"))),
        this.timeoutMs
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      // 把 signal + 监听器记进登记项：`answer()` / `skip()` 这两条**正常收尾**路径
      // 也必须摘掉它。只靠 `finish()` 摘的话，用户正常答完（最常见路径）时监听器
      // 会留在本轮 signal 上——同一轮里连续问几次就累积几个闭包，
      // 且它们捕获着已落定的 resolver（阻止整轮上下文被回收）。
      this.pending.set(requestId, { sessionId, questions, resolve, reject, timer, signal, onAbort });
    });
  }

  /** 渲染端回答。找不到该 requestId 时返回 false（超时后用户又点了，属正常竞态，不报错）。 */
  answer(requestId: string, answers: Record<string, string[]>): boolean {
    // 走 settle()：正常作答这条**最常见**的收尾路径也必须摘掉 abort 监听器，
    // 否则同一轮里连问几次就在本轮 signal 上累积几个闭包。
    const entry = this.settle(requestId);
    if (!entry) return false;
    entry.resolve(formatAnswers(entry.questions, answers));
    return true;
  }

  /** 用户跳过：与超时同一条收尾路径（reject），模型会按最佳判断继续。 */
  skip(requestId: string): boolean {
    const entry = this.settle(requestId);
    if (!entry) return false;
    entry.reject(new Error("用户跳过了这组问题。"));
    return true;
  }

  /**
   * 会话中止/结束：该会话所有未答问题立即 reject。
   * 不做这一步的话，用户点了「停止」而问题还挂着，工具循环不会退出。
   */
  cancelSession(sessionId: string): void {
    for (const requestId of [...this.pending.keys()]) {
      const entry = this.pending.get(requestId);
      if (!entry || entry.sessionId !== sessionId) continue;
      const settled = this.settle(requestId);
      settled?.reject(new Error("本轮对话已结束。"));
    }
  }

  /** 是否有挂起的问题。 */
  hasPending(sessionId?: string): boolean {
    if (!sessionId) return this.pending.size > 0;
    for (const entry of this.pending.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }
}
