// request_user_input 端到端探针：这是本轮最risky 的改动——主进程工具循环**挂起**等渲染端回答。
// 单测只覆盖了 QuestionBridge 自身，没覆盖"工具挂起 → 弹卡 → 点选 → 回传 → 工具继续"这条链路。
// 载 dist 产物：改完代码先 npm run build 再跑。
// 从 repo 目录运行：node ../_scratch/probes/probe-user-input.mjs
import { createServer } from "node:http";
import { withApp } from "../../.e2e/driver.mjs";

const SEEN = [];
let callCount = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 忽略探测请求 */ }
    SEEN.push(parsed);
    callCount += 1;

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // 第 1 轮：模型调 request_user_input（工具挂起，等用户点选）。
    if (callCount === 1) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "request_user_input", arguments: "" } }] }, index: 0 }] });
      const args = JSON.stringify({
        questions: [{
          id: "duration", header: "视频时长", question: "你想要多长的视频？",
          options: [
            { id: "6", label: "6 秒", description: "适合单个镜头" },
            { id: "15", label: "15 秒", description: "能容纳完整叙事" }
          ]
        }]
      });
      // 参数分片推送，贴近真实流式
      for (const piece of args.match(/.{1,40}/g)) send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, index: 0 }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // 第 2 轮：工具结果已回填，模型据答案收尾。断言答案确实进了历史。
    const historyText = JSON.stringify(parsed?.messages ?? []);
    const gotAnswer = historyText.includes("15 秒") || historyText.includes("用户选择");
    send({ choices: [{ delta: { content: gotAnswer ? "收到，按 15 秒来做。" : "（我没收到答案）" }, index: 0 }] });
    send({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let failed = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`);
};

try {
  await withApp({}, async (cdp) => {
    await cdp.eval(`(async () => {
      await window.h3.updateSettings({ llm: { provider: "custom", baseUrl: "http://127.0.0.1:${port}/v1", model: "mock-model", systemPrompt: "" } });
      await window.h3.setSecret("llmApiKey", "mock-key-not-real");
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));

    for (let i = 0; i < 25; i++) {
      const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, 800));

    // 开智能体（不开计划模式：request_user_input 在两种模式下都下发）
    await cdp.eval(`(() => {
      const chips = [...document.querySelectorAll(".pg-chip")];
      const agent = chips.find((c) => (c.title || "").includes("智能体"));
      if (agent && !agent.className.includes("on")) agent.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));

    await cdp.eval(`(() => {
      const ta = document.querySelector(".pg-input-row textarea");
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      set.call(ta, "帮我生成一段视频");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await cdp.eval(`document.querySelector(".pg-input-row .primary").click()`);

    // 等选择卡片出现（工具挂起中）
    let cardReady = false;
    for (let i = 0; i < 40; i++) {
      cardReady = await cdp.eval(`Boolean(document.querySelector(".pg-question-card"))`);
      if (cardReady) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check("选择题卡片出现（工具挂起等回答）", cardReady);

    const cardInfo = await cdp.eval(`(() => {
      const card = document.querySelector(".pg-question-card");
      if (!card) return null;
      return {
        header: (card.querySelector(".pg-question-chip") || {}).textContent || "",
        options: [...card.querySelectorAll(".pg-question-option")].map((b) => b.textContent),
        hasSkip: Boolean(card.querySelector(".pg-question-skip"))
      };
    })()`);
    check("卡片渲染题目标签", Boolean(cardInfo && cardInfo.header.includes("视频时长")), JSON.stringify(cardInfo));
    check("卡片渲染两个选项", Boolean(cardInfo && cardInfo.options.length === 2), JSON.stringify(cardInfo && cardInfo.options));
    check("卡片有「跳过」出口（否则不想答只能干等超时）", Boolean(cardInfo && cardInfo.hasSkip));

    // 单选单题：点一下即提交
    await cdp.eval(`(() => {
      const opts = [...document.querySelectorAll(".pg-question-option")];
      const fifteen = opts.find((b) => (b.textContent || "").includes("15 秒"));
      if (fifteen) fifteen.click();
      return true;
    })()`);

    // 等卡片消失 + 第二轮请求
    let cleared = false;
    for (let i = 0; i < 40; i++) {
      cleared = !(await cdp.eval(`Boolean(document.querySelector(".pg-question-card"))`));
      if (cleared && SEEN.length >= 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check("回答后卡片消失", cleared);
    check("工具循环继续，发出第二轮请求", SEEN.length >= 2, `请求数 ${SEEN.length}`);

    const secondHistory = JSON.stringify(SEEN[1]?.messages ?? []);
    check("答案回传进历史（模型能看到用户选了 15 秒）", secondHistory.includes("15 秒"), secondHistory.slice(-300));

    const finalText = await cdp.eval(`(() => {
      const bubbles = [...document.querySelectorAll(".pg-msg.assistant .pg-bubble")];
      return bubbles.map((b) => b.textContent).join(" | ");
    })()`);
    check("模型据答案收尾", finalText.includes("15 秒"), finalText.slice(0, 200));

    console.log("-".repeat(60));
    console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
  });
} finally {
  server.close();
}
if (failed > 0) process.exitCode = 1;
