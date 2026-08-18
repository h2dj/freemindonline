import {
  createDefaultRoot, addChild, addSiblingAfter, deleteSubtree, toggleCollapse,
  reparentNode, findNode, moveSelectionHorizontal, makeId,
  reorderNode, canReorderNode, promoteNode, canPromoteNode, demoteNode, canDemoteNode,
  flipRootChildSide, canFlipRootChildSide, canInsertParentAbove, insertParentAbove,
  setCloud, setLink, addIcon, removeLastIcon, clearIcons, collectSubtreeIds,
  addCheckbox, removeCheckbox, toggleCheckboxChecked, collectCheckboxNodes,
  toPlain, fromPlain, countDescendants,
} from './model.js';
import { render, nextVisibleSameSide } from './render.js';
import { setupCanvasInteractions, setupKeyboard, startEditImpl } from './interactions.js';
import {
  autosaveTabs, loadTabs, downloadJSON, parseJSONFile, exportMM, parseMM,
  exportMarkdown, parseMarkdown, exportPNG, printMap,
} from './io.js';
import { createHistory } from './undo.js';
import {
  loadSettings, saveSettings, applySettings,
  NODE_COLOR_PRESETS, ACCENT_COLOR_PRESETS, DEFAULT_SETTINGS,
} from './settings.js';
import { renderIconToken } from './icons.js';

const CLOUD_COLORS = ['#c9d6e3', '#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fecaca'];
const LINK_COLORS = ['#f97316', '#2563eb', '#16a34a', '#db2777', '#64748b'];
const ICON_PALETTE = [
  '⭐', '❗', '❓', '✅', '❌', '⚠️', '💡', '📌', '🚩', '❤️', '⏰', '🔥', '👍', '👎', '🔒', '📎', '🎯', '🏆',
  // 색깔별 원형 배지 숫자 1~9 (renderIconToken이 '#N' 토큰을 흰 글자 배지로 그림)
  '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9',
  // 사람 모양
  '👤', '🧑', '👨', '👩',
  // 기타: 폭탄, 노트, 마법봉, 돋보기, 모래시계, 7색깔 깃발
  '💣', '📝', '🪄', '🔍', '⏳', '🏳️‍🌈',
];

// App-level preferences (font size / default colors) — separate from the
// map document itself, applied once up front so the very first layout
// pass already measures nodes at the right font size.
let settings = loadSettings();
applySettings(settings);

// Multiple maps open at once: each tab owns its own document (root +
// graphical links), pan/zoom, and undo history. `state` always holds the
// data for whichever tab is currently active — its object identity never
// changes (interactions.js/render.js hold a reference to this exact
// object), only its properties get swapped out on tab switch. `history`
// is a plain module-level binding reassigned to the active tab's own
// undo/redo instance for the same reason: every ctx method that calls
// history.push()/undo()/redo() just references this binding by name, so
// reassigning it here is all it takes to redirect them to the new tab.
const state = {
  root: null, graphicalLinks: null, selectedId: null, editingId: null,
  linkSourceId: null, selectedLinkId: null, settingsOpen: false,
  pan: { x: 0, y: 0 }, zoom: 1,
};
let history = null;
let tabs = [];
let activeTabId = null;

// Sidebar show/hide is plain UI chrome, not document state — it isn't tied
// to any particular tab. The icon sidebar's default comes from `settings`
// (see settings.js) so it's a real persisted preference; the checklist
// panel is otherwise fully automatic (shows itself whenever the active
// tab has checkbox nodes), so it only needs a one-off "user closed it"
// flag rather than a saved setting.
let checklistManuallyHidden = false;

