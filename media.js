// media are encouraged, never required — and each sense is independent
const LSKEY = "mediaPrefs";
export function getMediaPrefs() {
  try { return JSON.parse(localStorage.getItem(LSKEY)) || { video: true, audio: true }; }
  catch { return { video: true, audio: true }; }
}
export function saveMediaPrefs(p) {
  try { localStorage.setItem(LSKEY, JSON.stringify(p)); } catch {}
}

let videoStream = null, audioStream = null, recorder = null, chunks = [], ac = null, analyser = null;

function audioMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

export async function startVideo() {
  if (videoStream) return true;
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    return true;
  } catch { return false; }
}

export async function startAudio() {
  if (recorder) return true;
  try { audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return false; }
  const track = audioStream.getAudioTracks()[0];
  const mime = track && audioMime();
  if (!mime) { stopAudio(); return false; }
  chunks = [];
  recorder = new MediaRecorder(new MediaStream([track]), { mimeType: mime });
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.start();
  ac = new (window.AudioContext || window.webkitAudioContext)();
  analyser = ac.createAnalyser();
  analyser.fftSize = 256;
  ac.createMediaStreamSource(audioStream).connect(analyser);
  return true;
}

export function stopVideo() {
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
}

export function stopAudio() {
  if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch {} }
  recorder = null; chunks = [];
  if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
  if (ac) { ac.close(); ac = null; analyser = null; }
}

export function videoStreamRef() { return videoStream; }
export function audioActive() { return !!recorder; }

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

// seal the sound, stop every sense
export function finishMedia() {
  return new Promise(res => {
    const cleanup = () => {
      stopVideo();
      if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
      if (ac) { ac.close(); ac = null; analyser = null; }
    };
    if (recorder && recorder.state !== "inactive") {
      const mime = recorder.mimeType;
      recorder.onstop = () => {
        const b = chunks.length ? new Blob(chunks, { type: mime }) : null;
        recorder = null; chunks = [];
        cleanup();
        res(b);
      };
      recorder.stop();
    } else { recorder = null; cleanup(); res(null); }
  });
}
