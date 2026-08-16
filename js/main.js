import {
  createDefaultRoot, addChild, addSiblingAfter, deleteSubtree, toggleCollapse,
  reparentNode, findNode, moveSelectionHorizontal, makeId,
  reorderNode, canReorderNode, promoteNode, canPromoteNode, demoteNode, canDemoteNode,
  flipRootChildSide, canFlipRootChildSide,
  setCloud, setLink, addIcon, removeLastIcon, clearIcons, collectSubtreeIds,
  toPlain, fromPlain, countDescendants,
} from './model.js';
import { render, nextVisibleSameSide } from './render.js';
import { setupCanvasInteractions, setupKeyboard, startEditImpl } from './interactions.js';
import { autosave, loadAutosaved, downloadJSON, parseJSONFile, exportMM, parseMM, exportPNG, printMap } from './io.js';
import { createHistory } from './undo.js';
import {
  loadSettings, saveSettings, applySettings,
  NODE_COLOR_PRESETS, ACCENT_COLOR_PRESETS, DEFAULT_SETTINGS,
} from './settings.js';

const CLOUD_COLORS = ['#c9d6e3', '#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fecaca'];
const LINK_COLORS = ['#f97316', '#2563eb', '#16a34a', '#db2777', '#64748b'];
const ICON_PALETTE = ['⭐', '❗', '❓', '✅', '❌', '⚠️', '💡', '📌', '🚩', '❤️', '⏰', '🔥', '👍', '👎', '🔒', '📎', '🎯', '🏆'];

// App-level preferences (font size / default colors) — separate from the
// map document itself, applied once up front so the very first layout
// pass already measures nodes at the right font size.
let settings = loadSettings();
applySettings(settings);

const loaded = loadAutosaved();
const state = {
  root: loaded ? loaded.root : createDefaultRoot(),
  graphicalLinks: loaded ? loaded.graphicalLinks : [],
  selectedId: null,
  editingId: null,
  linkSourceId: null,
  selectedLinkId: null,
  settingsOpen: false,
  pan: { x: 0, y: 0 },
  zoom: 1,
};
state.selectedId = state.root.id;

const history = createHistory(
  () => ({
    plain: toPlain(state.root),
    selectedId: state.selectedId,
    links: state.graphicalLinks.map((l) => ({ ...l })),
  }),
  (snap) => {
    state.root = fromPlain(snap.plain);
    state.selectedId = snap.selectedId;
    state.graphicalLinks = (snap.links || []).map((l) => ({ ...l }));
    state.editingId = null;
    state.linkSourceId = null;
    state.selectedLinkId = null;
    rerenderAll();
  },
);

