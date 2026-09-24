// GPS-based speed / acceleration / trip-stat tracking.
const R_EARTH = 6371000; // meters

export function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

export class SpeedTracker {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.watchId = null;
    this.timerId = null;
    this.reset();
  }

  reset() {
    this.lastPos = null; // {lat,lng,t}
    this.lastSpeedMs = 0;
    this.smoothedAccel = 0;
    this.startTime = null;
    this.elapsedMs = 0;
    this.pausedAt = null;
    this.totalDistanceM = 0;
    this.maxSpeedMs = 0;
    this.speedSamples = []; // for avg
    this.current = {
      speedKmh: 0, accelMs2: 0, headingDeg: null,
      lat: null, lng: null, elapsedSec: 0,
      distanceKm: 0, maxSpeedKmh: 0, avgSpeedKmh: 0,
      gpsOk: false,
    };
  }

  start() {
    if (!navigator.geolocation) {
      this.current.gpsOk = false;
      this._emit();
      return;
    }
    this.startTime = Date.now();
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onPosition(pos),
      () => { this.current.gpsOk = false; this._emit(); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 8000 }
    );
    this.timerId = setInterval(() => this._tick(), 1000);
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    if (this.timerId) clearInterval(this.timerId);
    this.watchId = null;
    this.timerId = null;
  }

  _tick() {
    if (this.startTime) {
      this.elapsedMs = Date.now() - this.startTime;
      this.current.elapsedSec = Math.floor(this.elapsedMs / 1000);
    }
    // decay speed toward 0 if no fresh GPS fix for a while (avoid frozen reading)
    if (this.lastPos && Date.now() - this.lastPos.t > 6000) {
      this.current.speedKmh *= 0.7;
      if (this.current.speedKmh < 0.5) this.current.speedKmh = 0;
      this.current.accelMs2 = 0;
    }
    this._emit();
  }

  _onPosition(pos) {
    const { latitude: lat, longitude: lng, speed, heading, accuracy } = pos.coords;
    const t = pos.timestamp || Date.now();
    this.current.gpsOk = true;
    this.current.lat = lat;
    this.current.lng = lng;
    if (heading != null && !Number.isNaN(heading)) this.current.headingDeg = heading;

    let speedMs;
    if (speed != null && !Number.isNaN(speed) && speed >= 0) {
      speedMs = speed;
    } else if (this.lastPos) {
      const dt = (t - this.lastPos.t) / 1000;
      if (dt > 0.2) {
        const distM = haversine(this.lastPos.lat, this.lastPos.lng, lat, lng);
        speedMs = distM / dt;
      } else {
        speedMs = this.lastSpeedMs;
      }
    } else {
      speedMs = 0;
    }
    // reject GPS noise spikes (>250 km/h)
    if (speedMs > 70) speedMs = this.lastSpeedMs;

    // acceleration, low-pass filtered
    if (this.lastPos) {
      const dt = Math.max(0.3, (t - this.lastPos.t) / 1000);
      const rawAccel = (speedMs - this.lastSpeedMs) / dt;
      this.smoothedAccel = this.smoothedAccel * 0.7 + rawAccel * 0.3;
    }

    // distance accumulation
    if (this.lastPos && accuracy != null ? accuracy < 30 : true) {
      if (this.lastPos) {
        const distM = haversine(this.lastPos.lat, this.lastPos.lng, lat, lng);
        if (distM > 0.5) this.totalDistanceM += distM; // ignore GPS jitter under 0.5m
      }
    }

    this.maxSpeedMs = Math.max(this.maxSpeedMs, speedMs);
    this.speedSamples.push(speedMs);
    if (this.speedSamples.length > 600) this.speedSamples.shift();

    this.lastSpeedMs = speedMs;
    this.lastPos = { lat, lng, t };

    this.current.speedKmh = speedMs * 3.6;
    this.current.accelMs2 = this.smoothedAccel;
    this.current.distanceKm = this.totalDistanceM / 1000;
    this.current.maxSpeedKmh = this.maxSpeedMs * 3.6;
    const avgMs = this.speedSamples.reduce((a, b) => a + b, 0) / (this.speedSamples.length || 1);
    this.current.avgSpeedKmh = avgMs * 3.6;

    this._emit();
  }

  _emit() {
    if (this.onUpdate) this.onUpdate({ ...this.current });
  }
}

export function fmtTime(totalSec) {
  const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(totalSec % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}
