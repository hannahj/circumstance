export function weatherBucket(code) {
  if (code === 0 || code === 1) return "clear";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return "rain";
  return "cloud";
}

export async function fetchWeatherNow(lat, lon) {
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m`,
    { signal: AbortSignal.timeout(6000) });
  const c = (await r.json()).current;
  return { code: c.weather_code, bucket: weatherBucket(c.weather_code), temp: c.temperature_2m, wind: c.wind_speed_10m };
}

// resolve-later path: weather must describe the capture moment
export async function backfillWeather(lat, lon, timeISO) {
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code,wind_speed_10m&past_days=7&forecast_days=1`,
    { signal: AbortSignal.timeout(8000) });
  const h = (await r.json()).hourly;
  const t = new Date(timeISO).getTime();
  let bi = 0, bd = Infinity;
  h.time.forEach((x, i) => { const d = Math.abs(new Date(x + "Z").getTime() - t); if (d < bd) { bd = d; bi = i; } });
  return { code: h.weather_code[bi], bucket: weatherBucket(h.weather_code[bi]), temp: h.temperature_2m[bi], wind: h.wind_speed_10m[bi], backfilled: true };
}
