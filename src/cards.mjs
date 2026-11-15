// 公式卡片采集：把页面上的公式卡片读成结构化记录。
// 两条硬性保证：
//  1. 原子性——整张页面在一次 page.evaluate（单个 JS 任务）内读完，setTimeout 等
//     迟到替换无法插入任务之间，因此同一条分式的分子与分母永远来自同一瞬间的 DOM，
//     不会把新分子配到旧分母上。
//  2. 确认状态——单次快照只能标记为"待确认"；经过稳定窗口（两次相邻快照一致）的
//     才标记为"已确认"。窗口内被替换掉的旧快照记入 capture.superseded，不并入结果。
import { mathmlToStructure, parseTeX, normalizeTextAlternative, compareStructures, structureToString, parseSymbols } from './structure.mjs';

// 在页面上下文执行的提取函数，必须自包含（Playwright 序列化后无模块作用域）。
async function extractPage() {
  const cssPath = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      if (current.dataset && current.dataset.card) part += `[data-card="${current.dataset.card}"]`;
      else if (current.id) part += `#${current.id}`;
      else if (current.parentElement) {
        const same = [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const cards = [...document.querySelectorAll('[data-card]')].map((section, order) => ({
    card: section.dataset.card ?? '',
    title: section.querySelector('h1,h2,h3')?.textContent?.trim() ?? '',
    order,
    selector: cssPath(section),
    symbols: [...section.querySelectorAll('.symbols')].map((el) => el.textContent ?? ''),
    conditions: [...section.querySelectorAll('.condition')].map((el) => ({ text: (el.textContent ?? '').trim(), selector: cssPath(el) })),
    alternatives: [...section.querySelectorAll('.alternative')].map((el) => ({
      text: (el.textContent ?? '').trim(),
      hidden: Boolean(el.hidden) || getComputedStyle(el).display === 'none',
      selector: cssPath(el)
    })),
    formulas: [...section.querySelectorAll('math')].map((mathEl) => ({
      selector: cssPath(mathEl),
      markup: mathEl.outerHTML,
      annotations: [...mathEl.querySelectorAll('annotation')].map((annotation) => ({
        encoding: annotation.getAttribute('encoding') ?? '',
        text: annotation.textContent ?? '',
        selector: cssPath(annotation)
      }))
    }))
  }));
  return { cards };
}

// 一次原子快照：整个页面在单个 JS 任务内读取完毕。
export async function snapshotFormulaPage(page) {
  return page.evaluate(extractPage);
}

export function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 稳定窗口：相邻两次快照一致才算确认；期间被替换的旧快照记入 superseded。
// takeSnapshot 与 wait 可注入，便于用脚本化快照做确定性测试。
export async function settleSnapshots(takeSnapshot, { quietMs = 200, maxAttempts = 5, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const superseded = [];
  let current = await takeSnapshot();
  let attempts = 1;
  for (;;) {
    await wait(quietMs);
    const next = await takeSnapshot();
    attempts += 1;
    if (snapshotsEqual(current, next)) return { status: 'stable', snapshot: next, superseded, attempts, quietMs };
    superseded.push(current);
    current = next;
    if (superseded.length >= maxAttempts) return { status: 'unstable', snapshot: current, superseded, attempts, quietMs };
  }
}

function mathmlExpression(rawFormula, ctx) {
  let structure = null;
  let parseIssue;
  try { structure = mathmlToStructure(rawFormula.markup); }
  catch (error) { parseIssue = `MathML 解析失败: ${error.message}`; }
  return {
    kind: 'mathml',
    markup: rawFormula.markup,
    structure,
    structureText: structure ? structureToString(structure) : null,
    ...(parseIssue ? { parseIssue } : {}),
    confirmation: ctx.confirmation,
    ...(ctx.confirmationReason ? { confirmationReason: ctx.confirmationReason } : {}),
    evidence: { binding: '渲染结构（math 元素本身）', selector: rawFormula.selector }
  };
}

function annotationExpression(annotation, ctx) {
  const isTex = /tex|latex/i.test(annotation.encoding);
  const kind = isTex ? 'tex' : 'annotation';
  let structure = null;
  let parseIssue;
  if (isTex) {
    try { structure = parseTeX(annotation.text); }
    catch (error) { parseIssue = error.message; }
  } else {
    parseIssue = `未识别的注解编码 "${annotation.encoding || '(空)'}"，保留原文待核对`;
  }
  return {
    kind,
    encoding: annotation.encoding,
    text: annotation.text,
    structure,
    structureText: structure ? structureToString(structure) : null,
    ...(parseIssue ? { parseIssue } : {}),
    confirmation: ctx.confirmation,
    ...(ctx.confirmationReason ? { confirmationReason: ctx.confirmationReason } : {}),
    evidence: { binding: '同一 <semantics> 元素内的注解（与渲染结构同源）', selector: annotation.selector, encoding: annotation.encoding }
  };
}

function alternativeExpression(alternative, ctx) {
  const structure = normalizeTextAlternative(alternative.text);
  return {
    kind: 'text',
    text: alternative.text,
    structure,
    structureText: structure ? structureToString(structure) : null,
    ...(structure ? {} : { parseIssue: '文字替代超出可核对的中文表达子集，保留原文待核对' }),
    confirmation: ctx.confirmation,
    ...(ctx.confirmationReason ? { confirmationReason: ctx.confirmationReason } : {}),
    evidence: { binding: '同卡片内的隐藏文字替代（.alternative，非 semantics 绑定）', selector: alternative.selector, hidden: alternative.hidden }
  };
}

// 以渲染结构为基准逐一比对其它表达；不一致全部保留为冲突，不挑选任何一份。
function assessConsistency(expressions) {
  const reference = expressions.find((expression) => expression.kind === 'mathml' && expression.structure);
  const conflicts = [];
  const pending = [];
  for (const expression of expressions) {
    if (expression === reference) continue;
    if (!expression.structure) {
      pending.push({ expression: expression.kind, reason: expression.parseIssue ?? '表达无法结构化，保留原文待核对', evidence: expression.evidence });
      continue;
    }
    if (!reference) {
      pending.push({ expression: expression.kind, reason: '渲染结构不可用，无法比对', evidence: expression.evidence });
      continue;
    }
    for (const diff of compareStructures(reference.structure, expression.structure)) {
      conflicts.push({ expression: expression.kind, path: diff.path, rendered: diff.a, actual: diff.b, evidence: expression.evidence });
    }
  }
  return { status: conflicts.length ? 'conflict' : pending.length ? 'pending' : 'consistent', conflicts, pending };
}

function buildFormula(rawCard, rawFormula, index, ctx) {
  const expressions = [mathmlExpression(rawFormula, ctx)];
  for (const annotation of rawFormula.annotations ?? []) expressions.push(annotationExpression(annotation, ctx));
  return {
    id: `${rawCard.card}#math${index + 1}`,
    selector: rawFormula.selector,
    expressions
  };
}

export function buildCards(raw, ctx = { confirmation: 'settled' }) {
  return raw.cards.map((rawCard) => {
    const symbols = [];
    const unparsedSymbols = [];
    for (const text of rawCard.symbols ?? []) {
      const parsed = parseSymbols(text);
      symbols.push(...parsed.symbols);
      unparsedSymbols.push(...parsed.unparsed);
    }
    const formulas = (rawCard.formulas ?? []).map((rawFormula, index) => buildFormula(rawCard, rawFormula, index, ctx));
    const unboundAlternatives = [];
    // 文字替代不是 semantics 绑定：卡片内只有一个公式时才能归属，否则保留为待确认，不猜归属。
    for (const alternative of rawCard.alternatives ?? []) {
      if (formulas.length === 1) formulas[0].expressions.push(alternativeExpression(alternative, ctx));
      else unboundAlternatives.push({ text: alternative.text, evidence: { binding: '同卡片内的隐藏文字替代', selector: alternative.selector }, reason: `卡片含 ${formulas.length} 个公式，文字替代归属待确认` });
    }
    for (const formula of formulas) formula.consistency = assessConsistency(formula.expressions);
    return {
      card: rawCard.card,
      title: rawCard.title,
      order: rawCard.order,
      selector: rawCard.selector,
      symbols,
      unparsedSymbols,
      conditions: rawCard.conditions ?? [],
      formulas,
      unboundAlternatives
    };
  });
}

function summarizeSuperseded(rawSnapshot, sequence) {
  return rawSnapshot.cards.flatMap((card) => (card.formulas ?? []).map((formula, index) => {
    let structure = null;
    try { structure = structureToString(mathmlToStructure(formula.markup)); } catch { structure = '(无法解析)'; }
    return {
      sequence,
      card: card.card,
      formula: `${card.card}#math${index + 1}`,
      selector: formula.selector,
      replacedStructure: structure,
      annotations: (formula.annotations ?? []).map((annotation) => annotation.text)
    };
  }));
}

const CONFIRMATION = {
  stable: { confirmation: 'settled' },
  'single-shot': { confirmation: 'unconfirmed', confirmationReason: '单次快照，未经过稳定窗口核对' },
  unstable: { confirmation: 'pending', confirmationReason: '稳定窗口内渲染持续变化，表达仍待确认' }
};

export function buildRecord({ source, raw, capture }) {
  const ctx = CONFIRMATION[capture.status] ?? CONFIRMATION['single-shot'];
  return {
    kind: 'formula-cards',
    at: new Date().toISOString(),
    source,
    capture: {
      status: capture.status,
      attempts: capture.attempts ?? 1,
      quietMs: capture.quietMs ?? 0,
      superseded: (capture.superseded ?? []).flatMap((snapshot, index) => summarizeSuperseded(snapshot, index + 1))
    },
    cards: buildCards(raw, ctx)
  };
}

// 稳定采集：经过稳定窗口确认后才产出记录。
export async function captureSettledRecord(page, { source, quietMs = 200, maxAttempts = 5 } = {}) {
  const settled = await settleSnapshots(() => snapshotFormulaPage(page), { quietMs, maxAttempts, wait: (ms) => page.waitForTimeout(ms) });
  return buildRecord({ source, raw: settled.snapshot, capture: settled });
}

// 单次快照：立即返回，全部表达标记为待确认。
export async function captureOnceRecord(page, { source } = {}) {
  const raw = await snapshotFormulaPage(page);
  return buildRecord({ source, raw, capture: { status: 'single-shot', attempts: 1, quietMs: 0, superseded: [] } });
}
