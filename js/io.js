import { toPlain, fromPlain, createDefaultRoot, makeId, addChild } from './model.js';
import { computeContentBounds } from './render.js';

const TABS_STORAGE_KEY = 'freemindonline.tabs.v1';
// Superseded by TABS_STORAGE_KEY once multi-tab support landed, but kept
// around purely so loadTabs() can migrate a single-document save from
// before that into a one-tab session instead of silently losing it.
const LEGACY_STORAGE_KEY = 'freemindonline.doc.v1';

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

// Multiple maps open at once (Chapter: tabs) — each tab is its own
// document (root + graphical links) plus its own pan/zoom, so returning to
// a tab leaves you where you left it. The whole session (every open tab)
// autosaves together under one key.
function serializeTab(tab) {
  return {
    id: tab.id,
    ...serializeDoc(tab.root, tab.graphicalLinks),
    pan: { x: tab.pan.x, y: tab.pan.y },
    zoom: tab.zoom,
  };
}

function deserializeTab(raw) {
  const doc = deserializeDoc(raw);
  return {
    id: raw.id || makeId(),
    root: doc.root,
    graphicalLinks: doc.graphicalLinks,
    selectedId: null, // always defaults to the root on a fresh page load
    pan: raw.pan && typeof raw.pan.x === 'number' ? { x: raw.pan.x, y: raw.pan.y } : { x: 0, y: 0 },
    zoom: typeof raw.zoom === 'number' ? raw.zoom : 1,
  };
}

export function autosaveTabs(tabs, activeTabId) {
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({
      version: 1,
      activeTabId,
      tabs: tabs.map(serializeTab),
    }));
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

// Returns { tabs: [...], activeTabId } — or null if there's nothing saved
// yet at all (first-ever visit), in which case the caller starts with one
// fresh blank tab.
export function loadTabs() {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length) {
        return { tabs: parsed.tabs.map(deserializeTab), activeTabId: parsed.activeTabId };
      }
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const tab = deserializeTab({ id: makeId(), ...JSON.parse(legacy) });
      return { tabs: [tab], activeTabId: tab.id };
    }
  } catch (e) {
    console.warn('failed to load tabs', e);
  }
  return null;
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
    // Non-standard attribute — real FreeMind has no checkbox concept and
    // simply ignores attributes it doesn't recognize, while round-tripping
    // through this app's own .mm export/import preserves the checkbox.
    if (n.checkbox != null) attrs.push(`CHECKBOX="${n.checkbox ? 'true' : 'false'}"`);

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

    const checkboxAttr = el.getAttribute('CHECKBOX');
    const checkbox = checkboxAttr === 'true' ? true : (checkboxAttr === 'false' ? false : null);

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
      checkbox,
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

// ---------- Markdown export/import ----------
// A lightweight, human-readable outline format (GitHub-flavored task lists
// for checkboxes, `[text](url)` for hyperlinks). Unlike JSON this is
// intentionally lossy — colors, clouds, icons, and graphical links don't
// have a natural Markdown equivalent and are dropped, same spirit as PNG
// export/print being visual-only snapshots.
function markdownLineText(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').trim();
}

// A flat GitHub/Notion-style Markdown task list (`- [ ] text` / `- [x]
// text`), one line per checkbox node in the order given — no heading, no
// indentation, since pasting this into Notion (or any other
// markdown-aware target) turns each line into its own to-do block
// regardless of where in the original tree that node lived.
export function checklistToMarkdown(nodes) {
  return nodes
    .map((n) => `- [${n.checkbox ? 'x' : ' '}] ${markdownLineText(n.text) || '(제목 없음)'}`)
    .join('\n');
}

export function exportMarkdown(root, filename = 'mindmap.md') {
  const lines = [`# ${markdownLineText(root.text) || '중심 주제'}`, ''];
  function walk(node, depth) {
    node.children.forEach((c) => {
      const indent = '  '.repeat(depth);
      let text = markdownLineText(c.text);
      if (c.link) text = `[${text}](${c.link})`;
      const box = c.checkbox != null ? `[${c.checkbox ? 'x' : ' '}] ` : '';
      lines.push(`${indent}- ${box}${text}`);
      walk(c, depth + 1);
    });
  }
  walk(root, 0);
  triggerDownload(lines.join('\n') + '\n', filename, 'text/markdown');
}

