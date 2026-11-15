import test from 'node:test';
import assert from 'node:assert/strict';
import { settleSnapshots, buildRecord, buildCards, snapshotsEqual } from '../src/cards.mjs';

const noWait = async () => {};

function rawPage({ markup = '<math><mfrac><msup><mi>x</mi><mn>2</mn></msup><mi>t</mi></mfrac></math>', annotation = null, alternative = null, symbols = ['x 为体积，t 为时间'], conditions = ['仅适用于稳定流'] } = {}) {
  return {
    cards: [{
      card: 'flow',
      title: '流量换算',
      order: 0,
      selector: 'main > section[data-card="flow"]',
      symbols,
      conditions: conditions.map((text) => ({ text, selector: 'p.condition' })),
      alternatives: alternative ? [{ text: alternative, hidden: true, selector: 'span.alternative' }] : [],
      formulas: [{ selector: 'section[data-card="flow"] math', markup, annotations: annotation ? [{ encoding: 'application/x-tex', text: annotation, selector: 'annotation' }] : [] }]
    }]
  };
}

test('稳定窗口：首次一致即确认，无被替换快照', async () => {
  const page = rawPage();
  const snapshots = [page, page];
  const result = await settleSnapshots(async () => snapshots.shift() ?? page, { wait: noWait });
  assert.equal(result.status, 'stable');
  assert.equal(result.superseded.length, 0);
  assert.equal(result.attempts, 2);
});

test('稳定窗口：中途变化时旧快照记入 superseded，最终确认新结构', async () => {
  const before = rawPage();
  const after = rawPage({ markup: '<math><mfrac><mi>q</mi><msup><mi>t</mi><mn>2</mn></msup></mfrac></math>' });
  const snapshots = [before, after, after];
  const result = await settleSnapshots(async () => snapshots.shift() ?? after, { wait: noWait });
  assert.equal(result.status, 'stable');
  assert.equal(result.superseded.length, 1);
  assert.equal(result.superseded[0], before);
  assert.equal(result.snapshot, after);
});

test('稳定窗口：持续变化达到上限则整体待确认', async () => {
  let counter = 0;
  const result = await settleSnapshots(async () => rawPage({ markup: `<math><mi>v${counter++}</mi></math>` }), { wait: noWait, maxAttempts: 2 });
  assert.equal(result.status, 'unstable');
  assert.equal(result.superseded.length, 2);
});

test('单次快照记录：全部表达待确认并给出原因', () => {
  const record = buildRecord({ source: 'http://127.0.0.1:1', raw: rawPage(), capture: { status: 'single-shot', attempts: 1, quietMs: 0, superseded: [] } });
  for (const card of record.cards) {
    for (const formula of card.formulas) {
      for (const expression of formula.expressions) {
        assert.equal(expression.confirmation, 'unconfirmed');
        assert.match(expression.confirmationReason, /稳定窗口/);
      }
    }
  }
});

test('稳定记录：多表达分组到同一公式，一致时不标冲突', () => {
  const record = buildRecord({
    source: 'http://127.0.0.1:1',
    raw: rawPage({ annotation: 'x^2/t', alternative: 'x平方除以t' }),
    capture: { status: 'stable', attempts: 2, quietMs: 200, superseded: [] }
  });
  const formula = record.cards[0].formulas[0];
  assert.equal(formula.expressions.length, 3);
  assert.deepEqual(formula.expressions.map((expression) => expression.kind), ['mathml', 'tex', 'text']);
  assert.equal(formula.consistency.status, 'consistent');
  for (const expression of formula.expressions) assert.equal(expression.confirmation, 'settled');
});

test('注解与结构不一致：两份表达都保留为冲突，不选较长者', () => {
  const record = buildRecord({
    source: 'http://127.0.0.1:1',
    raw: rawPage({ annotation: 'x/t' }),
    capture: { status: 'stable', attempts: 2, quietMs: 200, superseded: [] }
  });
  const formula = record.cards[0].formulas[0];
  assert.equal(formula.consistency.status, 'conflict');
  assert.deepEqual(formula.consistency.conflicts.map((entry) => entry.path), ['numerator']);
  const tex = formula.expressions.find((expression) => expression.kind === 'tex');
  assert.equal(tex.text, 'x/t');
  assert.equal(tex.structureText, 'x/t');
  const mathml = formula.expressions.find((expression) => expression.kind === 'mathml');
  assert.equal(mathml.structureText, 'x^2/t');
});

