// Real files on disk.
//
// Opened directly in Chrome, Edge or Arc (from the repo, or any web host), the
// editor uses the File System Access API: Open gives us a handle to the actual
// file, and Save writes back into that same file. Handles are kept in
// IndexedDB so the next visit can save to the same file after one permission
// click.
//
// Inside claude.ai the page runs in a sandboxed frame, where browsers refuse
// file handles, so the app falls back to a picker plus downloads.

export const canWriteFiles = (() => {
  try { return typeof window.showOpenFilePicker === "function" && window.self === window.top; }
  catch { return false; }
})();

const TYPES = [{ description: "Fountain screenplay", accept: { "text/plain": [".fountain", ".spmd", ".txt"] } }];

export async function pickFile() {
  const [handle] = await window.showOpenFilePicker({ types: TYPES, excludeAcceptAllOption: false, multiple: false });
  const file = await handle.getFile();
  return { handle, name: file.name, text: await file.text(), modified: file.lastModified };
}

export async function pickSaveTarget(suggestedName) {
  return window.showSaveFilePicker({ suggestedName, types: TYPES });
}

export async function writeFile(handle, text) {
  if ((await handle.queryPermission?.({ mode: "readwrite" })) !== "granted") {
    const p = await handle.requestPermission?.({ mode: "readwrite" });
    if (p && p !== "granted") throw new Error("permission");
  }
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
  const f = await handle.getFile();
  return { name: f.name, modified: f.lastModified };
}

export async function readHandle(handle) {
  if ((await handle.queryPermission?.({ mode: "read" })) !== "granted") return null;
  const f = await handle.getFile();
  return { name: f.name, text: await f.text(), modified: f.lastModified };
}

// Plain download for browsers without file handles (Safari, Firefox).
export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- handle storage (IndexedDB) ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("fountain-studio", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function saveHandle(id, handle) {
  try {
    const db = await idb();
    await new Promise((res) => { const t = db.transaction("handles", "readwrite"); t.objectStore("handles").put(handle, id); t.oncomplete = res; t.onerror = res; });
  } catch {}
}
export async function loadHandle(id) {
  try {
    const db = await idb();
    return await new Promise((res) => { const r = db.transaction("handles").objectStore("handles").get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  } catch { return null; }
}

// Short, stable fingerprint of a text, so we can tell if the editor differs
// from what was last written to the file without storing the file twice.
export function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ":" + text.length;
}

export function ensureExt(name) {
  const n = (name || "Untitled").trim().replace(/[\/\\:*?"<>|]+/g, "-").replace(/\.fountain\.txt$/i, ".fountain");
  return /\.(fountain|spmd|txt)$/i.test(n) ? n : n + ".fountain";
}
