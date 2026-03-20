/**
 * Beyond RTS Conquest — Procedural Music Generator
 * Generates layered WAV tracks (calm, battle, intense, victory)
 * All combat tracks share tempo/key for seamless crossfading.
 *
 * Run:  node tools/generate-music.js
 * Output: public/music/*.wav
 */

const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────
const SR = 44100;
const BPM = 85;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const BARS = 16;
const DUR = BAR * BARS;          // ~45s loop
const N = Math.ceil(DUR * SR);
const TAU = Math.PI * 2;

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ── Chord progression (A minor) ─────────────────────────────────────────────
// Am  Am  F   F   Dm  Dm  Em  Em  Am  Am  C   C   F   G   Am  Em
const CHORDS = [
  [57, 60, 64], [57, 60, 64], [53, 57, 60], [53, 57, 60],
  [50, 53, 57], [50, 53, 57], [52, 55, 59], [52, 55, 59],
  [57, 60, 64], [57, 60, 64], [60, 64, 67], [60, 64, 67],
  [53, 57, 60], [55, 59, 62], [57, 60, 64], [52, 55, 59],
];
const ROOTS = [45, 45, 41, 41, 38, 38, 40, 40, 45, 45, 48, 48, 41, 43, 45, 40];

// Arp patterns (indices into chord notes, 8 per bar = 8th notes)
const ARP_PAT = [0, 1, 2, 1, 0, 2, 1, 2];

// ── Oscillators ──────────────────────────────────────────────────────────────
const osc = {
  sine: (p) => Math.sin(p * TAU),
  saw: (p) => 2 * (p - Math.floor(p)) - 1,
  square: (p) => (p - Math.floor(p)) < 0.5 ? 1 : -1,
  tri: (p) => { const t = p - Math.floor(p); return t < 0.5 ? 4 * t - 1 : 3 - 4 * t; },
};

// ── ADSR Envelope ────────────────────────────────────────────────────────────
function env(t, a, d, s, r, dur) {
  if (t < 0) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * (t - a) / d;
  if (t < dur - r) return s;
  if (t < dur) return s * (1 - (t - (dur - r)) / r);
  return 0;
}

// ── Simple one-pole low-pass filter ──────────────────────────────────────────
class LP {
  constructor(freq) { this.a = 1 - Math.exp(-TAU * freq / SR); this.y = 0; }
  tick(x) { this.y += this.a * (x - this.y); return this.y; }
  setCutoff(f) { this.a = 1 - Math.exp(-TAU * f / SR); }
}

// ── Delay line ───────────────────────────────────────────────────────────────
class Delay {
  constructor(timeSec, fb) {
    this.buf = new Float32Array(Math.ceil(timeSec * SR));
    this.i = 0; this.fb = fb;
  }
  tick(x) {
    const d = this.buf[this.i];
    this.buf[this.i] = x + d * this.fb;
    this.i = (this.i + 1) % this.buf.length;
    return d;
  }
}

// ── Schroeder reverb (6 comb + 2 allpass) ────────────────────────────────────
class Reverb {
  constructor(roomSize = 0.8) {
    const ds = [1557, 1617, 1491, 1422, 1277, 1356];
    this.combs = ds.map(d => {
      const len = Math.round(d * SR / 44100);
      return { buf: new Float32Array(len), i: 0, fb: roomSize };
    });
    this.ap = [225, 556].map(d => {
      const len = Math.round(d * SR / 44100);
      return { buf: new Float32Array(len), i: 0 };
    });
  }
  tick(x) {
    let sum = 0;
    for (const c of this.combs) {
      const d = c.buf[c.i];
      c.buf[c.i] = x + d * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      sum += d;
    }
    sum /= this.combs.length;
    let v = sum;
    for (const a of this.ap) {
      const d = a.buf[a.i];
      const y = -v + d;
      a.buf[a.i] = v + d * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      v = y;
    }
    return v;
  }
}

