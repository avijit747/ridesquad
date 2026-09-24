import { SpeedTracker, fmtTime, haversine } from './speed.js';
import { GroupClient } from './group.js';
import { VoiceChat } from './voice.js';
import { SquadMap, HAZARD_TYPES } from './map.js';
import { fetchWeather } from './weather.js';
import { fetchRoadSpeedLimit } from './roadspeed.js';

const COLORS = ['#ff4d1c', '#ffb703', '#1cff9a', '#38bdf8', '#c084fc', '#ff2e6d'];
const BIKES = ['Sport', 'Naked', 'Cruiser', 'Adventure', 'Scooter'];
const THEMES = [
  { id: 'night', label: 'Night / Sport', desc: 'Dark display — easy on the eyes after dark', swatch: '#0a0c10', border: '#ff4d1c' },
  { id: 'day', label: 'Day / Sunlight', desc: 'Bright display — reads clearly in direct sun', swatch: '#eef1f6', border: '#e04510' },
  { id: 'contrast', label: 'High-Contrast', desc: 'Max contrast for glare or low-vision riding', swatch: '#000000', border: '#ffea00' },
];
const MAX_GAUGE_KMH = 220;
const ARC_DASH = 603.19; // matches CSS stroke-dasharray
const HAZARD_TTL_MS = 45 * 60 * 1000; // client-side marker lifetime, mirrors server
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const ROAD_SPEED_POLL_MS = 60 * 1000; // keep infrequent - shared public Overpass API

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let profile = loadProfile();
let selectedColor = profile?.color || COLORS[0];
let selectedBike = profile?.bike || BIKES[0];

applyTheme(loadTheme());

const speedTracker = new SpeedTracker((state) => onSpeedUpdate(state));
const group = new GroupClient();
const voice = new VoiceChat(group);
let squadMap = null;
let riding = false;
let wakeLock = null;
let lastSOSLocation = null;
let locationSendTimer = null;
let micOn = false;
let squadSpeedLimit = null;
let wasOverLimit = false;
let lastOverspeedAlertAt = 0;
let roadSpeedEnabled = loadRoadSpeedToggle();
let roadSpeedTimer = null;
let weatherTimer = null;
let myDestination = null;
let squadDestination = null;
let pickingDestination = false;
let pendingDestLatLng = null;

// ---------- persistence ----------
function loadProfile() {
  try { return JSON.parse(localStorage.getItem('ridesquad_profile')); } catch { return null; }
}
function saveProfile(p) {
  localStorage.setItem('ridesquad_profile', JSON.stringify(p));
}
function loadTheme() {
  return localStorage.getItem('ridesquad_theme') || 'night';
}
function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('ridesquad_theme', id);
}
function loadRoadSpeedToggle() {
  return localStorage.getItem('ridesquad_road_speed_beta') === '1';
}
function saveRoadSpeedToggle(v) {
  localStorage.setItem('ridesquad_road_speed_beta', v ? '1' : '0');
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- screen navigation ----------
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $(`#screen-${id}`).classList.add('active');
}

function showAppScreen(name) {
  $$('.app-screen').forEach((s) => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
  if (name === 'map') {
    ensureMap();
    squadMap.invalidate();
  }
}

// ============================================================
// SPLASH -> ONBOARDING / APP
// ============================================================
function initSplash() {
  setTimeout(() => {
    if (profile) {
      enterApp();
    } else {
      showScreen('onboarding');
      initOnboarding();
    }
  }, 1900);
}

function initOnboarding() {
  const colorPicker = $('#color-picker');
  colorPicker.innerHTML = COLORS.map((c) =>
    `<div class="color-dot" data-color="${c}" style="background:${c}"></div>`
  ).join('');
  const bikePicker = $('#bike-picker');
  bikePicker.innerHTML = BIKES.map((b) => `<div class="chip" data-bike="${b}">${b}</div>`).join('');

  function refresh() {
    $$('.color-dot').forEach((d) => d.classList.toggle('selected', d.dataset.color === selectedColor));
    $$('.chip').forEach((c) => c.classList.toggle('selected', c.dataset.bike === selectedBike));
  }
  refresh();

  colorPicker.addEventListener('click', (e) => {
    const dot = e.target.closest('.color-dot');
    if (!dot) return;
    selectedColor = dot.dataset.color;
    refresh();
  });
  bikePicker.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectedBike = chip.dataset.bike;
    refresh();
  });

  $('#btn-start-riding').addEventListener('click', () => {
    const name = $('#input-name').value.trim() || 'Rider';
    profile = { name, color: selectedColor, bike: selectedBike, note: '' };
    saveProfile(profile);
    enterApp();
  });
}

