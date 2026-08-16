// Generic snapshot-based undo/redo. `getSnapshot`/`applySnapshot` are
// supplied by the caller so this module stays agnostic of the app's state shape.
export function createHistory(getSnapshot, applySnapshot, limit = 100) {
  const undoStack = [];
  const redoStack = [];

  return {
    // Call BEFORE mutating state, to record what it looked like beforehand.
    push() {
      undoStack.push(getSnapshot());
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
    },
    undo() {
      if (!undoStack.length) return false;
      const current = getSnapshot();
      const prev = undoStack.pop();
      redoStack.push(current);
      applySnapshot(prev);
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      const current = getSnapshot();
      const next = redoStack.pop();
      undoStack.push(current);
      applySnapshot(next);
      return true;
    },
    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },
  };
}
