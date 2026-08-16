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
    if (e.target.closest('.glink-hit')) return; // handled on click; no pan/drag from a link
    if (e.target.closest('.link-badge')) return; // handled on click; selecting/dragging here would rebuild the DOM mid-click
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
    const linkBadge = e.target.closest('.link-badge');
    if (linkBadge) {
      ctx.openLink(linkBadge.dataset.id);
      e.stopPropagation();
      return;
    }
    const linkHit = e.target.closest('.glink-hit');
    if (linkHit) {
      ctx.selectGraphicalLink(linkHit.closest('g').dataset.linkId);
      e.stopPropagation();
      return;
    }
    const foldEl = e.target.closest('.fold-toggle');
    if (foldEl) {
      ctx.toggleCollapse(foldEl.dataset.id);
      e.stopPropagation();
      return;
    }
    if (e.target === canvas || e.target === world) {
      ctx.select(null);
      ctx.selectGraphicalLink(null);
      ctx.cancelLinkMode();
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const linkHit = e.target.closest('.glink-hit');
    if (linkHit) {
      ctx.showLinkContextMenu(linkHit.closest('g').dataset.linkId, e.clientX, e.clientY);
      return;
    }
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
    if (!e.target.closest('#icon-picker')) ctx.hideIconPicker();
    if (!e.target.closest('#file-menu') && !e.target.closest('#btn-menu')) ctx.hideFileMenu();
  });

  // ---------- Touch: one-finger pan/select/drag, two-finger pinch-zoom,
  // long-press for the context menu, double-tap to edit. ----------
  const TOUCH_MOVE_THRESHOLD = 8;
  const LONG_PRESS_MS = 500;
  const DOUBLE_TAP_MS = 350;

  let pinch = null;
  let longPressTimer = null;
  let lastTap = null;

  function touchDist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }
  function touchMid(t0, t1) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }
  function resetTouchState() {
    clearTimeout(longPressTimer);
    pinch = null;
    panDrag = null;
    nodeDrag = null;
    clearDropHighlight();
    nodesLayer.classList.remove('dragging-node');
  }

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      clearTimeout(longPressTimer);
      panDrag = null;
      nodeDrag = null;
      const [t0, t1] = e.touches;
      const rect = canvas.getBoundingClientRect();
      const mid = touchMid(t0, t1);
      pinch = {
        startDist: touchDist(t0, t1),
        startZoom: state.zoom,
        anchorX: (mid.x - rect.left - state.pan.x) / state.zoom,
        anchorY: (mid.y - rect.top - state.pan.y) / state.zoom,
      };
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];

    const linkBadge = t.target.closest?.('.link-badge');
    if (linkBadge) {
      e.preventDefault();
      ctx.openLink(linkBadge.dataset.id);
      return;
    }

    const linkHit = t.target.closest?.('.glink-hit');
    if (linkHit) {
      e.preventDefault();
      const linkId = linkHit.closest('g').dataset.linkId;
      ctx.selectGraphicalLink(linkId);
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
        ctx.showLinkContextMenu(linkId, t.clientX, t.clientY);
      }, LONG_PRESS_MS);
      return;
    }

    const foldEl = t.target.closest?.('.fold-toggle');
    if (foldEl) {
      e.preventDefault();
      ctx.toggleCollapse(foldEl.dataset.id);
      return;
    }

    const nodeEl = t.target.closest?.('.node-box');
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      const alreadyEditingThis = state.editingId === id && t.target.closest('.node-text');
      if (!alreadyEditingThis) ctx.select(id);
      if (alreadyEditingThis) return; // let native caret placement / keyboard happen
      nodeDrag = { id, startX: t.clientX, startY: t.clientY, moved: false, longPressFired: false };
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        if (!nodeDrag || nodeDrag.moved) return;
        nodeDrag.longPressFired = true;
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
        ctx.showContextMenu(id, nodeDrag.startX, nodeDrag.startY);
      }, LONG_PRESS_MS);
      e.preventDefault();
      return;
    }

    panDrag = { startX: t.clientX, startY: t.clientY, ox: state.pan.x, oy: state.pan.y };
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!pinch && !panDrag && !nodeDrag) return; // e.g. actively editing text — let it scroll/select natively
    e.preventDefault();

    if (pinch && e.touches.length === 2) {
      const [t0, t1] = e.touches;
      const rect = canvas.getBoundingClientRect();
      const scale = touchDist(t0, t1) / pinch.startDist;
      const newZoom = Math.min(3, Math.max(0.2, pinch.startZoom * scale));
      const mid = touchMid(t0, t1);
      state.zoom = newZoom;
      state.pan.x = (mid.x - rect.left) - pinch.anchorX * newZoom;
      state.pan.y = (mid.y - rect.top) - pinch.anchorY * newZoom;
      ctx.applyTransform();
      return;
    }

    if (panDrag && e.touches.length === 1) {
      const t = e.touches[0];
      state.pan.x = panDrag.ox + (t.clientX - panDrag.startX);
      state.pan.y = panDrag.oy + (t.clientY - panDrag.startY);
      ctx.applyTransform();
      return;
    }

    if (nodeDrag && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - nodeDrag.startX;
      const dy = t.clientY - nodeDrag.startY;
      if (Math.abs(dx) > TOUCH_MOVE_THRESHOLD || Math.abs(dy) > TOUCH_MOVE_THRESHOLD) {
        if (!nodeDrag.moved) clearTimeout(longPressTimer);
        nodeDrag.moved = true;
        nodesLayer.classList.add('dragging-node');
        highlightDropTarget(t.clientX, t.clientY);
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length > 0) return; // wait for all fingers to lift

    clearTimeout(longPressTimer);
    const changed = e.changedTouches[0];

    if (nodeDrag) {
      if (nodeDrag.moved) {
        clearDropHighlight();
        const targetEl = changed && document.elementFromPoint(changed.clientX, changed.clientY)?.closest('.node-box');
        if (targetEl && targetEl.dataset.id !== nodeDrag.id) {
          ctx.reparent(nodeDrag.id, targetEl.dataset.id, changed.clientX);
        }
      } else if (!nodeDrag.longPressFired) {
        const now = Date.now();
        if (lastTap && lastTap.id === nodeDrag.id && now - lastTap.time < DOUBLE_TAP_MS) {
          ctx.startEdit(nodeDrag.id);
          lastTap = null;
        } else {
          lastTap = { id: nodeDrag.id, time: now };
        }
      }
    }
    panDrag = null;
    nodeDrag = null;
    nodesLayer.classList.remove('dragging-node');
  });

  canvas.addEventListener('touchcancel', resetTouchState);

  document.addEventListener('touchstart', (e) => {
    if (!state.editingId) return;
    const activeEl = document.querySelector(`.node-box[data-id="${CSS.escape(state.editingId)}"] .node-text`);
    if (activeEl && !activeEl.contains(e.target)) ctx.commitEdit();
  }, true);
}

