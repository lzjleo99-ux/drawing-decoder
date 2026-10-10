// 清洗模型生成的 SVG。
//
// 图形是模型产出的内容，会被原样注入预览 HTML，所以必须当成不可信输入处理：
// SVG 里可以塞 <script>、on* 事件、外部引用。清洗之后预览 iframe 才能放开
// allow-scripts（溢出重排脚本需要它），否则"预览所见即 PDF 所得"无从保证。
//
// 采用白名单：只保留画工程图真正需要的元素与属性，其余一律丢弃。

// 浏览器原生 DOMParser / XMLSerializer

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc',
  'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse',
  'text', 'tspan', 'marker',
]);

const ALLOWED_ATTRS = new Set([
  'xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio',
  'x', 'y', 'dx', 'dy', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform',
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'fill-opacity',
  'stroke-opacity', 'opacity', 'color',
  'font-size', 'font-family', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing',
  'id', 'marker-end', 'marker-start', 'marker-mid',
  'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits',
]);

/** 只允许指向文档内部片段的 url(#id) 引用，外部 URL 一律拒绝。 */
function safeAttrValue(name, value) {
  const v = String(value);
  if (/^on/i.test(name)) return null;
  if (/url\(\s*['"]?(?!#)/i.test(v)) return null;
  if (/javascript:|data:text\/html/i.test(v)) return null;
  return v;
}

function clean(el, removed) {
  for (let child = el.firstChild; child;) {
    const next = child.nextSibling;
    if (child.nodeType === 1) {
      if (!ALLOWED_ELEMENTS.has(child.localName)) {
        removed.push(child.localName);
        el.removeChild(child);
      } else {
        // 属性要倒序遍历：removeAttribute 会改变 attributes 的下标
        for (let i = child.attributes.length - 1; i >= 0; i--) {
          const a = child.attributes[i];
          const keep = ALLOWED_ATTRS.has(a.localName) && safeAttrValue(a.localName, a.value) !== null;
          if (!keep) { removed.push(`@${a.name}`); child.removeAttribute(a.name); }
        }
        clean(child, removed);
      }
    } else if (child.nodeType === 8) {
      el.removeChild(child); // 注释
    }
    child = next;
  }
}

/**
 * 清洗 SVG。
 * @param {string} src
 * @returns {{svg:string|null, removed:string[]}}
 */
export function sanitizeSvg(src) {
  const text = String(src ?? '').trim();
  if (!text.startsWith('<svg')) return { svg: null, removed: [] };

  // 浏览器原生 DOMParser 不抛异常：XML 解析失败时返回一个含 <parsererror> 的文档，
  // 必须显式检查，否则格式错误的 SVG 会被当成合法的放进页面
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  } catch (e) {
    return { svg: null, removed: [`格式错误：${e.message}`] };
  }
  if (doc.getElementsByTagName('parsererror').length) {
    return { svg: null, removed: ['格式错误：XML 解析失败'] };
  }

  const root = doc?.documentElement;
  if (!root || root.localName !== 'svg') {
    return { svg: null, removed: ['根元素不是 svg'] };
  }

  const removed = [];
  for (let i = root.attributes.length - 1; i >= 0; i--) {
    const a = root.attributes[i];
    const keep = ALLOWED_ATTRS.has(a.localName) && safeAttrValue(a.localName, a.value) !== null;
    if (!keep) { removed.push(`@${a.name}`); root.removeAttribute(a.name); }
  }
  clean(root, removed);

  // 栅格化与浏览器渲染都需要显式命名空间
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  return { svg: new XMLSerializer().serializeToString(root), removed };
}
