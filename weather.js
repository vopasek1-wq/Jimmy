// Počasí z Open-Meteo (zdarma, bez API klíče) – aktuální stav a předpověď na 5 dní.
"use strict";

const PLACE = { name: "Teplice", latitude: 50.6404, longitude: 13.8245 };

const URL_BASE = "https://api.open-meteo.com/v1/forecast";

// WMO kódy počasí → česky + ikona ze sprite v index.html (v noci měsíc místo slunce)
function describe(code, isDay = true) {
  if (code === 0) return { text: "Jasno", icon: isDay ? "wx-sun" : "wx-moon" };
  if (code === 1) return { text: "Skoro jasno", icon: isDay ? "wx-partly" : "wx-partly-night" };
  if (code === 2) return { text: "Polojasno", icon: isDay ? "wx-partly" : "wx-partly-night" };
  if (code === 3) return { text: "Zataženo", icon: "wx-cloud" };
  if (code === 45 || code === 48) return { text: "Mlha", icon: "wx-fog" };
  if (code >= 51 && code <= 57) return { text: "Mrholení", icon: "wx-rain" };
  if (code >= 61 && code <= 67) return { text: "Déšť", icon: "wx-rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { text: "Sněžení", icon: "wx-snow" };
  if (code >= 80 && code <= 82) return { text: "Přeháňky", icon: "wx-showers" };
  if (code >= 95) return { text: "Bouřky", icon: "wx-storm" };
  return { text: "—", icon: "wx-cloud" };
}

async function fetchWeather(fetchImpl, place = PLACE) {
  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    timezone: "Europe/Prague",
    forecast_days: "5",
  });
  const res = await fetchImpl(`${URL_BASE}?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`);
  const data = await res.json();
  const c = data.current;
  return {
    place: place.name,
    current: {
      temperature: Math.round(c.temperature_2m),
      feelsLike: Math.round(c.apparent_temperature),
      humidity: Math.round(c.relative_humidity_2m),
      wind: Math.round(c.wind_speed_10m),
      isDay: c.is_day !== 0,
      ...describe(c.weather_code, c.is_day !== 0),
    },
    daily: data.daily.time.map((date, i) => ({
      date,
      max: Math.round(data.daily.temperature_2m_max[i]),
      min: Math.round(data.daily.temperature_2m_min[i]),
      ...describe(data.daily.weather_code[i]),
    })),
    fetchedAt: Date.now(),
  };
}

module.exports = { PLACE, describe, fetchWeather };