function enterApp() {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $('#app-shell').classList.add('active');
  $('#settings-name').value = profile.name;
  $('#settings-note').value = profile.note || '';
  showAppScreen('home');
  initGauge();
  wireNav();
  wireHome();
  wireSquad();
  wireSOS();
  wireSettings();
  wireThemePicker();
  wireHazards();
  wireDestination();
  startWeather();
  if (roadSpeedEnabled) startRoadSpeedPolling();
}

// ============================================================
// THEME
// ============================================================
function wireThemePicker() {
  const picker = $('#theme-picker');
  picker.innerHTML = THEMES.map((t) => `
    <div class="theme-option" data-theme-id="${t.id}">
      <span class="theme-swatch" style="background:${t.swatch}; border-color:${t.border}"></span>
      <div style="flex:1">
        <div class="theme-option-label">${t.label}</div>
        <div class="theme-option-desc">${t.desc}</div>
      </div>
    </div>
  `).join('');

  function refresh() {
    const current = document.documentElement.getAttribute('data-theme') || 'night';
    $$('.theme-option').forEach((el) => el.classList.toggle('selected', el.dataset.themeId === current));
  }
  refresh();

  picker.addEventListener('click', (e) => {
    const opt = e.target.closest('.theme-option');
    if (!opt) return;
    applyTheme(opt.dataset.themeId);
    refresh();
  });
}

// ============================================================
// WEATHER
// ============================================================
function startWeather() {
  fetchWeatherOnce();
  if (weatherTimer) clearInterval(weatherTimer);
  weatherTimer = setInterval(fetchWeatherOnce, WEATHER_REFRESH_MS);
}

async function fetchWeatherOnce() {
  let lat = speedTracker.current.lat;
  let lng = speedTracker.current.lng;
  if (lat == null) {
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 6000 })
      );
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    } catch {
      return; // no location available yet - try again next interval
    }
  }
  try {
    renderWeather(await fetchWeather(lat, lng));
  } catch {
    /* weather is best-effort; fail silently */
  }
}

function renderWeather(w) {
  $('#weather-widget').style.display = 'flex';
  $('#weather-emoji').textContent = w.emoji;
  $('#weather-temp').textContent = w.tempC != null ? `${Math.round(w.tempC)}°C` : '--°C';
  $('#weather-label').textContent = w.label;
  $('#weather-extra').textContent = w.windKph != null ? `💨 ${Math.round(w.windKph)} km/h` : '';

  const rainAlert = $('#rain-alert');
  if (w.rainProb != null && w.rainProb >= 55) {
    rainAlert.style.display = 'block';
    rainAlert.textContent = `🌧️ ${w.rainProb}% chance of rain in the next few hours — ride safe.`;
  } else {
    rainAlert.style.display = 'none';
  }
}

// ============================================================
// ROAD SPEED LIMIT (Beta, best-effort via OpenStreetMap)
// ============================================================
function startRoadSpeedPolling() {
  stopRoadSpeedPolling();
  const poll = async () => {
    const s = speedTracker.current;
    if (s.lat == null) return;
    const limit = await fetchRoadSpeedLimit(s.lat, s.lng);
    $('#stat-road-limit-card').style.display = '';
    $('#stat-road-limit').innerHTML = limit != null
      ? `${limit}<span class="stat-sub">km/h</span>`
      : `—<span class="stat-sub">km/h</span>`;
    updateLimitsRowVisibility();
  };
  poll();
  roadSpeedTimer = setInterval(poll, ROAD_SPEED_POLL_MS);
}

