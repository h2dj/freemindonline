import { computeLayout } from './layout.js';
import { measureNode } from './measure.js';

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

function drawEdges(root) {
  const svg = document.getElementById('edges');
  svg.innerHTML = '';
  const list = [];
  collectVisible(root, list);
  list.forEach((n) => {
    if (n.collapsed || !n.children.length) return;
    n.children.forEach((c) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
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

function drawNodes(root, selectedId, editingId) {
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
    div.className = classes.join(' ');
    div.style.left = n.x + 'px';
    div.style.top = n.y + 'px';
    div.style.width = n.w + 'px';
    if (n.color) div.style.background = n.color;
    div.dataset.id = n.id;

    const span = document.createElement('div');
    span.className = 'node-text';
    span.textContent = n.text;
    if (n.id === editingId) {
      span.contentEditable = 'true';
      span.spellcheck = false;
    }
    div.appendChild(span);

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
  drawEdges(state.root);
  drawNodes(state.root, state.selectedId, state.editingId);
}
