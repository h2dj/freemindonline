// Computes a FreeMind-style horizontal tree layout: the root sits at the
// origin, top-level children fan out to the left and right, and every
// deeper node is stacked so that no subtree overlaps its neighbors
// vertically. Mutates x/y/w/h/subtreeHeight directly onto each node.

export function computeLayout(root, sizeOf, opts = {}) {
  const H_GAP = opts.hGap ?? 70;
  const V_GAP = opts.vGap ?? 14;

  function sizeAndStack(node) {
    const size = sizeOf(node);
    node.w = size.w;
    node.h = size.h;
    const visibleChildren = node.collapsed ? [] : node.children;
    if (!visibleChildren.length) {
      node.subtreeHeight = node.h;
      return;
    }
    let total = 0;
    visibleChildren.forEach((c, i) => {
      sizeAndStack(c);
      total += c.subtreeHeight + (i > 0 ? V_GAP : 0);
    });
    node.subtreeHeight = Math.max(node.h, total);
  }

  sizeAndStack(root);

  function place(node, side, x, centerY) {
    node.x = x;
    node.y = centerY;
    node.side = node.isRoot ? null : side;
    const visibleChildren = node.collapsed ? [] : node.children;
    if (!visibleChildren.length) return;
    let cursor = centerY - node.subtreeHeight / 2;
    visibleChildren.forEach((c) => {
      const cx = side === 'left'
        ? x - (node.w / 2 + H_GAP + c.w / 2)
        : x + (node.w / 2 + H_GAP + c.w / 2);
      const cy = cursor + c.subtreeHeight / 2;
      place(c, side, cx, cy);
      cursor += c.subtreeHeight + V_GAP;
    });
  }

  root.x = 0;
  root.y = 0;
  const rightKids = root.collapsed ? [] : root.children.filter((c) => c.side !== 'left');
  const leftKids = root.collapsed ? [] : root.children.filter((c) => c.side === 'left');

  function placeSide(kids, side) {
    const totalH = kids.reduce((s, c, i) => s + c.subtreeHeight + (i > 0 ? V_GAP : 0), 0);
    let cursor = -totalH / 2;
    kids.forEach((c) => {
      const cx = side === 'left'
        ? -(root.w / 2 + H_GAP + c.w / 2)
        : (root.w / 2 + H_GAP + c.w / 2);
      const cy = cursor + c.subtreeHeight / 2;
      place(c, side, cx, cy);
      cursor += c.subtreeHeight + V_GAP;
    });
  }

  placeSide(rightKids, 'right');
  placeSide(leftKids, 'left');

  return root;
}