function stopRoadSpeedPolling() {
  if (roadSpeedTimer) clearInterval(roadSpeedTimer);
  roadSpeedTimer = null;
  $('#stat-road-limit-card').style.display = 'none';
  updateLimitsRowVisibility();
}

function updateLimitsRowVisibility() {
  const anyVisible = $('#stat-squad-limit-card').style.display !== 'none'
    || $('#stat-road-limit-card').style.display !== 'none';
  $('#limits-row').style.display = anyVisible ? 'flex' : 'none';
}

// ============================================================
// NAV
// ============================================================
function wireNav() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showAppScreen(btn.dataset.screen));
  });
}

// ============================================================
// GAUGE (dashboard)
// ============================================================
function initGauge() {
  const ticksGroup = $('#gauge-ticks');
  const steps = 12; // 0..220 step 20
  let html = '';
  for (let i = 0; i < steps; i++) {
    const val = Math.round((MAX_GAUGE_KMH / (steps - 1)) * i);
    const angleDeg = (270 / (steps - 1)) * i; // 0..270, local (pre-rotation) coords
    const rad = (angleDeg * Math.PI) / 180;
    const cx = 150, cy = 150;
    const rOuter = 128, rInner = 110, rLabel = 92;
    const x1 = cx + rOuter * Math.cos(rad), y1 = cy + rOuter * Math.sin(rad);
    const x2 = cx + rInner * Math.cos(rad), y2 = cy + rInner * Math.sin(rad);
    const lx = cx + rLabel * Math.cos(rad), ly = cy + rLabel * Math.sin(rad);
    html += `<line class="gauge-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    html += `<text class="gauge-tick-label" x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" transform="rotate(210 ${lx} ${ly})">${val}</text>`;
  }
  ticksGroup.innerHTML = html;
}

function updateGauge(speedKmh) {
  const pct = Math.max(0, Math.min(1, speedKmh / MAX_GAUGE_KMH));
  const offset = ARC_DASH * (1 - pct);
  $('#gauge-fill').style.strokeDashoffset = offset.toFixed(1);
  const fill = $('#gauge-fill');
  if (speedKmh > 140) fill.style.stroke = 'var(--danger)';
  else if (speedKmh > 90) fill.style.stroke = 'var(--accent2)';
  else fill.style.stroke = 'var(--accent)';
}

// ============================================================
// HOME / SPEED TRACKING
// ============================================================
function onSpeedUpdate(state) {
  $('#speed-value').textContent = Math.round(state.speedKmh);
  updateGauge(state.speedKmh);
  $('#stat-time').textContent = fmtTime(state.elapsedSec);
  $('#stat-accel').innerHTML = `${state.accelMs2.toFixed(1)}<span class="stat-sub">m/s²</span>`;
  $('#stat-distance').innerHTML = `${state.distanceKm.toFixed(2)}<span class="stat-sub">km</span>`;
  $('#stat-max').innerHTML = `${Math.round(state.maxSpeedKmh)}<span class="stat-sub">km/h</span>`;
  $('#stat-avg').innerHTML = `${Math.round(state.avgSpeedKmh)}<span class="stat-sub">km/h</span>`;

  const gpsBadge = $('#gps-badge');
  gpsBadge.textContent = state.gpsOk ? 'GPS OK' : 'GPS —';
  gpsBadge.classList.toggle('good', state.gpsOk);

  lastSOSLocation = state.lat != null ? { lat: state.lat, lng: state.lng } : lastSOSLocation;

  if (state.lat != null && group.selfId) {
    updateSelfOnMap(state);
    const m = group.members.get(group.selfId);
    if (m) { m.lat = state.lat; m.lng = state.lng; m.speed = state.speedKmh; m.heading = state.headingDeg; }
  }

  if (group.room && squadSpeedLimit != null) {
    const isOver = state.speedKmh > squadSpeedLimit;
    $('#stat-squad-limit-card').classList.toggle('over-limit', isOver);
    if (isOver && (!wasOverLimit || Date.now() - lastOverspeedAlertAt > 60000)) {
      toast(`⚠️ Over squad limit — ${Math.round(state.speedKmh)}/${squadSpeedLimit} km/h`);
      navigator.vibrate?.(150);
      group.sendOverspeed(state.speedKmh, squadSpeedLimit);
      lastOverspeedAlertAt = Date.now();
    }
    wasOverLimit = isOver;
  }

  if (myDestination || squadDestination) updateDestinationPill();
}

