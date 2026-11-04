// Music for Drive mode, the car radio: a small library of original tracks, synthesised as they
// play with the Web Audio API (no audio files). Turning the music on picks one at random.
//
// Each track is data: sections of bars, each bar a chord, with the parts that play in it, and a
// play() that turns one sixteenth-note step of that into notes. Notes are MIDI numbers; times are
// steps, 16 to a bar. A scheduler looks a little ahead and queues each step on the audio clock,
// swung if the track asks (the off-beat sixteenths late). After the last section a track loops.

const MUSIC = { AHEAD: 0.3, TICK: 40 };
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

// "Neon Meridian" ---------------------------------------------------------------------------
// 80s synthwave in A minor at 106 bpm: four on the floor, a gated snare, a thick pumping saw
// bass, detuned pads ducking under the kick, a square-wave arpeggio through a dotted-eighth delay,
// and a saw lead. Intro, verse, chorus, break, verse and a double chorus, then from the verse.

const NEON = (() => {
  const CHORDS = {
    Am: { pad: [57, 60, 64], root: 33 },
    F: { pad: [57, 60, 65], root: 29 },
    C: { pad: [55, 60, 64], root: 36 },
    G: { pad: [55, 59, 62], root: 31 },
    Em: { pad: [55, 59, 64], root: 28 },
  };
  const VERSE = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'];
  const CHORUS = ['F', 'G', 'Em', 'Am', 'F', 'G', 'Em', 'Am'];
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
  // Parts: pad, arp, bass ('8' or '16': eighths or sixteenths), kick, beat (snare and hats),
  // lead (a melody, up `oct` octaves), fill (toms in the last bar).
  const SONG = [
    { name: 'intro', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true },
    { name: 'intro', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true, bass: '8', kick: true, fill: true },
    { name: 'verse', chords: VERSE, pad: true, bass: '8', kick: true, beat: true, lead: VERSE_LEAD, fill: true },
    { name: 'chorus', chords: CHORUS, pad: true, arp: true, bass: '16', kick: true, beat: true, lead: CHORUS_LEAD, fill: true },
    { name: 'break', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true, bass: '8' },
    { name: 'break', chords: ['Am', 'F', 'C', 'G'], pad: true, arp: true, bass: '8', kick: true, fill: true },
    { name: 'verse', chords: VERSE, pad: true, arp: true, bass: '8', kick: true, beat: true, lead: VERSE_LEAD, fill: true },
    { name: 'chorus', chords: CHORUS, pad: true, arp: true, bass: '16', kick: true, beat: true, lead: CHORUS_LEAD },
    { name: 'chorus', chords: CHORUS, pad: true, arp: true, bass: '16', kick: true, beat: true, lead: CHORUS_LEAD, oct: 1, fill: true },
  ];
  // The bass: root eighths with octave jumps, or driving sixteenths.
  const BASS_8 = [[0, 0], [2, 0], [4, 0], [6, 12], [8, 0], [10, 0], [12, 12], [14, 0]];
  const BASS_16 = Array.from({ length: 16 }, (_, i) => [i, i % 8 === 6 ? 12 : 0]);
  // The arpeggio, indices into the chord's notes and their octave above.
  const ARP = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 3];

  return {
    title: 'Neon Meridian', bpm: 106, swing: 0, volume: 0.32, song: SONG, loopTo: 2,
    play(m, t, S, bar, step) {
      const ch = CHORDS[S.chords[bar]], st = m.step, lastBar = bar === S.chords.length - 1;
      if (step === 0 && bar === 0 && S.beat) m.crash(t);
      if (S.pad && step === 0) for (const n of ch.pad) m.pad(t, n, st * 16);
      if (S.arp) {
        const notes = [...ch.pad.map((n) => n + 12), ch.pad[0] + 24, ch.pad[1] + 24];
        m.arp(t, notes[ARP[step]], step % 2 ? 0.25 : -0.25);
      }
      if (S.bass) for (const [s, o] of S.bass === '16' ? BASS_16 : BASS_8) if (s === step) m.bass(t, ch.root + o, st * (S.bass === '16' ? 0.9 : 1.6));
      const filling = S.fill && lastBar && step >= 12;
      if (filling) m.tom(t, [196, 165, 139, 110][step - 12]);
      if (S.kick && step % 4 === 0 && !(filling && step > 12)) m.kick(t);
      if (S.beat && !filling) {
        if (step === 4 || step === 12) m.snare(t);
        if (step % 2 === 0) m.hat(t, step === 14 && bar % 2 === 1 ? 0.22 : 0.035, step % 4 === 2 ? 0.11 : 0.06);
        else m.hat(t, 0.02, 0.03);
      }
      if (S.lead) for (const [s, n, len] of S.lead[bar]) if (s === step) m.lead(t, n + 12 * (S.oct || 0), len * st);
    },
  };
})();

