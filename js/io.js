import { toPlain, fromPlain, createDefaultRoot } from './model.js';
import { computeContentBounds } from './render.js';

const STORAGE_KEY = 'freemindonline.doc.v1';

// A small subset of FreeMind's real built-in icon names, mapped to a
// visually-equivalent emoji, so importing an actual FreeMind .mm file
// degrades gracefully instead of showing raw codenames for common cases.
const MM_ICON_TO_EMOJI = {
  help: '❓', yes: '✅', button_ok: '✅', button_cancel: '❌', cancel: '❌',
  idea: '💡', messagebox_warning: '⚠️', stop: '🛑', flag: '🚩', 'flag-black': '🏴',
  bell: '🔔', clock: '⏰', clock2: '⏰', hourglass: '⏳', attach: '📎',
  password: '🔒', pencil: '✏️', go: '🟢', checked: '☑️', info: 'ℹ️',
  'full-1': '1️⃣', 'full-2': '2️⃣', 'full-3': '3️⃣', star: '⭐',
};

// The document is the node tree plus the doc-level graphical-link list
// (Chapter 3: "Adding graphical links" — arrows between arbitrary nodes,
// not just parent/child). Serialized as { root, links }. Older saves were
// just the bare root-node object, so deserializeDoc accepts both shapes.
function serializeDoc(root, graphicalLinks) {
  return { root: toPlain(root), links: (graphicalLinks || []).map((l) => ({ ...l })) };
}

function deserializeDoc(raw) {
  const rootPlain = raw && raw.root ? raw.root : raw;
  return {
    root: fromPlain(rootPlain),
    graphicalLinks: raw && Array.isArray(raw.links) ? raw.links.map((l) => ({ ...l })) : [],
  };
}

export function autosave(root, graphicalLinks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeDoc(root, graphicalLinks)));
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

export function loadAutosaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return deserializeDoc(JSON.parse(raw));
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

export function downloadJSON(root, graphicalLinks, filename = 'mindmap.json') {
  const data = JSON.stringify(serializeDoc(root, graphicalLinks), null, 2);
  triggerDownload(data, filename, 'application/json');
}

export function parseJSONFile(text) {
  return deserializeDoc(JSON.parse(text));
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Exports to FreeMind's native .mm XML format so files stay interoperable
// with the desktop FreeMind application. Every node gets an ID so graphical
// links (<arrowlink DESTINATION="...">) can reference each other, matching
// how real FreeMind files are structured.
export function exportMM(root, graphicalLinks, filename = 'mindmap.mm') {
  const linksByFrom = new Map();
  (graphicalLinks || []).forEach((l) => {
    if (!linksByFrom.has(l.fromId)) linksByFrom.set(l.fromId, []);
    linksByFrom.get(l.fromId).push(l);
  });

  function nodeToXML(n, isTop) {
    const attrs = [`TEXT="${xmlEscape(n.text)}"`, `ID="${xmlEscape(n.id)}"`];
    if (isTop) attrs.push(`POSITION="${n.side === 'left' ? 'left' : 'right'}"`);
    if (n.collapsed && n.children.length) attrs.push('FOLDED="true"');
    if (n.color) attrs.push(`BACKGROUND_COLOR="${n.color}"`);
    if (n.link) attrs.push(`LINK="${xmlEscape(n.link)}"`);

    const extra = [];
    if (n.cloud) extra.push(`<cloud COLOR="${xmlEscape(n.cloud)}"/>`);
    (n.icons || []).forEach((ic) => extra.push(`<icon BUILTIN="${xmlEscape(ic)}"/>`));
    (linksByFrom.get(n.id) || []).forEach((link) => {
      const arrows = link.arrows || 'end';
      const startArrow = arrows === 'both' ? 'Default' : 'None';
      const endArrow = arrows === 'none' ? 'None' : 'Default';
      const colorAttr = link.color ? ` COLOR="${xmlEscape(link.color)}"` : '';
      extra.push(`<arrowlink DESTINATION="${xmlEscape(link.toId)}" STARTARROW="${startArrow}" ENDARROW="${endArrow}"${colorAttr}/>`);
    });

    const childrenXML = extra.join('') + n.children.map((c) => nodeToXML(c, n.isRoot)).join('');
    return childrenXML
      ? `<node ${attrs.join(' ')}>${childrenXML}</node>`
      : `<node ${attrs.join(' ')}/>`;
  }

  const xml = `<map version="1.0.1">${nodeToXML(root, false)}</map>`;
  triggerDownload(xml, filename, 'application/xml');
}

// Imports a FreeMind .mm file (or any map following the same simple
// <map><node TEXT="..." POSITION="left|right">...</node></map> schema).
// Reads IDs, LINK, <cloud>, <icon BUILTIN>, and <arrowlink> so clouds,
// hyperlinks, icons, and graphical links all round-trip through this app,
// and degrade gracefully when opening a real FreeMind file.
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

  let genCounter = 0;
  const genId = () => 'mm-' + (genCounter++) + '-' + Math.random().toString(36).slice(2, 6);
  const rawLinks = []; // { fromId, toId, color, arrows }

  function build(el, inheritedSide, isTop, isRootNode) {
    const id = el.getAttribute('ID') || genId();
    const position = el.getAttribute('POSITION');
    const side = isRootNode ? null : (isTop ? (position === 'left' ? 'left' : 'right') : inheritedSide);

    const cloudEl = el.querySelector(':scope > cloud');
    const iconEls = Array.from(el.children).filter((c) => c.tagName === 'icon');
    const arrowEls = Array.from(el.children).filter((c) => c.tagName === 'arrowlink');
    arrowEls.forEach((ae) => {
      const dest = ae.getAttribute('DESTINATION');
      if (!dest) return;
      const startArrow = (ae.getAttribute('STARTARROW') || 'None').toLowerCase();
      const endArrow = (ae.getAttribute('ENDARROW') || 'Default').toLowerCase();
      let arrows = 'end';
      if (startArrow !== 'none' && endArrow !== 'none') arrows = 'both';
      else if (startArrow === 'none' && endArrow === 'none') arrows = 'none';
      rawLinks.push({ fromId: id, toId: dest, color: ae.getAttribute('COLOR') || null, arrows });
    });

    const childEls = Array.from(el.children).filter((c) => c.tagName === 'node');
    const plain = {
      id,
      text: textOf(el) || (isRootNode ? '중심 주제' : ''),
      collapsed: el.getAttribute('FOLDED') === 'true',
      color: el.getAttribute('BACKGROUND_COLOR') || null,
      side,
      isRoot: !!isRootNode,
      cloud: cloudEl ? (cloudEl.getAttribute('COLOR') || '#c9d6e3') : null,
      link: el.getAttribute('LINK') || null,
      icons: iconEls
        .map((ie) => {
          const b = ie.getAttribute('BUILTIN') || '';
          return MM_ICON_TO_EMOJI[b] || b;
        })
        .filter(Boolean),
      children: [],
    };
    plain.children = childEls.map((ce) => build(ce, side, isRootNode, false));
    return plain;
  }

  const rootPlain = build(rootEl, null, false, true);
  const root = fromPlain(rootPlain);

  const validIds = new Set();
  (function collect(n) { validIds.add(n.id); n.children.forEach(collect); })(root);
  const graphicalLinks = rawLinks
    .filter((l) => validIds.has(l.fromId) && validIds.has(l.toId))
    .map((l, i) => ({ id: 'gl-' + i + '-' + Math.random().toString(36).slice(2, 6), ...l }));

  return { root, graphicalLinks };
}

