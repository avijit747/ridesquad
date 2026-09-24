// Leaflet squad map: self + live group member markers.
/* global L */
export const HAZARD_TYPES = {
  police: { emoji: '🚓', label: 'Police check' },
  road: { emoji: '🚧', label: 'Bad road' },
  traffic: { emoji: '🚦', label: 'Traffic jam' },
  accident: { emoji: '⚠️', label: 'Accident / hazard' },
};

export class SquadMap {
  constructor(elId) {
    this.map = L.map(elId, { zoomControl: false, attributionControl: false }).setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      subdomains: 'abc', maxZoom: 19,
      className: 'map-tiles-dark',
    }).addTo(this.map);
    L.control.zoom({ position: 'bottomleft' }).addTo(this.map);
    this.markers = new Map(); // id -> L.marker
    this.sosMarkers = new Map(); // id -> L.marker
    this.hazardMarkers = new Map(); // id -> L.marker
    this.myDestMarker = null;
    this.squadDestMarker = null;
    this._hasCentered = false;

    // set to a function(lat,lng) to receive the next plain map tap (e.g. while picking
    // a destination); markers/controls stop propagation so this only fires on open map
    this.onMapTap = null;
    this.map.on('click', (e) => { if (this.onMapTap) this.onMapTap(e.latlng.lat, e.latlng.lng); });
  }

  _icon(color, emoji, self) {
    return L.divIcon({
      className: '',
      html: `<div class="rider-marker${self ? ' self' : ''}" style="background:${color}">${emoji}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  upsertRider(id, { lat, lng, name, color, self }) {
    if (lat == null || lng == null) return;
    let marker = this.markers.get(id);
    if (!marker) {
      marker = L.marker([lat, lng], { icon: this._icon(color || '#ff4d1c', self ? '🏍' : '🏍', self) })
        .bindTooltip(name || 'Rider', { permanent: true, direction: 'top', offset: [0, -16], className: 'rider-label' })
        .addTo(this.map);
      this.markers.set(id, marker);
    } else {
      marker.setLatLng([lat, lng]);
    }
    if (!this._hasCentered && self) {
      this.map.setView([lat, lng], 15);
      this._hasCentered = true;
    }
  }

  removeRider(id) {
    const marker = this.markers.get(id);
    if (marker) { this.map.removeLayer(marker); this.markers.delete(id); }
    this.clearSOS(id);
  }

  showSOS(id, lat, lng, name) {
    if (lat == null || lng == null) return;
    let marker = this.sosMarkers.get(id);
    const icon = L.divIcon({
      className: '', html: `<div class="sos-marker">🚨</div>`, iconSize: [40, 40], iconAnchor: [20, 20],
    });
    if (!marker) {
      marker = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
        .bindTooltip(`${name || 'Rider'} — SOS`, { permanent: true, direction: 'top', offset: [0, -20], className: 'rider-label' })
        .addTo(this.map);
      this.sosMarkers.set(id, marker);
    } else {
      marker.setLatLng([lat, lng]);
    }
  }

  clearSOS(id) {
    const marker = this.sosMarkers.get(id);
    if (marker) { this.map.removeLayer(marker); this.sosMarkers.delete(id); }
  }

  showHazard(id, lat, lng, hazardType, name) {
    if (lat == null || lng == null) return;
    const info = HAZARD_TYPES[hazardType] || { emoji: '⚠️', label: 'Hazard' };
    const icon = L.divIcon({
      className: '', html: `<div class="hazard-marker">${info.emoji}</div>`, iconSize: [36, 36], iconAnchor: [18, 18],
    });
    const marker = L.marker([lat, lng], { icon, zIndexOffset: 800 })
      .bindTooltip(`${info.label} — ${name || 'Rider'}`, { permanent: false, direction: 'top', offset: [0, -18], className: 'rider-label' })
      .addTo(this.map);
    this.hazardMarkers.set(id, marker);
  }

  clearHazard(id) {
    const marker = this.hazardMarkers.get(id);
    if (marker) { this.map.removeLayer(marker); this.hazardMarkers.delete(id); }
  }

  _destIcon(kind) {
    return L.divIcon({
      className: '', html: `<div class="dest-marker ${kind}"><span>${kind === 'squad' ? '🏁' : '🎯'}</span></div>`,
      iconSize: [38, 38], iconAnchor: [19, 38],
    });
  }

  showMyDestination(lat, lng) {
    if (lat == null || lng == null) return;
    if (this.myDestMarker) this.map.removeLayer(this.myDestMarker);
    this.myDestMarker = L.marker([lat, lng], { icon: this._destIcon('mine'), zIndexOffset: 700 })
      .bindTooltip('Your destination', { permanent: false, direction: 'top', offset: [0, -30], className: 'rider-label' })
      .addTo(this.map);
  }

  clearMyDestination() {
    if (this.myDestMarker) { this.map.removeLayer(this.myDestMarker); this.myDestMarker = null; }
  }

  showSquadDestination(lat, lng, by) {
    if (lat == null || lng == null) return;
    if (this.squadDestMarker) this.map.removeLayer(this.squadDestMarker);
    this.squadDestMarker = L.marker([lat, lng], { icon: this._destIcon('squad'), zIndexOffset: 700 })
      .bindTooltip(`Squad destination — set by ${by || 'a rider'}`, { permanent: false, direction: 'top', offset: [0, -30], className: 'rider-label' })
      .addTo(this.map);
  }

  clearSquadDestination() {
    if (this.squadDestMarker) { this.map.removeLayer(this.squadDestMarker); this.squadDestMarker = null; }
  }

  recenterOnSelf(id) {
    const marker = this.markers.get(id);
    if (marker) this.map.setView(marker.getLatLng(), 16);
  }

  fitAll() {
    const pts = [...this.markers.values()].map((m) => m.getLatLng());
    if (pts.length) this.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }

  invalidate() {
    setTimeout(() => this.map.invalidateSize(), 50);
  }
}