// "Boulevard After Dark" -----------------------------------------------------------------------
// Laid-back West Coast hip hop in D minor at 92 bpm, swung: a boom-bap kick and a snare with a
// clap, Rhodes chords with a slow tremolo, a deep sine bass sliding between notes, brass stabs,
// a high whining portamento lead on the hook, and vinyl crackle all the way through. Intro, verse,
// hook, verse, a breakdown and a double hook, then from the verse.

const BOULEVARD = (() => {
  const CHORDS = {
    Dm7: { keys: [53, 57, 60, 64], root: 38 },
    Bbmaj7: { keys: [53, 57, 58, 62], root: 34 },
    Gm7: { keys: [55, 58, 62, 65], root: 31 },
    A7: { keys: [55, 61, 64, 69], root: 33 },
  };
  const VERSE = ['Dm7', 'Bbmaj7', 'Gm7', 'A7', 'Dm7', 'Bbmaj7', 'Gm7', 'A7'];
  const HOOK = ['Dm7', 'Gm7', 'Dm7', 'A7', 'Dm7', 'Gm7', 'Dm7', 'A7'];
  const HOOK_LEAD = [
    [[0, 81, 6], [6, 79, 2], [8, 77, 4], [12, 74, 4]],
    [[0, 77, 3], [3, 79, 3], [6, 82, 6], [12, 81, 4]],
    [[0, 81, 8], [8, 84, 2], [10, 81, 2], [12, 79, 4]],
    [[0, 76, 4], [4, 73, 4], [8, 76, 2], [10, 79, 6]],
    [[0, 81, 6], [6, 79, 2], [8, 77, 4], [12, 74, 4]],
    [[0, 77, 3], [3, 79, 3], [6, 82, 6], [12, 81, 4]],
    [[0, 81, 8], [8, 84, 2], [10, 86, 2], [12, 84, 4]],
    [[0, 76, 4], [4, 79, 2], [6, 81, 10]],
  ];
  // Parts: keys (Rhodes), bass, drums, stabs, lead, drop (the drums stop for the last beat).
  const SONG = [
    { name: 'intro', chords: ['Dm7', 'Bbmaj7', 'Gm7', 'A7'], keys: true, hats: true, drop: true },
    { name: 'verse', chords: VERSE, keys: true, bass: true, drums: true, stabs: true },
    { name: 'hook', chords: HOOK, keys: true, bass: true, drums: true, lead: HOOK_LEAD, drop: true },
    { name: 'verse', chords: VERSE, keys: true, bass: true, drums: true, stabs: true },
    { name: 'break', chords: ['Dm7', 'Bbmaj7', 'Gm7', 'A7'], keys: true, bass: true, drop: true },
    { name: 'hook', chords: HOOK, keys: true, bass: true, drums: true, lead: HOOK_LEAD, stabs: true },
    { name: 'hook', chords: HOOK, keys: true, bass: true, drums: true, lead: HOOK_LEAD, drop: true },
  ];
  // The bass, [step, semitones above the root, length]: long notes that slide into each other.
  const BASS = [[0, 0, 5], [6, 0, 2], [8, 7, 2], [10, 0, 3], [14, -2, 2]];
  const BASS_TURN = [[0, 0, 5], [6, 0, 2], [8, 7, 2], [10, 10, 2], [12, 12, 2], [14, 7, 2]];
  // Boom bap: the kick on 1, the "and" of 2 and on 3's "and"; the snare and clap on 2 and 4.
  const KICK = [0, 7, 10], KICK_TURN = [0, 7, 10, 15];

  return {
    title: 'Boulevard After Dark', bpm: 92, swing: 0.22, volume: 0.3, song: SONG, loopTo: 1,
    play(m, t, S, bar, step) {
      const ch = CHORDS[S.chords[bar]], st = m.step, lastBar = bar === S.chords.length - 1, turn = bar % 4 === 3;
      const dropped = S.drop && lastBar && step >= 12;
      m.crackle(t);
      // The Rhodes: the chord on 1, pushed a sixteenth ahead on the "and" of 2 in alternate bars.
      if (S.keys && (step === 0 || (step === 7 && bar % 2 === 1))) for (const n of ch.keys) m.rhodes(t, n, st * (step ? 9 : 7));
      if (S.bass && !dropped) for (const [s, o, len] of turn ? BASS_TURN : BASS) if (s === step) m.sub(t, ch.root + o, len * st);
      if (S.drums && !dropped) {
        if ((turn ? KICK_TURN : KICK).includes(step)) m.boom(t);
        if (step === 4 || step === 12) m.clapSnare(t);
      }
      if ((S.drums || S.hats) && !dropped && step % 2 === 0) m.hat(t, step === 6 && bar % 4 === 1 ? 0.18 : 0.03, step % 4 === 2 ? 0.09 : 0.06);
      if (S.drums && !dropped && step % 2 === 1 && (step === 11 || step === 15)) m.hat(t, 0.02, 0.03);
      if (S.stabs && (bar % 2 === 0) && (step === 0 || step === 3)) m.stab(t, ch.keys.map((n) => n + 12));
      if (S.lead) for (const [s, n, len] of S.lead[bar]) if (s === step) m.whine(t, n, len * st);
    },
  };
})();

