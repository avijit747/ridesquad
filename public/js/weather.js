// Live weather via Open-Meteo (free, no API key). Used for a compact dashboard
// widget and a rain-ahead warning — not a substitute for checking a real forecast
// before a long ride.
const WMO = {
  0: { emoji: '☀️', label: 'Clear' }, 1: { emoji: '🌤️', label: 'Mostly clear' },
  2: { emoji: '⛅', label: 'Partly cloudy' }, 3: { emoji: '☁️', label: 'Overcast' },
  45: { emoji: '🌫️', label: 'Fog' }, 48: { emoji: '🌫️', label: 'Rime fog' },
  51: { emoji: '🌦️', label: 'Light drizzle' }, 53: { emoji: '🌦️', label: 'Drizzle' }, 55: { emoji: '🌧️', label: 'Dense drizzle' },
  61: { emoji: '🌧️', label: 'Light rain' }, 63: { emoji: '🌧️', label: 'Rain' }, 65: { emoji: '🌧️', label: 'Heavy rain' },
  71: { emoji: '🌨️', label: 'Light snow' }, 73: { emoji: '🌨️', label: 'Snow' }, 75: { emoji: '❄️', label: 'Heavy snow' },
  80: { emoji: '🌦️', label: 'Rain showers' }, 81: { emoji: '🌧️', label: 'Rain showers' }, 82: { emoji: '⛈️', label: 'Violent showers' },
  95: { emoji: '⛈️', label: 'Thunderstorm' }, 96: { emoji: '⛈️', label: 'Storm + hail' }, 99: { emoji: '⛈️', label: 'Severe storm' },
};

export async function fetchWeather(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m` +
    `&hourly=precipitation_probability&forecast_days=1&timezone=auto`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('weather fetch failed');
  const data = await res.json();

  const code = data.current?.weather_code;
  const info = WMO[code] || { emoji: '🌡️', label: 'Unknown' };

  let rainProb = null;
  if (data.hourly?.time && data.hourly?.precipitation_probability) {
    const now = Date.now();
    const upcoming = data.hourly.time
      .map((t, i) => ({ t: new Date(t).getTime(), i }))
      .filter(({ t }) => t >= now && t <= now + 3 * 3600 * 1000)
      .map(({ i }) => data.hourly.precipitation_probability[i] ?? 0);
    if (upcoming.length) rainProb = Math.max(...upcoming);
  }

  return {
    tempC: data.current?.temperature_2m ?? null,
    windKph: data.current?.wind_speed_10m ?? null,
    humidity: data.current?.relative_humidity_2m ?? null,
    code, emoji: info.emoji, label: info.label,
    rainProb,
  };
}
