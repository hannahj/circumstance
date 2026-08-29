// solar elevation in degrees (NOAA-style approximation, ~0.2 deg)
export function sunElevation(lat, lon, date) {
  const rad = Math.PI / 180;
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const eps = 23.439 * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const H = (gmst * 15 + lon) * rad - ra;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(H));
  return el / rad;
}

// band by sky state, not clock: December dusk is 16:20, June dusk is 20:45
export function timeBand(lat, lon, date) {
  const el = sunElevation(lat, lon, date);
  const rising = sunElevation(lat, lon, new Date(date.getTime() + 600000)) > el;
  let band;
  if (el >= 6) band = "day";
  else if (el <= -6) band = "night";
  else band = rising ? "dawn" : "dusk";
  return { band, elev: +el.toFixed(1) };
}

// sunrise/sunset (elevation crossing -0.833, refraction-adjusted horizon)
export function sunTimes(lat, lon, date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const el = m => sunElevation(lat, lon, new Date(dayStart.getTime() + m * 60000)) + 0.833;
  let rise = null, set = null;
  let prev = el(0);
  for (let m = 5; m <= 1440; m += 5) {
    const cur = el(m);
    if (prev <= 0 && cur > 0) rise = refine(m - 5, m);
    if (prev > 0 && cur <= 0) set = refine(m - 5, m);
    prev = cur;
  }
  function refine(a, b) {
    for (let i = 0; i < 8; i++) {
      const mid = (a + b) / 2;
      if ((el(a) <= 0) === (el(mid) <= 0)) a = mid; else b = mid;
    }
    return new Date(dayStart.getTime() + ((a + b) / 2) * 60000);
  }
  return { rise, set };
}
