// anonymous use counts, and nothing else: a random install id, an event name, no
// coordinates, no content, no device details. Do-Not-Track is honoured. Fail-silent.
const PING_URL = "https://misty-dew-73be.uglywalks.workers.dev/ping";

export function ping(event) {
  try {
    if (navigator.doNotTrack === "1") return;
    let id = localStorage.getItem("circId");
    if (!id) { id = crypto.randomUUID(); localStorage.setItem("circId", id); }
    if (event === "open") {
      const day = new Date().toISOString().slice(0, 10);
      if (localStorage.getItem("circPingDay") === day) return; // one open per day
      localStorage.setItem("circPingDay", day);
    }
    navigator.sendBeacon(PING_URL, JSON.stringify({ e: event, id }));
  } catch {}
}
