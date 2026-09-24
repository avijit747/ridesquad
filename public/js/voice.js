// WebRTC mesh voice chat, toggled with a MIC ON/OFF button (not push-to-talk — riding
// with gloves on makes holding a button impractical). Turning the mic on for the first
// time in a squad requests the microphone and opens connections to everyone currently
// in the squad; toggling off just mutes the local track so you keep hearing the channel.
// Remote streams always play once connected, regardless of your own mic state.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class VoiceChat {
  constructor(groupClient) {
    this.group = groupClient;
    this.localStream = null;
    this.peers = new Map(); // id -> RTCPeerConnection
    this.audioEls = new Map(); // id -> <audio>
    this.micEnabled = false;
    this.ready = false;

    this.group.addEventListener('member-joined', (e) => this._onMemberJoined(e.detail));
    this.group.addEventListener('member-left', (e) => this._onMemberLeft(e.detail));
    this.group.addEventListener('signal', (e) => this._onSignal(e.detail));
  }

  async init() {
    if (this.ready) return true;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
      this.ready = true;
      return true;
    } catch (err) {
      this.ready = false;
      return false;
    }
  }

  // called after group.join() resolves with existing member list -> initiate offers to each
  async connectToExisting(memberIds) {
    if (!this.ready) return;
    for (const id of memberIds) {
      if (id === this.group.selfId) continue;
      await this._createPeer(id, true);
    }
  }

  async _onMemberJoined(member) {
    if (!this.ready) return;
    if (member.id === this.group.selfId) return;
    // new joiner initiates offers themselves once they call connectToExisting();
    // existing members just wait for the offer. Nothing to do here.
  }

  _onMemberLeft(info) {
    const pc = this.peers.get(info.id);
    if (pc) { pc.close(); this.peers.delete(info.id); }
    const audio = this.audioEls.get(info.id);
    if (audio) { audio.remove(); this.audioEls.delete(info.id); }
  }

  async _createPeer(peerId, initiator) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(peerId, pc);

    this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) this.group.sendSignal(peerId, { candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      let audio = this.audioEls.get(peerId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
        this.audioEls.set(peerId, audio);
      }
      audio.srcObject = e.streams[0];
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.group.sendSignal(peerId, { sdp: pc.localDescription });
    }

    return pc;
  }

  async _onSignal(msg) {
    if (!this.ready) return;
    const { from, data } = msg;
    let pc = this.peers.get(from);
    if (!pc) pc = await this._createPeer(from, false);

    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.group.sendSignal(from, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
    }
  }

  setTalking(active) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = active));
    this.micEnabled = active;
    this.group.sendMic(active);
  }

  teardown() {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    for (const a of this.audioEls.values()) a.remove();
    this.audioEls.clear();
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.ready = false;
  }
}