// Parses a Markdown outline back into a document: an optional leading `#`
// heading becomes the center topic, and a nested bullet list (any of
// `-`/`*`/`+`, any indentation width — depth is read from an indentation
// stack rather than a fixed column count) becomes the tree below it.
// `- [ ] text` / `- [x] text` restores a checkbox, and a lone
// `[text](url)` bullet restores a hyperlink. Graphical links have no
// Markdown equivalent, so imported documents never have any.
export function parseMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  let rootText = '중심 주제';
  if (i < lines.length && /^#{1,6}\s+/.test(lines[i])) {
    rootText = lines[i].replace(/^#{1,6}\s+/, '').trim() || rootText;
    i++;
  }
  const root = createDefaultRoot();
  root.text = rootText;

  const stack = [{ indent: -1, node: root }];
  for (; i < lines.length; i++) {
    const m = /^(\s*)[-*+]\s+(.*)$/.exec(lines[i]);
    if (!m) continue; // blank lines / stray prose outside the list are ignored
    const indent = m[1].replace(/\t/g, '  ').length;
    let content = m[2].trim();

    let checkbox = null;
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (taskMatch) {
      checkbox = taskMatch[1].toLowerCase() === 'x';
      content = taskMatch[2].trim();
    }

    let text = content, link = null;
    const linkMatch = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(content);
    if (linkMatch) { text = linkMatch[1]; link = linkMatch[2]; }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node = addChild(parent, text || '새 노드');
    if (checkbox != null) node.checkbox = checkbox;
    if (link) node.link = link;
    stack.push({ indent, node });
  }

  return { root, graphicalLinks: [] };
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

// The standalone SVG built below is its own isolated document — its :root
// is the <svg> element, not the live page's <html> — so it only ever sees
// the *static* :root custom-property values baked into styles.css on disk,
// never any settings the user applied at runtime via
// document.documentElement.style.setProperty (see settings.js). Re-reading
// the live computed values here and re-declaring them (after the base
// stylesheet, so they win) keeps exported/printed images in sync with the
// user's font size and color settings instead of always falling back to
// the built-in defaults.
function runtimeCSSOverrides() {
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--node-font-size', '--node-bg', '--accent', '--accent-dark', '--bg'];
  const decls = vars.map((v) => `${v}: ${cs.getPropertyValue(v).trim()};`).join(' ');
  return `:root { ${decls} }`;
}

async function buildMapSVGMarkup(state) {
  const bounds = computeContentBounds(state);
  const MARGIN = 40;
  const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX) + MARGIN * 2);
  const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY) + MARGIN * 2);
  const dx = MARGIN - bounds.minX;
  const dy = MARGIN - bounds.minY;

  const css = await loadAppCSS();
  const overrides = runtimeCSSOverrides();
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f4f6f9';
  const clouds = document.getElementById('clouds').innerHTML;
  const edges = document.getElementById('edges').innerHTML;
  const glinks = document.getElementById('glinks').innerHTML;

  // A plain snapshot of the current nodes: strip interaction-only state
  // (selection outline, in-progress edit) that shouldn't appear in an
  // exported/printed image of the map itself.
  const nodesClone = document.getElementById('nodes').cloneNode(true);
  nodesClone.querySelectorAll('.node-box').forEach((el) => {
    el.classList.remove('selected', 'link-source');
  });
  nodesClone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));

  const markup = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>${css}</style>`,
    `<style>${overrides}</style>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>`,
    `<g transform="translate(${dx}, ${dy})">${clouds}${edges}${glinks}</g>`,
    `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative; width:${width}px; height:${height}px;">`,
    `<div style="position:absolute; left:${dx}px; top:${dy}px;">${nodesClone.innerHTML}</div>`,
    `</div>`,
    `</foreignObject>`,
    `</svg>`,
  ].join('');

  return { markup, width, height };
}

// Rasterizes the whole map (see buildMapSVGMarkup) through an offscreen
// canvas at the given pixel scale. Shared by exportPNG and printMap so
// both produce an identical, crisp image of the same content.
async function renderMapToCanvas(state, scale = 2) {
  const { markup, width, height } = await buildMapSVGMarkup(state);
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('SVG를 이미지로 변환하지 못했습니다.'));
    img.src = svgUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const c = canvas.getContext('2d');
  c.scale(scale, scale);
  c.drawImage(img, 0, 0, width, height);
  return canvas;
}

export async function exportPNG(state, filename = 'mindmap.png') {
  const canvas = await renderMapToCanvas(state, 2); // 2x for a crisp, print-quality image
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

// Prints the whole map (regardless of current pan/zoom), independent of the
// app's own UI chrome (toolbar, status bar) — a plain browser print of the
// live page would only show whatever's currently in the viewport. Instead
// this renders the same standalone image used by exportPNG into a fresh
// tab and triggers that tab's print dialog.
//
// The window MUST be opened synchronously, before any await, or popup
// blockers won't recognize it as a direct result of the user's click —
// since an async function's body runs synchronously up to its first
// `await`, opening it as the very first statement here still qualifies.
export async function printMap(state) {
  const printWin = window.open('', '_blank');
  if (!printWin) {
    throw new Error('팝업이 차단되어 인쇄 창을 열 수 없습니다. 팝업 차단을 해제한 뒤 다시 시도해주세요.');
  }
  printWin.document.write('<!doctype html><meta charset="utf-8"><title>인쇄 준비 중…</title><body style="font-family:sans-serif;padding:40px;color:#6b7280">인쇄할 이미지를 준비하는 중입니다…</body>');
  try {
    const canvas = await renderMapToCanvas(state, 2);
    const dataUrl = canvas.toDataURL('image/png');
    printWin.document.open();
    printWin.document.write([
      '<!doctype html><html><head><meta charset="utf-8"><title>FreeMind Online - 인쇄</title>',
      '<style>',
      '@page { margin: 12mm; }',
      'html, body { margin: 0; padding: 0; background: #fff; }',
      'img { display: block; max-width: 100%; height: auto; margin: 0 auto; }',
      '</style></head><body><img id="print-img" src="', dataUrl, '" alt="mindmap"></body></html>',
    ].join(''));
    printWin.document.close();
    const finish = () => { printWin.focus(); printWin.print(); };
    const imgEl = printWin.document.getElementById('print-img');
    if (imgEl.complete) finish();
    else imgEl.onload = finish;
    printWin.onafterprint = () => printWin.close();
  } catch (e) {
    if (!printWin.closed) {
      printWin.document.open();
      printWin.document.write('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;color:#b91c1c">인쇄 이미지를 준비하지 못했습니다: ' + String(e.message || e) + '</body>');
      printWin.document.close();
    }
    throw e;
  }
}

export { createDefaultRoot };
