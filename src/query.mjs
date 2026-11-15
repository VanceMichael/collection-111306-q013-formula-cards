// 检索索引：把接收文件里的公式卡片记录展开成可检索条目。
// 每条条目都带来源回查信息（接收修订号、来源地址、原文选择器、证据），
// 符号一律按 formulaIdentity(卡片, 符号) 区分作用域，不按名字合并。
import { formulaIdentity } from './domain.mjs';
import { structureToString } from './structure.mjs';

function walkStructure(node, path, visit) {
  if (!node) return;
  visit(node, path);
  const descend = (child, part) => walkStructure(child, path ? `${path}/${part}` : part, visit);
  switch (node.node) {
    case 'fraction':
      descend(node.numerator, 'numerator');
      descend(node.denominator, 'denominator');
      break;
    case 'superscript':
      descend(node.base, 'base');
      descend(node.superscript, 'superscript');
      break;
    case 'subscript':
      descend(node.base, 'base');
      descend(node.subscript, 'subscript');
      break;
    case 'subsuperscript':
      descend(node.base, 'base');
      descend(node.subscript, 'subscript');
      descend(node.superscript, 'superscript');
      break;
    case 'radical':
      if (node.index) descend(node.index, 'index');
      descend(node.inner, 'inner');
      break;
    case 'delimited':
      descend(node.inner, 'inner');
      break;
    case 'row':
      node.children.forEach((child, index) => descend(child, `children[${index}]`));
      break;
    default:
      break;
  }
}

export function indexRecords(records) {
  const index = { fractions: [], scripts: [], symbols: [], conditions: [], conflicts: [], pending: [], superseded: [], textPreviews: [] };
  records.forEach((record, offset) => {
    const revision = offset + 1;
    const origin = { revision, at: record.at ?? null, source: record.source ?? null };
    if (record.kind === 'text-preview') {
      index.textPreviews.push({ ...origin, cards: record.cards ?? [] });
      return;
    }
    if (record.kind !== 'formula-cards') return;
    for (const replaced of record.capture?.superseded ?? []) index.superseded.push({ ...origin, ...replaced });
    for (const card of record.cards ?? []) {
      for (const symbol of card.symbols ?? []) {
        index.symbols.push({ ...origin, scope: formulaIdentity(card.card, symbol.symbol), card: card.card, ...symbol });
      }
      for (const condition of card.conditions ?? []) index.conditions.push({ ...origin, card: card.card, ...condition });
      for (const unbound of card.unboundAlternatives ?? []) {
        index.pending.push({ ...origin, card: card.card, category: '归属核对', expression: 'text', reason: unbound.reason, evidence: unbound.evidence });
      }
      for (const formula of card.formulas ?? []) {
        const location = { card: card.card, formula: formula.id, selector: formula.selector };
        for (const expression of formula.expressions ?? []) {
          if (expression.confirmation && expression.confirmation !== 'settled') {
            index.pending.push({
              ...origin, ...location,
              category: '采集确认',
              expression: expression.kind,
              reason: expression.confirmationReason ?? expression.confirmation,
              evidence: expression.evidence
            });
          }
          if (!expression.structure) continue;
          walkStructure(expression.structure, '', (node, path) => {
            if (node.node === 'fraction') {
              index.fractions.push({
                ...origin, ...location,
                expression: expression.kind,
                path,
                numerator: structureToString(node.numerator),
                denominator: structureToString(node.denominator),
                confirmation: expression.confirmation,
                evidence: expression.evidence
              });
            }
            if (node.node === 'superscript' || node.node === 'subscript') {
              index.scripts.push({
                ...origin, ...location,
                expression: expression.kind,
                path,
                kind: node.node === 'superscript' ? '上标' : '下标',
                base: structureToString(node.base),
                script: structureToString(node.superscript ?? node.subscript),
                confirmation: expression.confirmation,
                evidence: expression.evidence
              });
            }
          });
        }
        for (const conflict of formula.consistency?.conflicts ?? []) index.conflicts.push({ ...origin, ...location, ...conflict });
        for (const pending of formula.consistency?.pending ?? []) index.pending.push({ ...origin, ...location, category: '表达核对', ...pending });
      }
    }
  });
  return index;
}

// 按符号名检索：返回各卡片作用域的独立条目，调用方自行区分 scope，不做合并。
export function findSymbol(index, name) {
  return index.symbols.filter((entry) => entry.symbol === name);
}

export function findFractions(index, { card, numerator, denominator } = {}) {
  return index.fractions.filter((entry) =>
    (card === undefined || entry.card === card) &&
    (numerator === undefined || entry.numerator === numerator) &&
    (denominator === undefined || entry.denominator === denominator));
}

export function findScripts(index, { card, kind } = {}) {
  return index.scripts.filter((entry) =>
    (card === undefined || entry.card === card) &&
    (kind === undefined || entry.kind === kind));
}

export function findConditions(index, card) {
  return index.conditions.filter((entry) => card === undefined || entry.card === card);
}

export function findConflicts(index, { card } = {}) {
  return index.conflicts.filter((entry) => card === undefined || entry.card === card);
}

export function findPending(index, { card } = {}) {
  return index.pending.filter((entry) => card === undefined || entry.card === card);
}

// 来源回查：从任意索引条目还原其出处链；表达级证据（如注解元素自身）优先于公式级位置。
export function describeOrigin(entry) {
  return {
    接收修订: entry.revision,
    采集时间: entry.at,
    来源地址: entry.source,
    卡片: entry.card ?? null,
    公式: entry.formula ?? null,
    原文选择器: entry.evidence?.selector ?? entry.selector ?? null,
    表达证据: entry.evidence?.binding ?? null
  };
}
