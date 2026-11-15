import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, mathmlToStructure, parseTeX, normalizeTextAlternative, parseSymbols, compareStructures, structureToString } from '../src/structure.mjs';

const FLOW_MARKUP = '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mfrac><msup><mi>x</mi><mn>2</mn></msup><mi>t</mi></mfrac><annotation encoding="application/x-tex">x^2/t</annotation></semantics></math>';
const PRESSURE_MARKUP = '<math><msub><mi>x</mi><mn>0</mn></msub></math>';

const FLOW_STRUCTURE = {
  node: 'fraction',
  numerator: { node: 'superscript', base: { node: 'identifier', text: 'x' }, superscript: { node: 'number', text: '2' } },
  denominator: { node: 'identifier', text: 't' }
};

test('MathML 分式与上下标保留结构，注解不混入渲染结构', () => {
  assert.deepEqual(mathmlToStructure(FLOW_MARKUP), FLOW_STRUCTURE);
  assert.deepEqual(mathmlToStructure(PRESSURE_MARKUP), {
    node: 'subscript', base: { node: 'identifier', text: 'x' }, subscript: { node: 'number', text: '0' }
  });
});

test('XML 解析拒绝畸形输入，不静默猜结构', () => {
  assert.throws(() => parseXml('<mfrac><mi>x</mi>'), /未闭合/);
  assert.throws(() => parseXml('<a></b>'), /不匹配/);
  assert.throws(() => parseXml(''), /为空/);
  assert.throws(() => mathmlToStructure('<div>没有公式</div>'), /math/);
});

test('TeX 子集解析与 MathML 结构对齐，斜杠按分式解读', () => {
  assert.deepEqual(parseTeX('x^2/t'), FLOW_STRUCTURE);
  assert.deepEqual(parseTeX('\\frac{x^2}{t}'), FLOW_STRUCTURE);
  assert.deepEqual(parseTeX('x_0'), { node: 'subscript', base: { node: 'identifier', text: 'x' }, subscript: { node: 'number', text: '0' } });
  assert.deepEqual(parseTeX('x/t^2'), {
    node: 'fraction',
    numerator: { node: 'identifier', text: 'x' },
    denominator: { node: 'superscript', base: { node: 'identifier', text: 't' }, superscript: { node: 'number', text: '2' } }
  });
});

test('TeX 超出文法抛错，交由采集方标记待确认', () => {
  assert.throws(() => parseTeX('x^'), /意外结束/);
  assert.throws(() => parseTeX(''), /为空/);
  assert.throws(() => parseTeX('x @ y'), /无法识别/);
});

test('中文文字替代只规范化可识别子集，其余返回 null 不猜', () => {
  assert.deepEqual(normalizeTextAlternative('x平方除以t'), FLOW_STRUCTURE);
  assert.deepEqual(normalizeTextAlternative('x除以t'), {
    node: 'fraction', numerator: { node: 'identifier', text: 'x' }, denominator: { node: 'identifier', text: 't' }
  });
  assert.equal(normalizeTextAlternative('这是一个无法核对的自然语言描述'), null);
  assert.equal(normalizeTextAlternative(''), null);
});

test('符号说明按卡片原文解析，未识别片段保留待查', () => {
  const flow = parseSymbols('x 为体积，t 为时间');
  assert.deepEqual(flow.symbols, [
    { symbol: 'x', meaning: '体积', raw: 'x 为体积' },
    { symbol: 't', meaning: '时间', raw: 't 为时间' }
  ]);
  assert.deepEqual(flow.unparsed, []);
  const broken = parseSymbols('某段无法解析的说明');
  assert.deepEqual(broken.symbols, []);
  assert.deepEqual(broken.unparsed, ['某段无法解析的说明']);
});

test('结构比对给出差异路径，双方原样保留', () => {
  const annotation = parseTeX('x/t');
  const diffs = compareStructures(FLOW_STRUCTURE, annotation);
  assert.deepEqual(diffs, [{ path: 'numerator', a: 'x^2', b: 'x' }]);
  assert.deepEqual(compareStructures(FLOW_STRUCTURE, parseTeX('x^2/t')), []);
});

test('结构显示不求值不化简，只还原层级', () => {
  assert.equal(structureToString(FLOW_STRUCTURE), 'x^2/t');
  assert.equal(structureToString(parseTeX('x/t^2')), 'x/t^2');
  assert.equal(structureToString(parseTeX('(a+b)/c')), '(a + b)/c');
});
