// Measures how big a node's box would render as, by rendering it into a
// hidden probe element that shares the real .node-box/.root-box CSS rules
// and the same .node-icons/.node-text child structure real nodes get (see
// render.js's drawNodes) — right down to using renderIconToken for each
// icon, so a colored number badge measures the same here as it paints.
// This keeps layout.js's math and the actual DOM output pixel-consistent.

import { renderIconToken } from './icons.js';

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
  el.innerHTML = '';

  if (node.icons && node.icons.length) {
    const icons = document.createElement('div');
    icons.className = 'node-icons';
    node.icons.forEach((icon, i) => {
      if (i > 0) icons.appendChild(document.createTextNode(' '));
      icons.appendChild(renderIconToken(icon));
    });
    el.appendChild(icons);
  }

  const text = document.createElement('div');
  text.className = 'node-text';
  text.textContent = node.text && node.text.length ? node.text : ' ';
  el.appendChild(text);

  const rect = el.getBoundingClientRect();
  el.classList.remove('root-box');
  return {
    w: Math.max(Math.ceil(rect.width), 28),
    h: Math.max(Math.ceil(rect.height), 22),
  };
}
