const DB_NAME = "circumstance";

function open() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("captures", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction("captures", mode);
    const out = fn(t.objectStore("captures"));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

export async function addCapture(capture) {
  const db = await open();
  return tx(db, "readwrite", store => store.add(capture));
}

export async function putCapture(capture) {
  const db = await open();
  return tx(db, "readwrite", store => store.put(capture));
}

export async function allCaptures() {
  const db = await open();
  const db2 = db;
  return new Promise((res, rej) => {
    const t = db2.transaction("captures", "readonly");
    const req = t.objectStore("captures").getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function deleteCapture(id) {
  const db = await open();
  return tx(db, "readwrite", store => store.delete(id));
}
