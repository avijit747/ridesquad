// WebSocket client: squad membership, location relay, chat, SOS, and WebRTC signaling transport.
export class GroupClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.selfId = null;
    this.room = null;
    this.members = new Map(); // id -> {id,name,color,lat,lng,speed,heading,mic}
    this._locThrottle = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => this._emit('disconnected', {});
      this.ws.onmessage = (ev) => this._onMessage(JSON.parse(ev.data));
    });
  }

  async ensureConnected() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await this.connect();
  }

  join(room, name, color) {
    this.room = room;
    this._send({ type: 'join', room, name, color });
  }

  leave() {
    if (this.ws) this.ws.close();
    this.ws = null;
    this.members.clear();
    this.room = null;
    this.selfId = null;
  }

  sendLocation(lat, lng, speed, heading) {
    this._send({ type: 'location', lat, lng, speed, heading });
  }

  sendMic(active) {
    this._send({ type: 'mic', active });
  }

  sendSOS(lat, lng, message) {
    this._send({ type: 'sos', lat, lng, message });
  }

  sendSOSCancel() {
    this._send({ type: 'sos-cancel' });
  }

  sendChat(text) {
    this._send({ type: 'chat', text });
  }

  sendSignal(to, data) {
    this._send({ type: 'signal', to, data });
  }

  sendSpeedLimit(limitKmh) {
    this._send({ type: 'speed-limit', limitKmh });
  }

  sendOverspeed(speedKmh, limitKmh) {
    this._send({ type: 'overspeed', speedKmh, limitKmh });
  }

  sendHazard(hazardType, lat, lng) {
    this._send({ type: 'hazard', hazardType, lat, lng });
  }

  sendDestination(lat, lng) {
    this._send({ type: 'destination', lat, lng });
  }

  sendDestinationClear() {
    this._send({ type: 'destination-clear' });
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'joined':
        this.selfId = msg.id;
        this.members.clear();
        for (const m of msg.members) this.members.set(m.id, m);
        this._emit('joined', {
          id: msg.id, room: msg.room, members: msg.members,
          speedLimit: msg.speedLimit ?? null, hazards: msg.hazards || [],
          destination: msg.destination ?? null,
        });
        break;
      case 'member-joined':
        this.members.set(msg.member.id, msg.member);
        this._emit('member-joined', msg.member);
        break;
      case 'member-left':
        this.members.delete(msg.id);
        this._emit('member-left', { id: msg.id, name: msg.name });
        break;
      case 'location': {
        const m = this.members.get(msg.id);
        if (m) { m.lat = msg.lat; m.lng = msg.lng; m.speed = msg.speed; m.heading = msg.heading; }
        this._emit('location', msg);
        break;
      }
      case 'mic': {
        const m = this.members.get(msg.id);
        if (m) m.mic = msg.active;
        this._emit('mic', msg);
        break;
      }
      case 'sos':
        this._emit('sos', msg);
        break;
      case 'sos-cancel':
        this._emit('sos-cancel', msg);
        break;
      case 'chat':
        this._emit('chat', msg);
        break;
      case 'signal':
        this._emit('signal', msg);
        break;
      case 'speed-limit':
        this._emit('speed-limit', msg);
        break;
      case 'overspeed':
        this._emit('overspeed', msg);
        break;
      case 'hazard':
        this._emit('hazard', msg);
        break;
      case 'destination':
        this._emit('destination', msg);
        break;
      case 'destination-clear':
        this._emit('destination-clear', msg);
        break;
      case 'error':
        this._emit('error', msg);
        break;
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
