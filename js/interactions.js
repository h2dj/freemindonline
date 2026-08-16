// Wires DOM events (mouse, touch-ish drag, wheel, keyboard) to the `ctx`
// action object built in main.js. This module never mutates the document
// model directly; it only decides *when* to call into `ctx`.

export function startEditImpl(state, id, renderFn, onBlurCommit) {
  state.editingId = id;
  renderFn(); // synchronous DOM update — safe to focus right after, no rAF needed
  const el = document.querySelector(`.node-box[data-id="${CSS.escape(id)}"] .node-text`);
  if (!el) return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  if (onBlurCommit) el.addEventListener('blur', onBlurCommit, { once: true });
}

export function setupCanvasInteractions(state, ctx) {
  const canvas = document.getElementById('canvas');
  const world = document.getElementById('world');
  const nodesLayer = document.getElementById('nodes');

  let panDrag = null;
  let nodeDrag = null;

  function clearDropHighlight() {
    document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  }

  function highlightDropTarget(clientX, clientY) {
    clearDropHighlight();
    const el = document.elementFromPoint(clientX, clientY)?.closest('.node-box');
    if (el && el.dataset.id !== nodeDrag.id) el.classList.add('drop-target');
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const nodeEl = e.target.closest('.node-box');
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      const alreadyEditingThis = state.editingId === id && e.target.closest('.node-text');
      if (!alreadyEditingThis) {
        ctx.select(id);
      }
      if (alreadyEditingThis) return; // let native text caret placement happen
      nodeDrag = { id, startX: e.clientX, startY: e.clientY, moved: false };
      e.preventDefault();
      return;
    }
    panDrag = { startX: e.clientX, startY: e.clientY, ox: state.pan.x, oy: state.pan.y };
  });

  window.addEventListener('mousemove', (e) => {
    if (panDrag) {
      state.pan.x = panDrag.ox + (e.clientX - panDrag.startX);
      state.pan.y = panDrag.oy + (e.clientY - panDrag.startY);
      ctx.applyTransform();
    } else if (nodeDrag) {
      const dx = e.clientX - nodeDrag.startX;
      const dy = e.clientY - nodeDrag.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        nodeDrag.moved = true;
        nodesLayer.classList.add('dragging-node');
        highlightDropTarget(e.clientX, e.clientY);
      }
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (nodeDrag && nodeDrag.moved) {
      clearDropHighlight();
      const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node-box');
      if (targetEl && targetEl.dataset.id !== nodeDrag.id) {
        ctx.reparent(nodeDrag.id, targetEl.dataset.id, e.clientX);
      }
    }
    panDrag = null;
    nodeDrag = null;
    nodesLayer.classList.remove('dragging-node');
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(3, Math.max(0.2, state.zoom * factor));
    state.pan.x = mx - (mx - state.pan.x) * (newZoom / state.zoom);
    state.pan.y = my - (my - state.pan.y) * (newZoom / state.zoom);
    state.zoom = newZoom;
    ctx.applyTransform();
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const nodeEl = e.target.closest('.node-box');
    if (!nodeEl) return;
    ctx.select(nodeEl.dataset.id);
    ctx.startEdit(nodeEl.dataset.id);
  });

  canvas.addEventListener('click', (e) => {
    const foldEl = e.target.closest('.fold-toggle');
    if (foldEl) {
      ctx.toggleCollapse(foldEl.dataset.id);
      e.stopPropagation();
      return;
    }
    if (e.target === canvas || e.target === world) ctx.select(null);
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const nodeEl = e.target.closest('.node-box');
    if (nodeEl) {
      ctx.select(nodeEl.dataset.id);
      ctx.showContextMenu(nodeEl.dataset.id, e.clientX, e.clientY);
    }
  });

  // Commit any pending text edit whenever the user interacts outside of it
  // (toolbar buttons, context menu, background clicks, etc).
  document.addEventListener('mousedown', (e) => {
    if (!state.editingId) return;
    const activeEl = document.querySelector(`.node-box[data-id="${CSS.escape(state.editingId)}"] .node-text`);
    if (activeEl && !activeEl.contains(e.target)) ctx.commitEdit();
  }, true);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) ctx.hideContextMenu();
  });
}

export function setupKeyboard(state, ctx) {
  document.addEventListener('keydown', (e) => {
    const editing = !!state.editingId;
    if (editing) {
      if (e.key === 'Escape') { ctx.cancelEdit(); e.preventDefault(); }
      else if (e.key === 'Enter' && !e.shiftKey) { ctx.commitEdit(); e.preventDefault(); }
      else if (e.key === 'Tab') { e.preventDefault(); ctx.commitEdit(); ctx.addChild(); }
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      ctx.undo(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      ctx.redo(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      ctx.saveJSON(); e.preventDefault(); return;
    }
    if (!state.selectedId) return;

    switch (e.key) {
      case 'Tab': e.preventDefault(); ctx.addChild(); break;
      case 'Enter': e.preventDefault(); ctx.addSibling(); break;
      case 'F2': e.preventDefault(); ctx.startEdit(state.selectedId); break;
      case 'Delete': case 'Backspace': e.preventDefault(); ctx.deleteSelected(); break;
      case ' ': e.preventDefault(); ctx.toggleCollapse(state.selectedId); break;
      case 'ArrowUp': e.preventDefault(); ctx.moveSelect('up'); break;
      case 'ArrowDown': e.preventDefault(); ctx.moveSelect('down'); break;
      case 'ArrowLeft': e.preventDefault(); ctx.moveSelect('left'); break;
      case 'ArrowRight': e.preventDefault(); ctx.moveSelect('right'); break;
      default: break;
    }
  });
}
