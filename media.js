// media are encouraged, never required: every path degrades to a data-only capture
let stream = null;
let recorder = null;
let chunks = [];

function audioMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

export async function startMedia() {
  // request each sense independently: one blocked permission must never silence the other
  let videoStream = null, audioStream = null;
  try { videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); } catch {}
  try { audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
  const tracks = [
    ...(videoStream ? videoStream.getTracks() : []),
    ...(audioStream ? audioStream.getTracks() : []),
  ];
  stream = tracks.length ? new MediaStream(tracks) : null;

  const audioTrack = audioStream && audioStream.getAudioTracks()[0];
  const mime = audioTrack && audioMime();
  if (mime) {
    chunks = [];
    recorder = new MediaRecorder(new MediaStream([audioTrack]), { mimeType: mime });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
  }
  return { video: !!videoStream, audio: !!recorder, stream };
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

export function stopMedia() {
  return new Promise(res => {
    const finish = audioBlob => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null;
      recorder = null;
      res(audioBlob);
    };
    if (recorder && recorder.state !== "inactive") {
      const mime = recorder.mimeType;
      recorder.onstop = () => finish(chunks.length ? new Blob(chunks, { type: mime }) : null);
      recorder.stop();
    } else finish(null);
  });
}