function wireHome() {
  $('#btn-ride-toggle').addEventListener('click', async () => {
    riding = !riding;
    const btn = $('#btn-ride-toggle');
    if (riding) {
      speedTracker.reset();
      speedTracker.start();
      btn.textContent = '■ End Ride';
      btn.classList.add('btn-danger-outline');
      requestWakeLock();
      startLocationBroadcast();
    } else {
      speedTracker.stop();
      btn.textContent = '▶ Start Ride';
      btn.classList.remove('btn-danger-outline');
      releaseWakeLock();
      stopLocationBroadcast();
    }
  });
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported / denied */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

function startLocationBroadcast() {
  stopLocationBroadcast();
  locationSendTimer = setInterval(() => {
    if (!group.room) return;
    const s = speedTracker.current;
    if (s.lat == null) return;
    group.sendLocation(s.lat, s.lng, Math.round(s.speedKmh), s.headingDeg || 0);
  }, 2000);
}
function stopLocationBroadcast() {
  if (locationSendTimer) clearInterval(locationSendTimer);
  locationSendTimer = null;
}

// ============================================================
// MAP
// ============================================================
function ensureMap() {
  if (squadMap) return;
  squadMap = new SquadMap('leaflet-map');
  $('#btn-recenter').addEventListener('click', () => {
    if (group.selfId) squadMap.recenterOnSelf(group.selfId);
  });
}

function updateSelfOnMap(state) {
  if (!squadMap) return;
  squadMap.upsertRider(group.selfId, {
    lat: state.lat, lng: state.lng, name: `${profile.name} (You)`, color: profile.color, self: true,
  });
}

function renderAllOnMap() {
  if (!squadMap) return;
  for (const [id, m] of group.members) {
    if (m.lat == null) continue;
    squadMap.upsertRider(id, {
      lat: m.lat, lng: m.lng,
      name: id === group.selfId ? `${m.name} (You)` : m.name,
      color: m.color, self: id === group.selfId,
    });
  }
}

// ============================================================
// SQUAD (join/create, members, voice, chat)
// ============================================================
function genRoomCode() {
  // 8 chars from a 32-symbol alphabet (~1.1e12 combinations) - long enough that
  // guessing a live squad code is impractical even against a public server,
  // especially combined with the server's own join-rate limiting.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function wireSquad() {
  $('#btn-new-room').addEventListener('click', () => {
    $('#input-room').value = genRoomCode();
    joinRoom();
  });
  $('#btn-join-room').addEventListener('click', joinRoom);
  $('#input-room').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#btn-leave-room').addEventListener('click', leaveRoom);

  $('#btn-chat-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  $('#btn-mic-toggle').addEventListener('click', toggleMic);

  $$('.quick-status-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!group.room) { toast('Join a squad first'); return; }
      const text = btn.dataset.status;
      group.sendChat(text);
      appendChat(profile.name, text, true);
      toast('Status sent to squad');
    });
  });

  $('#btn-set-speed-limit').addEventListener('click', () => {
    if (!group.room) { toast('Join a squad first'); return; }
    const val = Number($('#input-speed-limit').value);
    if (!Number.isFinite(val) || val <= 0) { toast('Enter a valid speed limit'); return; }
    group.sendSpeedLimit(val);
    applySquadSpeedLimit(val);
    $('#input-speed-limit').value = '';
    toast(`Squad speed limit set to ${val} km/h`);
  });

  group.addEventListener('joined', (e) => {
    $('#squad-join-box').style.display = 'none';
    $('#squad-active-box').style.display = 'block';
    $('#squad-code-display').textContent = e.detail.room;
    $('#map-room-pill').textContent = `Squad ${e.detail.room} · ${e.detail.members.length} riders`;
    setConnectedStatus(true);
    renderMembers();
    ensureMap();
    renderAllOnMap();
    resetMicUI();
    applySquadSpeedLimit(e.detail.speedLimit);
    for (const h of e.detail.hazards) addHazardMarker(h.id, h.lat, h.lng, h.hazardType, h.name, h.time);
    if (e.detail.destination) applySquadDestination(e.detail.destination.lat, e.detail.destination.lng, e.detail.destination.by);
  });

  group.addEventListener('member-joined', (m) => {
    toast(`${m.detail.name} joined the squad`);
    renderMembers();
    updateRoomPill();
  });
  group.addEventListener('member-left', (m) => {
    toast(`${m.detail.name} left the squad`);
    renderMembers();
    updateRoomPill();
    if (squadMap) squadMap.removeRider(m.detail.id);
  });
  group.addEventListener('location', () => { renderMembers(); renderAllOnMap(); });
  group.addEventListener('mic', () => renderMembers());
  group.addEventListener('chat', (e) => appendChat(e.detail.name, e.detail.text, false));
  group.addEventListener('sos', (e) => handleIncomingSOS(e.detail));
  group.addEventListener('sos-cancel', (e) => {
    toast(`${e.detail.name} cancelled their SOS`);
    if (squadMap) squadMap.clearSOS(e.detail.id);
  });
  group.addEventListener('speed-limit', (e) => {
    applySquadSpeedLimit(e.detail.limitKmh);
    toast(`Squad speed limit set to ${e.detail.limitKmh} km/h by ${e.detail.by}`);
  });
  group.addEventListener('overspeed', (e) => {
    toast(`🚨 ${e.detail.name} is over the squad limit! (${Math.round(e.detail.speedKmh)}/${e.detail.limitKmh} km/h)`);
    navigator.vibrate?.(150);
  });
  group.addEventListener('hazard', (e) => {
    const info = HAZARD_TYPES[e.detail.hazardType] || { emoji: '⚠️', label: 'Hazard' };
    addHazardMarker(e.detail.id, e.detail.lat, e.detail.lng, e.detail.hazardType, e.detail.name, e.detail.time);
    toast(`${info.emoji} ${info.label} reported by ${e.detail.name}`);
    navigator.vibrate?.(100);
  });
  group.addEventListener('destination', (e) => {
    applySquadDestination(e.detail.lat, e.detail.lng, e.detail.by);
    toast(`🏁 ${e.detail.by} set the squad destination`);
  });
  group.addEventListener('destination-clear', (e) => {
    clearSquadDestinationLocal();
    toast(`Squad destination cleared by ${e.detail.by}`);
  });
  group.addEventListener('error', (e) => toast(e.detail.message));
  group.addEventListener('disconnected', () => setConnectedStatus(false));
}