test('无法核对的文字替代标记待确认，原文保留', () => {
  const record = buildRecord({
    source: 'http://127.0.0.1:1',
    raw: rawPage({ alternative: '一段无法核对的自然语言' }),
    capture: { status: 'stable', attempts: 2, quietMs: 200, superseded: [] }
  });
  const formula = record.cards[0].formulas[0];
  assert.equal(formula.consistency.status, 'pending');
  const text = formula.expressions.find((expression) => expression.kind === 'text');
  assert.equal(text.text, '一段无法核对的自然语言');
  assert.equal(text.structure, null);
});

test('卡片含多个公式时文字替代不猜归属', () => {
  const raw = rawPage({ alternative: 'x平方除以t' });
  raw.cards[0].formulas.push({ selector: 'section math:nth-of-type(2)', markup: '<math><mi>y</mi></math>', annotations: [] });
  const record = buildRecord({ source: 'http://127.0.0.1:1', raw, capture: { status: 'stable', attempts: 2, quietMs: 200, superseded: [] } });
  const card = record.cards[0];
  assert.equal(card.unboundAlternatives.length, 1);
  assert.match(card.unboundAlternatives[0].reason, /归属待确认/);
  assert.equal(card.formulas[0].expressions.length, 1);
});

test('被替换快照摘要保留旧结构证据', () => {
  const before = rawPage();
  const record = buildRecord({
    source: 'http://127.0.0.1:1',
    raw: rawPage({ markup: '<math><mfrac><mi>q</mi><msup><mi>t</mi><mn>2</mn></msup></mfrac></math>' }),
    capture: { status: 'stable', attempts: 3, quietMs: 200, superseded: [before] }
  });
  assert.equal(record.capture.superseded.length, 1);
  assert.equal(record.capture.superseded[0].replacedStructure, 'x^2/t');
  assert.equal(record.cards[0].formulas[0].expressions[0].structureText, 'q/t^2');
});

test('每个表达都带原文位置证据', () => {
  const record = buildRecord({
    source: 'http://127.0.0.1:1',
    raw: rawPage({ annotation: 'x^2/t', alternative: 'x平方除以t' }),
    capture: { status: 'stable', attempts: 2, quietMs: 200, superseded: [] }
  });
  const formula = record.cards[0].formulas[0];
  for (const expression of formula.expressions) {
    assert.ok(expression.evidence.binding);
    assert.ok(expression.evidence.selector);
  }
  assert.match(formula.expressions[1].evidence.binding, /semantics/);
  assert.match(formula.expressions[2].evidence.binding, /隐藏文字替代/);
});

test('快照相等性判断', () => {
  const a = rawPage();
  assert.ok(snapshotsEqual(a, structuredClone(a)));
  assert.ok(!snapshotsEqual(a, rawPage({ markup: '<math><mi>y</mi></math>' })));
});

test('buildCards 保留卡片符号与条件的作用域归属', () => {
  const raw = rawPage();
  raw.cards.push({
    card: 'pressure', title: '压强换算', order: 1, selector: 'section[data-card="pressure"]',
    symbols: ['x 为压强'], conditions: [], alternatives: [],
    formulas: [{ selector: 'section[data-card="pressure"] math', markup: '<math><msub><mi>x</mi><mn>0</mn></msub></math>', annotations: [] }]
  });
  const cards = buildCards(raw);
  assert.deepEqual(cards[0].symbols.map((s) => s.symbol), ['x', 't']);
  assert.deepEqual(cards[1].symbols.map((s) => s.symbol), ['x']);
  assert.equal(cards[0].conditions.length, 1);
  assert.equal(cards[1].conditions.length, 0);
});
