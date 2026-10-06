// 测试 01：启动 → 六个页面导航 → 每页关键元素断言
import { withApp } from "./driver.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`); };

await withApp({}, async (cdp) => {
  // 就绪检测页
  check("就绪检测-品牌标题", await cdp.eval(`document.querySelector('.brand strong')?.textContent === 'MiniMax H3'`));
  check("就绪检测-开始检测按钮", await cdp.eval(`Boolean(document.querySelector('.hero .primary'))`));
  // 导航含游乐场
  const navIds = await cdp.eval(`Array.from(document.querySelectorAll('nav button')).map(b => b.dataset.page)`);
  check("导航含六页(含游乐场)", JSON.stringify(navIds) === JSON.stringify(["ready","studio","playground","downloads","guide","connections"]), navIds.join(","));
  // 生成工作台
  await cdp.eval(`document.querySelector('[data-page="studio"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  check("工作台-后端下拉含 rb", await cdp.eval(`Array.from(document.querySelectorAll('select option')).some(o => o.value === 'rb')`));
  check("工作台-结果数量下拉", await cdp.eval(`Array.from(document.querySelectorAll('select option')).some(o => o.textContent === '1 路')`));
  check("工作台-默认四宫格", await cdp.eval(`document.querySelectorAll('.result-grid .task-card').length === 4`));
  // 切 1 路验证 single 类
  await cdp.eval(`(() => { const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.textContent === '1 路')); sel.value = '1'; sel.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await new Promise(r => setTimeout(r, 300));
  check("工作台-1路占满(single类)", await cdp.eval(`Boolean(document.querySelector('.result-grid.single')) && document.querySelectorAll('.result-grid .task-card').length === 1`));
  // 切回 4 路
  await cdp.eval(`(() => { const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.textContent === '1 路')); sel.value = '4'; sel.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  // RB 后端预设切换
  await cdp.eval(`(() => { const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'rb')); sel.value = 'rb'; sel.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await new Promise(r => setTimeout(r, 300));
  check("RB-预设标签五个", await cdp.eval(`document.querySelectorAll('.mode-tabs button').length === 5`));
  check("RB-默认贴合参考图", await cdp.eval(`document.querySelector('.mode-tabs button.active')?.textContent === '贴合参考图'`));
  // easy_15 切换：时长锁定 15
  await cdp.eval(`Array.from(document.querySelectorAll('.mode-tabs button')).find(b => b.textContent === '15 秒').click()`);
  await new Promise(r => setTimeout(r, 300));
  check("RB-easy15时长选项仅15", await cdp.eval(`Boolean(Array.from(document.querySelectorAll('select')).find(s => s.value === '15'))`));
  // flashvsr：提示词隐藏、源视频上传出现
  await cdp.eval(`Array.from(document.querySelectorAll('.mode-tabs button')).find(b => b.textContent === '视频变清晰').click()`);
  await new Promise(r => setTimeout(r, 300));
  check("RB-flashvsr-无提示词框", await cdp.eval(`!Array.from(document.querySelectorAll('.control-panel textarea')).some(t => (t.closest('label')?.textContent || '').includes('视频描述'))`));
  check("RB-flashvsr-源视频上传", await cdp.eval(`Array.from(document.querySelectorAll('.file-picker')).some(f => f.textContent.includes('源视频'))`));
  // 游乐场
  await cdp.eval(`document.querySelector('[data-page="playground"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  check("游乐场-空状态提示", await cdp.eval(`Boolean(document.querySelector('.pg-empty'))`));
  check("游乐场-composer存在", await cdp.eval(`Boolean(document.querySelector('.pg-input-row textarea'))`));
  check("游乐场-三个chips", await cdp.eval(`document.querySelectorAll('.pg-chip').length >= 3`));
  check("游乐场-模型徽章", await cdp.eval(`Boolean(document.querySelector('.pg-model'))`));
  // 连接设置
  await cdp.eval(`document.querySelector('[data-page="connections"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  check("连接页-六张卡片", await cdp.eval(`document.querySelectorAll('.connection-card').length === 6`));
  check("连接页-LLM测试按钮", await cdp.eval(`Array.from(document.querySelectorAll('.connection-card')).some(c => c.textContent.includes('游乐场 LLM') && c.querySelector('button.secondary'))`));
  check("连接页-获取列表按钮", await cdp.eval(`Array.from(document.querySelectorAll('.connection-card button')).some(b => b.textContent === '获取列表')`));
  // 模型下载页
  await cdp.eval(`document.querySelector('[data-page="downloads"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  check("模型下载-清单条目", await cdp.eval(`document.querySelectorAll('.download-list article').length >= 8`));
  // 配置指南
  await cdp.eval(`document.querySelector('[data-page="guide"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  check("配置指南-六卡", await cdp.eval(`document.querySelectorAll('.guide-grid article').length === 6`));
});

const failed = results.filter(r => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
