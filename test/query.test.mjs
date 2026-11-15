import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/cards.mjs';
import { indexRecords, findSymbol, findFractions, findScripts, findConditions, findConflicts, findPending, describeOrigin } from '../src/query.mjs';
import { formulaIdentity } from '../src/domain.mjs';

function makeRecord({ annotation = 'x^2/t', alternative = 'x平方除以t', status = 'stable', source = 'http://127.0.0.1:9' } = {}) {
  const raw = {
    cards: [
      {
        card: 'flow', title: '流量换算', order: 0, selector: 'main > section[data-card="flow"]',
        symbols: ['x 为体积，t 为时间'],
        conditions: [{ text: '仅适用于稳定流', selector: 'section[data-card="flow"] p.condition' }],
        alternatives: [{ text: alternative, hidden: true, selector: 'span.alternative' }],
        formulas: [{
          selector: 'section[data-card="flow"] math',
          markup: '<math><semantics><mfrac><msup><mi>x</mi><mn>2</mn></msup><mi>t</mi></mfrac><annotation encoding="application/x-tex">' + annotation + '</annotation></semantics></math>',
          annotations: [{ encoding: 'application/x-tex', text: annotation, selector: 'annotation' }]
        }]
      },
      {
        card: 'pressure', title: '压强换算', order: 1, selector: 'main > section[data-card="pressure"]',
        symbols: ['x 为压强'], conditions: [], alternatives: [],
        formulas: [{ selector: 'section[data-card="pressure"] math', markup: '<math><msub><mi>x</mi><mn>0</mn></msub></math>', annotations: [] }]
      }
    ]
  };
  return buildRecord({ source, raw, capture: { status, attempts: status === 'stable' ? 2 : 1, quietMs: 200, superseded: [] } });
}

test('索引可按分式、上下标与条件关系检索，条目带来源', () => {
  const index = indexRecords([makeRecord()]);
  const fractions = findFractions(index, { card: 'flow', denominator: 't' });
  assert.ok(fractions.length >= 1);
  assert.ok(fractions.every((entry) => entry.numerator === 'x^2'));
  assert.ok(fractions[0].selector.includes('flow'));
  assert.equal(fractions[0].revision, 1);
  assert.equal(fractions[0].source, 'http://127.0.0.1:9');

  const scripts = findScripts(index, { kind: '下标' });
  assert.deepEqual(scripts.map((entry) => [entry.base, entry.script]), [['x', '0']]);

  assert.deepEqual(findConditions(index, 'flow').map((entry) => entry.text), ['仅适用于稳定流']);
  assert.equal(findConditions(index, 'pressure').length, 0);
});

test('同名符号按卡片作用域独立，不按名字合并', () => {
  const index = indexRecords([makeRecord()]);
  const entries = findSymbol(index, 'x');
  const scopes = new Set(entries.map((entry) => entry.scope));
  assert.equal(scopes.size, 2);
  assert.ok(scopes.has(formulaIdentity('flow', 'x')));
  assert.ok(scopes.has(formulaIdentity('pressure', 'x')));
  const meanings = Object.fromEntries(entries.map((entry) => [entry.card, entry.meaning]));
  assert.deepEqual(meanings, { flow: '体积', pressure: '压强' });
});

test('冲突与待确认均可检索，且能来源回查', () => {
  const conflicting = makeRecord({ annotation: 'x/t' });
  const unconfirmed = makeRecord({ status: 'single-shot' });
  const index = indexRecords([conflicting, unconfirmed]);

  const conflicts = findConflicts(index, { card: 'flow' });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'numerator');
  assert.equal(conflicts[0].rendered, 'x^2');
  assert.equal(conflicts[0].actual, 'x');
  const origin = describeOrigin(conflicts[0]);
  assert.equal(origin.接收修订, 1);
  assert.equal(origin.卡片, 'flow');
  assert.match(origin.原文选择器, /annotation/);
  assert.match(origin.表达证据, /semantics/);

  const pending = findPending(index);
  assert.ok(pending.some((entry) => entry.revision === 2 && entry.category === '采集确认' && /稳定窗口/.test(entry.reason)));
});

test('纯文本预览记录进入索引但不混入公式条目', () => {
  const textRecord = { kind: 'text-preview', at: new Date().toISOString(), source: 'http://127.0.0.1:9', preview: { mode: 'text-preview' }, cards: [{ card: 'flow', text: '流量换算' }] };
  const index = indexRecords([makeRecord(), textRecord]);
  assert.equal(index.textPreviews.length, 1);
  assert.equal(index.textPreviews[0].revision, 2);
  assert.ok(index.fractions.every((entry) => entry.revision === 1));
});

test('被替换的旧表达可检索，确认结果中无混合分式', () => {
  const before = {
    cards: [{
      card: 'flow', title: '流量换算', order: 0, selector: 's', symbols: [], conditions: [], alternatives: [],
      formulas: [{ selector: 'm', markup: '<math><mfrac><msup><mi>x</mi><mn>2</mn></msup><mi>t</mi></mfrac></math>', annotations: [] }]
    }]
  };
  const after = {
    cards: [{
      card: 'flow', title: '流量换算', order: 0, selector: 's', symbols: [], conditions: [], alternatives: [],
      formulas: [{ selector: 'm', markup: '<math><mfrac><mi>q</mi><msup><mi>t</mi><mn>2</mn></msup></mfrac></math>', annotations: [] }]
    }]
  };
  const record = buildRecord({ source: 'http://127.0.0.1:9', raw: after, capture: { status: 'stable', attempts: 3, quietMs: 200, superseded: [before] } });
  const index = indexRecords([record]);
  assert.deepEqual(index.superseded.map((entry) => entry.replacedStructure), ['x^2/t']);
  const fractions = findFractions(index, { card: 'flow' });
  assert.deepEqual(fractions.map((entry) => [entry.numerator, entry.denominator]), [['q', 't^2']]);
});