function applySquadSpeedLimit(limitKmh) {
  squadSpeedLimit = limitKmh;
  wasOverLimit = false;
  $('#stat-squad-limit-card').classList.remove('over-limit');
  if (limitKmh != null) {
    $('#stat-squad-limit-card').style.display = '';
    $('#stat-squad-limit').innerHTML = `${Math.round(limitKmh)}<span class="stat-sub">km/h</span>`;
    $('#speed-limit-current').style.display = 'block';
    $('#speed-limit-current').innerHTML = `Current squad limit: <b>${Math.round(limitKmh)}</b> km/h`;
  } else {
    $('#stat-squad-limit-card').style.display = 'none';
    $('#speed-limit-current').style.display = 'none';
  }
  updateLimitsRowVisibility();
}

function addHazardMarker(id, lat, lng, hazardType, name, time) {
  ensureMap();
  squadMap.showHazard(id, lat, lng, hazardType, name);
  const remaining = Math.max(5000, time + HAZARD_TTL_MS - Date.now());
  setTimeout(() => { if (squadMap) squadMap.clearHazard(id); }, remaining);
}

function wireHazards() {
  $('#btn-hazard').addEventListener('click', () => {
    if (!group.room) { toast('Join a squad first'); return; }
    $('#hazard-picker-overlay').classList.add('show');
  });
  $('#btn-hazard-cancel').addEventListener('click', () => {
    $('#hazard-picker-overlay').classList.remove('show');
  });
  $$('.hazard-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#hazard-picker-overlay').classList.remove('show');
      const type = btn.dataset.hazard;
      const s = speedTracker.current;
      const loc = s.lat != null ? s : lastSOSLocation;
      if (!loc || loc.lat == null) { toast('No GPS fix yet — start your ride first'); return; }
      group.sendHazard(type, loc.lat, loc.lng);
      addHazardMarker(`self-${Date.now()}`, loc.lat, loc.lng, type, profile.name, Date.now());
      toast('Hazard reported to squad');
    });
  });
}

