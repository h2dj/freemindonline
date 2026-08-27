import { toPlain, fromPlain, createDefaultRoot, makeId, addChild, ancestorPathText } from './model.js';
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

// Every exported file (JSON/.mm/.md/PNG) is named after the map itself —
// mindmap_<중심주제>_<날짜>.<ext> — instead of a fixed "mindmap.json" that
// silently overwrites the last export and gives no hint what's inside.
function sanitizeForFilename(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '') // strip characters invalid in Windows/macOS filenames
    .replace(/\s+/g, '_')
    .slice(0, 60);
  return cleaned || '중심주제';
}

function todayDateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function mindmapFilename(rootText, ext) {
  return `mindmap_${sanitizeForFilename(rootText)}_${todayDateStr()}.${ext}`;
}

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
  triggerBlobDownload(new Blob([content], { type: mime }), filename);
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A File (not just a Blob) so it can be handed directly to the Web Share
// API's `files` option — sharing the map means sharing this app's own
// full-fidelity JSON format, same as "저장".
export function buildJSONFile(root, graphicalLinks, filename = mindmapFilename(root.text, 'json')) {
  const data = JSON.stringify(serializeDoc(root, graphicalLinks), null, 2);
  return new File([data], filename, { type: 'application/json' });
}

export function downloadJSON(root, graphicalLinks, filename = mindmapFilename(root.text, 'json')) {
  triggerBlobDownload(buildJSONFile(root, graphicalLinks, filename), filename);
}

export function parseJSONFile(text) {
  return deserializeDoc(JSON.parse(text));
}

// ---------- Shareable link (no server/account needed) ----------
// Packs the whole document into the URL's hash fragment so pasting the
// link into a chat or email reopens the exact same map, no file attachment
// or sign-in required. A hash fragment is never sent in the HTTP request
// (only ? query strings are) — the browser keeps it entirely client-side —
// so there's no server URL-length limit to worry about; the only real
// constraint is whether wherever the user pastes the link (a chat client,
// an email body) mangles a very long one, which buildShareLink flags via
// `tooLong` for the caller to warn about, not something to block on.

const SHARE_HASH_PREFIX = '#share=';
// A heads-up threshold, not a hard cutoff — most of the length budget goes
// unused by the browser itself. Maps with embedded images (already-compressed
// JPEG/PNG data) will very likely cross it; that's expected, not a bug.
const SHARE_LINK_WARN_LENGTH = 8000;

