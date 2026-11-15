import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startSource } from '../src/source.mjs';
import { captureSettledRecord, captureOnceRecord } from '../src/cards.mjs';
import { CaptureStore } from '../src/store.mjs';
import { indexRecords, findSymbol, findFractions, findConditions, findConflicts, findPending } from '../src/query.mjs';
import { formulaIdentity } from '../src/domain.mjs';

test('公式卡片采集：结构、作用域、冲突、迟到替换与来源回查', { timeout: 30000 }, async () => {
  const source = await startSource();
  const browser = await chromium.launch({ headless: true });
  const root = await mkdtemp(join(tmpdir(), 'formula-cards-'));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(source.url);
    await page.waitForFunction(() => window.portalReady);

    // 初始稳定采集
    const initial = await captureSettledRecord(page, { source: source.url });
    assert.equal(initial.capture.status, 'stable');
    const flow = initial.cards.find((card) => card.card === 'flow');
    const pressure = initial.cards.find((card) => card.card === 'pressure');

    // 分式与上下标保留结构
    const flowMath = flow.formulas[0].expressions.find((expression) => expression.kind === 'mathml');
    assert.deepEqual(flowMath.structure, {
      node: 'fraction',
      numerator: { node: 'superscript', base: { node: 'identifier', text: 'x' }, superscript: { node: 'number', text: '2' } },
      denominator: { node: 'identifier', text: 't' }
    });
    const pressureMath = pressure.formulas[0].expressions[0];
    assert.deepEqual(pressureMath.structure, {
      node: 'subscript', base: { node: 'identifier', text: 'x' }, subscript: { node: 'number', text: '0' }
    });

    // 同公式多表达分组不重复，且一致
    assert.deepEqual(flow.formulas[0].expressions.map((expression) => expression.kind), ['mathml', 'tex', 'text']);
    assert.equal(flow.formulas[0].consistency.status, 'consistent');

    // 不同卡片同名符号独立；脚注条件只属于 flow
    assert.deepEqual(flow.symbols.map((symbol) => symbol.symbol), ['x', 't']);
    assert.deepEqual(pressure.symbols.map((symbol) => symbol.symbol), ['x']);
    assert.equal(flow.conditions.length, 1);
    assert.equal(pressure.conditions.length, 0);

    // 单次快照：全部表达待确认
    const once = await captureOnceRecord(page, { source: source.url });
    assert.equal(once.capture.status, 'single-shot');
    for (const card of once.cards) {
      for (const formula of card.formulas) {
        for (const expression of formula.expressions) assert.equal(expression.confirmation, 'unconfirmed');
      }
    }

    // 迟到替换：确认后的分式必须原子完整（q/t^2），旧注解保留为冲突
    await page.click('#replace');
    await page.waitForFunction(() => document.querySelector('mfrac').textContent === 'qt2');
    const replaced = await captureSettledRecord(page, { source: source.url });
    assert.equal(replaced.capture.status, 'stable');
    const replacedFlow = replaced.cards.find((card) => card.card === 'flow');
    const replacedMath = replacedFlow.formulas[0].expressions.find((expression) => expression.kind === 'mathml');
    assert.deepEqual(replacedMath.structure, {
      node: 'fraction',
      numerator: { node: 'identifier', text: 'q' },
      denominator: { node: 'superscript', base: { node: 'identifier', text: 't' }, superscript: { node: 'number', text: '2' } }
    });
    assert.equal(replacedFlow.formulas[0].consistency.status, 'conflict');
    const staleTex = replacedFlow.formulas[0].expressions.find((expression) => expression.kind === 'tex');
    assert.equal(staleTex.text, 'x^2/t');
    assert.ok(replacedFlow.formulas[0].consistency.conflicts.some((entry) => entry.expression === 'tex'));

    // 修改一条注解：差异保留，双方原样可查
    await page.click('#conflict');
    const annotated = await captureSettledRecord(page, { source: source.url });
    const annotatedFlow = annotated.cards.find((card) => card.card === 'flow');
    const annotatedTex = annotatedFlow.formulas[0].expressions.find((expression) => expression.kind === 'tex');
    assert.equal(annotatedTex.text, 'x/t');
    assert.equal(annotatedFlow.formulas[0].consistency.status, 'conflict');
    assert.ok(annotatedFlow.formulas[0].consistency.conflicts.some((entry) => entry.path.includes('numerator')));

    // 接收文件往返后检索
    const path = join(root, 'captures.json');
    const store = new CaptureStore(path);
    await store.append(initial);
    await store.append(once);
    await store.append(replaced);
    await store.append(annotated);
    const stored = await new CaptureStore(path).read();
    assert.equal(stored.revision, 4);
    const index = indexRecords(stored.records);

    // 同名符号两个作用域各自独立
    const scopes = new Set(findSymbol(index, 'x').map((entry) => entry.scope));
    assert.ok(scopes.has(formulaIdentity('flow', 'x')));
    assert.ok(scopes.has(formulaIdentity('pressure', 'x')));

    // 分式检索：确认记录中只有 x^2/t 与 q/t^2，无混合表达
    const flowFractions = findFractions(index, { card: 'flow' }).filter((entry) => entry.expression === 'mathml' && entry.confirmation === 'settled');
    assert.deepEqual(
      flowFractions.map((entry) => [entry.numerator, entry.denominator]),
      [['x^2', 't'], ['q', 't^2'], ['q', 't^2']]
    );

    // 条件只属于 flow；待确认可检索；冲突带来源
    assert.ok(findConditions(index, 'flow').length > 0);
    assert.equal(findConditions(index, 'pressure').length, 0);
    assert.ok(findPending(index).some((entry) => entry.category === '采集确认'));
    const conflicts = findConflicts(index, { card: 'flow' });
    assert.ok(conflicts.length >= 2);
    for (const conflict of conflicts) {
      assert.ok(conflict.revision >= 3);
      assert.ok(conflict.evidence.selector);
      assert.equal(conflict.source, source.url);
    }
    await context.close();
  } finally {
    await browser.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
