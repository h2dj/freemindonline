import { toPlain, fromPlain, createDefaultRoot } from './model.js';

const STORAGE_KEY = 'freemindonline.doc.v1';

export function autosave(root) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPlain(root)));
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

export function loadAutosaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return fromPlain(JSON.parse(raw));
  } catch (e) {
    console.warn('failed to load autosaved map', e);
    return null;
  }
}

function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJSON(root, filename = 'mindmap.json') {
  const data = JSON.stringify(toPlain(root), null, 2);
  triggerDownload(data, filename, 'application/json');
}

export function parseJSONFile(text) {
  return fromPlain(JSON.parse(text));
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Exports to FreeMind's native .mm XML format so files stay interoperable
// with the desktop FreeMind application.
export function exportMM(root, filename = 'mindmap.mm') {
  function nodeToXML(n, isTop) {
    const attrs = [`TEXT="${xmlEscape(n.text)}"`];
    if (isTop) attrs.push(`POSITION="${n.side === 'left' ? 'left' : 'right'}"`);
    if (n.collapsed && n.children.length) attrs.push('FOLDED="true"');
    if (n.color) attrs.push(`BACKGROUND_COLOR="${n.color}"`);
    const childrenXML = n.children.map((c) => nodeToXML(c, false)).join('');
    return childrenXML
      ? `<node ${attrs.join(' ')}>${childrenXML}</node>`
      : `<node ${attrs.join(' ')}/>`;
  }

  const rootAttrs = [`TEXT="${xmlEscape(root.text)}"`];
  if (root.collapsed && root.children.length) rootAttrs.push('FOLDED="true"');
  const childrenXML = root.children.map((c) => nodeToXML(c, true)).join('');
  const xml = `<map version="1.0.1"><node ${rootAttrs.join(' ')}>${childrenXML}</node></map>`;
  triggerDownload(xml, filename, 'application/xml');
}

// Imports a FreeMind .mm file (or any map following the same simple
// <map><node TEXT="..." POSITION="left|right">...</node></map> schema).
export function parseMM(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('XML을 해석할 수 없습니다.');
  }
  const mapEl = doc.querySelector('map');
  const rootEl = (mapEl || doc).querySelector(':scope > node') || doc.querySelector('node');
  if (!rootEl) throw new Error('올바른 FreeMind(.mm) 파일이 아닙니다.');

  function textOf(el) {
    const direct = el.getAttribute('TEXT');
    if (direct) return direct;
    const rich = el.querySelector(':scope > richcontent');
    return rich ? (rich.textContent || '').trim() : '';
  }

  function build(el, inheritedSide, isTop) {
    const childEls = Array.from(el.children).filter((c) => c.tagName === 'node');
    const position = el.getAttribute('POSITION');
    const side = isTop ? (position === 'left' ? 'left' : 'right') : inheritedSide;
    const plain = {
      text: textOf(el),
      collapsed: el.getAttribute('FOLDED') === 'true',
      color: el.getAttribute('BACKGROUND_COLOR') || null,
      side,
      isRoot: false,
      children: [],
    };
    plain.children = childEls.map((ce) => build(ce, side, false));
    return plain;
  }

  const topEls = Array.from(rootEl.children).filter((c) => c.tagName === 'node');
  const rootPlain = {
    text: textOf(rootEl) || '중심 주제',
    collapsed: false,
    color: null,
    side: null,
    isRoot: true,
    children: topEls.map((el) => build(el, null, true)),
  };
  return fromPlain(rootPlain);
}

export { createDefaultRoot };
