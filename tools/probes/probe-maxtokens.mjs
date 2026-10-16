// 验证上游是否真的接受 max_tokens: 64000。
//
// 为什么需要单独验证：上次"32KB 产物一次写成功"证明的是**智能体路径**（maxOutputTokens），
// 普通对话路径（max_tokens）从未被证明。而且"跑通了"不等于"64000 被接受"——
// 那次可能只是没触到上限。
//
// 判据（关键）：请求一段**明显超过旧上限**（约 17.5k 字符）的输出。
//   - 输出 > 20k 字符        → 上游接受了更大的 max_tokens
//   - 输出 ≈ 17.5k 且被截断   → 上游忽略/夹紧了该值（静默截断）
//   - 直接报错              → 上游拒绝该值
import { withApp } from "../../.e2e/driver.mjs";
import { cloneUserData } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { dir } = await cloneUserData();

// 要求输出远超旧上限。
// 初版用"重复输出 3000 行"——模型直接偷懒收尾（只回 48 字符），根本触不到上限，证明不了任何事。
// 改用模型**愿意完整输出**的机械展开任务，且规模要够大：500 个函数 × 约 55 字符 ≈ 27k 字符，
// 明显越过旧上限（约 17.5k 字符），从而能区分"接受了更大上限"与"被静默截断"。
const PROMPT = `请写一个完整的 HTML 文件，内含 500 个 JavaScript 函数，命名依次为 fn001 到 fn500。
每个函数的实现都必须是这一行（把 001 换成对应编号）：
function fn001(a, b) { const t = a * 2 + b; return t - 1; }
不要省略、不要写"以下省略"、不要只给前几个再补一句"其余同理"。必须从 fn001 一直写到 fn500，一个不漏。只输出 HTML 代码本身。`;

await withApp({ H3_USER_DATA: dir }, async (cdp) => {
  for (let i = 0; i < 25; i++) {
    const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
    if (ok) break;
    await sleep(400);
  }
  await sleep(900);
  console.log(`模型：${await cdp.eval(`(document.querySelector('.pg-model') || {}).textContent || ""`)}`);

  // 关掉智能体 → 走普通对话路径（它发的是 max_tokens: 64000）
  const chip = await cdp.eval(`(() => {
    const chips = [...document.querySelectorAll(".pg-chip")];
    const agent = chips.find((c) => (c.title || "").includes("智能体"));
    const was = agent ? agent.className.includes("on") : null;
    if (agent && was) agent.click();
    return JSON.stringify({ found: Boolean(agent), wasOn: was });
  })()`);
  console.log(`智能体 chip：${chip}（关掉 = 走普通对话，测 max_tokens）`);
  await sleep(500);

  await cdp.eval(`(() => {
    const ta = document.querySelector(".pg-input-row textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await cdp.eval(`document.querySelector(".pg-input-row .primary").click()`);

  let text = "";
  for (let i = 0; i < 180; i++) {
    text = await cdp.eval(`(() => [...document.querySelectorAll(".pg-msg.assistant .pg-bubble")].map((b) => b.textContent || "").join("\\n"))()`);
    const busy = await cdp.eval(`Boolean(document.querySelector(".pg-chip.stop"))`);
    if (!busy && text.trim()) break;
    await sleep(1000);
  }

  const len = text.length;
  // 数实际出现的函数编号：fn001..fn500，用最大编号判断"写到第几个"
  const found = [...text.matchAll(/fn(\d{3})/g)].map((m) => Number(m[1]));
  const maxFn = found.length ? Math.max(...found) : 0;
  const errored = /请求失败|服务商未返回任何内容|上游未返回任何内容/.test(text);

  console.log(`\n=== 结果 ===`);
  console.log(`  输出字符数：${len}`);
  console.log(`  写到第几个函数：fn${String(maxFn).padStart(3, "0")} / fn500`);
  console.log(`  是否报错：${errored ? "是" : "否"}`);
  console.log(`  开头：${text.slice(0, 80).replace(/\n/g, " ")}`);
  console.log(`  结尾：${text.slice(-80).replace(/\n/g, " ")}`);

  console.log(`\n=== 判定 ===`);
  if (errored) {
    console.log("  上游**拒绝**了 max_tokens: 64000（或该请求失败）——需要调小。");
  } else if (len > 20_000) {
    console.log(`  上游**接受**了更大的 max_tokens：输出 ${len} 字符，远超旧上限（约 17.5k）。`);
    console.log(maxFn >= 500 ? "  且完整写到 fn500，未被截断。" : `  写到 fn${maxFn}——长度已超旧上限，说明上限确实被抬高（未写满可能是模型自行收尾）。`);
  } else {
    console.log(`  输出仅 ${len} 字符、写到 fn${maxFn}，**未超旧上限** → 无法证明 64000 被接受。`);
  }
});
