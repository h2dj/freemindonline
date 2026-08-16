import { computeLayout } from './layout.js';
import { measureNode } from './measure.js';
import { findNode } from './model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_LINK_COLOR = '#f97316';

export function collectVisible(node, arr) {
  arr.push(node);
  if (!node.collapsed) node.children.forEach((c) => collectVisible(c, arr));
}

// Arrow-key Up/Down navigation: moves to the next/previous node on the same
// side in *screen order* (by rendered y), not strictly among literal
// siblings — so reaching the end of one branch's children continues into
// whatever's visually next below/above (a cousin, an aunt/uncle's branch,
// etc), matching how the tree actually looks on screen. Relies on x/y from
// the most recent computeLayout() call (see render() below).
export function nextVisibleSameSide(root, node, dir) {
  if (!node.parent) return node; // root has no vertical peers
  const all = [];
  collectVisible(root, all);
  const sameSide = all.filter((n) => !n.isRoot && n.side === node.side);
  sameSide.sort((a, b) => a.y - b.y);
  const idx = sameSide.indexOf(node);
  if (idx < 0) return node;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= sameSide.length) return node;
  return sameSide[newIdx];
}

const CLOUD_PAD = 14;

// Bounding box of `node` plus all of its *visible* descendants (a collapsed
// node's hidden children don't extend the cloud). Used to draw a highlight
// bubble behind a node's whole subtree (Chapter 3: "Highlighting nodes with
// clouds").
function subtreeBounds(node) {
  let minX = node.x - node.w / 2, maxX = node.x + node.w / 2;
  let minY = node.y - node.h / 2, maxY = node.y + node.h / 2;
  function visit(n) {
    minX = Math.min(minX, n.x - n.w / 2);
    maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2);
    maxY = Math.max(maxY, n.y + n.h / 2);
    if (!n.collapsed) n.children.forEach(visit);
  }
  visit(node);
  return { minX, maxX, minY, maxY };
}

// Bounding box of everything render() would draw: every visible node, cloud
// highlights, and graphical-link curves (including their bow). Relies on
// x/y/w/h from the most recent computeLayout() call. Used by PNG export to
// size the exported image so nothing gets clipped.
export function computeContentBounds(state) {
  const list = [];
  collectVisible(state.root, list);
  if (!list.length) return { minX: -100, minY: -60, maxX: 100, maxY: 60 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  list.forEach((n) => {
    minX = Math.min(minX, n.x - n.w / 2);
    maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2);
    maxY = Math.max(maxY, n.y + n.h / 2);
    if (n.cloud) {
      const b = subtreeBounds(n);
      minX = Math.min(minX, b.minX - CLOUD_PAD);
      maxX = Math.max(maxX, b.maxX + CLOUD_PAD);
      minY = Math.min(minY, b.minY - CLOUD_PAD);
      maxY = Math.max(maxY, b.maxY + CLOUD_PAD);
    }
  });
  (state.graphicalLinks || []).forEach((link) => {
    const from = findNode(state.root, link.fromId);
    const to = findNode(state.root, link.toId);
    if (!from || !to || from.x == null || to.x == null) return;
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(70, len * 0.18);
    const cx = mx + (-dy / len) * bow, cy = my + (dx / len) * bow;
    minX = Math.min(minX, from.x, to.x, cx);
    maxX = Math.max(maxX, from.x, to.x, cx);
    minY = Math.min(minY, from.y, to.y, cy);
    maxY = Math.max(maxY, from.y, to.y, cy);
  });
  return { minX, minY, maxX, maxY };
}

function drawClouds(root) {
  const svg = document.getElementById('clouds');
  svg.innerHTML = '';
  const list = [];
  collectVisible(root, list);
  const PAD = 14;
  list.forEach((n) => {
    if (!n.cloud) return;
    const { minX, maxX, minY, maxY } = subtreeBounds(n);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', minX - PAD);
    rect.setAttribute('y', minY - PAD);
    rect.setAttribute('width', maxX - minX + PAD * 2);
    rect.setAttribute('height', maxY - minY + PAD * 2);
    rect.setAttribute('rx', 24);
    rect.setAttribute('ry', 24);
    rect.setAttribute('class', 'cloud');
    rect.style.fill = n.cloud;
    rect.style.stroke = n.cloud;
    svg.appendChild(rect);
  });
}

