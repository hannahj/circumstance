// IndexedDB, with an in-memory fallback so private windows still play (ephemerally)
const DB_NAME = "circumstance";
let memory = null;

function open() {
  return new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return rej(e); }
    req.onupgradeneeded = () => {
      req.result.createObjectStore("captures", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function getDB() {
  if (memory) return null;
  try { return await open(); }
  catch { memory = { rows: [], next: 1 }; return null; }
}

export function isEphemeral() { return !!memory; }

function tx(db, mode, fn, packed) {
  return new Promise((res, rej) => {
    const t = db.transaction("captures", mode);
    const out = fn(t.objectStore("captures"), packed);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

// Safari can lose the ability to read Blobs stored in IndexedDB; raw ArrayBuffers are
// reliable. Media is packed to buffers on write and rebuilt into Blobs on read.
const MEDIA = ["photo", "audio", "video"];
async function pack(capture) {
  const row = { ...capture };
  for (const k of MEDIA) {
    if (row[k] instanceof Blob) row[k] = { __buf: await row[k].arrayBuffer(), type: row[k].type };
  }
  return row;
}
function unpack(row) {
  for (const k of MEDIA) {
    if (row[k] && row[k].__buf) row[k] = new Blob([row[k].__buf], { type: row[k].type });
  }
  return row;
}
export function isPacked(row) {
  return MEDIA.every(k => !(row[k] instanceof Blob));
}

export async function addCapture(capture) {
  const db = await getDB();
  if (!db) { capture.id = memory.next++; memory.rows.push(capture); return capture.id; }
  return tx(db, "readwrite", (store, row) => store.add(row), await pack(capture));
}

export async function putCapture(capture) {
  const db = await getDB();
  if (!db) {
    const i = memory.rows.findIndex(r => r.id === capture.id);
    if (i >= 0) memory.rows[i] = capture; else memory.rows.push(capture);
    return capture.id;
  }
  return tx(db, "readwrite", (store, row) => store.put(row), await pack(capture));
}

export async function deleteCapture(id) {
  const db = await getDB();
  if (!db) { memory.rows = memory.rows.filter(r => r.id !== id); return; }
  return tx(db, "readwrite", store => store.delete(id));
}

export async function allCaptures() {
  const db = await getDB();
  if (!db) return [...memory.rows];
  return new Promise((res, rej) => {
    const t = db.transaction("captures", "readonly");
    const req = t.objectStore("captures").getAll();
    req.onsuccess = () => res(req.result.map(unpack));
    req.onerror = () => rej(req.error);
  });
}