// ============================================================
// DESTINATION (target location - private or shared with squad)
// ============================================================
function wireDestination() {
  $('#btn-destination').addEventListener('click', () => {
    if (pickingDestination) { cancelPickingDestination(); return; }
    ensureMap();
    pickingDestination = true;
    $('#btn-destination').classList.add('picking');
    toast('Tap the map to set your destination');
    squadMap.onMapTap = (lat, lng) => {
      pendingDestLatLng = { lat, lng };
      cancelPickingDestination();
      $('#destination-picker-overlay').classList.add('show');
    };
  });

  $('#btn-dest-mine').addEventListener('click', () => {
    $('#destination-picker-overlay').classList.remove('show');
    if (!pendingDestLatLng) return;
    applyMyDestination(pendingDestLatLng.lat, pendingDestLatLng.lng);
    toast('Destination set');
    pendingDestLatLng = null;
  });

  $('#btn-dest-squad').addEventListener('click', () => {
    $('#destination-picker-overlay').classList.remove('show');
    if (!pendingDestLatLng) return;
    if (!group.room) { toast('Join a squad first to share a destination'); return; }
    group.sendDestination(pendingDestLatLng.lat, pendingDestLatLng.lng);
    applySquadDestination(pendingDestLatLng.lat, pendingDestLatLng.lng, profile.name);
    toast('Destination shared with squad');
    pendingDestLatLng = null;
  });

  $('#btn-dest-cancel').addEventListener('click', () => {
    $('#destination-picker-overlay').classList.remove('show');
    pendingDestLatLng = null;
  });

  $('#destination-pill').addEventListener('click', (e) => {
    const clearEl = e.target.closest('.dest-clear');
    if (!clearEl) return;
    if (clearEl.dataset.clear === 'mine') {
      clearMyDestination();
    } else if (clearEl.dataset.clear === 'squad') {
      if (group.room) group.sendDestinationClear();
      clearSquadDestinationLocal();
    }
  });
}

function cancelPickingDestination() {
  pickingDestination = false;
  $('#btn-destination').classList.remove('picking');
  if (squadMap) squadMap.onMapTap = null;
}

function applyMyDestination(lat, lng) {
  myDestination = { lat, lng };
  ensureMap();
  squadMap.showMyDestination(lat, lng);
  updateDestinationPill();
}

function clearMyDestination() {
  myDestination = null;
  if (squadMap) squadMap.clearMyDestination();
  updateDestinationPill();
}

function applySquadDestination(lat, lng, by) {
  squadDestination = { lat, lng, by };
  ensureMap();
  squadMap.showSquadDestination(lat, lng, by);
  updateDestinationPill();
}

function clearSquadDestinationLocal() {
  squadDestination = null;
  if (squadMap) squadMap.clearSquadDestination();
  updateDestinationPill();
}