function drawEdges(root) {
  const svg = document.getElementById('edges');
  svg.innerHTML = '';
  const list = [];
  collectVisible(root, list);
  list.forEach((n) => {
    if (n.collapsed || !n.children.length) return;
    n.children.forEach((c) => {
      const path = document.createElementNS(SVG_NS, 'path');
      const x1 = n.x + (c.side === 'left' ? -n.w / 2 : n.w / 2);
      const y1 = n.y;
      const x2 = c.x + (c.side === 'left' ? c.w / 2 : -c.w / 2);
      const y2 = c.y;
      const dx = (x2 - x1) * 0.5;
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      path.setAttribute('d', d);
      path.setAttribute('class', 'edge');
      if (c.color) path.style.stroke = c.color;
      svg.appendChild(path);
    });
  });
}

// Chapter 3: "Adding graphical links" — arbitrary arrows between any two
// nodes, independent of the parent/child tree structure.
function drawGraphicalLinks(root, links, selectedLinkId) {
  const svg = document.getElementById('glinks');
  svg.innerHTML = '';
  if (!links || !links.length) return;

  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  const markerCache = new Map();
  function markerFor(color) {
    if (markerCache.has(color)) return markerCache.get(color);
    const id = 'glink-arrow-' + markerCache.size;
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', id);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const arrowPath = document.createElementNS(SVG_NS, 'path');
    arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    arrowPath.style.fill = color;
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    markerCache.set(color, id);
    return id;
  }

  links.forEach((link) => {
    const from = findNode(root, link.fromId);
    const to = findNode(root, link.toId);
    if (!from || !to || from.x == null || to.x == null) return; // hidden or stale
    const color = link.color || DEFAULT_LINK_COLOR;
    const x1 = from.x, y1 = from.y, x2 = to.x, y2 = to.y;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(70, len * 0.18);
    const cx = mx + (-dy / len) * bow, cy = my + (dx / len) * bow;
    const d = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;

    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.linkId = link.id;

    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'glink-hit');
    g.appendChild(hit);

    const visible = document.createElementNS(SVG_NS, 'path');
    visible.setAttribute('d', d);
    visible.setAttribute('class', 'glink' + (link.id === selectedLinkId ? ' selected' : ''));
    visible.style.stroke = color;
    const arrows = link.arrows || 'end';
    if (arrows !== 'none') visible.setAttribute('marker-end', `url(#${markerFor(color)})`);
    if (arrows === 'both') visible.setAttribute('marker-start', `url(#${markerFor(color)})`);
    g.appendChild(visible);

    svg.appendChild(g);
  });
}

function drawNodes(state) {
  const { root, selectedId, editingId, linkSourceId } = state;
  const layer = document.getElementById('nodes');
  layer.innerHTML = '';
  const list = [];
  collectVisible(root, list);
  list.forEach((n) => {
    const div = document.createElement('div');
    const classes = ['node-box'];
    if (n.isRoot) classes.push('root-box');
    if (n.id === selectedId) classes.push('selected');
    if (n.collapsed && n.children.length) classes.push('collapsed');
    if (n.id === linkSourceId) classes.push('link-source');
    if (n.link) classes.push('has-link');
    div.className = classes.join(' ');
    div.style.left = n.x + 'px';
    div.style.top = n.y + 'px';
    div.style.width = n.w + 'px';
    if (n.color) div.style.background = n.color;
    div.dataset.id = n.id;

    if (n.icons.length) {
      const icons = document.createElement('div');
      icons.className = 'node-icons';
      icons.textContent = n.icons.join(' ');
      div.appendChild(icons);
    }

    const span = document.createElement('div');
    span.className = 'node-text';
    span.textContent = n.text;
    if (n.id === editingId) {
      span.contentEditable = 'true';
      span.spellcheck = false;
    }
    div.appendChild(span);

    if (n.link) {
      const badge = document.createElement('div');
      badge.className = 'link-badge';
      badge.textContent = '🔗';
      badge.title = n.link;
      badge.dataset.id = n.id;
      div.appendChild(badge);
    }

    if (n.children.length) {
      const fold = document.createElement('div');
      fold.className = 'fold-toggle ' + (n.side === 'left' ? 'side-left' : 'side-right');
      fold.textContent = n.collapsed ? '+' : '−';
      fold.dataset.id = n.id;
      div.appendChild(fold);
    }

    layer.appendChild(div);
  });
}

export function render(state) {
  computeLayout(state.root, measureNode, state.layoutOpts);
  drawClouds(state.root);
  drawEdges(state.root);
  drawGraphicalLinks(state.root, state.graphicalLinks, state.selectedLinkId);
  drawNodes(state);
}
