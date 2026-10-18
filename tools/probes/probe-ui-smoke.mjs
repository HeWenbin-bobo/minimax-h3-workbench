// UI 冒烟截图：改完界面必须看真实渲染（CSS 继承问题读代码看不出来）。
import { createServer } from "node:http";
import { withApp } from "../../.e2e/driver.mjs";
import { mkdir, writeFile } from "node:fs/promises";

const setReactInput = `(() => {
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const t = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  window.__set = (el, v) => { (el.tagName === "TEXTAREA" ? t : s).call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); };
})()`;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    if (payload.stream === false) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "非流式" } }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // 回带围栏代码块：让产物卡片与 .md-code 真的渲染出来，才能测它们的对比度。
    const chunks = ["好的，", "这是", "示例：\n\n", "```csv\n", "城市,价格\n", "北京,120\n", "```\n\n", "```js\n", "const a = 1;\n", "console.log(a);\n", "```\n"];
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(18925, "127.0.0.1", r));

await mkdir("F:/MinimaxH3/_scratch/results", { recursive: true });

await withApp({}, async (cdp) => {
  await cdp.eval(`localStorage.removeItem('h3-playground-sessions')`);
  await cdp.send("Page.reload");
  await new Promise((r) => setTimeout(r, 2000));

  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  await cdp.eval(`(() => { ${setReactInput}
    const card = Array.from(document.querySelectorAll('.connection-card')).find(c => c.textContent.includes('游乐场 LLM'));
    window.__set(card.querySelector('input[placeholder="https://api.example.com/v1"]'), 'http://127.0.0.1:18925/v1');
    window.__set(card.querySelector('input[placeholder="deepseek-chat"]'), 'glm-5.3');
  })()`);
  await cdp.eval(`document.querySelector('.page-title .primary').click()`);
  await new Promise((r) => setTimeout(r, 700));

  // 造三个会话（含一个分类组）以验证分组侧栏
  await cdp.eval(`(() => {
    const now = new Date().toISOString();
    const mk = (id, title, category, n) => ({
      id, title, createdAt: now, updatedAt: now, category,
      messages: Array.from({ length: n }, (_, i) => ({ id: id + '-m' + i, role: i % 2 ? 'assistant' : 'user', content: '示例消息 ' + i }))
    });
    localStorage.setItem('h3-playground-sessions', JSON.stringify([
      mk('s1', '玻璃球产品视频', '工作', 4),
      mk('s2', '粒子环绕 8 秒版', '工作', 2),
      mk('s3', '随便聊聊', undefined, 2)
    ]));
  })()`);
  await cdp.send("Page.reload");
  await new Promise((r) => setTimeout(r, 2000));
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await new Promise((r) => setTimeout(r, 600));

  await cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), '帮我做一段 8 秒的科技感视频'); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise((r) => setTimeout(r, 3000));

  const shot = async (file) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(`F:/MinimaxH3/_scratch/results/${file}`, Buffer.from(data, "base64"));
    console.log("wrote", file);
  };

  await shot("ui-v5-collapsed.png");
  await cdp.eval(`document.querySelector('.pg-runs-head').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await shot("ui-v5-runs-open.png");

  // 产物卡片 / 代码块：真实渲染下测前后景对比度，不靠肉眼判断"看不清"。
  await cdp.eval(`(() => { ${setReactInput}; window.__set(document.querySelector('.pg-input-row textarea'), '再给我一段代码示例'); })()`);
  await cdp.eval(`document.querySelector('.pg-input-row .primary').click()`);
  await new Promise((r) => setTimeout(r, 2500));

  const contrast = await cdp.eval(`(() => {
    const lum = (c) => { const p = c.match(/\\d+/g).slice(0,3).map(Number).map((v) => { const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); }); return 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]; };
    const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return +(((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toFixed(2)); };
    // **背景要一路向上找到真正不透明的祖先**：只查一级时，中间层若也是
    // rgba(0,0,0,0) 就会拿"透明黑"当底色算——实测产物卡片小字因此被算成 3.55:1
    // （真实值 #5c656f on #f7f8fa = 5.57:1，本达标），属于探针自身的假告警。
    const effectiveBg = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      }
      return getComputedStyle(document.body).backgroundColor || 'rgb(255, 255, 255)';
    };
    const probe = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el);
      // **渐变背景不能按 background-color 算**：用户气泡的底色来自
      // 背景图用了 brand-gradient 变量，而 background-color 一路透明到
      // body 的白色——直接算会得到「白字白底 1:1」的假告警。
      // 这里标注出来交给 probe-codex-ui.mjs（它按渐变端点色实测，气泡为 4.71:1）。
      const gradientEl = (() => { for (let n = el; n; n = n.parentElement) { if (getComputedStyle(n).backgroundImage !== 'none') return n; } return null; })();
      if (gradientEl) return { bg: 'gradient', fg: cs.color, ratio: null, note: '渐变底，由 probe-codex-ui 实测' };
      const bg = effectiveBg(el);
      return { bg, fg: cs.color, ratio: ratio(cs.color, bg) }; };
    return JSON.stringify({ artifactCard: probe('.pg-artifact-card'), artifactSmall: probe('.pg-artifact-name small'), codeBlock: probe('.md-code'), bubble: probe('.pg-bubble') });
  })()`);
  console.log("CONTRAST", contrast);

  const metrics = await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const cs = (el) => el ? getComputedStyle(el) : null;
    const rect = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
    const sendBtn = q('.pg-input-row .primary');
    const ta = q('.pg-input-row textarea');
    // chips 行的最大间隙：两端对齐会留出大段空白，这里量化它（VLM 对间距的判断不可靠）。
    const kids = Array.from(q('.pg-chips').children).map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.slice(0, 10), left: Math.round(r.left), right: Math.round(r.right) }; });
    let maxGap = 0, gapAt = "";
    for (let i = 1; i < kids.length; i += 1) { const g = kids[i].left - kids[i - 1].right; if (g > maxGap) { maxGap = g; gapAt = kids[i - 1].t + " → " + kids[i].t; } }
    return JSON.stringify({
      textareaW: rect(ta)?.w,
      sendBtn: rect(sendBtn),
      sendInsideRow: sendBtn ? Math.abs(sendBtn.getBoundingClientRect().bottom - ta.getBoundingClientRect().bottom) < 24 : false,
      runsH: rect(q('.pg-runs'))?.h,
      groups: document.querySelectorAll('.pg-group').length,
      groupHeads: Array.from(document.querySelectorAll('.pg-group-head')).map((e) => e.textContent),
      groupHeadBg: cs(q('.pg-group-head'))?.backgroundColor,
      groupHeadColor: cs(q('.pg-group-head'))?.color,
      sessionTimes: Array.from(document.querySelectorAll('.pg-session-time')).map((e) => e.textContent),
      sessionTimeOpacity: cs(q('.pg-session-time'))?.opacity,
      textareaAboveChips: ta && q('.pg-chips') ? ta.getBoundingClientRect().top < q('.pg-chips').getBoundingClientRect().top : null,
      textareaColor: cs(ta)?.color,
      contextChip: q('.pg-chip.ctx')?.textContent,
      maxChipGapPx: Math.round(maxGap), maxChipGapAt: gapAt,
      // 底部元素是否被"检查更新"卡片之类的东西压住（VLM 说重叠，用几何量证伪/证实）。
      overlap: (() => {
        const notice = Array.from(document.querySelectorAll('footer, .update-notice, aside, .notice'))
          .find((e) => /检查更新|v0\\.2\\.0/.test(e.textContent || ''));
        const composer = q('.pg-composer');
        if (!notice || !composer) return null;
        const a = notice.getBoundingClientRect(), b = composer.getBoundingClientRect();
        const hit = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        return { hit, notice: { l: Math.round(a.left), t: Math.round(a.top), r: Math.round(a.right), b: Math.round(a.bottom) }, composer: { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) } };
      })()
    });
  })()`);
  console.log("METRICS", metrics);
});

server.close();