// ── Note scheduler ───────────────────────────────────────────────────────────
// Returns a list of { start, dur, freq, vel } for each synth layer
function scheduleNotes() {
  const pads = [], arps = [], bass = [], melody = [];

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * BAR;
    const chord = CHORDS[bar];
    const root = ROOTS[bar];

    // Pad — whole notes per chord tone
    for (const m of chord) {
      pads.push({ start: t0, dur: BAR, freq: midi(m), vel: 0.12 });
      pads.push({ start: t0, dur: BAR, freq: midi(m) * 1.003, vel: 0.06 }); // detune
    }

    // Bass — root note pattern (quarter + eighths)
    const bf = midi(root);
    bass.push({ start: t0, dur: BEAT * 0.8, freq: bf, vel: 0.25 });
    bass.push({ start: t0 + BEAT * 1.5, dur: BEAT * 0.4, freq: bf, vel: 0.15 });
    bass.push({ start: t0 + BEAT * 2, dur: BEAT * 0.8, freq: bf * 2, vel: 0.18 });
    bass.push({ start: t0 + BEAT * 3, dur: BEAT * 0.4, freq: bf, vel: 0.15 });
    bass.push({ start: t0 + BEAT * 3.5, dur: BEAT * 0.4, freq: midi(root + 7), vel: 0.12 }); // fifth

    // Arp — 8th notes cycling chord tones + octave
    const arpNotes = [...chord, chord[0] + 12];
    for (let i = 0; i < 8; i++) {
      const idx = ARP_PAT[i] % arpNotes.length;
      const octUp = i >= 4 ? 12 : 0;
      arps.push({
        start: t0 + i * BEAT * 0.5,
        dur: BEAT * 0.35,
        freq: midi(arpNotes[idx] + octUp),
        vel: 0.08 + (i % 2 === 0 ? 0.03 : 0),
      });
    }

    // Melody — simple call-and-response every 4 bars
    if (bar % 4 === 0) {
      const scale = [0, 2, 3, 5, 7, 8, 10, 12]; // A minor
      const baseNote = 69; // A4
      const phrases = [
        [0, 2, 3, 5, 3, 2],
        [7, 5, 3, 2, 0, -1],
        [0, 3, 5, 7, 8, 7],
        [5, 3, 2, 0, 2, 0],
      ];
      const phrase = phrases[(bar / 4) % phrases.length];
      phrase.forEach((deg, i) => {
        const semi = deg >= 0 ? scale[deg % scale.length] + Math.floor(deg / scale.length) * 12 : -scale[-deg % scale.length];
        melody.push({
          start: t0 + BEAT * 2 + i * BEAT * 0.6,
          dur: BEAT * 0.5,
          freq: midi(baseNote + semi),
          vel: 0.06,
        });
      });
    }
  }

  return { pads, arps, bass, melody };
}

// ── Drum patterns ────────────────────────────────────────────────────────────
function scheduleDrums() {
  const kicks = [], snares = [], hats = [], percs = [];

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * BAR;
    // Kick: 1 and 3 (with ghost on the "and of 4" every other bar)
    kicks.push({ start: t0, vel: 1.0 });
    kicks.push({ start: t0 + BEAT * 2, vel: 0.85 });
    if (bar % 2 === 1) kicks.push({ start: t0 + BEAT * 3.5, vel: 0.5 });

    // Snare: 2 and 4
    snares.push({ start: t0 + BEAT, vel: 0.8 });
    snares.push({ start: t0 + BEAT * 3, vel: 0.85 });

    // Hi-hat: 8th notes with velocity variation
    for (let i = 0; i < 8; i++) {
      const open = i === 2 || i === 6;
      hats.push({ start: t0 + i * BEAT * 0.5, vel: i % 2 === 0 ? 0.5 : 0.3, open });
    }

    // Extra perc every 4 bars
    if (bar % 4 === 3) {
      percs.push({ start: t0 + BEAT * 3.75, vel: 0.4 });
    }
  }

  return { kicks, snares, hats, percs };
}

// ── Synthesis functions ──────────────────────────────────────────────────────

function synthPad(buf, notes, brightness = 400) {
  for (const n of notes) {
    const lp = new LP(brightness);
    const s0 = Math.floor(n.start * SR);
    const s1 = Math.min(s0 + Math.ceil(n.dur * SR), N);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const e = env(t, 0.8, 0.5, 0.7, 0.8, n.dur);
      const v = osc.saw(phase) * 0.5 + osc.sine(phase) * 0.5;
      buf[i] += lp.tick(v) * e * n.vel;
      phase += n.freq / SR;
    }
  }
}

function synthBass(buf, notes, drive = 0) {
  for (const n of notes) {
    const lp = new LP(250);
    const s0 = Math.floor(n.start * SR);
    const s1 = Math.min(s0 + Math.ceil(n.dur * SR), N);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const e = env(t, 0.01, 0.1, 0.6, 0.05, n.dur);
      let v = osc.saw(phase) * 0.6 + osc.square(phase * 0.5) * 0.4;
      if (drive > 0) v = Math.tanh(v * (1 + drive * 3)) / (1 + drive);
      // Filter sweep on attack
      lp.setCutoff(250 + 400 * env(t, 0.02, 0.15, 0.3, 0.05, n.dur));
      buf[i] += lp.tick(v) * e * n.vel;
      phase += n.freq / SR;
    }
  }
}

