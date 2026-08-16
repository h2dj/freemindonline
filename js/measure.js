// Measures how big a node's box would render as, by rendering it into a
// hidden probe element that shares the real .node-box/.root-box CSS rules.
// This keeps layout.js's math and the actual DOM output pixel-consistent.

let probe = null;

function getProbe() {
  if (!probe) {
    probe = document.createElement('div');
    probe.className = 'node-box measure-probe';
    document.body.appendChild(probe);
  }
  return probe;
}

export function measureNode(node) {
  const el = getProbe();
  el.classList.toggle('root-box', !!node.isRoot);
  el.style.width = '';
  const iconPrefix = node.icons && node.icons.length ? node.icons.join(' ') + ' ' : '';
  el.textContent = iconPrefix + (node.text && node.text.length ? node.text : ' ');
  const rect = el.getBoundingClientRect();
  el.classList.remove('root-box');
  return {
    w: Math.max(Math.ceil(rect.width), 28),
    h: Math.max(Math.ceil(rect.height), 22),
  };
}
