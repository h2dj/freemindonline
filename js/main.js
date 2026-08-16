import {
  createDefaultRoot, addChild, addSiblingAfter, deleteSubtree, toggleCollapse,
  reparentNode, findNode, moveSelectionVertical, moveSelectionHorizontal,
  reorderNode, canReorderNode, promoteNode, canPromoteNode, demoteNode, canDemoteNode,
  toPlain, fromPlain, countDescendants,
} from './model.js';
import { render } from './render.js';
import { setupCanvasInteractions, setupKeyboard, startEditImpl } from './interactions.js';
import { autosave, loadAutosaved, downloadJSON, parseJSONFile, exportMM, parseMM } from './io.js';
import { createHistory } from './undo.js';

const state = {
  root: loadAutosaved() || createDefaultRoot(),
  selectedId: null,
  editingId: null,
  pan: { x: 0, y: 0 },
  zoom: 1,
};
state.selectedId = state.root.id;

const history = createHistory(
  () => ({ plain: toPlain(state.root), selectedId: state.selectedId }),
  (snap) => {
    state.root = fromPlain(snap.plain);
    state.selectedId = snap.selectedId;
    state.editingId = null;
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

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

function rerenderAll() {
  render(state);
  applyTransform();
  updateUndoRedoButtons();
  autosave(state.root);
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
    const parent = deleteSubtree(n);
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
    if (dir === 'up') target = moveSelectionVertical(n, -1);
    else if (dir === 'down') target = moveSelectionVertical(n, 1);
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
  // node one level deeper, under its previous sibling); the direction
  // pointing back toward the root promotes it (out to be a sibling of its
  // current parent).
  changeLevel(dir) {
    const n = findNode(state.root, state.selectedId);
    if (!n || !n.parent) return;
    const outward = n.side === 'left' ? -1 : 1;
    const wantDir = dir === 'right' ? 1 : -1;
    const demoting = wantDir === outward;
    history.push();
    const ok = demoting ? demoteNode(n) : promoteNode(n);
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

  saveJSON() { downloadJSON(state.root); toast('JSON 파일로 저장했습니다.'); },

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
    if (canDemoteNode(n)) items.push(['▶ 하위 레벨로 이동', () => this.changeLevel(n.side === 'left' ? 'left' : 'right')]);
    if (n.parent) items.push(['🗑 삭제', () => this.deleteSelected()]);
    items.forEach(([label, fn]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.onclick = (e) => { e.stopPropagation(); fn(); this.hideContextMenu(); };
      menu.appendChild(btn);
    });
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.remove('hidden');
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
      state.root = parseJSONFile(reader.result);
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

document.getElementById('btn-export-mm').onclick = () => { exportMM(state.root); toast('.mm 파일로 내보냈습니다.'); };
document.getElementById('btn-import-mm').onclick = () => document.getElementById('mm-input').click();
document.getElementById('mm-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      history.push();
      state.root = parseMM(reader.result);
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

window.addEventListener('resize', applyTransform);

rerenderAll();
centerOnRoot();