function synthArp(buf, notes, brightness = 1500, waveform = 'tri') {
  for (const n of notes) {
    const lp = new LP(brightness);
    const s0 = Math.floor(n.start * SR);
    const s1 = Math.min(s0 + Math.ceil(n.dur * SR), N);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const e = env(t, 0.005, 0.08, 0.3, 0.1, n.dur);
      buf[i] += lp.tick(osc[waveform](phase)) * e * n.vel;
      phase += n.freq / SR;
    }
  }
}

function synthMelody(buf, notes) {
  for (const n of notes) {
    const lp = new LP(2000);
    const s0 = Math.floor(n.start * SR);
    const s1 = Math.min(s0 + Math.ceil(n.dur * SR), N);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const e = env(t, 0.01, 0.1, 0.5, 0.15, n.dur);
      const v = osc.tri(phase) * 0.6 + osc.sine(phase * 2.01) * 0.3;
      buf[i] += lp.tick(v) * e * n.vel;
      phase += n.freq / SR;
    }
  }
}

function synthKick(buf, events) {
  for (const ev of events) {
    const s0 = Math.floor(ev.start * SR);
    const dur = 0.35;
    const s1 = Math.min(s0 + Math.ceil(dur * SR), N);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const freq = 150 * Math.exp(-t * 30) + 40;
      const e = Math.exp(-t * 8);
      buf[i] += osc.sine(phase) * e * ev.vel * 0.35;
      phase += freq / SR;
    }
  }
}

function synthSnare(buf, events) {
  for (const ev of events) {
    const s0 = Math.floor(ev.start * SR);
    const dur = 0.2;
    const s1 = Math.min(s0 + Math.ceil(dur * SR), N);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const e = Math.exp(-t * 15);
      const body = osc.sine(phase) * Math.exp(-t * 30);
      const nz = (Math.random() * 2 - 1) * e;
      buf[i] += (body * 0.3 + nz * 0.25) * ev.vel;
      phase += 200 / SR;
    }
  }
}

function synthHat(buf, events) {
  for (const ev of events) {
    const s0 = Math.floor(ev.start * SR);
    const dur = ev.open ? 0.12 : 0.04;
    const s1 = Math.min(s0 + Math.ceil(dur * SR), N);
    const hp = new LP(12000);
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const e = Math.exp(-t * (ev.open ? 20 : 60));
      const nz = (Math.random() * 2 - 1);
      buf[i] += hp.tick(nz) * e * ev.vel * 0.2;
    }
  }
}

function synthPerc(buf, events) {
  for (const ev of events) {
    const s0 = Math.floor(ev.start * SR);
    const dur = 0.1;
    const s1 = Math.min(s0 + Math.ceil(dur * SR), N);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      buf[i] += osc.sine(phase) * Math.exp(-t * 25) * ev.vel * 0.2;
      phase += (800 * Math.exp(-t * 20) + 200) / SR;
    }
  }
}

// ── Apply effects to buffer ──────────────────────────────────────────────────

function applyReverb(buf, mix = 0.3, roomSize = 0.82) {
  const rev = new Reverb(roomSize);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const wet = rev.tick(buf[i]);
    out[i] = buf[i] * (1 - mix) + wet * mix;
  }
  return out;
}

function applyDelay(buf, timeSec = 0.375, fb = 0.35, mix = 0.25) {
  const del = new Delay(timeSec, fb);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const wet = del.tick(buf[i]);
    out[i] = buf[i] + wet * mix;
  }
  return out;
}

function normalize(buf, peak = 0.9) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  if (max > 0) {
    const scale = peak / max;
    for (let i = 0; i < buf.length; i++) buf[i] *= scale;
  }
  return buf;
}

// ── WAV writer ───────────────────────────────────────────────────────────────

