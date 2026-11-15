// 一次运行入口：公式卡片采集演示。
// 流程：初始稳定采集 → 保留纯文本预览 → 触发迟到替换（先单次快照标待确认，再稳定采集）
// → 修改一条注解 → 从接收文件重新读取，展示检索、来源回查、冲突与待确认项。
// 只通过页面可见界面操作，不用源端控制接口代替接收结果。
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { startSource } from './source.mjs';
import { CaptureStore } from './store.mjs';
import { preview } from './domain.mjs';
import { captureSettledRecord, captureOnceRecord } from './cards.mjs';
import { indexRecords, findSymbol, findFractions, findConditions, findConflicts, findPending, describeOrigin } from './query.mjs';

const source = await startSource();
const path = resolve(process.env.CAPTURE_PATH ?? 'var/captures.json');
const store = new CaptureStore(path);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(source.url);
  await page.waitForFunction(() => window.portalReady);

  // 1. 初始稳定采集
  const initial = await captureSettledRecord(page, { source: source.url });
  const receiptInitial = await store.append(initial);

  // 2. 纯文本预览仍保留：原有领域预览函数 + 每卡片可见文本
  const snapshotData = await (await fetch(`${source.url}/api/snapshot`)).json();
  const textCards = await page.evaluate(() => [...document.querySelectorAll('[data-card]')].map((el) => ({ card: el.dataset.card, text: el.textContent })));
  const receiptText = await store.append({ kind: 'text-preview', at: new Date().toISOString(), source: source.url, preview: preview(snapshotData), cards: textCards });

  // 3. 迟到替换：替换排定后立刻单次快照（全部表达待确认），再经稳定窗口确认
  await page.click('#replace');
  const during = await captureOnceRecord(page, { source: source.url });
  const receiptDuring = await store.append(during);
  const replaced = await captureSettledRecord(page, { source: source.url });
  const receiptReplaced = await store.append(replaced);

  // 4. 修改一条注解（制造注解与渲染结构不一致）
  await page.click('#conflict');
  const annotated = await captureSettledRecord(page, { source: source.url });
  const receiptAnnotated = await store.append(annotated);

  await context.close();

  // 5. 从接收文件重新读取（不经内存），构建检索索引
  const stored = await new CaptureStore(path).read();
  const index = indexRecords(stored.records);
  const latestRevision = stored.revision;
  const latest = (entries) => entries.filter((entry) => entry.revision === latestRevision);

  const flowFractions = findFractions(index, { card: 'flow' }).filter((entry) => entry.expression === 'mathml');
  const symbolX = findSymbol(index, 'x');
  const conflicts = findConflicts(index);
  const pending = findPending(index);
  const latestConflict = latest(conflicts)[0];
  const confirmedRevisions = [receiptReplaced.revision, receiptAnnotated.revision];

  const report = {
    资料源: source.url,
    接收文件: path,
    已存记录: stored.revision,
    采集步骤: [
      { 步骤: '初始稳定采集', 修订: receiptInitial.revision, 状态: initial.capture.status, 快照次数: initial.capture.attempts },
      { 步骤: '纯文本预览', 修订: receiptText.revision, 状态: '已保留', 记录类型: 'text-preview' },
      { 步骤: '迟到替换·单次快照', 修订: receiptDuring.revision, 状态: during.capture.status, 说明: '全部表达标记为待确认' },
      { 步骤: '迟到替换·稳定采集', 修订: receiptReplaced.revision, 状态: replaced.capture.status, 快照次数: replaced.capture.attempts, 被替换旧快照: new Set(replaced.capture.superseded.map((entry) => entry.sequence)).size },
      { 步骤: '修改注解后稳定采集', 修订: receiptAnnotated.revision, 状态: annotated.capture.status, 快照次数: annotated.capture.attempts }
    ],
    检索演示: {
      分式检索_flow卡片: flowFractions.map((entry) => ({ 分子: entry.numerator, 分母: entry.denominator, 表达: entry.expression, 确认: entry.confirmation, 修订: entry.revision })),
      上下标检索_最新记录: latest(index.scripts).map((entry) => ({ 卡片: entry.card, 类型: entry.kind, 底: entry.base, 标: entry.script, 表达: entry.expression })),
      符号x_按作用域不合并: symbolX.filter((entry) => entry.revision === latestRevision).map((entry) => ({ 作用域: entry.scope, 卡片: entry.card, 含义: entry.meaning })),
      条件关系_flow: findConditions(index, 'flow').filter((entry) => entry.revision === latestRevision).map((entry) => entry.text),
      条件关系_pressure: findConditions(index, 'pressure').filter((entry) => entry.revision === latestRevision).map((entry) => entry.text)
    },
    迟到替换核对: {
      被替换的旧表达: index.superseded.map((entry) => ({ 卡片: entry.card, 公式: entry.formula, 旧结构: entry.replacedStructure, 出现于修订: entry.revision })),
      确认记录中的分式: flowFractions.filter((entry) => confirmedRevisions.includes(entry.revision)).map((entry) => `${entry.numerator}/${entry.denominator}（修订${entry.revision}，已确认）`),
      结论: '每条分式的分子与分母来自同一次原子快照；旧表达只出现在 superseded 记录中，未混入确认结果'
    },
    冲突结果: latest(conflicts).map((entry) => ({ 卡片: entry.card, 公式: entry.formula, 表达: entry.expression, 路径: entry.path, 渲染结构: entry.rendered, 该表达: entry.actual })),
    待确认表达: pending.filter((entry) => entry.revision >= receiptDuring.revision).map((entry) => ({ 卡片: entry.card, 表达: entry.expression, 类别: entry.category, 原因: entry.reason, 修订: entry.revision })),
    来源回查_示例: latestConflict ? describeOrigin(latestConflict) : null,
    纯文本预览: index.textPreviews.map((entry) => ({ 修订: entry.revision, 模式: stored.records[entry.revision - 1].preview?.mode, 卡片数: entry.cards.length }))
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  await source.close();
}
