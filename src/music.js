// Music for Drive mode: "Neon Meridian", an original 80s synthwave piece in A minor at 106 bpm,
// synthesised as it plays with the Web Audio API (no audio files). Four on the floor, a gated
// snare, a thick pumping saw bass, detuned pads ducking under the kick, a square-wave arpeggio
// through a dotted-eighth delay, and a saw lead.
//
// The song is data: sections of bars, each bar a chord, with the parts that play in it. Notes are
// MIDI numbers; times are sixteenth-note steps, 16 to a bar. A scheduler looks a little ahead and
// queues each step's notes on the audio clock. After the last section it loops back to the verse.

const MUSIC = { BPM: 106, VOLUME: 0.32, AHEAD: 0.3, TICK: 40 };

// Chords: the pad's voicing and the bass's root.
const CHORDS = {
  Am: { pad: [57, 60, 64], root: 33 },
  F: { pad: [57, 60, 65], root: 29 },
  C: { pad: [55, 60, 64], root: 36 },
  G: { pad: [55, 59, 62], root: 31 },
  Em: { pad: [55, 59, 64], root: 28 },
};
const VERSE_CHORDS = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'];
const CHORUS_CHORDS = ['F', 'G', 'Em', 'Am', 'F', 'G', 'Em', 'Am'];

// Melodies, a list per bar of [step, note, length in steps].
const VERSE_LEAD = [
  [[0, 69, 3], [3, 72, 3], [6, 76, 6], [12, 74, 4]],
  [[0, 72, 6], [6, 69, 2], [8, 72, 4], [12, 77, 4]],
  [[0, 76, 6], [6, 79, 2], [8, 76, 4], [12, 72, 4]],
  [[0, 74, 8], [8, 71, 4], [12, 67, 4]],
  [[0, 69, 3], [3, 72, 3], [6, 76, 6], [12, 74, 4]],
  [[0, 72, 6], [6, 69, 2], [8, 72, 4], [12, 77, 4]],
  [[0, 76, 6], [6, 79, 2], [8, 76, 4], [12, 72, 4]],
  [[0, 74, 4], [4, 76, 4], [8, 79, 8]],
];
const CHORUS_LEAD = [
  [[0, 76, 4], [4, 77, 2], [6, 81, 6], [12, 79, 4]],
  [[0, 79, 6], [6, 77, 2], [8, 76, 4], [12, 74, 4]],
  [[0, 76, 8], [8, 71, 4], [12, 76, 4]],
  [[0, 76, 4], [4, 74, 2], [6, 72, 2], [8, 69, 8]],
  [[0, 76, 4], [4, 77, 2], [6, 81, 6], [12, 79, 4]],
  [[0, 79, 6], [6, 77, 2], [8, 76, 4], [12, 79, 4]],
  [[0, 83, 8], [8, 79, 4], [12, 76, 4]],
  [[0, 69, 2], [2, 72, 2], [4, 76, 4], [8, 81, 8]],
];

// The sections in order. Parts: pad, arp, bass ('8' or '16': eighths or sixteenths), kick,
// beat (snare and hats), lead (a melody, up `oct` octaves), fill (toms in the last bar).
const SONG = [
  { name: 'intro', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true },
  { name: 'intro', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true, bass: '8', kick: true, fill: true },
  { name: 'verse', chords: VERSE_CHORDS, pad: true, bass: '8', kick: true, beat: true, lead: VERSE_LEAD, fill: true },
  { name: 'chorus', chords: CHORUS_CHORDS, pad: true, arp: true, bass: '16', kick: true, beat: true, lead: CHORUS_LEAD, fill: true },
  { name: 'break', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true, bass: '8' },
  { name: 'break', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true, bass: '8', kick: true, fill: true },
  { name: 'verse', chords: VERSE_CHORDS, pad: true, arp: true, bass: '8', kick: true, beat: true, lead: VERSE_LEAD, fill: true },
  { name: 'chorus', chords: CHORUS_CHORDS, pad: true, arp: true, bass: '16', kick: true, beat: true, lead: CHORUS_LEAD },
  { name: 'chorus', chords: CHORUS_CHORDS, pad: true, arp: true, bass: '16', kick: true, beat: true, lead: CHORUS_LEAD, oct: 1, fill: true },
];
const LOOP_TO = 2; // the first verse

// The bass: root eighths with octave jumps, or driving sixteenths.
const BASS_8 = [[0, 0], [2, 0], [4, 0], [6, 12], [8, 0], [10, 0], [12, 12], [14, 0]];
const BASS_16 = Array.from({ length: 16 }, (_, i) => [i, i % 8 === 6 ? 12 : 0]);
// The arpeggio, indices into the chord's notes and their octave above.
const ARP = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 3];

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