const TRACKS = [NEON, BOULEVARD];

class DriveMusic {
  // ctx(): the AudioContext to play through (shared with the car's sounds), or null.
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.timer = null;
    this.pick();
  }

  get step() { return 60 / this.track.bpm / 4; } // seconds per sixteenth

  // A track at random, a different one from the last, from its start.
  pick() {
    const others = TRACKS.filter((tr) => tr !== this.track);
    this.track = others[Math.floor(Math.random() * others.length)] || TRACKS[0];
    this.pos = { sec: 0, bar: 0, step: 0 };
    if (this.out) this.out.delay.delayTime.setValueAtTime(this.step * 3, this.out.ac.currentTime);
    if (this.on) this.fadeTo(this.track.volume, 0.6);
    this.lastGlide = null;
  }

  fadeTo(v, s) {
    const t = this.out.ac.currentTime, g = this.out.master.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(v, t + s);
  }

  // Called often (each frame while driving): starts or stops the music, which picks up where it left off.
  set(on) {
    if (on === this.on) return;
    if (on) {
      const ac = this.ctx();
      if (!ac) return;
      if (!this.out || this.out.ac !== ac) this.build(ac, ac.destination);
      this.on = true;
      this.fadeTo(this.track.volume, 0.6);
      this.next = ac.currentTime + 0.1;
      this.timer = setInterval(() => this.tick(), MUSIC.TICK);
      this.tick();
    } else {
      this.on = false;
      clearInterval(this.timer);
      this.timer = null;
      if (this.out) this.fadeTo(0, 0.4);
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
    this.out = { ac, master, comp, rev: revIn, del: delIn, delay: del, pump, noise };
  }

  // Queues every step due within the look-ahead.
  tick() {
    const ac = this.out.ac;
    if (this.next < ac.currentTime - 0.1) this.next = ac.currentTime + 0.05; // fell behind (a hidden tab)
    while (this.next < ac.currentTime + MUSIC.AHEAD) {
      const T = this.track, p = this.pos;
      T.play(this, this.next + (p.step % 2 ? T.swing * this.step : 0), T.song[p.sec], p.bar, p.step);
      this.next += this.step;
      if (++p.step === 16) { p.step = 0; if (++p.bar === T.song[p.sec].chords.length) { p.bar = 0; p.sec = p.sec + 1 < T.song.length ? p.sec + 1 : T.loopTo; } }
    }
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

  // Boulevard After Dark's instruments -------------------------------------------------------

  // A boom-bap kick: lower and longer than the synthwave one, with a soft click on top.
  boom(t) {
    const ac = this.out.ac, g = ac.createGain();
    g.connect(this.out.comp);
    const end = this.env(g, t, 1, 0.002, 0.06, 0.42);
    const o = this.osc('sine', 120, t, end, g);
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    const cg = ac.createGain(), lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2500; lp.connect(cg); cg.connect(this.out.comp);
    this.noiseSrc(t, this.env(cg, t, 0.18, 0.001, 0, 0.015), lp);
  }

  // A dusty snare with a clap: a noise body and tone, and three quick bursts for the hands.
  clapSnare(t) {
    const ac = this.out.ac, g = ac.createGain(), bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.8;
    bp.connect(g); g.connect(this.out.comp); g.connect(this.out.rev);
    this.noiseSrc(t, this.env(g, t, 0.4, 0.002, 0.01, 0.16), bp);
    const tg = ac.createGain(); tg.connect(this.out.comp);
    this.osc('triangle', 185, t, this.env(tg, t, 0.3, 0.002, 0.01, 0.08), tg);
    for (const d of [0, 0.011, 0.022]) {
      const cg = ac.createGain(), hp = ac.createBiquadFilter();
      hp.type = 'bandpass'; hp.frequency.value = 1300; hp.Q.value = 1.2;
      hp.connect(cg); cg.connect(this.out.comp); cg.connect(this.out.rev);
      this.noiseSrc(t + d, this.env(cg, t + d, d === 0.022 ? 0.35 : 0.25, 0.001, 0, d === 0.022 ? 0.12 : 0.01), hp);
    }
  }

  // A Rhodes: a sine tine, its bell from a quick frequency-modulation burst, fading under a slow
  // stereo tremolo.
  rhodes(t, m, dur) {
    const ac = this.out.ac, f = mtof(m), g = ac.createGain();
    let out = g;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner(), lfo = ac.createOscillator(), d = ac.createGain();
      lfo.frequency.value = 3.2; d.gain.value = 0.35; lfo.connect(d); d.connect(p.pan);
      lfo.start(t); lfo.stop(t + dur + 0.6);
      g.connect(p); out = p;
    }
    out.connect(this.out.comp); out.connect(this.out.rev);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.055, t + 0.9);
    g.gain.setValueAtTime(0.055, t + Math.max(0.9, dur));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.9, dur) + 0.35);
    const end = t + Math.max(0.9, dur) + 0.35;
    const c = this.osc('sine', f, t, end, g);
    const mod = ac.createOscillator(), mg = ac.createGain();
    mod.frequency.value = f; mg.gain.setValueAtTime(f * 1.4, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.5);
    mod.connect(mg); mg.connect(c.frequency); mod.start(t); mod.stop(end + 0.05);
  }

  // A deep sine bass, sliding up or down from the note before.
  sub(t, m, dur) {
    const ac = this.out.ac, g = ac.createGain(), lp = ac.createBiquadFilter(), f = mtof(m);
    lp.type = 'lowpass'; lp.frequency.value = 700;
    lp.connect(g); g.connect(this.out.comp);
    const end = this.env(g, t, 0.34, 0.008, Math.max(0, dur - 0.06), 0.09);
    const from = this.lastGlide || f;
    for (const [type, k] of [['sine', 1], ['triangle', 0.35]]) {
      const kg = ac.createGain(); kg.gain.value = k; kg.connect(lp);
      const o = this.osc(type, from, t, end, kg);
      o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
    }
    this.lastGlide = f;
  }

  // A brass stab: the chord on saws, the filter closing fast.
  stab(t, notes) {
    const ac = this.out.ac, g = ac.createGain(), lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(3200, t); lp.frequency.exponentialRampToValueAtTime(700, t + 0.18);
    lp.connect(g); g.connect(this.out.comp); g.connect(this.out.rev);
    const end = this.env(g, t, 0.05, 0.01, 0.06, 0.2);
    for (const n of notes) { this.osc('sawtooth', mtof(n), t, end, lp, -7); this.osc('sawtooth', mtof(n), t, end, lp, 7); }
  }

  // The West Coast whine: a near-sine lead gliding from note to note, with a wide vibrato.
  whine(t, m, dur) {
    const ac = this.out.ac, g = ac.createGain(), lp = ac.createBiquadFilter(), f = mtof(m);
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    lp.connect(g); g.connect(this.out.comp);
    const send = ac.createGain(); send.gain.value = 0.35; g.connect(send); send.connect(this.out.del); send.connect(this.out.rev);
    const end = this.env(g, t, 0.11, 0.02, Math.max(0, dur - 0.05), 0.15);
    const from = this.lastWhine && this.lastWhine.until > t - 0.4 ? this.lastWhine.f : f;
    const lfo = ac.createOscillator(), depth = ac.createGain();
    lfo.frequency.value = 6; depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(dur > 0.3 ? 22 : 6, t + Math.min(dur, 0.35));
    lfo.connect(depth); lfo.start(t); lfo.stop(end + 0.05);
    for (const [type, k] of [['sine', 1], ['sawtooth', 0.12]]) {
      const kg = ac.createGain(); kg.gain.value = k; kg.connect(lp);
      const o = this.osc(type, from, t, end, kg);
      o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
      depth.connect(o.detune);
    }
    this.lastWhine = { f, until: t + dur };
  }

  // Vinyl: a few faint clicks and pops each step.
  crackle(t) {
    const ac = this.out.ac, st = this.step;
    for (let i = 0, n = Math.floor(Math.random() * 3); i < n; i++) {
      const at = t + Math.random() * st, g = ac.createGain(), hp = ac.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1500 + Math.random() * 3000;
      hp.connect(g); g.connect(this.out.comp);
      this.noiseSrc(at, this.env(g, at, 0.01 + Math.random() * 0.03, 0.0005, 0, 0.004), hp);
    }
  }
}