function updateDestinationPill() {
  const pill = $('#destination-pill');
  const pos = speedTracker.current.lat != null ? speedTracker.current : lastSOSLocation;
  const lines = [];

  if (myDestination) {
    let distText = '';
    if (pos && pos.lat != null) {
      const d = haversine(pos.lat, pos.lng, myDestination.lat, myDestination.lng);
      distText = ` — <b>${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'}</b>`;
    }
    lines.push(`🎯 Your destination${distText} <span class="dest-clear" data-clear="mine">✕</span>`);
  }
  if (squadDestination) {
    let distText = '';
    if (pos && pos.lat != null) {
      const d = haversine(pos.lat, pos.lng, squadDestination.lat, squadDestination.lng);
      distText = ` — <b>${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'}</b>`;
    }
    lines.push(`🏁 Squad destination (${escapeHtml(squadDestination.by)})${distText} <span class="dest-clear" data-clear="squad">✕</span>`);
  }

  if (lines.length) {
    pill.innerHTML = lines.join('<br>');
    pill.style.display = 'block';
  } else {
    pill.style.display = 'none';
  }
}

// ============================================================
// VOICE (MIC ON/OFF toggle)
// ============================================================
async function toggleMic() {
  if (!group.room) { toast('Join a squad first'); return; }
  const btn = $('#btn-mic-toggle');

  if (!micOn) {
    btn.disabled = true;
    if (!voice.ready) {
      const ok = await voice.init();
      if (!ok) {
        btn.disabled = false;
        toast('Microphone permission denied');
        return;
      }
    }
    const others = [...group.members.keys()].filter((id) => id !== group.selfId);
    await voice.connectToExisting(others);
    voice.setTalking(true);
    micOn = true;
    btn.disabled = false;
  } else {
    voice.setTalking(false);
    micOn = false;
  }
  updateMicUI();
}

function updateMicUI() {
  const btn = $('#btn-mic-toggle');
  btn.classList.toggle('on', micOn);
  btn.querySelector('.mic-toggle-label').textContent = micOn ? 'MIC ON' : 'MIC OFF';
  $('#voice-status').textContent = micOn
    ? 'Live — your squad can hear you'
    : voice.ready
      ? 'Connected — mic muted, you can still hear the squad'
      : 'Tap MIC ON to connect voice with your squad';
}

function resetMicUI() {
  micOn = false;
  updateMicUI();
}

function updateRoomPill() {
  $('#map-room-pill').textContent = `Squad ${group.room} · ${group.members.size} riders`;
  $('#squad-count').textContent = `${group.members.size} rider${group.members.size === 1 ? '' : 's'}`;
}

async function joinRoom() {
  let code = $('#input-room').value.trim().toUpperCase();
  if (!code) code = genRoomCode();
  $('#input-room').value = code;
  try {
    await group.ensureConnected();
    group.join(code, profile.name, profile.color);
  } catch (err) {
    toast('Could not reach server — is it running?');
  }
}

function leaveRoom() {
  voice.teardown();
  group.leave();
  resetMicUI();
  applySquadSpeedLimit(null);
  clearSquadDestinationLocal();
  cancelPickingDestination();
  $('#squad-join-box').style.display = 'block';
  $('#squad-active-box').style.display = 'none';
  $('#map-room-pill').textContent = 'No squad joined';
  setConnectedStatus(false);
  $('#chat-log').innerHTML = '';
  if (squadMap) {
    for (const id of [...squadMap.markers.keys()]) squadMap.removeRider(id);
    for (const id of [...squadMap.sosMarkers.keys()]) squadMap.clearSOS(id);
    for (const id of [...squadMap.hazardMarkers.keys()]) squadMap.clearHazard(id);
  }
}

function setConnectedStatus(on) {
  $('#ride-status-dot').classList.toggle('on', on);
  $('#ride-status-text').textContent = on ? `Squad ${group.room}` : 'Not connected';
}

