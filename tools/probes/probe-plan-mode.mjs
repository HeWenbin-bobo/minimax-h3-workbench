// 计划模式端到端探针：验证 chip → plan 请求 → 「继续执行」按钮 → execute 请求。
// 用本地 mock LLM（不起真上游）——本探针要证的是**链路**，不是模型 IQ。
// 载 dist 产物：改完代码先 npm run build 再跑。
// 从 repo 目录运行：node ../_scratch/probes/probe-plan-mode.mjs
import { createServer } from "node:http";
import { withApp } from "../../.e2e/driver.mjs";

const SEEN = []; // 记录收到的请求体，断言第二轮是否带 execute 语义

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 忽略非 JSON 探测请求 */ }
    SEEN.push(parsed);
    // 第二轮判断：历史里带了"按上面的计划执行"这句确认语。
    const isExecuteTurn = JSON.stringify(parsed?.messages ?? []).includes("按上面的计划执行");
    // 计划轮按 PLAN_MODE_PROMPT 的契约输出 <proposed_plan> 块——这样才验证到
    // "提示词契约 → 渲染器 .md-plan → 按钮亮起"这条完整链路，而不只是 looksLikePlan 的宽容分支。
    const planBlock = [
      "<proposed_plan>",
      "## 国产显卡价格表",
      "",
      "1. 先搜索 2025 年国产显卡的实时价格",
      "2. 整理成表格并生成 xlsx 文件",
      "3. 附上一段简要分析",
      "",
      "## 假设",
      "- 默认取近三个月价格",
      "</proposed_plan>"
    ].join("\n");
    const text = isExecuteTurn
      ? "已按计划完成，生成了表格文件。"
      : `好的，我打算这么做：\n\n${planBlock}\n\n确认后我就开始执行。`;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
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
    // 指向本地 mock 上游。此处的 key 是占位串，不是任何真实凭据。
    await cdp.eval(`(async () => {
      await window.h3.updateSettings({ llm: { provider: "custom", baseUrl: "http://127.0.0.1:${port}/v1", model: "mock-model", systemPrompt: "" } });
      await window.h3.setSecret("llmApiKey", "mock-key-not-real");
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));

    // 进游乐场（轮询等导航出现：reload 后 React 挂载需要时间）
    for (let i = 0; i < 25; i++) {
      const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, 800));

    const found = await cdp.eval(`(() => {
      const chips = [...document.querySelectorAll(".pg-chip")];
      const agent = chips.find((c) => (c.title || "").includes("智能体"));
      const plan = chips.find((c) => (c.textContent || "").includes("计划"));
      if (!plan) return false;
      if (agent && !agent.className.includes("on")) agent.click();
      plan.click();
      return true;
    })()`);
    check("存在「计划」chip 并已点击", found);
    // React 的 setState 要等下一帧才落到 DOM：同一 tick 里读 className 必然还是旧值
    // （初版就是这么误报的）。等一拍再读。
    await new Promise((r) => setTimeout(r, 400));
    const planOn = await cdp.eval(`(() => {
      const chips = [...document.querySelectorAll(".pg-chip")];
      const plan = chips.find((c) => (c.textContent || "").includes("计划"));
      return Boolean(plan && plan.className.includes("on"));
    })()`);
    check("点击后 chip 进入选中态", planOn === true);

    // 发一条会触发计划的消息（用原型 setter 赋值，React 才认这个受控输入）
    await cdp.eval(`(() => {
      const ta = document.querySelector(".pg-input-row textarea");
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      set.call(ta, "帮我做一份国产显卡价格表");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await cdp.eval(`document.querySelector(".pg-input-row .primary").click()`);

    // 等计划回来 + 按钮出现
    let buttonReady = false;
    for (let i = 0; i < 40; i++) {
      buttonReady = await cdp.eval(`Boolean(document.querySelector(".pg-plan-run"))`);
      if (buttonReady) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check("计划返回后出现「继续执行」按钮", buttonReady);
    const hint = await cdp.eval(`(document.querySelector(".pg-plan-actions") || {}).textContent || ""`);
    check("按钮带说明文案", hint.includes("继续执行"), hint);
    // 方案块必须被渲染器认出来并包成 .md-plan——否则尖括号会作为字面文本糊在气泡里。
    const blockInfo = await cdp.eval(`(() => {
      const bubble = document.querySelector(".pg-msg.assistant .pg-bubble");
      const text = bubble ? bubble.textContent || "" : "";
      return { hasBlock: Boolean(document.querySelector(".md-plan")), leaksTag: text.includes("proposed_plan") };
    })()`);
    check("方案块渲染成 .md-plan", blockInfo.hasBlock, JSON.stringify(blockInfo));
    check("尖括号标签未泄露成字面文本", blockInfo.leaksTag === false, JSON.stringify(blockInfo));

    const firstReq = SEEN[0] ?? {};
    check("第一轮请求带工具表（agent 路径）", JSON.stringify(firstReq.tools ?? []).length > 2);

    // 点「继续执行」
    const before = SEEN.length;
    await cdp.eval(`document.querySelector(".pg-plan-run").click()`);
    for (let i = 0; i < 40; i++) {
      if (SEEN.length > before) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check("点击后发出第二轮请求", SEEN.length > before, `请求数 ${before} → ${SEEN.length}`);
    check("第二轮请求带「按上面的计划执行」确认语",
      JSON.stringify(SEEN[SEEN.length - 1]?.messages ?? []).includes("按上面的计划执行"));
    check("第二轮不再出现「继续执行」按钮（标记已清除）",
      !(await cdp.eval(`Boolean(document.querySelector(".pg-plan-run"))`)));

    console.log("-".repeat(60));
    console.log(failed === 0 ? "=== 全部通过 ===" : `=== ${failed} 项失败 ===`);
  });
} finally {
  server.close();
}
if (failed > 0) process.exitCode = 1;