class DriveMusic {
  // ctx(): the AudioContext to play through (shared with the car's sounds), or null.
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.pos = { sec: 0, bar: 0, step: 0 };
    this.timer = null;
  }

  get step() { return 60 / MUSIC.BPM / 4; } // seconds per sixteenth

  // Called often (each frame while driving): starts or stops the music, which picks up where it left off.
  set(on) {
    if (on === this.on) return;
    if (on) {
      const ac = this.ctx();
      if (!ac) return;
      if (!this.out || this.out.ac !== ac) this.build(ac, ac.destination);
      this.on = true;
      const t = ac.currentTime;
      this.out.master.gain.cancelScheduledValues(t);
      this.out.master.gain.setValueAtTime(this.out.master.gain.value, t);
      this.out.master.gain.linearRampToValueAtTime(MUSIC.VOLUME, t + 0.6);
      this.next = t + 0.1;
      this.timer = setInterval(() => this.tick(), MUSIC.TICK);
      this.tick();
    } else {
      this.on = false;
      clearInterval(this.timer);
      this.timer = null;
      if (this.out) {
        const t = this.out.ac.currentTime, g = this.out.master.gain;
        g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + 0.4);
      }
    }
  }

  // The mixing desk: a compressor before the output; a reverb, a delay, and the "pump" bus the
  // pads and arpeggio go through, ducked by each kick.
  build(ac, dest) {
    const master = ac.createGain(); master.gain.value = 0;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(master); master.connect(dest);
    // Reverb: a generated impulse, two seconds of decaying noise.
    const rev = ac.createConvolver(), n = Math.floor(ac.sampleRate * 2.2), ir = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3; }
    rev.buffer = ir;
    const revIn = ac.createGain(); revIn.gain.value = 0.5;
    revIn.connect(rev); rev.connect(comp);
    // Delay: a dotted eighth, with its repeats darkening.
    const del = ac.createDelay(1), fb = ac.createGain(), dlp = ac.createBiquadFilter();
    del.delayTime.value = this.step * 3; fb.gain.value = 0.38; dlp.type = 'lowpass'; dlp.frequency.value = 2800;
    const delIn = ac.createGain(); delIn.gain.value = 1;
    delIn.connect(del); del.connect(dlp); dlp.connect(fb); fb.connect(del); dlp.connect(comp);
    const pump = ac.createGain(); pump.connect(comp);
    const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.out = { ac, master, comp, rev: revIn, del: delIn, pump, noise };
  }

  // Queues every step due within the look-ahead.
  tick() {
    const ac = this.out.ac;
    if (this.next < ac.currentTime - 0.1) this.next = ac.currentTime + 0.05; // fell behind (a hidden tab)
    while (this.next < ac.currentTime + MUSIC.AHEAD) {
      this.play(this.next);
      this.next += this.step;
      const p = this.pos;
      if (++p.step === 16) { p.step = 0; if (++p.bar === SONG[p.sec].chords.length) { p.bar = 0; p.sec = p.sec + 1 < SONG.length ? p.sec + 1 : LOOP_TO; } }
    }
  }

  // Everything that sounds at one step, starting at time t.
  play(t) {
    const { sec, bar, step } = this.pos, S = SONG[sec], ch = CHORDS[S.chords[bar]], st = this.step;
    const lastBar = bar === S.chords.length - 1;
    if (step === 0 && bar === 0 && S.beat) this.crash(t);
    if (S.pad && step === 0) for (const m of ch.pad) this.pad(t, m, st * 16);
    if (S.arp) {
      const notes = [...ch.pad.map((m) => m + 12), ch.pad[0] + 24, ch.pad[1] + 24];
      this.arp(t, notes[ARP[step]], step % 2 ? 0.25 : -0.25);
    }
    if (S.bass) for (const [s, o] of S.bass === '16' ? BASS_16 : BASS_8) if (s === step) this.bass(t, ch.root + o, st * (S.bass === '16' ? 0.9 : 1.6));
    const filling = S.fill && lastBar && step >= 12;
    if (filling) this.tom(t, [196, 165, 139, 110][step - 12]);
    if (S.kick && step % 4 === 0 && !(filling && step > 12)) this.kick(t);
    if (S.beat && !filling) {
      if (step === 4 || step === 12) this.snare(t);
      if (step % 2 === 0) this.hat(t, step === 14 && bar % 2 === 1 ? 0.22 : 0.035, step % 4 === 2 ? 0.11 : 0.06);
      else this.hat(t, 0.02, 0.03);
    }
    if (S.lead) for (const [s, m, len] of S.lead[bar]) if (s === step) this.lead(t, m + 12 * (S.oct || 0), len * st);
  }

  // Instruments -----------------------------------------------------------------------------

  env(g, t, peak, attack, hold, release) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return t + attack + hold + release;
  }

  osc(type, f, t, end, dest, detune = 0) {
    const o = this.out.ac.createOscillator();
    o.type = type; o.frequency.value = f; o.detune.value = detune;
    o.connect(dest); o.start(t); o.stop(end + 0.05);
    return o;
  }

  noiseSrc(t, end, dest) {
    const s = this.out.ac.createBufferSource();
    s.buffer = this.out.noise; s.connect(dest); s.start(t, Math.random() * 0.5); s.stop(end + 0.05);
  }

  kick(t) {
    const ac = this.out.ac, g = ac.createGain();
    g.connect(this.out.comp);
    const end = this.env(g, t, 0.9, 0.002, 0.04, 0.32);
    const o = this.osc('sine', 150, t, end, g);
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    // The pads and arpeggio duck under it and swell back.
    const p = this.out.pump.gain;
    p.cancelScheduledValues(t); p.setValueAtTime(0.3, t); p.linearRampToValueAtTime(1, t + this.step * 3.2);
  }

  // The 80s snare: a burst of noise held flat and cut off short (gated), with a tone under it.
  snare(t) {
    const ac = this.out.ac, g = ac.createGain(), bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.6;
    bp.connect(g); g.connect(this.out.comp); g.connect(this.out.rev);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.55, t + 0.003);
    g.gain.linearRampToValueAtTime(0.35, t + 0.15); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    this.noiseSrc(t, t + 0.2, bp);
    const tg = ac.createGain(); tg.connect(this.out.comp);
    const end = this.env(tg, t, 0.35, 0.002, 0.01, 0.12);
    const o = this.osc('triangle', 200, t, end, tg);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.1);
  }

  hat(t, decay, level) {
    const ac = this.out.ac, g = ac.createGain(), hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7500;
    hp.connect(g); g.connect(this.out.comp);
    this.noiseSrc(t, this.env(g, t, level, 0.001, 0, decay), hp);
  }

  crash(t) {
    const ac = this.out.ac, g = ac.createGain(), hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 4500;
    hp.connect(g); g.connect(this.out.comp); g.connect(this.out.rev);
    this.noiseSrc(t, this.env(g, t, 0.16, 0.002, 0, 1.6), hp);
  }

  tom(t, f) {
    const ac = this.out.ac, g = ac.createGain();
    g.connect(this.out.comp); g.connect(this.out.rev);
    const end = this.env(g, t, 0.6, 0.002, 0.02, 0.28);
    const o = this.osc('sine', f, t, end, g);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.25);
  }

  // Thick bass: two detuned saws and a sine, through a low-pass that snaps shut on each note.
  bass(t, m, dur) {
    const ac = this.out.ac, g = ac.createGain(), lp = ac.createBiquadFilter(), f = mtof(m);
    lp.type = 'lowpass'; lp.Q.value = 5;
    lp.frequency.setValueAtTime(1500, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.13);
    lp.connect(g); g.connect(this.out.comp);
    const end = this.env(g, t, 0.24, 0.004, dur * 0.7, dur * 0.3);
    this.osc('sawtooth', f, t, end, lp, -8); this.osc('sawtooth', f, t, end, lp, 8);
    const sg = ac.createGain(); sg.gain.value = 0.6; sg.connect(g);
    this.osc('sine', f, t, end, sg);
  }

  pad(t, m, dur) {
    const ac = this.out.ac, g = ac.createGain(), lp = ac.createBiquadFilter(), f = mtof(m);
    lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 0.8;
    lp.connect(g); g.connect(this.out.pump); g.connect(this.out.rev);
    const end = this.env(g, t, 0.055, 0.35, dur - 0.35, 0.6);
    this.osc('sawtooth', f, t, end, lp, -11); this.osc('sawtooth', f, t, end, lp, 11);
  }

  arp(t, m, pan) {
    const ac = this.out.ac, g = ac.createGain(), lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    let out = g;
    if (ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = pan; g.connect(p); out = p; }
    lp.connect(g); out.connect(this.out.pump); out.connect(this.out.del);
    this.osc('square', mtof(m), t, this.env(g, t, 0.07, 0.003, 0.02, 0.11), lp);
  }

  // The lead: a saw and a square, a little apart, with vibrato coming in on held notes.
  lead(t, m, dur) {
    const ac = this.out.ac, g = ac.createGain(), lp = ac.createBiquadFilter(), f = mtof(m);
    lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 1.5;
    lp.connect(g); g.connect(this.out.comp);
    const send = ac.createGain(); send.gain.value = 0.4; g.connect(send); send.connect(this.out.del); send.connect(this.out.rev);
    const end = this.env(g, t, 0.1, 0.012, Math.max(0, dur - 0.06), 0.18);
    const a = this.osc('sawtooth', f, t, end, lp, -6), b = this.osc('square', f, t, end, lp, 6);
    const lfo = ac.createOscillator(), depth = ac.createGain();
    lfo.frequency.value = 5.5; depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(dur > 0.4 ? 12 : 0, t + Math.min(dur, 0.5));
    lfo.connect(depth); depth.connect(a.detune); depth.connect(b.detune);
    lfo.start(t); lfo.stop(end + 0.05);
  }
}
