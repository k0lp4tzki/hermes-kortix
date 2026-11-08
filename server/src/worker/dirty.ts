let dirty = true;
export function markDirty() { dirty = true; }
export function takeDirty() { const d = dirty; dirty = false; return d; }
