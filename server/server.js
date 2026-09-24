const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

// roomCode -> Map<clientId, { ws, name, color, lat, lng, speed, heading, mic, joinedAt }>
const rooms = new Map();

// roomCode -> { speedLimit: number|null, hazards: [{id,hazardType,lat,lng,name,time}], destination }
// Hazard reports (police checks / bad roads / traffic) are entirely squad-sourced —
// riders report what they see, relayed only to their own squad. There is no external
// live-traffic or checkpoint data source involved.
const roomMeta = new Map();
const HAZARD_TTL_MS = 45 * 60 * 1000;

function getMeta(roomCode) {
  if (!roomMeta.has(roomCode)) roomMeta.set(roomCode, { speedLimit: null, hazards: [], destination: null });
  return roomMeta.get(roomCode);
}

function activeHazards(meta) {
  const now = Date.now();
  meta.hazards = meta.hazards.filter((h) => now - h.time < HAZARD_TTL_MS);
  return meta.hazards;
}

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function roomMembersPublic(room) {
  const out = [];
  for (const [id, m] of room) {
    out.push({
      id, name: m.name, color: m.color,
      lat: m.lat, lng: m.lng, speed: m.speed, heading: m.heading, mic: m.mic,
    });
  }
  return out;
}

function broadcast(room, payload, exceptId) {
  const data = JSON.stringify(payload);
  for (const [id, m] of room) {
    if (id === exceptId) continue;
    if (m.ws.readyState === 1) m.ws.send(data);
  }
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

// ============================================================
// Abuse protection
// This server is designed to be reachable from the open internet (not just a
// home LAN), so every limit below exists to bound what a single misbehaving
// or malicious client can do to everyone else sharing this free-tier instance.
// Limits are deliberately generous for a real group of riders and stingy for
// anything that looks like scripted abuse.
// ============================================================
const MAX_ROOMS = 2000;                        // total distinct squads at once
const MAX_MEMBERS_PER_ROOM = 25;                // riders per squad
const MAX_OPEN_CONNECTIONS_PER_IP = 8;          // simultaneous sockets from one IP
const MAX_NEW_CONNECTIONS_PER_IP_PER_MIN = 20;  // new sockets per IP per minute
const MAX_JOINS_PER_CONNECTION_PER_MIN = 6;     // room-code attempts on one socket
const MAX_MESSAGES_PER_CONNECTION_PER_SEC = 15; // general flood guard
const SOS_COOLDOWN_MS = 10_000;
const HAZARD_COOLDOWN_MS = 5_000;

const ipOpenConnections = new Map();  // ip -> open socket count
const ipConnectAttempts = new Map();  // ip -> { count, windowStart }

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function allowNewConnection(ip) {
  const now = Date.now();
  const rec = ipConnectAttempts.get(ip) || { count: 0, windowStart: now };
  if (now - rec.windowStart > 60_000) { rec.count = 0; rec.windowStart = now; }
  rec.count += 1;
  ipConnectAttempts.set(ip, rec);
  if (rec.count > MAX_NEW_CONNECTIONS_PER_IP_PER_MIN) return false;
  if ((ipOpenConnections.get(ip) || 0) >= MAX_OPEN_CONNECTIONS_PER_IP) return false;
  return true;
}

// periodic sweep so these maps don't grow forever on a long-running deployment
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipConnectAttempts) {
    if (now - rec.windowStart > 5 * 60_000) ipConnectAttempts.delete(ip);
  }
}, 5 * 60_000).unref();

wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  if (!allowNewConnection(ip)) {
    ws.close(1013, 'Too many connections - try again shortly');
    return;
  }
  ipOpenConnections.set(ip, (ipOpenConnections.get(ip) || 0) + 1);

  const clientId = genId();
  let currentRoom = null;
  let roomCode = null;
  let joinAttempts = 0;
  let joinWindowStart = Date.now();
  let msgCount = 0;
  let msgWindowStart = Date.now();
  let lastSOSAt = 0;
  let lastHazardAt = 0;

  function withinMessageRate() {
    const now = Date.now();
    if (now - msgWindowStart > 1000) { msgCount = 0; msgWindowStart = now; }
    msgCount += 1;
    return msgCount <= MAX_MESSAGES_PER_CONNECTION_PER_SEC;
  }

  function leaveCurrentRoom() {
    if (!currentRoom || !roomCode) return;
    const prevRoom = currentRoom;
    const prevCode = roomCode;
    const m = prevRoom.get(clientId);
    prevRoom.delete(clientId);
    if (m) broadcast(prevRoom, { type: 'member-left', id: clientId, name: m.name });
    if (prevRoom.size === 0) { rooms.delete(prevCode); roomMeta.delete(prevCode); }
    currentRoom = null;
    roomCode = null;
  }

  ws.on('message', (raw) => {
    if (!withinMessageRate()) return; // silently drop - client is over the flood limit

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const now = Date.now();
      if (now - joinWindowStart > 60_000) { joinAttempts = 0; joinWindowStart = now; }
      joinAttempts += 1;
      if (joinAttempts > MAX_JOINS_PER_CONNECTION_PER_MIN) {
        ws.close(1013, 'Too many join attempts');
        return;
      }

      leaveCurrentRoom(); // clean up membership if this socket was already in a room

      const code = String(msg.room || 'PUBLIC').toUpperCase().slice(0, 12);
      if (!rooms.has(code)) {
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { type: 'error', message: 'Server is at capacity - try again later' });
          return;
        }
        rooms.set(code, new Map());
      }
      const room = rooms.get(code);
      if (room.size >= MAX_MEMBERS_PER_ROOM) {
        send(ws, { type: 'error', message: 'This squad is full' });
        return;
      }

      roomCode = code;
      currentRoom = room;
      currentRoom.set(clientId, {
        ws,
        name: (msg.name || 'Rider').slice(0, 24),
        color: msg.color || '#ff5c00',
        lat: null, lng: null, speed: 0, heading: 0, mic: false,
        joinedAt: Date.now(),
      });

      const meta = getMeta(roomCode);
      send(ws, {
        type: 'joined', id: clientId, room: roomCode, members: roomMembersPublic(currentRoom),
        speedLimit: meta.speedLimit, hazards: activeHazards(meta), destination: meta.destination,
      });
      broadcast(currentRoom, { type: 'member-joined', member: { id: clientId, ...currentRoom.get(clientId), ws: undefined } }, clientId);
      return;
    }

    if (msg.type === 'leave') {
      leaveCurrentRoom();
      return;
    }

    if (!currentRoom) return; // must join first

    switch (msg.type) {
      case 'location': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        m.lat = msg.lat; m.lng = msg.lng; m.speed = msg.speed || 0; m.heading = msg.heading || 0;
        broadcast(currentRoom, { type: 'location', id: clientId, lat: m.lat, lng: m.lng, speed: m.speed, heading: m.heading }, clientId);
        break;
      }
      case 'mic': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        m.mic = !!msg.active;
        broadcast(currentRoom, { type: 'mic', id: clientId, active: m.mic }, clientId);
        break;
      }
      case 'sos': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        const now = Date.now();
        if (now - lastSOSAt < SOS_COOLDOWN_MS) return;
        lastSOSAt = now;
        broadcast(currentRoom, {
          type: 'sos', id: clientId, name: m.name,
          lat: msg.lat ?? m.lat, lng: msg.lng ?? m.lng,
          message: msg.message || `${m.name} triggered an SOS!`,
          time: now,
        }, clientId);
        break;
      }
      case 'sos-cancel': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        broadcast(currentRoom, { type: 'sos-cancel', id: clientId, name: m.name }, clientId);
        break;
      }
      case 'chat': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        broadcast(currentRoom, { type: 'chat', id: clientId, name: m.name, text: String(msg.text || '').slice(0, 500), time: Date.now() }, clientId);
        break;
      }
      case 'signal': {
        // WebRTC signaling relay: forward to a specific peer in the same room
        const target = currentRoom.get(msg.to);
        if (target) send(target.ws, { type: 'signal', from: clientId, data: msg.data });
        break;
      }
      case 'speed-limit': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        const limit = Number(msg.limitKmh);
        if (!Number.isFinite(limit) || limit <= 0 || limit > 400) return;
        getMeta(roomCode).speedLimit = limit;
        broadcast(currentRoom, { type: 'speed-limit', limitKmh: limit, by: m.name }, clientId);
        break;
      }
      case 'overspeed': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        broadcast(currentRoom, {
          type: 'overspeed', id: clientId, name: m.name,
          speedKmh: msg.speedKmh, limitKmh: msg.limitKmh, time: Date.now(),
        }, clientId);
        break;
      }
      case 'hazard': {
        const m = currentRoom.get(clientId);
        if (!m || msg.lat == null || msg.lng == null) return;
        const now = Date.now();
        if (now - lastHazardAt < HAZARD_COOLDOWN_MS) return;
        lastHazardAt = now;
        const meta = getMeta(roomCode);
        const hazard = {
          id: genId(), hazardType: String(msg.hazardType || 'hazard').slice(0, 24),
          lat: msg.lat, lng: msg.lng, name: m.name, time: now,
        };
        meta.hazards.push(hazard);
        activeHazards(meta);
        broadcast(currentRoom, { type: 'hazard', ...hazard }, clientId);
        break;
      }
      case 'destination': {
        const m = currentRoom.get(clientId);
        if (!m || msg.lat == null || msg.lng == null) return;
        const destination = { lat: msg.lat, lng: msg.lng, by: m.name, time: Date.now() };
        getMeta(roomCode).destination = destination;
        broadcast(currentRoom, { type: 'destination', ...destination }, clientId);
        break;
      }
      case 'destination-clear': {
        const m = currentRoom.get(clientId);
        if (!m) return;
        getMeta(roomCode).destination = null;
        broadcast(currentRoom, { type: 'destination-clear', by: m.name }, clientId);
        break;
      }
    }
  });

  ws.on('close', () => {
    const cnt = ipOpenConnections.get(ip) || 1;
    if (cnt <= 1) ipOpenConnections.delete(ip); else ipOpenConnections.set(ip, cnt - 1);
    leaveCurrentRoom();
  });
});

server.listen(PORT, () => {
  console.log(`RideSquad server running at http://localhost:${PORT}`);
});
