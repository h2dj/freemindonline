// Shared representation for "icon" tokens attached to nodes. Most are
// plain emoji characters, but the numbered badges (for numbering nodes)
// are stored as small string tokens ('#1'..'#9') and rendered as colored
// circular badges instead — no single Unicode glyph renders "white text
// on an arbitrary background color" the way plain CSS can.
//
// Centralized here so render.js (actual node rendering), measure.js (the
// offscreen probe used to size nodes), and main.js (the icon sidebar and
// picker) all build pixel-identical markup for a given icon — if any of
// them drifted from the others, node boxes would end up laid out at the
// wrong size, or the picker would look different from what gets applied.

export const NUMBER_BADGE_COLORS = {
  1: '#ef4444', 2: '#f97316', 3: '#d97706', 4: '#16a34a', 5: '#0d9488',
  6: '#2563eb', 7: '#4f46e5', 8: '#9333ea', 9: '#db2777',
};

export function isNumberBadge(icon) {
  return /^#[1-9]$/.test(icon);
}

// Builds the DOM node for one icon token: a colored badge <span> for
// '#1'..'#9', or a plain text node for anything else (regular emoji).
export function renderIconToken(icon) {
  const m = /^#([1-9])$/.exec(icon);
  if (m) {
    const span = document.createElement('span');
    span.className = 'icon-badge';
    span.style.background = NUMBER_BADGE_COLORS[m[1]];
    span.textContent = m[1];
    return span;
  }
  return document.createTextNode(icon);
}
