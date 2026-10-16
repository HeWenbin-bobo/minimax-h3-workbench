// 主题 + Codex 骨架的机器验证探针：浅/深两套主题各截图，并**机器测量**对比度。
// 为什么不用肉眼看：用户已因"黑底黑字看不清"报过一次 bug，肉眼在浅色下看不出来。
// 载入的是 dist 产物 —— 改完代码必须先 npm run build 再跑本探针，否则跑的是旧构建。
// 从 repo 目录运行：node ../_scratch/probes/probe-codex-ui.mjs
import { writeFile, mkdir } from "node:fs/promises";
import { withApp } from "../../.e2e/driver.mjs";

const OUT = "F:/MinimaxH3/_scratch/results";
const MIN_CONTRAST = 4.5; // WCAG AA 正文级硬门槛

// 在页面里算对比度：取元素自身前景色与其最近的不透明背景色。
const MEASURE = `(() => {
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
    if (!m) return null;
    const parts = m[1].split(",").map((x) => parseFloat(x));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // 逐级向上找第一个不透明背景；全透明则退回 body 的背景。
  // 注意：背景是**渐变**（background-image）时 backgroundColor 是透明的，这里会穿透过去——
  // 那种情况在下面 ratioOf 里单独处理，不能把穿透结果当成真实底色。
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== "none") return null; // 渐变底：交给调用方
      const c = parse(style.backgroundColor);
      if (c && c.a > 0.95) return c;
      node = node.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  // 从渐变里取一个代表色（取第一个色标）。品牌渐变两端对比度接近，取一端足以判断。
  const gradientStop = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const img = getComputedStyle(node).backgroundImage;
      // 反斜杠要写双份：这段文本先经 JS 模板字面量求值，再交给浏览器当正则解析。
      const m = img && img !== "none" ? /rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)/.exec(img) : null;
      if (m) return { r: +m[1], g: +m[2], b: +m[3], a: 1 };
      node = node.parentElement;
    }
    return null;
  };
  const ratio = (fg, bg) => {
    const l1 = lum(fg), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const check = (sel, label) => {
    const el = document.querySelector(sel);
    if (!el) return { label, sel, missing: true };
    const fg = parse(getComputedStyle(el).color);
    if (!fg) return { label, sel, missing: true };
    const bg = bgOf(el) || gradientStop(el) || { r: 255, g: 255, b: 255, a: 1 };
    return { label, sel, ratio: Math.round(ratio(fg, bg) * 100) / 100, fg: getComputedStyle(el).color, bg: "rgb(" + bg.r + "," + bg.g + "," + bg.b + ")" };
  };
  return [
    check(".pg-msg.assistant .pg-bubble", "助手回答正文"),
    check(".pg-msg.user .pg-bubble", "用户气泡正文"),
    check(".pg-session-body strong", "会话标题"),
    check(".pg-session-body small", "会话摘要"),
    check(".pg-runs-head", "运行面板"),
    check(".pg-input-row textarea", "输入框文字"),
    check(".pg-chip", "工具条 chip"),
    check(".pg-model", "模型名"),
    check(".sidebar-theme", "主题按钮"),
    check(".md-code", "代码块"),
    check(".pg-empty span", "空状态说明"),
    check(".pg-tool-step", "工具步骤记录"),
  ];
})()`;

// 造一个渲染好的会话，供测量用（否则气泡/产物卡片都不在 DOM 里）。
// 不调 location.reload()：重载会换掉 CDP 的执行上下文，之后所有 evaluate 都打不到新文档——
// 探针会静默卡住（实测踩到，只能靠 taskkill 收场）。改为写入 localStorage 后由外层重新导航。
const SEED = `(() => {
  const key = "h3-playground-sessions";
  const now = new Date().toISOString();
  const rid = () => Math.random().toString(36).slice(2);
  localStorage.setItem(key, JSON.stringify([{
    id: "probe-session", title: "主题验证会话", createdAt: now, updatedAt: now,
    messages: [
      { id: rid(), role: "user", content: "帮我整理一份显卡价格表" },
      { id: rid(), role: "assistant",
        content: "这是整理好的结果：\\n\\n1. 先搜索实时价格\\n2. 再整理成表格\\n\\n\\u0060\\u0060\\u0060csv\\n型号,价格\\nRTX 5090,16999\\n\\u0060\\u0060\\u0060\\n\\n已生成表格文件。",
        toolSteps: ["✓ 搜索完成（找到 6 条结果）", "✓ 表格已生成"] }
    ]
  }]));
  return true;
})()`;

const run = async () => {
  await mkdir(OUT, { recursive: true });
  await withApp({}, async (cdp) => {
    await cdp.eval(SEED);
    // 重新加载让 localStorage 生效，然后等 React 重新挂载。
    await cdp.send("Page.navigate", { url: "file:///F:/MinimaxH3/repo/dist/index.html" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3500));
    // 等 [data-page="playground"] 真的出现再点：reload 后 React 挂载需要时间，
    // 点早了会静默落空（截图就变成启动页），探针却不会报错——只能靠轮询。
    let clicked = false;
    for (let i = 0; i < 30; i++) {
      const ok = await cdp.eval(`(() => { const b = document.querySelector('[data-page="playground"]'); if (!b) return false; b.click(); return true; })()`);
      if (ok) { clicked = true; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!clicked) throw new Error("30 次轮询后仍未出现游乐场导航按钮");
    // 再等会话渲染出来，否则量不到气泡。
    for (let i = 0; i < 25; i++) {
      const ready = await cdp.eval(`Boolean(document.querySelector('.pg-msg.assistant .pg-bubble'))`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, 600));

    const results = {};
    for (const theme of ["light", "dark"]) {
      await cdp.eval(`(() => { localStorage.setItem("h3-theme", "${theme}"); document.documentElement.dataset.theme = "${theme}"; document.documentElement.style.colorScheme = "${theme}"; })()`);
      await new Promise((r) => setTimeout(r, 400));
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(`${OUT}/theme-${theme}.png`, Buffer.from(shot.data, "base64"));
      results[theme] = await cdp.eval(MEASURE);
    }

    let failed = 0;
    for (const [theme, rows] of Object.entries(results)) {
      console.log(`\n=== ${theme === "light" ? "浅色" : "深色"}主题 ===`);
      for (const row of rows) {
        if (row.missing) { console.log(`  – ${row.label}: 未渲染（跳过）`); continue; }
        const ok = row.ratio >= MIN_CONTRAST;
        if (!ok) failed += 1;
        console.log(`  ${ok ? "OK" : "!!"} ${row.label}: ${row.ratio}:1  (${row.fg} on ${row.bg})`);
      }
    }
    console.log(`\n对比度门槛 ${MIN_CONTRAST}:1 — ${failed === 0 ? "全部通过" : `${failed} 项未达标`}`);
    if (failed > 0) process.exitCode = 1;
  });
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