function applyTransform() {
  document.getElementById('world').style.transform =
    `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
}

function centerOnRoot() {
  const rect = document.getElementById('canvas').getBoundingClientRect();
  state.pan.x = rect.width / 2;
  state.pan.y = rect.height / 2;
  state.zoom = 1;
  applyTransform();
}

function updateUndoRedoButtons() {
  document.getElementById('btn-undo').disabled = !history.canUndo();
  document.getElementById('btn-redo').disabled = !history.canRedo();
}

// Positions a popup (context menu / icon picker) at (x, y) but keeps it
// fully inside the viewport, so long menus near an edge don't render
// partly off-screen and become unreachable by mouse/touch.
function positionPopup(el, x, y) {
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  const margin = 6;
  const rect = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (rect.right > window.innerWidth - margin) left -= rect.right - (window.innerWidth - margin);
  if (rect.bottom > window.innerHeight - margin) top -= rect.bottom - (window.innerHeight - margin);
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

function renderSwatchRow(containerId, presets, currentValue, onPick) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  presets.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (preset.value === currentValue ? ' active' : '');
    btn.style.background = preset.value;
    btn.title = preset.label;
    btn.onclick = () => onPick(preset);
    el.appendChild(btn);
  });
}

function refreshSettingsUI() {
  document.getElementById('setting-font-size').value = settings.fontSize;
  document.getElementById('setting-font-size-value').textContent = settings.fontSize + 'px';
  renderSwatchRow('setting-node-color', NODE_COLOR_PRESETS, settings.nodeBg, (preset) => {
    ctx.setSetting({ nodeBg: preset.value });
    refreshSettingsUI();
  });
  renderSwatchRow('setting-accent-color', ACCENT_COLOR_PRESETS, settings.accent, (preset) => {
    ctx.setSetting({ accent: preset.value, accentDark: preset.dark });
    refreshSettingsUI();
  });
}

function rerenderAll() {
  render(state);
  applyTransform();
  updateUndoRedoButtons();
  autosave(state.root, state.graphicalLinks);
}

const ctx = {
  select(id) {
    if (state.editingId && state.editingId !== id) this.commitEdit();
    state.selectedId = id;
    render(state);
  },

  toggleCollapse(id) {
    const n = findNode(state.root, id);
    if (!n) return;
    history.push();
    toggleCollapse(n);
    rerenderAll();
  },

  addChild() {
    const n = findNode(state.root, state.selectedId);
    if (!n) return;
    history.push();
    const c = addChild(n, '새 노드');
    state.selectedId = c.id;
    rerenderAll();
    this.startEdit(c.id);
  },

  addSibling() {
    const n = findNode(state.root, state.selectedId);
    if (!n) return;
    history.push();
    const c = addSiblingAfter(n, '새 노드');
    state.selectedId = c.id;
    rerenderAll();
    this.startEdit(c.id);
  },

  deleteSelected() {
    const n = findNode(state.root, state.selectedId);
    if (!n) return;
    if (!n.parent) { toast('루트 노드는 삭제할 수 없습니다.'); return; }
    if (n.children.length && !confirm(`"${n.text}" 노드와 하위 ${countDescendants(n)}개 노드를 삭제할까요?`)) return;
    history.push();
    const removedIds = new Set(collectSubtreeIds(n));
    const parent = deleteSubtree(n);
    state.graphicalLinks = state.graphicalLinks.filter((l) => !removedIds.has(l.fromId) && !removedIds.has(l.toId));
    if (state.selectedLinkId && !state.graphicalLinks.some((l) => l.id === state.selectedLinkId)) {
      state.selectedLinkId = null;
    }
    state.selectedId = parent ? parent.id : state.root.id;
    rerenderAll();
  },

  startEdit(id) {
    if (state.editingId === id) return;
    if (state.editingId) this.commitEdit();
    startEditImpl(state, id, () => render(state), () => this.commitEdit());
  },

  commitEdit() {
    if (!state.editingId) return;
    const id = state.editingId;
    const el = document.querySelector(`.node-box[data-id="${CSS.escape(id)}"] .node-text`);
    const text = el ? el.textContent.replace(/\s+$/, '').trim() : null;
    const n = findNode(state.root, id);
    state.editingId = null;
    if (n && text) {
      if (text !== n.text) {
        history.push();
        n.text = text;
      }
    }
    rerenderAll();
  },

  cancelEdit() {
    state.editingId = null;
    rerenderAll();
  },

  moveSelect(dir) {
    const n = findNode(state.root, state.selectedId);
    if (!n) return;
    let target = n;
    if (dir === 'up') target = nextVisibleSameSide(state.root, n, -1);
    else if (dir === 'down') target = nextVisibleSameSide(state.root, n, 1);
    else target = moveSelectionHorizontal(n, dir === 'right' ? 1 : -1);
    state.selectedId = target.id;
    render(state);
  },

  // dir: -1 moves the node earlier among its siblings, +1 moves it later.
  reorder(dir) {
    const n = findNode(state.root, state.selectedId);
    if (!n) return;
    history.push();
    if (!reorderNode(n, dir)) { history.discardLast(); return; }
    rerenderAll();
  },

  // dir: 'left'/'right' in screen terms — matches moveSelect's convention.
  // The direction pointing further away from the root demotes (nests the
  // node one level deeper, under its previous sibling). The direction
  // pointing back toward the root promotes it (out to be a sibling of its
  // current parent) — except for a root-level node, which has nowhere to
  // promote to, so that direction instead flips it to the opposite branch
  // of the root.
  changeLevel(dir) {
    const n = findNode(state.root, state.selectedId);
    if (!n || !n.parent) return;
    const outward = n.side === 'left' ? -1 : 1;
    const wantDir = dir === 'right' ? 1 : -1;
    const demoting = wantDir === outward;
    history.push();
    let ok;
    if (demoting) ok = demoteNode(n);
    else if (n.parent.isRoot) ok = flipRootChildSide(n);
    else ok = promoteNode(n);
    if (!ok) { history.discardLast(); return; }
    rerenderAll();
  },

  reparent(dragId, targetId, clientX) {
    if (dragId === targetId) return;
    const dragNode = findNode(state.root, dragId);
    const targetNode = findNode(state.root, targetId);
    if (!dragNode || !targetNode) return;
    let p = targetNode;
    while (p) {
      if (p === dragNode) { toast('자기 자신의 하위 노드로는 이동할 수 없습니다.'); return; }
      p = p.parent;
    }
    history.push();
    let sideHint;
    if (targetNode.isRoot) {
      const rootScreenX = document.querySelector(`.node-box[data-id="${CSS.escape(targetId)}"]`).getBoundingClientRect().x
        + document.querySelector(`.node-box[data-id="${CSS.escape(targetId)}"]`).getBoundingClientRect().width / 2;
      sideHint = clientX < rootScreenX ? 'left' : 'right';
    }
    reparentNode(dragNode, targetNode, sideHint);
    state.selectedId = dragNode.id;
    rerenderAll();
  },

  undo() { if (history.undo()) toast('실행 취소됨'); },
  redo() { if (history.redo()) toast('다시 실행됨'); },
  applyTransform,

  saveJSON() { downloadJSON(state.root, state.graphicalLinks); toast('JSON 파일로 저장했습니다.'); },

  // ---------- Chapter 3: clouds ----------
  addCloud(id) {
    const n = findNode(state.root, id);
    if (!n) return;
    history.push();
    setCloud(n, CLOUD_COLORS[0]);
    rerenderAll();
  },
  cycleCloudColor(id) {
    const n = findNode(state.root, id);
    if (!n) return;
    const idx = CLOUD_COLORS.indexOf(n.cloud);
    history.push();
    setCloud(n, CLOUD_COLORS[(idx + 1) % CLOUD_COLORS.length]);
    rerenderAll();
  },
  removeCloud(id) {
    const n = findNode(state.root, id);
    if (!n || !n.cloud) return;
    history.push();
    setCloud(n, null);
    rerenderAll();
  },

  // ---------- Chapter 3: hyperlinks ----------
  setLinkPrompt(id) {
    const n = findNode(state.root, id);
    if (!n) return;
    const url = window.prompt('링크(URL, mailto:...) 를 입력하세요. 비워두고 확인하면 링크가 제거됩니다.', n.link || '');
    if (url === null) return; // cancelled
    history.push();
    setLink(n, url);
    rerenderAll();
  },
  removeLink(id) {
    const n = findNode(state.root, id);
    if (!n || !n.link) return;
    history.push();
    setLink(n, null);
    rerenderAll();
  },
  openLink(id) {
    const n = findNode(state.root, id);
    if (!n || !n.link) return;
    window.open(n.link, '_blank', 'noopener');
  },

  // ---------- Chapter 3: icons ----------
  showIconPicker(id, x, y) {
    const picker = document.getElementById('icon-picker');
    picker.innerHTML = '';
    ICON_PALETTE.forEach((icon) => {
      const btn = document.createElement('button');
      btn.textContent = icon;
      btn.onclick = (e) => { e.stopPropagation(); this.addIconTo(id, icon); this.hideIconPicker(); };
      picker.appendChild(btn);
    });
    picker.classList.remove('hidden');
    positionPopup(picker, x, y);
  },
  hideIconPicker() {
    document.getElementById('icon-picker').classList.add('hidden');
  },
  addIconTo(id, icon) {
    const n = findNode(state.root, id);
    if (!n) return;
    history.push();
    addIcon(n, icon);
    rerenderAll();
  },
  removeLastIcon(id) {
    const n = findNode(state.root, id);
    if (!n || !n.icons.length) return;
    history.push();
    removeLastIcon(n);
    rerenderAll();
  },
  clearIcons(id) {
    const n = findNode(state.root, id);
    if (!n || !n.icons.length) return;
    history.push();
    clearIcons(n);
    rerenderAll();
  },

  // ---------- Chapter 3: graphical links ----------
  startLinkMode(id) {
    state.linkSourceId = id;
    toast('연결할 다른 노드를 우클릭(또는 롱프레스)해서 "여기로 연결"을 선택하세요. Esc로 취소.');
    render(state);
  },
  cancelLinkMode() {
    if (!state.linkSourceId) return;
    state.linkSourceId = null;
    render(state);
  },
  completeLinkMode(targetId) {
    if (!state.linkSourceId || state.linkSourceId === targetId) { this.cancelLinkMode(); return; }
    history.push();
    state.graphicalLinks.push({ id: makeId(), fromId: state.linkSourceId, toId: targetId, color: null, arrows: 'end' });
    state.linkSourceId = null;
    rerenderAll();
  },
  selectGraphicalLink(id) {
    state.selectedLinkId = id;
    render(state);
  },
  showLinkContextMenu(id, x, y) {
    const link = state.graphicalLinks.find((l) => l.id === id);
    if (!link) return;
    state.selectedLinkId = id;
    render(state);
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    const items = [
      ['🎨 색상 변경', () => this.cycleLinkColor(id)],
      ['↔ 화살표 스타일 변경', () => this.cycleLinkArrows(id)],
      ['🗑 링크 삭제', () => this.deleteGraphicalLink(id)],
    ];
    items.forEach(([label, fn]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.onclick = (e) => { e.stopPropagation(); fn(); this.hideContextMenu(); };
      menu.appendChild(btn);
    });
    menu.classList.remove('hidden');
    positionPopup(menu, x, y);
  },
  cycleLinkColor(id) {
    const link = state.graphicalLinks.find((l) => l.id === id);
    if (!link) return;
    // An unset color renders as LINK_COLORS[0] (see DEFAULT_LINK_COLOR in
    // render.js), so index from there — otherwise the first click would be
    // a no-visible-op, landing back on the same color the link already has.
    const idx = LINK_COLORS.indexOf(link.color || LINK_COLORS[0]);
    history.push();
    link.color = LINK_COLORS[(idx + 1) % LINK_COLORS.length];
    rerenderAll();
  },
  cycleLinkArrows(id) {
    const link = state.graphicalLinks.find((l) => l.id === id);
    if (!link) return;
    const order = ['end', 'both', 'none'];
    const idx = order.indexOf(link.arrows || 'end');
    history.push();
    link.arrows = order[(idx + 1) % order.length];
    rerenderAll();
  },
  deleteGraphicalLink(id) {
    const idx = state.graphicalLinks.findIndex((l) => l.id === id);
    if (idx < 0) return;
    history.push();
    state.graphicalLinks.splice(idx, 1);
    if (state.selectedLinkId === id) state.selectedLinkId = null;
    rerenderAll();
  },

  showContextMenu(id, x, y) {
    const menu = document.getElementById('context-menu');
    const n = findNode(state.root, id);
    if (!n) return;
    menu.innerHTML = '';
    const items = [
      ['➕ 하위 노드 추가', () => this.addChild()],
      ['➕ 형제 노드 추가', () => this.addSibling()],
      ['✏️ 이름 변경 (F2)', () => this.startEdit(id)],
    ];
    if (n.children.length) items.push([n.collapsed ? '펼치기' : '접기', () => this.toggleCollapse(id)]);
    if (canReorderNode(n, -1)) items.push(['⬆ 위로 이동 (Ctrl+↑)', () => this.reorder(-1)]);
    if (canReorderNode(n, 1)) items.push(['⬇ 아래로 이동 (Ctrl+↓)', () => this.reorder(1)]);
    if (canPromoteNode(n)) items.push(['◀ 상위 레벨로 이동', () => this.changeLevel(n.side === 'left' ? 'right' : 'left')]);
    else if (canFlipRootChildSide(n)) items.push(['⇄ 반대편으로 이동', () => this.changeLevel(n.side === 'left' ? 'right' : 'left')]);
    if (canDemoteNode(n)) items.push(['▶ 하위 레벨로 이동', () => this.changeLevel(n.side === 'left' ? 'left' : 'right')]);

    if (!n.cloud) items.push(['☁ 구름 추가', () => this.addCloud(id)]);
    else {
      items.push(['☁ 구름 색상 변경', () => this.cycleCloudColor(id)]);
      items.push(['☁ 구름 제거', () => this.removeCloud(id)]);
    }

    if (!n.link) items.push(['🔗 링크 추가', () => this.setLinkPrompt(id)]);
    else {
      items.push(['🔗 링크 열기', () => this.openLink(id)]);
      items.push(['🔗 링크 변경/제거', () => this.setLinkPrompt(id)]);
    }

    items.push(['😀 아이콘 추가', () => { this.hideContextMenu(); this.showIconPicker(id, x, y); }]);
    if (n.icons.length) {
      items.push(['🗑 마지막 아이콘 제거', () => this.removeLastIcon(id)]);
      items.push(['🗑 아이콘 모두 제거', () => this.clearIcons(id)]);
    }

    if (state.linkSourceId === id) items.push(['↗ 그래픽 링크 시작 취소', () => this.cancelLinkMode()]);
    else if (state.linkSourceId) items.push(['↗ 여기로 그래픽 링크 연결', () => this.completeLinkMode(id)]);
    else items.push(['↗ 그래픽 링크 시작', () => this.startLinkMode(id)]);

    if (n.parent) items.push(['🗑 노드 삭제', () => this.deleteSelected()]);
    items.forEach(([label, fn]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.onclick = (e) => { e.stopPropagation(); fn(); this.hideContextMenu(); };
      menu.appendChild(btn);
    });
    menu.classList.remove('hidden');
    positionPopup(menu, x, y);
  },

  hideContextMenu() {
    document.getElementById('context-menu').classList.add('hidden');
  },

  setColor(color) {
    const n = findNode(state.root, state.selectedId);
    if (!n) return;
    history.push();
    n.color = color || null;
    rerenderAll();
  },

  async printMap() {
    try {
      await printMap(state);
    } catch (e) {
      console.error(e);
      toast('인쇄 준비에 실패했습니다: ' + (e.message || e));
    }
  },

  // ---------- Settings ----------
  openSettings() {
    state.settingsOpen = true;
    refreshSettingsUI();
    document.getElementById('settings-backdrop').classList.remove('hidden');
  },
  closeSettings() {
    state.settingsOpen = false;
    document.getElementById('settings-backdrop').classList.add('hidden');
  },
  setSetting(patch) {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    applySettings(settings);
    render(state); // re-measures/re-lays-out nodes at the new font size
  },
  resetSettings() {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings(settings);
    applySettings(settings);
    render(state);
    refreshSettingsUI();
  },
};

setupCanvasInteractions(state, ctx);
setupKeyboard(state, ctx);

document.getElementById('btn-add-child').onclick = () => ctx.addChild();
document.getElementById('btn-add-sibling').onclick = () => ctx.addSibling();
document.getElementById('btn-delete').onclick = () => ctx.deleteSelected();
document.getElementById('btn-undo').onclick = () => ctx.undo();
document.getElementById('btn-redo').onclick = () => ctx.redo();
document.getElementById('btn-zoom-in').onclick = () => { state.zoom = Math.min(3, state.zoom * 1.2); applyTransform(); };
document.getElementById('btn-zoom-out').onclick = () => { state.zoom = Math.max(0.2, state.zoom / 1.2); applyTransform(); };
document.getElementById('btn-zoom-reset').onclick = () => centerOnRoot();

document.getElementById('btn-new').onclick = () => {
  if (!confirm('새 마인드맵을 만들까요? 저장하지 않은 변경사항은 사라집니다.')) return;
  history.push();
  state.root = createDefaultRoot();
  state.graphicalLinks = [];
  state.linkSourceId = null;
  state.selectedLinkId = null;
  state.selectedId = state.root.id;
  rerenderAll();
  centerOnRoot();
};

document.getElementById('btn-save').onclick = () => ctx.saveJSON();

document.getElementById('btn-open').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      history.push();
      const parsed = parseJSONFile(reader.result);
      state.root = parsed.root;
      state.graphicalLinks = parsed.graphicalLinks;
      state.linkSourceId = null;
      state.selectedLinkId = null;
      state.selectedId = state.root.id;
      rerenderAll();
      centerOnRoot();
      toast('불러오기 완료');
    } catch (err) {
      alert('JSON 파일을 읽을 수 없습니다: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};

document.getElementById('btn-export-mm').onclick = () => { exportMM(state.root, state.graphicalLinks); toast('.mm 파일로 내보냈습니다.'); };
document.getElementById('btn-import-mm').onclick = () => document.getElementById('mm-input').click();
document.getElementById('btn-export-png').onclick = async () => {
  const btn = document.getElementById('btn-export-png');
  btn.disabled = true;
  try {
    await exportPNG(state);
    toast('PNG 이미지로 내보냈습니다.');
  } catch (e) {
    console.error(e);
    toast('PNG 내보내기에 실패했습니다.');
  } finally {
    btn.disabled = false;
  }
};
document.getElementById('mm-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      history.push();
      const parsed = parseMM(reader.result);
      state.root = parsed.root;
      state.graphicalLinks = parsed.graphicalLinks;
      state.linkSourceId = null;
      state.selectedLinkId = null;
      state.selectedId = state.root.id;
      rerenderAll();
      centerOnRoot();
      toast('.mm 파일을 불러왔습니다.');
    } catch (err) {
      alert('.mm 파일을 읽을 수 없습니다: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};

document.querySelectorAll('#color-group .swatch').forEach((btn) => {
  btn.onclick = () => ctx.setColor(btn.dataset.color || null);
});

document.getElementById('btn-print').onclick = () => ctx.printMap();

document.getElementById('btn-settings').onclick = () => ctx.openSettings();
document.getElementById('settings-close').onclick = () => ctx.closeSettings();
document.getElementById('settings-done').onclick = () => ctx.closeSettings();
document.getElementById('settings-backdrop').onclick = (e) => {
  if (e.target.id === 'settings-backdrop') ctx.closeSettings();
};
document.getElementById('settings-reset').onclick = () => ctx.resetSettings();

const fontSizeInput = document.getElementById('setting-font-size');
fontSizeInput.oninput = (e) => {
  const fontSize = parseInt(e.target.value, 10);
  document.getElementById('setting-font-size-value').textContent = fontSize + 'px';
  applySettings({ ...settings, fontSize }); // live preview while dragging
  render(state);
};
fontSizeInput.onchange = (e) => ctx.setSetting({ fontSize: parseInt(e.target.value, 10) });

window.addEventListener('resize', applyTransform);

rerenderAll();
centerOnRoot();