function writeWav(filePath, buf) {
  const samples = buf.length;
  const headerSize = 44;
  const dataSize = samples * 2;
  const fileSize = headerSize + dataSize;
  const out = Buffer.alloc(fileSize);

  // RIFF header
  out.write('RIFF', 0);
  out.writeUInt32LE(fileSize - 8, 4);
  out.write('WAVE', 8);
  // fmt chunk
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);        // chunk size
  out.writeUInt16LE(1, 20);         // PCM
  out.writeUInt16LE(1, 22);         // mono
  out.writeUInt32LE(SR, 24);        // sample rate
  out.writeUInt32LE(SR * 2, 28);    // byte rate
  out.writeUInt16LE(2, 32);         // block align
  out.writeUInt16LE(16, 34);        // bits per sample
  // data chunk
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]));
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filePath, out);
  const mb = (fileSize / 1048576).toFixed(1);
  console.log(`  ✓ ${path.basename(filePath)} (${mb} MB, ${(DUR).toFixed(1)}s)`);
}

// ── Generate tracks ──────────────────────────────────────────────────────────

function generateCalm() {
  console.log('  Generating calm layer...');
  const { pads, arps, melody } = scheduleNotes();
  const buf = new Float32Array(N);

  // Warm pads with heavy reverb
  const padBuf = new Float32Array(N);
  synthPad(padBuf, pads, 350);
  const padWet = applyReverb(padBuf, 0.5, 0.88);
  for (let i = 0; i < N; i++) buf[i] += padWet[i] * 0.45;

  // Gentle arp with delay
  const arpBuf = new Float32Array(N);
  synthArp(arpBuf, arps, 800, 'tri');
  const arpWet = applyDelay(applyReverb(arpBuf, 0.35), BEAT * 0.75, 0.3, 0.3);
  for (let i = 0; i < N; i++) buf[i] += arpWet[i] * 0.2;

  // Subtle melody
  const melBuf = new Float32Array(N);
  synthMelody(melBuf, melody);
  const melWet = applyReverb(melBuf, 0.4);
  for (let i = 0; i < N; i++) buf[i] += melWet[i] * 0.25;

  return normalize(buf, 0.45);
}

function generateBattle() {
  console.log('  Generating battle layer...');
  const { pads, arps, bass, melody } = scheduleNotes();
  const drums = scheduleDrums();
  const buf = new Float32Array(N);

  // Brighter pad
  const padBuf = new Float32Array(N);
  synthPad(padBuf, pads, 600);
  const padWet = applyReverb(padBuf, 0.3, 0.8);
  for (let i = 0; i < N; i++) buf[i] += padWet[i] * 0.6;

  // Punchy bass
  const bassBuf = new Float32Array(N);
  synthBass(bassBuf, bass, 0.3);
  for (let i = 0; i < N; i++) buf[i] += bassBuf[i] * 1.0;

  // Bright arp with delay
  const arpBuf = new Float32Array(N);
  synthArp(arpBuf, arps, 2000, 'saw');
  const arpWet = applyDelay(applyReverb(arpBuf, 0.25), BEAT * 0.5, 0.25, 0.2);
  for (let i = 0; i < N; i++) buf[i] += arpWet[i] * 0.7;

  // Melody
  const melBuf = new Float32Array(N);
  synthMelody(melBuf, melody);
  const melWet = applyReverb(melBuf, 0.25);
  for (let i = 0; i < N; i++) buf[i] += melWet[i] * 0.7;

  // Drums
  const drumBuf = new Float32Array(N);
  synthKick(drumBuf, drums.kicks);
  synthSnare(drumBuf, drums.snares);
  synthHat(drumBuf, drums.hats);
  synthPerc(drumBuf, drums.percs);
  for (let i = 0; i < N; i++) buf[i] += drumBuf[i] * 1.0;

  return normalize(buf, 0.88);
}