function makeHistory() {
  return createHistory(
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
}

function newBlankTab() {
  const root = createDefaultRoot();
  return { id: makeId(), root, graphicalLinks: [], selectedId: root.id, pan: { x: 0, y: 0 }, zoom: 1, history: makeHistory() };
}

// Pulls whatever the active tab currently looks like on screen back into
// its entry in `tabs`, so that entry isn't stale the moment another tab
// becomes active (or the whole session autosaves).
function snapshotStateIntoTab(tab) {
  tab.root = state.root;
  tab.graphicalLinks = state.graphicalLinks;
  tab.selectedId = state.selectedId;
  tab.pan = { x: state.pan.x, y: state.pan.y };
  tab.zoom = state.zoom;
}

function loadTabIntoState(tab) {
  state.root = tab.root;
  state.graphicalLinks = tab.graphicalLinks;
  state.selectedId = tab.selectedId || tab.root.id;
  state.editingId = null;
  state.linkSourceId = null;
  state.selectedLinkId = null;
  state.pan = { x: tab.pan.x, y: tab.pan.y };
  state.zoom = tab.zoom;
  history = tab.history;
}

const loadedTabs = loadTabs();
if (loadedTabs && loadedTabs.tabs.length) {
  tabs = loadedTabs.tabs.map((t) => ({ ...t, history: makeHistory() }));
  activeTabId = tabs.some((t) => t.id === loadedTabs.activeTabId) ? loadedTabs.activeTabId : tabs[0].id;
} else {
  const tab = newBlankTab();
  tabs = [tab];
  activeTabId = tab.id;
}
loadTabIntoState(tabs.find((t) => t.id === activeTabId));

// Pure panning/zooming never goes through rerenderAll() (nothing about the
// map itself changed, so a full re-render would be wasted work) — but the
// new per-tab pan/zoom persistence means it still needs to be saved
// eventually. Debounced so a drag or a flurry of wheel events doesn't spam
// localStorage; it settles ~500ms after the user stops moving the canvas.
let panSaveTimer = null;
function applyTransform() {
  document.getElementById('world').style.transform =
    `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  clearTimeout(panSaveTimer);
  panSaveTimer = setTimeout(saveTabs, 500);
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
  document.getElementById('setting-icon-sidebar-visible').checked = settings.iconSidebarVisible !== false;
}

// Left icon sidebar: lets a single click on any icon add it straight to
// whichever node is currently selected, instead of having to open the
// context menu → "아이콘 추가" → picker every time. The button set itself
// is static (built once); only the enabled/disabled state needs to track
// the current selection, so it's kept separate from the main map redraw.
function iconLabel(icon) {
  const m = /^#([1-9])$/.exec(icon);
  return m ? `숫자 ${m[1]}` : icon;
}

function buildIconSidebar() {
  const grid = document.getElementById('icon-sidebar-grid');
  grid.innerHTML = '';
  ICON_PALETTE.forEach((icon) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.appendChild(renderIconToken(icon));
    btn.title = iconLabel(icon) + ' 추가';
    btn.onclick = () => {
      if (!state.selectedId) return;
      ctx.addIconTo(state.selectedId, icon);
    };
    grid.appendChild(btn);
  });
}

function updateIconSidebar() {
  const disabled = !state.selectedId;
  document.querySelectorAll('#icon-sidebar-grid button').forEach((btn) => { btn.disabled = disabled; });
  const n = state.selectedId ? findNode(state.root, state.selectedId) : null;
  const hasIcons = !!(n && n.icons.length);
  document.getElementById('icon-remove-last').disabled = !hasIcons;
  document.getElementById('icon-remove-all').disabled = !hasIcons;
}

// Applies settings.iconSidebarVisible to the actual DOM/toolbar-button
// state. Called at startup and any time that setting changes (toolbar
// toggle, settings modal checkbox, or "restore defaults") so all three
// controls always agree with each other immediately, not just after a
// reload.
function applyIconSidebarVisibility() {
  const visible = settings.iconSidebarVisible !== false;
  document.getElementById('icon-sidebar').classList.toggle('collapsed', !visible);
  const btn = document.getElementById('btn-toggle-icon-sidebar');
  btn.classList.toggle('active', visible);
  btn.setAttribute('aria-pressed', String(visible));
}

function tabTitle(tab, rootText) {
  const text = (rootText != null ? rootText : tab.root.text || '').trim();
  return text || '새 마인드맵';
}

function renderTabBar() {
  const list = document.getElementById('tab-list');
  list.innerHTML = '';
  tabs.forEach((tab) => {
    const isActive = tab.id === activeTabId;
    const title = tabTitle(tab, isActive ? state.root.text : undefined);
    const el = document.createElement('div');
    el.className = 'tab' + (isActive ? ' active' : '');
    el.title = title;
    el.onclick = () => ctx.switchTab(tab.id);

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = title;
    el.appendChild(label);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.title = '탭 닫기';
    close.textContent = '×';
    close.onclick = (e) => { e.stopPropagation(); ctx.closeTab(tab.id); };
    el.appendChild(close);

    list.appendChild(el);
  });
}

// The chain of ancestor titles from the center topic down to (but not
// including) `node` itself, e.g. ["중심 주제", "Branch"] for a grandchild —
// walks the live `.parent` back-references, so it always reflects the
// node's current position even after a reparent/promote/demote.
function ancestorPathText(node) {
  const names = [];
  for (let p = node.parent; p; p = p.parent) {
    names.unshift(p.text || (p.isRoot ? '중심 주제' : '(제목 없음)'));
  }
  return names.join(' › ');
}

// Checklist panel: whenever the active tab's document has at least one
// checkbox node, the left sidebar automatically shows them all as a
// checklist (regardless of collapsed state, so a task hidden inside a
// folded branch is still tracked) — unless the user has manually hidden it
// via the toolbar toggle (see checklistManuallyHidden), which sticks until
// they toggle it back on. Empty tree → toggle button disables itself, since
// there'd be nothing to show either way.
function renderChecklist() {
  const nodes = collectCheckboxNodes(state.root);
  const sidebar = document.getElementById('checklist-sidebar');
  const list = document.getElementById('checklist-list');
  const toggleBtn = document.getElementById('btn-toggle-checklist');
  const hasCheckboxes = nodes.length > 0;
  toggleBtn.disabled = !hasCheckboxes;
  const shouldShow = hasCheckboxes && !checklistManuallyHidden;
  toggleBtn.classList.toggle('active', shouldShow);
  toggleBtn.setAttribute('aria-pressed', String(shouldShow));

  if (!shouldShow) {
    sidebar.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  sidebar.classList.remove('hidden');
  const doneCount = nodes.filter((n) => n.checkbox).length;
  document.getElementById('checklist-progress').textContent = `${doneCount}/${nodes.length}`;
  list.innerHTML = '';
  nodes.forEach((n) => {
    const isSelected = n.id === state.selectedId;
    const row = document.createElement('div');
    row.className = 'checklist-item' + (n.checkbox ? ' checked' : '') + (isSelected ? ' selected' : '');
    row.onclick = () => ctx.select(n.id);

    const line = document.createElement('div');
    line.className = 'checklist-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!n.checkbox;
    cb.title = '완료 표시';
    cb.onclick = (e) => { e.stopPropagation(); ctx.toggleCheckboxChecked(n.id); };
    line.appendChild(cb);
    const label = document.createElement('span');
    label.className = 'checklist-text';
    label.textContent = n.text || '(제목 없음)';
    line.appendChild(label);
    row.appendChild(line);

    // Ancestor breadcrumb — only under the item that's currently selected,
    // so clicking a row reveals where it sits in the tree without
    // cluttering every other row.
    if (isSelected) {
      const pathText = ancestorPathText(n);
      if (pathText) {
        const path = document.createElement('div');
        path.className = 'checklist-path';
        path.textContent = pathText;
        row.appendChild(path);
      }
    }

    list.appendChild(row);
  });
}

// Keeps the active tab's entry in `tabs` in sync with what's on screen
// before persisting — otherwise the array only reflects a tab's state as
// of the last time it was switched *away from*, not live edits.
function saveTabs() {
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (activeTab) snapshotStateIntoTab(activeTab);
  autosaveTabs(tabs, activeTabId);
}

function rerenderAll() {
  render(state);
  applyTransform();
  updateUndoRedoButtons();
  updateIconSidebar();
  renderTabBar();
  renderChecklist();
  saveTabs();
}

const ctx = {
  select(id) {
    if (state.editingId && state.editingId !== id) this.commitEdit();
    state.selectedId = id;
    render(state);
    updateIconSidebar();
    renderChecklist(); // keeps the checklist panel's "selected" highlight in sync
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

  // Shift+Insert: wraps the selected node with a brand-new parent node,
  // taking its old spot in the tree — the reverse of "promote".
  insertParent() {
    const n = findNode(state.root, state.selectedId);
    if (!n) return;
    if (!canInsertParentAbove(n)) { toast('중심 주제 위에는 상위 노드를 만들 수 없습니다.'); return; }
    history.push();
    const wrapper = insertParentAbove(n, '새 노드');
    if (!wrapper) { history.discardLast(); return; }
    state.selectedId = wrapper.id;
    rerenderAll();
    this.startEdit(wrapper.id);
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
    updateIconSidebar();
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
  // Ctrl+Shift+J: add if there's no cloud yet, otherwise remove it — a
  // single shortcut that toggles, since add/remove are already separate
  // context-menu items but a keyboard shortcut only gets one verb.
  toggleCloud(id) {
    const n = findNode(state.root, id);
    if (!n) return;
    if (n.cloud) this.removeCloud(id);
    else this.addCloud(id);
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
      btn.appendChild(renderIconToken(icon));
      btn.title = iconLabel(icon);
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

  // ---------- Checkboxes / checklist ----------
  addCheckbox(id) {
    const n = findNode(state.root, id);
    if (!n) return;
    history.push();
    addCheckbox(n);
    rerenderAll();
  },
  removeCheckbox(id) {
    const n = findNode(state.root, id);
    if (!n || n.checkbox == null) return;
    history.push();
    removeCheckbox(n);
    rerenderAll();
  },
  toggleCheckboxChecked(id) {
    const n = findNode(state.root, id);
    if (!n || n.checkbox == null) return;
    history.push();
    toggleCheckboxChecked(n);
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
    if (canInsertParentAbove(n)) items.push(['⬆ 새 상위 노드 만들기 (Shift+Insert)', () => this.insertParent()]);
    if (n.parent) items.push(['🗂 새 탭에서 중심 주제로 열기', () => this.openInNewTab(id)]);

    if (n.checkbox == null) items.push(['☑ 체크박스 추가', () => this.addCheckbox(id)]);
    else items.push(['☑ 체크박스 제거', () => this.removeCheckbox(id)]);

    if (!n.cloud) items.push(['☁ 구름 추가 (Ctrl+Shift+J)', () => this.addCloud(id)]);
    else {
      items.push(['☁ 구름 색상 변경', () => this.cycleCloudColor(id)]);
      items.push(['☁ 구름 제거 (Ctrl+Shift+J)', () => this.removeCloud(id)]);
    }

    if (!n.link) items.push(['🔗 링크 추가 (Ctrl+K)', () => this.setLinkPrompt(id)]);
    else {
      items.push(['🔗 링크 열기', () => this.openLink(id)]);
      items.push(['🔗 링크 변경/제거 (Ctrl+K)', () => this.setLinkPrompt(id)]);
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

  // ---------- Hamburger menu (rarely-used actions: file I/O, settings) ----------
  showFileMenu() {
    const menu = document.getElementById('file-menu');
    const btn = document.getElementById('btn-menu');
    const rect = btn.getBoundingClientRect();
    menu.classList.remove('hidden');
    positionPopup(menu, rect.left, rect.bottom + 6);
    btn.setAttribute('aria-expanded', 'true');
  },
  hideFileMenu() {
    document.getElementById('file-menu').classList.add('hidden');
    document.getElementById('btn-menu').setAttribute('aria-expanded', 'false');
  },
  toggleFileMenu() {
    const hidden = document.getElementById('file-menu').classList.contains('hidden');
    if (hidden) this.showFileMenu(); else this.hideFileMenu();
  },

  // ---------- Tabs (multiple open maps) ----------
  switchTab(id) {
    if (id === activeTabId) return;
    if (state.editingId) this.commitEdit();
    const oldTab = tabs.find((t) => t.id === activeTabId);
    if (oldTab) snapshotStateIntoTab(oldTab);
    const newTab = tabs.find((t) => t.id === id);
    if (!newTab) return;
    activeTabId = id;
    loadTabIntoState(newTab);
    rerenderAll();
    // A never-viewed tab (e.g. migrated from the pre-tabs autosave) has no
    // real saved pan yet — center it instead of pinning it to the corner.
    if (state.pan.x !== 0 || state.pan.y !== 0) applyTransform();
    else centerOnRoot();
  },
  newTab() {
    if (state.editingId) this.commitEdit();
    const oldTab = tabs.find((t) => t.id === activeTabId);
    if (oldTab) snapshotStateIntoTab(oldTab);
    const tab = newBlankTab();
    tabs.push(tab);
    activeTabId = tab.id;
    loadTabIntoState(tab);
    rerenderAll();
    centerOnRoot();
  },
  closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;

    if (tabs.length === 1) {
      if (!confirm('마지막 탭입니다. 닫으면 새 빈 지도로 바뀝니다. 계속할까요?')) return;
      const tab = tabs[0];
      tab.root = createDefaultRoot();
      tab.graphicalLinks = [];
      tab.pan = { x: 0, y: 0 };
      tab.zoom = 1;
      tab.selectedId = tab.root.id;
      tab.history = makeHistory();
      loadTabIntoState(tab);
      rerenderAll();
      centerOnRoot();
      return;
    }

    const wasActive = id === activeTabId;
    tabs.splice(idx, 1);
    if (wasActive) {
      const next = tabs[Math.max(0, idx - 1)];
      activeTabId = next.id;
      loadTabIntoState(next);
      rerenderAll();
      if (state.pan.x !== 0 || state.pan.y !== 0) applyTransform();
      else centerOnRoot();
    } else {
      saveTabs();
      renderTabBar();
    }
  },
  // Opens a copy of the selected node's whole subtree as a new tab, with
  // that node promoted to be the new tab's center topic — a non-destructive
  // "focus" that leaves the original tab untouched. Node ids are kept as-is
  // (so it stays traceable back to the source), and graphical links carry
  // over only when both of their endpoints are inside the copied subtree.
  openInNewTab(id) {
    const n = findNode(state.root, id);
    if (!n) return;
    if (!n.parent) { toast('이미 이 탭의 중심 주제입니다.'); return; }
    if (state.editingId) this.commitEdit();
    const oldTab = tabs.find((t) => t.id === activeTabId);
    if (oldTab) snapshotStateIntoTab(oldTab);

    const plain = toPlain(n);
    plain.isRoot = true;
    plain.side = null;
    const newRoot = fromPlain(plain);
    const subtreeIds = new Set(collectSubtreeIds(n));
    const newLinks = state.graphicalLinks
      .filter((l) => subtreeIds.has(l.fromId) && subtreeIds.has(l.toId))
      .map((l) => ({ ...l }));

    const tab = {
      id: makeId(), root: newRoot, graphicalLinks: newLinks,
      selectedId: newRoot.id, pan: { x: 0, y: 0 }, zoom: 1, history: makeHistory(),
    };
    tabs.push(tab);
    activeTabId = tab.id;
    loadTabIntoState(tab);
    rerenderAll();
    centerOnRoot();
    toast('새 탭에서 중심 주제로 열었습니다.');
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
    applyIconSidebarVisibility();
    render(state); // re-measures/re-lays-out nodes at the new font size
  },
  resetSettings() {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings(settings);
    applySettings(settings);
    applyIconSidebarVisibility();
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

document.getElementById('btn-new').onclick = () => ctx.newTab();
document.getElementById('btn-new-tab').onclick = () => ctx.newTab();

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
document.getElementById('btn-export-md').onclick = () => { exportMarkdown(state.root); toast('마크다운(.md)으로 내보냈습니다.'); };
document.getElementById('btn-import-md').onclick = () => document.getElementById('md-input').click();
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
document.getElementById('md-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      history.push();
      const parsed = parseMarkdown(reader.result);
      state.root = parsed.root;
      state.graphicalLinks = parsed.graphicalLinks;
      state.linkSourceId = null;
      state.selectedLinkId = null;
      state.selectedId = state.root.id;
      rerenderAll();
      centerOnRoot();
      toast('마크다운(.md) 파일을 불러왔습니다.');
    } catch (err) {
      alert('마크다운 파일을 읽을 수 없습니다: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};

document.querySelectorAll('#color-group .swatch').forEach((btn) => {
  btn.onclick = () => ctx.setColor(btn.dataset.color || null);
});

document.getElementById('btn-menu').onclick = (e) => { e.stopPropagation(); ctx.toggleFileMenu(); };
// Any action button inside the menu should close it after running, same as
// how the context menu auto-closes once an item is picked.
document.getElementById('file-menu').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') ctx.hideFileMenu();
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

buildIconSidebar();
document.getElementById('icon-remove-last').onclick = () => {
  if (state.selectedId) ctx.removeLastIcon(state.selectedId);
};
document.getElementById('icon-remove-all').onclick = () => {
  if (state.selectedId) ctx.clearIcons(state.selectedId);
};

// Icon sidebar's shown/hidden state now lives entirely in settings (see
// applyIconSidebarVisibility) — this button and the settings-modal
// checkbox are just two different places to flip the same value.
document.getElementById('btn-toggle-icon-sidebar').onclick = () => {
  ctx.setSetting({ iconSidebarVisible: settings.iconSidebarVisible === false });
};
document.getElementById('setting-icon-sidebar-visible').onchange = (e) => {
  ctx.setSetting({ iconSidebarVisible: e.target.checked });
};
applyIconSidebarVisibility();

document.getElementById('btn-toggle-checklist').onclick = () => {
  checklistManuallyHidden = !checklistManuallyHidden;
  renderChecklist();
};

rerenderAll();
// A tab with a real saved pan (i.e. it was actually viewed/panned before —
// including in a previous session) restores exactly where it was left. A
// brand-new tab, or one migrated from the pre-tabs single-document
// autosave (which never recorded pan/zoom), still defaults to centered.
if (state.pan.x !== 0 || state.pan.y !== 0) applyTransform();
else centerOnRoot();
