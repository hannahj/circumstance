// self-serve backup: everything — records, photos, sound — in one JSON file the player keeps.
const b64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(",")[1]);
  r.onerror = () => rej(new Error("read failed"));
  r.readAsDataURL(blob);
});
const deb64 = (b64s, type) => {
  const bin = atob(b64s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: type || "application/octet-stream" });
};

export async function makeBackup(captures) {
  const rows = [];
  for (const c of captures) {
    const { photo, audio, id, ...rest } = c;
    rows.push({
      ...rest,
      photo: photo ? await b64(photo) : null, photoType: photo ? photo.type : null,
      audio: audio ? await b64(audio) : null, audioType: audio ? audio.type : null,
    });
  }
  return new Blob([JSON.stringify({ app: "circumstance", v: 1, rows })], { type: "application/json" });
}

export async function readBackup(file) {
  const d = JSON.parse(await file.text());
  if (d.app !== "circumstance" || !Array.isArray(d.rows)) throw new Error("not a circumstance backup");
  return d.rows.map(r => {
    const { photo, photoType, audio, audioType, ...rest } = r;
    return {
      ...rest,
      photo: photo ? deb64(photo, photoType) : null,
      audio: audio ? deb64(audio, audioType) : null,
    };
  });
}