export function setupKeyboard(state, ctx) {
  document.addEventListener('keydown', (e) => {
    if (state.settingsOpen) {
      if (e.key === 'Escape') { ctx.closeSettings(); e.preventDefault(); }
      return;
    }

    const editing = !!state.editingId;
    if (editing) {
      if (e.key === 'Escape') { ctx.cancelEdit(); e.preventDefault(); }
      else if (e.key === 'Enter' && !e.shiftKey) { ctx.commitEdit(); e.preventDefault(); }
      else if (e.key === 'Insert') { e.preventDefault(); ctx.commitEdit(); ctx.addChild(); }
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;

    if (e.key === 'Escape') {
      if (state.linkSourceId) { ctx.cancelLinkMode(); e.preventDefault(); return; }
      if (state.selectedLinkId) { ctx.selectGraphicalLink(null); e.preventDefault(); return; }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedLinkId) {
      ctx.deleteGraphicalLink(state.selectedLinkId);
      e.preventDefault();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      ctx.undo(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      ctx.redo(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      ctx.saveJSON(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      ctx.printMap(); e.preventDefault(); return;
    }
    if (!state.selectedId) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      ctx.setLinkPrompt(state.selectedId); e.preventDefault(); return;
    }

    if (e.ctrlKey) {
      switch (e.key) {
        case 'ArrowUp': e.preventDefault(); ctx.reorder(-1); return;
        case 'ArrowDown': e.preventDefault(); ctx.reorder(1); return;
        case 'ArrowLeft': e.preventDefault(); ctx.changeLevel('left'); return;
        case 'ArrowRight': e.preventDefault(); ctx.changeLevel('right'); return;
        default: break;
      }
    }

    switch (e.key) {
      case 'Insert': e.preventDefault(); ctx.addChild(); break;
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
