// Core mind-map data model: plain tree of nodes plus mutation helpers.
// A node looks like:
// { id, text, children: [Node], collapsed, color, side: 'left'|'right'|null, parent: Node|null, isRoot }
// `parent` is a live back-reference used only at runtime; it is stripped
// when serializing (see toPlain/fromPlain) so the tree stays JSON-safe.

function makeId() {
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function createNode(text, parent, side) {
  return {
    id: makeId(),
    text: text || '',
    children: [],
    collapsed: false,
    color: null,
    side: side || null,
    parent: parent || null,
    isRoot: false,
  };
}

export function createDefaultRoot() {
  const root = createNode('중심 주제', null, null);
  root.isRoot = true;
  return root;
}

// Balances new top-level children between the right and left sides of the root.
export function pickSide(root) {
  let left = 0, right = 0;
  root.children.forEach((c) => (c.side === 'left' ? left++ : right++));
  return right <= left ? 'right' : 'left';
}

export function setSideRecursive(node, side) {
  node.side = node.isRoot ? null : side;
  node.children.forEach((c) => setSideRecursive(c, side));
}

export function addChild(parent, text = '새 노드') {
  const side = parent.isRoot ? pickSide(parent) : parent.side;
  const node = createNode(text, parent, side);
  parent.children.push(node);
  parent.collapsed = false;
  return node;
}

export function addSiblingAfter(node, text = '새 노드') {
  if (!node.parent) return addChild(node, text); // root has no siblings
  const parent = node.parent;
  const idx = parent.children.indexOf(node);
  const sibling = createNode(text, parent, node.side);
  parent.children.splice(idx + 1, 0, sibling);
  return sibling;
}

export function deleteSubtree(node) {
  if (!node.parent) return null; // cannot delete the root
  const parent = node.parent;
  const idx = parent.children.indexOf(node);
  if (idx >= 0) parent.children.splice(idx, 1);
  return parent;
}

// Moves `node` (and its whole subtree) under `newParent`. `sideHint` is only
// used when `newParent` is the root, to choose which side it lands on.
export function reparentNode(node, newParent, sideHint) {
  let p = newParent;
  while (p) {
    if (p === node) return false; // would create a cycle
    p = p.parent;
  }
  const old = node.parent;
  if (old) {
    const idx = old.children.indexOf(node);
    if (idx >= 0) old.children.splice(idx, 1);
  }
  node.parent = newParent;
  const side = newParent.isRoot ? (sideHint || pickSide(newParent)) : newParent.side;
  setSideRecursive(node, side);
  newParent.children.push(node);
  newParent.collapsed = false;
  return true;
}

export function toggleCollapse(node) {
  if (node.children.length) node.collapsed = !node.collapsed;
}

export function forEachNode(root, fn) {
  fn(root);
  root.children.forEach((c) => forEachNode(c, fn));
}

export function findNode(root, id) {
  if (!id) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

export function countDescendants(node) {
  let count = 0;
  node.children.forEach((c) => (count += 1 + countDescendants(c)));
  return count;
}

// dir: -1 (previous sibling) or +1 (next sibling)
export function moveSelectionVertical(node, dir) {
  if (!node.parent) return node;
  const sibs = node.parent.children;
  const idx = sibs.indexOf(node);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= sibs.length) return node;
  return sibs[newIdx];
}

// dir: -1 (screen-left) or +1 (screen-right). Moves toward children on the
// side the node is growing out to, or back to the parent otherwise.
export function moveSelectionHorizontal(node, dir) {
  if (node.isRoot) {
    const wantSide = dir === 1 ? 'right' : 'left';
    const target = node.children.find((c) => (c.side || 'right') === wantSide);
    return target || node;
  }
  const outward = node.side === 'left' ? -1 : 1;
  if (dir === outward) {
    if (node.children.length && !node.collapsed) return node.children[0];
    return node;
  }
  return node.parent || node;
}

export function toPlain(node) {
  return {
    id: node.id,
    text: node.text,
    collapsed: !!node.collapsed,
    color: node.color || null,
    side: node.side || null,
    isRoot: !!node.isRoot,
    children: node.children.map(toPlain),
  };
}

export function fromPlain(plain, parent = null) {
  const node = {
    id: plain.id || makeId(),
    text: plain.text || '',
    children: [],
    collapsed: !!plain.collapsed,
    color: plain.color || null,
    side: plain.side || null,
    parent,
    isRoot: !!plain.isRoot,
  };
  node.children = (plain.children || []).map((c) => fromPlain(c, node));
  return node;
}
