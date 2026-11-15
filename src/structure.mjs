// 公式结构解析与比对（纯函数，不依赖浏览器）。
// 约定：只把页面给出的表达解析成结构树以便核对与检索，从不求值、不做代数化简；
// 原始串始终保留在表达记录里，结构树只是核对的副产物。
//
// 结构节点形态：
//   { node: 'fraction', numerator, denominator }
//   { node: 'superscript', base, superscript }
//   { node: 'subscript', base, subscript }
//   { node: 'subsuperscript', base, subscript, superscript }
//   { node: 'radical', index: null | node, inner }
//   { node: 'delimited', open, close, inner }
//   { node: 'row', children: [...] }
//   { node: 'identifier' | 'number' | 'operator' | 'text', text }

// 显示时无需加括号的节点：上下标、根式、括号表达式自身已界定范围
const ATOMIC = new Set(['identifier', 'number', 'operator', 'text', 'superscript', 'subscript', 'subsuperscript', 'radical', 'delimited']);

// ---------- 小型 XML 解析（outerHTML 是良构 XML；只支持元素/属性/文本/注释） ----------

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

export function parseXml(markup) {
  if (typeof markup !== 'string' || !markup.trim()) throw new Error('XML 解析失败: 输入为空');
  let i = 0;
  const error = (message) => new Error(`XML 解析失败: ${message}（位置 ${i}）`);
  const skipWhitespace = () => { while (i < markup.length && /\s/.test(markup[i])) i += 1; };
  function parseNode() {
    if (markup.startsWith('<!--', i)) {
      const end = markup.indexOf('-->', i + 4);
      if (end < 0) throw error('注释未闭合');
      i = end + 3;
      return null;
    }
    if (markup.startsWith('<?', i)) {
      const end = markup.indexOf('?>', i + 2);
      if (end < 0) throw error('处理指令未闭合');
      i = end + 2;
      return null;
    }
    if (markup.startsWith('<!', i)) {
      const end = markup.indexOf('>', i + 2);
      if (end < 0) throw error('声明未闭合');
      i = end + 1;
      return null;
    }
    if (markup[i] === '<') {
      if (markup[i + 1] === '/') throw error('意外的结束标签');
      i += 1;
      const nameMatch = markup.slice(i).match(/^[A-Za-z_][\w.-]*/);
      if (!nameMatch) throw error('缺少标签名');
      const name = nameMatch[0];
      i += name.length;
      const attributes = {};
      for (;;) {
        skipWhitespace();
        if (markup[i] === '/' && markup[i + 1] === '>') { i += 2; return { type: 'element', name, attributes, children: [] }; }
        if (markup[i] === '>') { i += 1; break; }
        const attr = markup.slice(i).match(/^([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
        if (!attr) throw error(`元素 <${name}> 的属性无法解析`);
        attributes[attr[1]] = decodeEntities(attr[2] ?? attr[3] ?? '');
        i += attr[0].length;
      }
      const children = [];
      for (;;) {
        if (i >= markup.length) throw error(`元素 <${name}> 未闭合`);
        if (markup.startsWith('</', i)) {
          const close = markup.slice(i).match(/^<\/\s*([A-Za-z_][\w.-]*)\s*>/);
          if (!close) throw error('结束标签无法解析');
          if (close[1] !== name) throw error(`标签不匹配: <${name}> 与 </${close[1]}>`);
          i += close[0].length;
          return { type: 'element', name, attributes, children };
        }
        const child = parseNode();
        if (child) children.push(child);
      }
    }
    const next = markup.indexOf('<', i);
    const end = next < 0 ? markup.length : next;
    const raw = markup.slice(i, end);
    i = end;
    const text = decodeEntities(raw);
    if (!text.trim()) return null;
    return { type: 'text', text };
  }
  const roots = [];
  for (;;) {
    skipWhitespace();
    if (i >= markup.length) break;
    const node = parseNode();
    if (node) roots.push(node);
  }
  const elements = roots.filter((node) => node.type === 'element');
  if (elements.length !== 1) throw error(`应有且仅有一个根元素，实际 ${elements.length}`);
  return elements[0];
}

// ---------- MathML → 结构树 ----------

function elementChildren(element) {
  return element.children.filter((child) => child.type === 'element');
}

function textOf(element) {
  const parts = [];
  const walk = (node) => {
    if (node.type === 'text') parts.push(node.text);
    else for (const child of node.children) walk(child);
  };
  walk(element);
  return parts.join('').trim();
}

function rowOf(elements) {
  const structures = elements.map(elementToStructure).filter(Boolean);
  if (structures.length === 1) return structures[0];
  return { node: 'row', children: structures };
}

function fixedChildren(element, tag, count) {
  const children = elementChildren(element);
  if (children.length !== count) throw new Error(`<${tag}> 需要 ${count} 个子元素，实际 ${children.length}`);
  return children.map(elementToStructure);
}

function elementToStructure(element) {
  switch (element.name) {
    case 'math':
    case 'semantics':
      // semantics 的渲染内容是除 annotation 之外的子元素；注解不作为渲染结构
      return rowOf(elementChildren(element).filter((child) => child.name !== 'annotation' && child.name !== 'annotation-xml'));
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
      return rowOf(elementChildren(element));
    case 'mfrac': {
      const [numerator, denominator] = fixedChildren(element, 'mfrac', 2);
      return { node: 'fraction', numerator, denominator };
    }
    case 'msup': {
      const [base, superscript] = fixedChildren(element, 'msup', 2);
      return { node: 'superscript', base, superscript };
    }
    case 'msub': {
      const [base, subscript] = fixedChildren(element, 'msub', 2);
      return { node: 'subscript', base, subscript };
    }
    case 'msubsup': {
      const [base, subscript, superscript] = fixedChildren(element, 'msubsup', 3);
      return { node: 'subsuperscript', base, subscript, superscript };
    }
    case 'msqrt':
      return { node: 'radical', index: null, inner: rowOf(elementChildren(element)) };
    case 'mroot': {
      const [inner, index] = fixedChildren(element, 'mroot', 2);
      return { node: 'radical', index, inner };
    }
    case 'mi': return { node: 'identifier', text: textOf(element) };
    case 'mn': return { node: 'number', text: textOf(element) };
    case 'mo': return { node: 'operator', text: textOf(element) };
    case 'mtext': return { node: 'text', text: textOf(element) };
    case 'annotation':
    case 'annotation-xml':
      return null;
    default:
      // 未识别的包装元素不丢弃内容，按行展开其子树
      return rowOf(elementChildren(element));
  }
}

export function mathmlToStructure(markup) {
  const root = parseXml(markup);
  let math = root.name === 'math' ? root : null;
  if (!math) {
    const stack = [root];
    while (stack.length && !math) {
      const node = stack.pop();
      if (node.type === 'element' && node.name === 'math') math = node;
      else if (node.type === 'element') stack.push(...node.children);
    }
  }
  if (!math) throw new Error('MathML 解析失败: 找不到 <math> 元素');
  return elementToStructure(math);
}

// ---------- TeX 子集解析（仅为与渲染结构比对；原始串由调用方保留） ----------
// 支持: 标识符、数字、^、_、/、\frac{a}{b}、{...}、(...)、+ - =、\cdot、\times。
// 斜杠 a/b 按分式解读，以便与 mfrac 核对；超出文法抛错，由采集方标记为待确认。

export function parseTeX(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('TeX 解析失败: 输入为空');
  let i = 0;
  const error = (message) => new Error(`TeX 解析失败: ${message}（"${source}" 位置 ${i}）`);
  const skipWhitespace = () => { while (i < source.length && /\s/.test(source[i])) i += 1; };
  const peek = () => source[i];
  function parseExpression() {
    let acc = parseTerm();
    for (;;) {
      skipWhitespace();
      const ch = peek();
      if (ch === '/') { i += 1; acc = { node: 'fraction', numerator: acc, denominator: parseTerm() }; }
      else if (ch === '+' || ch === '-' || ch === '=') { i += 1; acc = { node: 'row', children: [acc, { node: 'operator', text: ch }, parseTerm()] }; }
      else return acc;
    }
  }
  function parseTerm() {
    const factors = [parseFactor()];
    for (;;) {
      skipWhitespace();
      const ch = peek();
      if (ch === undefined || ch === '}' || ch === ')' || ch === '/' || ch === '+' || ch === '-' || ch === '=') break;
      if (source.startsWith('\\cdot', i)) { i += 5; factors.push({ node: 'operator', text: '⋅' }, parseFactor()); continue; }
      if (source.startsWith('\\times', i)) { i += 6; factors.push({ node: 'operator', text: '×' }, parseFactor()); continue; }
      factors.push(parseFactor());
    }
    return factors.length === 1 ? factors[0] : { node: 'row', children: factors };
  }
  function parseFactor() {
    const base = parseAtom();
    let superscript = null;
    let subscript = null;
    for (;;) {
      skipWhitespace();
      if (peek() === '^') { i += 1; if (superscript) throw error('重复上标'); superscript = parseAtom(); }
      else if (peek() === '_') { i += 1; if (subscript) throw error('重复下标'); subscript = parseAtom(); }
      else break;
    }
    if (superscript && subscript) return { node: 'subsuperscript', base, subscript, superscript };
    if (superscript) return { node: 'superscript', base, superscript };
    if (subscript) return { node: 'subscript', base, subscript };
    return base;
  }
  function parseAtom() {
    skipWhitespace();
    const ch = peek();
    if (ch === undefined) throw error('表达式意外结束');
    if (ch === '{') {
      i += 1;
      const inner = parseExpression();
      skipWhitespace();
      if (peek() !== '}') throw error('缺少 }');
      i += 1;
      return inner;
    }
    if (ch === '(') {
      i += 1;
      const inner = parseExpression();
      skipWhitespace();
      if (peek() !== ')') throw error('缺少 )');
      i += 1;
      return { node: 'delimited', open: '(', close: ')', inner };
    }
    if (ch === '\\') {
      if (source.startsWith('\\frac', i)) {
        i += 5;
        return { node: 'fraction', numerator: parseAtom(), denominator: parseAtom() };
      }
      const command = source.slice(i).match(/^\\[A-Za-z]+/);
      if (command) { i += command[0].length; return { node: 'identifier', text: command[0] }; }
      throw error('无法识别的命令');
    }
    if (/[A-Za-z]/.test(ch)) { i += 1; return { node: 'identifier', text: ch }; }
    if (/[0-9]/.test(ch)) {
      const number = source.slice(i).match(/^\d+(\.\d+)?/);
      i += number[0].length;
      return { node: 'number', text: number[0] };
    }
    throw error(`无法识别的字符 "${ch}"`);
  }
  const result = parseExpression();
  skipWhitespace();
  if (i < source.length) throw error('存在多余内容');
  return result;
}

// ---------- 中文文字替代规范化（保守子集；无法识别时返回 null，不猜） ----------

function textSide(fragment) {
  const trimmed = fragment.trim();
  let match = trimmed.match(/^([A-Za-z]|\d+(?:\.\d+)?)的?平方$/);
  if (match) return { node: 'superscript', base: textSide(match[1]), superscript: { node: 'number', text: '2' } };
  match = trimmed.match(/^([A-Za-z]|\d+(?:\.\d+)?)的?立方$/);
  if (match) return { node: 'superscript', base: textSide(match[1]), superscript: { node: 'number', text: '3' } };
  match = trimmed.match(/^([A-Za-z]|\d+(?:\.\d+)?)的(\d+)次方$/);
  if (match) return { node: 'superscript', base: textSide(match[1]), superscript: { node: 'number', text: match[2] } };
  if (/^[A-Za-z]$/.test(trimmed)) return { node: 'identifier', text: trimmed };
  if (/^\d+(\.\d+)?$/.test(trimmed)) return { node: 'number', text: trimmed };
  return null;
}

export function normalizeTextAlternative(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.trim();
  const parts = cleaned.split('除以');
  if (parts.length === 2) {
    const numerator = textSide(parts[0]);
    const denominator = textSide(parts[1]);
    if (numerator && denominator) return { node: 'fraction', numerator, denominator };
    return null;
  }
  return textSide(cleaned);
}

// ---------- 符号说明解析（"x 为体积，t 为时间" → 作用域内符号表） ----------

export function parseSymbols(text) {
  const symbols = [];
  const unparsed = [];
  for (const segment of String(text ?? '').split(/[，,、；;]/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([^\s为]{1,12})\s*为\s*(.+)$/);
    if (match) symbols.push({ symbol: match[1], meaning: match[2].trim(), raw: trimmed });
    else unparsed.push(trimmed);
  }
  return { symbols, unparsed };
}

// ---------- 结构显示与比对 ----------

function wrap(child) {
  return ATOMIC.has(child.node) ? structureToString(child) : `(${structureToString(child)})`;
}

export function structureToString(node) {
  if (!node) return '(缺失)';
  switch (node.node) {
    case 'fraction': return `${wrap(node.numerator)}/${wrap(node.denominator)}`;
    case 'superscript': return `${wrap(node.base)}^${wrap(node.superscript)}`;
    case 'subscript': return `${wrap(node.base)}_${wrap(node.subscript)}`;
    case 'subsuperscript': return `${wrap(node.base)}_${wrap(node.subscript)}^${wrap(node.superscript)}`;
    case 'radical': return node.index ? `root[${structureToString(node.index)}](${structureToString(node.inner)})` : `sqrt(${structureToString(node.inner)})`;
    case 'delimited': return `${node.open}${structureToString(node.inner)}${node.close}`;
    case 'row': return node.children.map(structureToString).join(' ');
    case 'identifier':
    case 'number':
    case 'operator':
    case 'text': return node.text;
    default: return `(未知节点 ${node.node})`;
  }
}

// 逐路径比对两棵结构树；不一致处各保留双方原样，不取并集、不选较长者。
export function compareStructures(a, b, path = '') {
  const at = path || '(根)';
  if (!a || !b) return [{ path: at, a: structureToString(a), b: structureToString(b) }];
  if (a.node !== b.node) return [{ path: at, a: structureToString(a), b: structureToString(b) }];
  const join = (part) => (path ? `${path}/${part}` : part);
  switch (a.node) {
    case 'fraction':
      return [
        ...compareStructures(a.numerator, b.numerator, join('numerator')),
        ...compareStructures(a.denominator, b.denominator, join('denominator'))
      ];
    case 'superscript':
      return [
        ...compareStructures(a.base, b.base, join('base')),
        ...compareStructures(a.superscript, b.superscript, join('superscript'))
      ];
    case 'subscript':
      return [
        ...compareStructures(a.base, b.base, join('base')),
        ...compareStructures(a.subscript, b.subscript, join('subscript'))
      ];
    case 'subsuperscript':
      return [
        ...compareStructures(a.base, b.base, join('base')),
        ...compareStructures(a.subscript, b.subscript, join('subscript')),
        ...compareStructures(a.superscript, b.superscript, join('superscript'))
      ];
    case 'radical': {
      const diffs = compareStructures(a.inner, b.inner, join('inner'));
      if ((a.index === null) !== (b.index === null)) return [{ path: at, a: structureToString(a), b: structureToString(b) }];
      if (a.index) diffs.push(...compareStructures(a.index, b.index, join('index')));
      return diffs;
    }
    case 'delimited':
      if (a.open !== b.open || a.close !== b.close) return [{ path: at, a: structureToString(a), b: structureToString(b) }];
      return compareStructures(a.inner, b.inner, join('inner'));
    case 'row':
      if (a.children.length !== b.children.length) return [{ path: at, a: structureToString(a), b: structureToString(b) }];
      return a.children.flatMap((child, index) => compareStructures(child, b.children[index], join(`children[${index}]`)));
    case 'identifier':
    case 'number':
    case 'operator':
    case 'text':
      return a.text === b.text ? [] : [{ path: at, a: a.text, b: b.text }];
    default:
      return [];
  }
}