function generateIntense() {
  console.log('  Generating intense layer...');
  const { pads, arps, bass } = scheduleNotes();
  const drums = scheduleDrums();
  const buf = new Float32Array(N);

  // Dark harsh pad — brighter, more saw
  const padBuf = new Float32Array(N);
  synthPad(padBuf, pads, 1200);
  const padWet = applyReverb(padBuf, 0.15, 0.7);
  for (let i = 0; i < N; i++) buf[i] += padWet[i] * 0.55;

  // Sub-bass rumble — constant low sine following root
  const subBuf = new Float32Array(N);
  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * BAR;
    const freq = midi(ROOTS[bar] - 12); // one octave below root
    const s0 = Math.floor(t0 * SR);
    const s1 = Math.min(s0 + Math.ceil(BAR * SR), N);
    let ph = 0;
    for (let i = s0; i < s1; i++) {
      subBuf[i] += osc.sine(ph) * 0.18;
      ph += freq / SR;
    }
  }
  for (let i = 0; i < N; i++) buf[i] += subBuf[i];

  // Heavily distorted bass — cranked drive
  const bassBuf = new Float32Array(N);
  synthBass(bassBuf, bass, 1.5);
  for (let i = 0; i < N; i++) buf[i] += bassBuf[i] * 1.4;

  // Rhythmic lead stabs — locked to 8th note grid, chord tones
  const leadBuf = new Float32Array(N);
  // Pattern: hit on beat 1, &of2, beat 3, &of3 — rhythmic and synced
  const leadPattern = [0, 1.5, 2, 2.5]; // beats within bar
  for (let bar = 0; bar < BARS; bar++) {
    const chord = CHORDS[bar];
    const t0 = bar * BAR;
    leadPattern.forEach((beatOff, pi) => {
      const midiNote = chord[pi % chord.length] + 12; // one octave up from chord
      const f = midi(midiNote);
      const dur = BEAT * 0.3;
      const lp1 = new LP(3500);
      const s0 = Math.floor((t0 + beatOff * BEAT) * SR);
      const s1 = Math.min(s0 + Math.ceil(dur * SR), N);
      let ph1 = 0, ph2 = 0;
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / SR;
        const e = env(t, 0.005, 0.04, 0.6, 0.05, dur);
        const v = osc.saw(ph1) * 0.4 + osc.square(ph2) * 0.35 + osc.saw(ph1 * 1.008) * 0.25;
        leadBuf[i] += lp1.tick(v) * e * 0.10;
        ph1 += f / SR;
        ph2 += (f * 1.002) / SR;
      }
    });
  }
  const leadWet = applyDelay(leadBuf, BEAT * 0.5, 0.25, 0.18);
  for (let i = 0; i < N; i++) buf[i] += leadWet[i];

  // Aggressive arp — sawtooth, very bright, with fast delay
  const arpBuf = new Float32Array(N);
  synthArp(arpBuf, arps, 5000, 'saw');
  const arpWet = applyDelay(arpBuf, BEAT * 0.25, 0.3, 0.25);
  for (let i = 0; i < N; i++) buf[i] += arpWet[i] * 1.0;

  // Pounding drums — kick on every beat + ghost notes
  const drumBuf = new Float32Array(N);
  const heavyKicks = [];
  for (let bar = 0; bar < BARS; bar++) {
    for (let b = 0; b < 4; b++) {
      heavyKicks.push({ start: bar * BAR + b * BEAT, vel: b % 2 === 0 ? 1.0 : 0.7 });
    }
    // Ghost kick on "and" of 4 for drive
    heavyKicks.push({ start: bar * BAR + BEAT * 3.5, vel: 0.5 });
  }
  synthKick(drumBuf, heavyKicks);

  // Snare on 2 and 4 + fills every 4th bar
  const heavySnares = [...drums.snares];
  for (let bar = 0; bar < BARS; bar++) {
    if (bar % 4 === 3) {
      // Snare fill on last bar of phrase
      heavySnares.push({ start: bar * BAR + BEAT * 3.25, vel: 0.6 });
      heavySnares.push({ start: bar * BAR + BEAT * 3.5, vel: 0.7 });
      heavySnares.push({ start: bar * BAR + BEAT * 3.75, vel: 0.9 });
    }
  }
  synthSnare(drumBuf, heavySnares);

  // 16th note hats with accents
  const fastHats = [];
  for (let bar = 0; bar < BARS; bar++) {
    for (let i = 0; i < 16; i++) {
      const accent = i % 4 === 0 ? 0.55 : i % 2 === 0 ? 0.35 : 0.2;
      fastHats.push({ start: bar * BAR + i * BEAT * 0.25, vel: accent, open: i % 8 === 4 });
    }
  }
  synthHat(drumBuf, fastHats);

  // Crash on every 4th bar downbeat
  for (let bar = 0; bar < BARS; bar += 4) {
    const s0 = Math.floor(bar * BAR * SR);
    const dur = 0.6;
    const s1 = Math.min(s0 + Math.ceil(dur * SR), N);
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      drumBuf[i] += (Math.random() * 2 - 1) * Math.exp(-t * 5) * 0.15;
    }
  }

  // Toms for extra aggression (every 8th bar)
  for (let bar = 0; bar < BARS; bar += 8) {
    const fills = [0, 0.25, 0.5, 0.75].map(b => bar * BAR + BEAT * 3 + b * BEAT);
    const freqs = [120, 100, 80, 65];
    fills.forEach((t0, fi) => {
      const s0 = Math.floor(t0 * SR);
      const s1 = Math.min(s0 + Math.ceil(0.2 * SR), N);
      let ph = 0;
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / SR;
        drumBuf[i] += osc.sine(ph) * Math.exp(-t * 12) * 0.25;
        ph += freqs[fi] / SR;
      }
    });
  }

  synthPerc(drumBuf, drums.percs);
  for (let i = 0; i < N; i++) buf[i] += drumBuf[i] * 1.3;

  return normalize(buf, 0.92);
}