function renderMembers() {
  const list = $('#member-list');
  const items = [...group.members.values()];
  list.innerHTML = items.map((m) => `
    <div class="member-row">
      <span class="member-dot" style="background:${m.color || '#888'}"></span>
      <span class="member-name">${escapeHtml(m.name)}${m.id === group.selfId ? ' (You)' : ''}</span>
      <span class="member-speed">${m.speed != null ? Math.round(m.speed) : 0} km/h</span>
      <span class="member-mic ${m.mic ? 'active' : ''}">🎙</span>
    </div>
  `).join('');
  updateRoomPill();
}

function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  group.sendChat(text);
  appendChat(profile.name, text, true);
  input.value = '';
}

function appendChat(name, text, self) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<b>${escapeHtml(self ? 'You' : name)}:</b>${escapeHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// SOS
// ============================================================
let sosTimer = null;
let sosCountdown = 3;

function wireSOS() {
  $('#btn-sos').addEventListener('click', () => {
    if (!group.room) { toast('Join a squad first to enable SOS'); return; }
    sosCountdown = 3;
    $('#sos-countdown').textContent = sosCountdown;
    $('#sos-confirm-overlay').classList.add('show');
    sosTimer = setInterval(() => {
      sosCountdown -= 1;
      if (sosCountdown <= 0) {
        clearInterval(sosTimer);
        fireSOS();
      } else {
        $('#sos-countdown').textContent = sosCountdown;
      }
    }, 1000);
  });

  $('#btn-sos-cancel').addEventListener('click', () => {
    clearInterval(sosTimer);
    $('#sos-confirm-overlay').classList.remove('show');
  });

  $('#btn-sos-dismiss').addEventListener('click', () => {
    $('#sos-incoming-overlay').classList.remove('show');
  });
  $('#btn-sos-view').addEventListener('click', () => {
    $('#sos-incoming-overlay').classList.remove('show');
    showAppScreen('map');
  });
}

function fireSOS() {
  $('#sos-confirm-overlay').classList.remove('show');
  const loc = lastSOSLocation;
  const note = profile.note ? ` Info: ${profile.note}` : '';
  group.sendSOS(loc?.lat ?? null, loc?.lng ?? null, `${profile.name} needs help!${note}`);
  toast('🚨 SOS sent to your squad');
  navigator.vibrate?.(200);
}

function handleIncomingSOS(detail) {
  $('#sos-incoming-name').textContent = detail.name;
  $('#sos-incoming-msg').textContent = detail.message;
  let distText = '';
  if (detail.lat != null && lastSOSLocation) {
    const distM = haversine(lastSOSLocation.lat, lastSOSLocation.lng, detail.lat, detail.lng);
    distText = distM < 1000 ? `${Math.round(distM)} m away` : `${(distM / 1000).toFixed(1)} km away`;
  }
  $('#sos-incoming-dist').textContent = distText;
  $('#sos-incoming-overlay').classList.add('show');
  playAlertSound();
  navigator.vibrate?.([200, 100, 200, 100, 200]);

  if (detail.lat != null) {
    ensureMap();
    squadMap.showSOS(detail.id, detail.lat, detail.lng, detail.name);
    squadMap.map.setView([detail.lat, detail.lng], 15);
  }
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((delay) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.12;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.15);
    });
  } catch { /* audio not available */ }
}

// ============================================================
// SETTINGS
// ============================================================
function wireSettings() {
  $('#btn-save-settings').addEventListener('click', () => {
    profile.name = $('#settings-name').value.trim() || profile.name;
    profile.note = $('#settings-note').value.trim();
    saveProfile(profile);
    toast('Profile saved');
  });

  const roadToggle = $('#toggle-road-speed');
  roadToggle.checked = roadSpeedEnabled;
  roadToggle.addEventListener('change', () => {
    roadSpeedEnabled = roadToggle.checked;
    saveRoadSpeedToggle(roadSpeedEnabled);
    if (roadSpeedEnabled) startRoadSpeedPolling();
    else stopRoadSpeedPolling();
  });
}

// ============================================================
// BOOT
// ============================================================
initSplash();