function toBase64Url(bytes) {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// CompressionStream isn't in every browser yet (Safari added it in 16.4) —
// gzip helps a lot for a plain text-heavy map (JSON compresses well) and
// barely at all for one with embedded images (already-compressed JPEG/PNG
// data doesn't shrink further), but either way a browser without it just
// gets the plain, uncompressed link instead of the feature failing outright.
async function gzipCompress(text) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecompress(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

// Returns { url, length, tooLong }.
export async function buildShareLink(root, graphicalLinks) {
  const json = JSON.stringify(serializeDoc(root, graphicalLinks));
  const compressed = await gzipCompress(json);
  const payload = compressed
    ? 'z' + toBase64Url(compressed)
    : 'r' + toBase64Url(new TextEncoder().encode(json));
  const base = location.href.split('#')[0];
  const url = `${base}${SHARE_HASH_PREFIX}${payload}`;
  return { url, length: url.length, tooLong: url.length > SHARE_LINK_WARN_LENGTH };
}

// Reads a document back out of a `#share=...` hash (see buildShareLink
// above). Returns null for a hash that isn't one of our share links at all
// (e.g. no hash, or some other fragment) so app startup can fall through
// to its normal autosave-restore path instead of treating that as an
// error; throws only once it's committed to this being a share link that
// then turns out to be corrupt, so the caller can tell those two cases
// apart and only surface a toast for the latter.
export async function parseShareLink(hash) {
  if (!hash || !hash.startsWith(SHARE_HASH_PREFIX)) return null;
  const payload = hash.slice(SHARE_HASH_PREFIX.length);
  const kind = payload[0];
  const bytes = fromBase64Url(payload.slice(1));
  const json = kind === 'z' ? await gzipDecompress(bytes) : new TextDecoder().decode(bytes);
  return deserializeDoc(JSON.parse(json));
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
export function exportMM(root, graphicalLinks, filename = mindmapFilename(root.text, 'mm')) {
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
    // Also non-standard, same spirit as CHECKBOX above — real FreeMind has
    // no equivalent (its own image support works through externally
    // referenced files, not an inline element like this), so the whole
    // data URL round-trips only through this app's own .mm export/import.
    if (n.image) extra.push(`<image DATA="${xmlEscape(n.image)}" W="${n.imageW || 0}" H="${n.imageH || 0}"/>`);
    (linksByFrom.get(n.id) || []).forEach((link) => {
      const arrows = link.arrows || 'end';
      const startArrow = arrows === 'both' ? 'Default' : 'None';
      const endArrow = arrows === 'none' ? 'None' : 'Default';
      const colorAttr = link.color ? ` COLOR="${xmlEscape(link.color)}"` : '';
      // CURVE_PERP/CURVE_ALONG are also non-standard (deliberately not real
      // FreeMind's STARTINCLINATION/ENDINCLINATION — those describe a
      // *cubic* curve with one control point per end, while this app's
      // curve is a simpler single-control-point quadratic, so reusing the
      // real attribute names would just be misleading) — only this app's
      // own .mm export/import understands them.
      const curveAttr = link.curve
        ? ` CURVE_PERP="${link.curve.perp}" CURVE_ALONG="${link.curve.along}"`
        : '';
      extra.push(`<arrowlink DESTINATION="${xmlEscape(link.toId)}" STARTARROW="${startArrow}" ENDARROW="${endArrow}"${colorAttr}${curveAttr}/>`);
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
// Reads IDs, LINK, <cloud>, <icon BUILTIN>, <image> (see exportMM), and
// <arrowlink> so clouds, hyperlinks, icons, images, and graphical links all
// round-trip through this app, and degrade gracefully when opening a real
// FreeMind file (which just won't have any of those non-standard bits).
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
    const imageEl = el.querySelector(':scope > image');
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
      const perpAttr = ae.getAttribute('CURVE_PERP');
      const alongAttr = ae.getAttribute('CURVE_ALONG');
      const curve = perpAttr != null && alongAttr != null
        ? { perp: Number(perpAttr) || 0, along: Number(alongAttr) || 0 }
        : null;
      rawLinks.push({ fromId: id, toId: dest, color: ae.getAttribute('COLOR') || null, arrows, curve });
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
      image: imageEl ? imageEl.getAttribute('DATA') || null : null,
      imageW: imageEl ? Number(imageEl.getAttribute('W')) || null : null,
      imageH: imageEl ? Number(imageEl.getAttribute('H')) || null : null,
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
// Flattens a node's text to one line — shared by the Markdown and CSV
// exporters below, since neither format has a cell/line-friendly way to
// keep an embedded newline.
function singleLineText(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').trim();
}

// A flat GitHub/Notion-style Markdown task list (`- [ ] text` / `- [x]
// text`), one line per checkbox node in the order given — no heading, no
// indentation, since pasting this into Notion (or any other
// markdown-aware target) turns each line into its own to-do block
// regardless of where in the original tree that node lived. When
// `includePath` is on (the default), each item's ancestor path is appended
// in parentheses (skipped for a checkbox on the center topic itself, which
// has no ancestors) so a flattened list out of context still says where in
// the map each task came from — off, for a plain checklist with no
// parenthetical clutter.
export function checklistToMarkdown(nodes, { includePath = true } = {}) {
  return nodes
    .map((n) => {
      const text = singleLineText(n.text) || '(제목 없음)';
      const path = includePath ? ancestorPathText(n) : '';
      const suffix = path ? ` (${path})` : '';
      return `- [${n.checkbox ? 'x' : ' '}] ${text}${suffix}`;
    })
    .join('\n');
}

// ---------- Checklist CSV export ----------
// Quotes a field only when it needs it (contains a comma, quote, or
// newline), doubling any embedded quotes — the usual minimal-quoting CSV
// convention, so a plain cell like a done flag or short task stays
// unquoted and readable.
function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Same flat, one-row-per-checkbox-node shape as checklistToMarkdown above,
// as a spreadsheet-friendly CSV instead: 완료 (TRUE/FALSE, which Excel and
// Google Sheets both recognize as a boolean on import) and 할 일 columns,
// plus an optional 상위 노드 경로 column — same includePath toggle and
// same "no ancestors" blank as the Markdown export uses.
export function checklistToCSV(nodes, { includePath = true } = {}) {
  const header = includePath ? ['완료', '할 일', '상위 노드 경로'] : ['완료', '할 일'];
  const rows = nodes.map((n) => {
    const text = singleLineText(n.text) || '(제목 없음)';
    const cols = [n.checkbox ? 'TRUE' : 'FALSE', text];
    if (includePath) cols.push(ancestorPathText(n));
    return cols;
  });
  return [header, ...rows].map((cols) => cols.map(csvField).join(',')).join('\r\n');
}

// A UTF-8 BOM is prepended so Excel (which otherwise guesses the file's
// legacy codepage) opens the Korean text correctly instead of mojibake —
// Google Sheets and other modern readers ignore a BOM either way. `root` is
// only used for the default filename, same division of labor as the other
// exporters below.
export function exportChecklistCSV(root, nodes, filename = mindmapFilename(root.text, 'csv'), opts) {
  triggerDownload('\uFEFF' + checklistToCSV(nodes, opts), filename, 'text/csv;charset=utf-8');
}

export function exportMarkdown(root, filename = mindmapFilename(root.text, 'md')) {
  const lines = [`# ${singleLineText(root.text) || '중심 주제'}`, ''];
  function walk(node, depth) {
    node.children.forEach((c) => {
      const indent = '  '.repeat(depth);
      let text = singleLineText(c.text);
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
// the built-in defaults (font size, colors, borderless-node style, etc).
function runtimeCSSOverrides() {
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--node-font-size', '--node-bg', '--accent', '--accent-dark', '--bg'];
  const decls = vars.map((v) => `${v}: ${cs.getPropertyValue(v).trim()};`).join(' ');
  return `:root { ${decls} }`;
}

// Wraps raw CSS text (from the file on disk, or the runtime overrides
// above) in a CDATA section before it goes into an XML <style> element —
// unlike an HTML document, this exported SVG is parsed as XML, so a `<` or
// `&` anywhere in the CSS text — even inside a comment, e.g. one that
// happens to mention an HTML tag like <body> — would otherwise be read as
// markup and can desync the whole document's tag structure. `]]>` is the
// one sequence CDATA itself can't contain; escaping it (the standard XML
// trick: split it into two adjacent CDATA sections) is only a theoretical
// concern for actual CSS but costs nothing to handle.
function cdata(css) {
  return `<![CDATA[${css.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
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
  // Same "strip interaction-only state" treatment as nodesClone below — a
  // selected link's highlight color and its curve-drag handle are editing
  // affordances, not part of the map itself.
  const glinksClone = document.getElementById('glinks').cloneNode(true);
  glinksClone.querySelectorAll('.glink.selected').forEach((el) => el.classList.remove('selected'));
  glinksClone.querySelectorAll('.glink-handle').forEach((el) => el.remove());
  const glinks = glinksClone.innerHTML;

  // A plain snapshot of the current nodes: strip interaction-only state
  // (selection outline, in-progress edit) that shouldn't appear in an
  // exported/printed image of the map itself.
  const nodesClone = document.getElementById('nodes').cloneNode(true);
  nodesClone.querySelectorAll('.node-box').forEach((el) => {
    el.classList.remove('selected', 'link-source');
  });
  nodesClone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  // .innerHTML serializes with plain HTML syntax — a void element like
  // <img> comes out as `<img ...>` with no closing slash, which is fine in
  // HTML but not well-formed XML, and this whole fragment is about to be
  // parsed as XML inside <foreignObject> below. XMLSerializer self-closes
  // it (`<img .../>`) instead, since it has no HTML-void-element concept —
  // it just serializes the DOM tree structure as-is.
  const serializer = new XMLSerializer();
  const nodesXML = Array.from(nodesClone.children).map((el) => serializer.serializeToString(el)).join('');
  // The .node-style-borderless/.node-style-underline rules (styles.css)
  // are scoped by an ancestor class normally living on the live page's
  // <html> — this exported SVG is its own isolated document, so that class
  // has to be re-applied to this fragment's own root element instead.
  const nodeStyleClass = state.nodeStyle && state.nodeStyle !== 'bordered' ? ` class="node-style-${state.nodeStyle}"` : '';

  const markup = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>${cdata(css)}</style>`,
    `<style>${cdata(overrides)}</style>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>`,
    `<g transform="translate(${dx}, ${dy})">${clouds}${edges}${glinks}</g>`,
    `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml"${nodeStyleClass} style="position:relative; width:${width}px; height:${height}px;">`,
    `<div style="position:absolute; left:${dx}px; top:${dy}px;">${nodesXML}</div>`,
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

export async function exportPNG(state, filename = mindmapFilename(state.root.text, 'png')) {
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
