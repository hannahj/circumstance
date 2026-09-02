// camera and mic for the clip; the mic also feeds the live waveform
let videoStream = null, audioStream = null, ac = null, analyser = null;

// one combined prompt when possible, separate fallbacks so a blocked sense never silences the other,
// silent absence when unavailable
export async function startAllMedia() {
  let combined = null;
  try {
    combined = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: true });
  } catch {}
  if (combined) {
    videoStream = new MediaStream(combined.getVideoTracks());
    const at = combined.getAudioTracks();
    if (at.length) { audioStream = new MediaStream(at); wireAnalyser(); }
  } else {
    try { videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); } catch {}
    try { audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }); wireAnalyser(); } catch {}
  }
  return { video: !!videoStream && videoStream.getTracks().length > 0, audio: !!audioStream };
}

function wireAnalyser() {
  ac = new (window.AudioContext || window.webkitAudioContext)();
  analyser = ac.createAnalyser();
  analyser.fftSize = 256;
  ac.createMediaStreamSource(audioStream).connect(analyser);
}

export function videoStreamRef() { return videoStream; }

// live amplitude levels for the waveform (null when no mic is running)
export function waveLevels(n = 24) {
  if (!analyser) return null;
  const d = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(d);
  const out = [], step = Math.floor(d.length / n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step; j < (i + 1) * step; j++) m = Math.max(m, Math.abs(d[j] - 128));
    out.push(m / 128);
  }
  return out;
}

// poster frame at release: the grid and list draw from this
export function snapPhoto(videoEl) {
  return new Promise(res => {
    if (!videoEl.videoWidth) return res(null);
    const max = 1280;
    const scale = Math.min(1, max / Math.max(videoEl.videoWidth, videoEl.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(videoEl.videoWidth * scale);
    canvas.height = Math.round(videoEl.videoHeight * scale);
    canvas.getContext("2d").drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(b => res(b), "image/jpeg", 0.82);
  });
}

// stop every sense
export function finishMedia() {
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
  if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
  if (ac) { ac.close(); ac = null; analyser = null; }
}

// ---- the clip: camera+mic into one short video ----
let clipRec = null, clipChunks = [];
function clipMime() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}
export function startClip() {
  if (!videoStream || !videoStream.getVideoTracks().length) return false;
  const mime = clipMime();
  if (!mime) return false;
  const tracks = [
    ...videoStream.getVideoTracks(),
    ...(audioStream ? audioStream.getAudioTracks() : []),
  ];
  clipChunks = [];
  clipRec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 2_500_000 });
  clipRec.ondataavailable = e => { if (e.data.size) clipChunks.push(e.data); };
  clipRec.start();
  return true;
}
export function stopClip() {
  return new Promise(res => {
    if (!clipRec || clipRec.state === "inactive") { clipRec = null; return res(null); }
    const r = clipRec;
    clipRec = null;
    r.onstop = () => res(clipChunks.length ? new Blob(clipChunks, { type: r.mimeType }) : null);
    r.stop();
  });
}