// Exports the whole map (regardless of current pan/zoom) as a PNG image, by
// re-drawing the on-screen clouds/edges/graphical-links SVG layers plus a
// snapshot of the HTML node layer into one standalone SVG document (nodes
// go through a <foreignObject> since they're real HTML, not SVG), then
// rasterizing that through an offscreen <canvas>. No external libraries —
// keeps with the rest of this app being dependency-free.
let cssTextCache = null;
async function loadAppCSS() {
  if (cssTextCache != null) return cssTextCache;
  try {
    const res = await fetch('css/styles.css');
    cssTextCache = res.ok ? await res.text() : '';
  } catch {
    cssTextCache = '';
  }
  return cssTextCache;
}

export async function exportPNG(state, filename = 'mindmap.png') {
  const bounds = computeContentBounds(state);
  const MARGIN = 40;
  const SCALE = 2; // export at 2x for a crisp, print-quality image
  const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX) + MARGIN * 2);
  const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY) + MARGIN * 2);
  const dx = MARGIN - bounds.minX;
  const dy = MARGIN - bounds.minY;

  const css = await loadAppCSS();
  const clouds = document.getElementById('clouds').innerHTML;
  const edges = document.getElementById('edges').innerHTML;
  const glinks = document.getElementById('glinks').innerHTML;

  // A plain snapshot of the current nodes: strip interaction-only state
  // (selection outline, in-progress edit) that shouldn't appear in an
  // exported image of the map itself.
  const nodesClone = document.getElementById('nodes').cloneNode(true);
  nodesClone.querySelectorAll('.node-box').forEach((el) => {
    el.classList.remove('selected', 'link-source');
  });
  nodesClone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));

  const svgMarkup = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>${css}</style>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#f4f6f9"/>`,
    `<g transform="translate(${dx}, ${dy})">${clouds}${edges}${glinks}</g>`,
    `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative; width:${width}px; height:${height}px;">`,
    `<div style="position:absolute; left:${dx}px; top:${dy}px;">${nodesClone.innerHTML}</div>`,
    `</div>`,
    `</foreignObject>`,
    `</svg>`,
  ].join('');

  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('SVG를 이미지로 변환하지 못했습니다.'));
    img.src = svgUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const c = canvas.getContext('2d');
  c.scale(SCALE, SCALE);
  c.drawImage(img, 0, 0, width, height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG 생성에 실패했습니다.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { createDefaultRoot };
