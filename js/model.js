// Core mind-map data model: plain tree of nodes plus mutation helpers.
// A node looks like:
// { id, text, children: [Node], collapsed, color, side: 'left'|'right'|null,
//   parent: Node|null, isRoot, cloud: colorString|null, link: string|null,
//   icons: string[] }
// `parent` is a live back-reference used only at runtime; it is stripped
// when serializing (see toPlain/fromPlain) so the tree stays JSON-safe.

export function makeId() {
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
    cloud: null,
    link: null,
    icons: [],
    // null = no checkbox on this node; true/false = checkbox present, checked or not.
    checkbox: null,
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
// `atIndex`, if given, inserts the node at that position in newParent's
// children instead of appending it at the end.
export function reparentNode(node, newParent, sideHint, atIndex) {
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
  if (atIndex == null || atIndex > newParent.children.length) {
    newParent.children.push(node);
  } else {
    newParent.children.splice(atIndex, 0, node);
  }
  newParent.collapsed = false;
  return true;
}

// The root's `children` array interleaves its left- and right-side
// top-level branches in a single list (order preserved per side, see
// pickSide). Anything that walks "siblings" needs to stay within the same
// visual side for root's direct children, or it'll jump across the canvas;
// for any other parent all children already share one side, so this is a
// no-op filter there.
function sameSideSiblingsOf(node) {
  const parent = node.parent;
  if (!parent) return [];
  if (!parent.isRoot) return parent.children;
  const side = node.side || 'right';
  return parent.children.filter((c) => (c.side || 'right') === side);
}

// dir: -1 (move earlier/up) or +1 (move later/down) among same-side siblings.
export function canReorderNode(node, dir) {
  const sibs = sameSideSiblingsOf(node);
  const idx = sibs.indexOf(node);
  if (idx < 0) return false;
  const newIdx = idx + dir;
  return newIdx >= 0 && newIdx < sibs.length;
}

export function reorderNode(node, dir) {
  if (!canReorderNode(node, dir)) return false;
  const sibs = sameSideSiblingsOf(node);
  const idx = sibs.indexOf(node);
  const other = sibs[idx + dir];
  const parent = node.parent;
  const realIdxA = parent.children.indexOf(node);
  const realIdxB = parent.children.indexOf(other);
  [parent.children[realIdxA], parent.children[realIdxB]] = [parent.children[realIdxB], parent.children[realIdxA]];
  return true;
}

// Promotes `node` one level up: it becomes a sibling of its current parent,
// placed immediately after it. Not possible for a top-level (root-child) node.
export function canPromoteNode(node) {
  return !!(node.parent && node.parent.parent);
}

export function promoteNode(node) {
  if (!canPromoteNode(node)) return false;
  const parent = node.parent;
  const grandparent = parent.parent;
  const parentIdx = grandparent.children.indexOf(parent);
  const sideHint = grandparent.isRoot ? parent.side : undefined;
  return reparentNode(node, grandparent, sideHint, parentIdx + 1);
}

// Demotes `node` one level down: it becomes the last child of its previous
// (same-side) sibling. Not possible for a first child (no previous sibling).
export function canDemoteNode(node) {
  const sibs = sameSideSiblingsOf(node);
  return sibs.indexOf(node) > 0;
}

export function demoteNode(node) {
  if (!canDemoteNode(node)) return false;
  const sibs = sameSideSiblingsOf(node);
  const newParent = sibs[sibs.indexOf(node) - 1];
  return reparentNode(node, newParent);
}

// Flips a top-level (root-child) node — and its whole subtree — from the
// left branch to the right one or vice versa. This is the only node-level
// move available for a root child on the "toward the root" side, since it
// has no grandparent to promote into.
export function canFlipRootChildSide(node) {
  return !!(node.parent && node.parent.isRoot);
}

export function flipRootChildSide(node) {
  if (!canFlipRootChildSide(node)) return false;
  setSideRecursive(node, node.side === 'left' ? 'right' : 'left');
  return true;
}

export function toggleCollapse(node) {
  if (node.children.length) node.collapsed = !node.collapsed;
}

// Inserts a brand-new node directly above `node` in the tree: the new node
// takes `node`'s old spot among its parent's children (same side, same
// position), and `node` becomes its sole child. Not possible for the root,
// which has no parent to insert anything between.
export function canInsertParentAbove(node) {
  return !!node.parent;
}

export function insertParentAbove(node, text = '새 노드') {
  if (!canInsertParentAbove(node)) return null;
  const parent = node.parent;
  const idx = parent.children.indexOf(node);
  const wrapper = createNode(text, parent, node.side);
  parent.children[idx] = wrapper;
  wrapper.children = [node];
  node.parent = wrapper;
  return wrapper;
}

// ---------- Chapter 3: clouds, hyperlinks, icons ----------

export function setCloud(node, color) {
  node.cloud = color || null;
}

export function setLink(node, url) {
  node.link = url ? url.trim() || null : null;
}

export function addIcon(node, icon) {
  node.icons.push(icon);
}

export function removeLastIcon(node) {
  node.icons.pop();
}

export function clearIcons(node) {
  node.icons.length = 0;
}

// ---------- Checkboxes / checklist ----------

export function addCheckbox(node) {
  node.checkbox = false; // freshly added checkboxes start unchecked
}

export function removeCheckbox(node) {
  node.checkbox = null;
}

export function toggleCheckboxChecked(node) {
  if (node.checkbox == null) return;
  node.checkbox = !node.checkbox;
}

// Every node in the tree that currently has a checkbox, in document order —
// regardless of collapsed state, since the checklist panel is meant to
// surface tasks even while their branch is folded away on the canvas.
export function collectCheckboxNodes(node, out = []) {
  if (node.checkbox != null) out.push(node);
  node.children.forEach((c) => collectCheckboxNodes(c, out));
  return out;
}

// The chain of ancestor titles from the center topic down to (but not
// including) `node` itself, e.g. ["중심 주제", "Branch"] for a grandchild —
// walks the live `.parent` back-references, so it always reflects the
// node's current position even after a reparent/promote/demote. Shared by
// the checklist panel's ancestor breadcrumb (main.js) and the
// clipboard-copy markdown (io.js), so both describe a node's position the
// same way.
export function ancestorPathText(node) {
  const names = [];
  for (let p = node.parent; p; p = p.parent) {
    names.unshift(p.text || (p.isRoot ? '중심 주제' : '(제목 없음)'));
  }
  return names.join(' › ');
}

// All node ids in `node`'s own subtree (including itself) — used to prune
// graphical links that reference a node about to be deleted.
export function collectSubtreeIds(node, out = []) {
  out.push(node.id);
  node.children.forEach((c) => collectSubtreeIds(c, out));
  return out;
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
    cloud: node.cloud || null,
    link: node.link || null,
    icons: node.icons.slice(),
    checkbox: typeof node.checkbox === 'boolean' ? node.checkbox : null,
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
    cloud: plain.cloud || null,
    link: plain.link || null,
    icons: Array.isArray(plain.icons) ? plain.icons.slice() : [],
    checkbox: typeof plain.checkbox === 'boolean' ? plain.checkbox : null,
  };
  node.children = (plain.children || []).map((c) => fromPlain(c, node));
  return node;
}