function generateVictory() {
  console.log('  Generating victory sting...');
  const vDur = 6; // 6 seconds
  const vN = Math.ceil(vDur * SR);
  const buf = new Float32Array(vN);

  // Triumphant major chord progression: A → D → E → A (major)
  const vChords = [
    { t: 0, notes: [57, 61, 64], dur: 1.5 },       // A major
    { t: 1.5, notes: [62, 66, 69], dur: 1.2 },     // D major
    { t: 2.7, notes: [64, 68, 71], dur: 1.3 },     // E major
    { t: 4.0, notes: [57, 61, 64, 69], dur: 2.0 }, // A major (full)
  ];

  for (const ch of vChords) {
    for (const m of ch.notes) {
      const f = midi(m);
      const s0 = Math.floor(ch.t * SR);
      const s1 = Math.min(s0 + Math.ceil(ch.dur * SR), vN);
      let phase = 0;
      const lp = new LP(1200);
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / SR;
        const e = env(t, 0.05, 0.2, 0.6, 0.5, ch.dur);
        const v = osc.tri(phase) * 0.5 + osc.sine(phase) * 0.5;
        buf[i] += lp.tick(v) * e * 0.12;
        phase += f / SR;
      }
    }
  }

  // Rising arp
  const arpNotes = [57, 61, 64, 69, 73, 76, 81];
  arpNotes.forEach((m, idx) => {
    const f = midi(m);
    const t0 = idx * 0.15;
    const s0 = Math.floor(t0 * SR);
    const dur = 1.5;
    const s1 = Math.min(s0 + Math.ceil(dur * SR), vN);
    let phase = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      const e = env(t, 0.01, 0.1, 0.3, 0.5, dur);
      buf[i] += osc.tri(phase) * e * 0.06;
      phase += f / SR;
    }
  });

  // Apply reverb
  const rev = new Reverb(0.9);
  const out = new Float32Array(vN);
  for (let i = 0; i < vN; i++) out[i] = buf[i] * 0.6 + rev.tick(buf[i]) * 0.4;

  normalize(out, 0.85);

  // Write with correct length
  const headerSize = 44;
  const dataSize = vN * 2;
  const fileSize = headerSize + dataSize;
  const wavBuf = Buffer.alloc(fileSize);
  wavBuf.write('RIFF', 0);
  wavBuf.writeUInt32LE(fileSize - 8, 4);
  wavBuf.write('WAVE', 8);
  wavBuf.write('fmt ', 12);
  wavBuf.writeUInt32LE(16, 16);
  wavBuf.writeUInt16LE(1, 20);
  wavBuf.writeUInt16LE(1, 22);
  wavBuf.writeUInt32LE(SR, 24);
  wavBuf.writeUInt32LE(SR * 2, 28);
  wavBuf.writeUInt16LE(2, 32);
  wavBuf.writeUInt16LE(16, 34);
  wavBuf.write('data', 36);
  wavBuf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < vN; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    wavBuf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  const filePath = path.join(__dirname, '..', 'public', 'music', 'victory.wav');
  fs.writeFileSync(filePath, wavBuf);
  console.log(`  ✓ victory.wav (${(fileSize / 1048576).toFixed(1)} MB, ${vDur}s)`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('🎵 Beyond RTS Conquest — Music Generator');
console.log(`   ${BARS} bars, ${BPM} BPM, ${DUR.toFixed(1)}s loops, A minor\n`);

const outDir = path.join(__dirname, '..', 'public', 'music');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const calm = generateCalm();
writeWav(path.join(outDir, 'calm.wav'), calm);

const battle = generateBattle();
writeWav(path.join(outDir, 'battle.wav'), battle);

const intense = generateIntense();
writeWav(path.join(outDir, 'intense.wav'), intense);

generateVictory();

console.log('\n✅ All tracks generated in public/music/');
console.log('   Tip: Convert to .ogg or .mp3 for smaller web deployment.');
