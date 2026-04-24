'use strict';
const fs = require('fs');
const path = require('path');

const SR = 44100;
const TAU = Math.PI * 2;
const DUR = 45.18;
const OUT = path.join(__dirname, 'public', 'music');

// ── WAV output (mono 16-bit) ──────────────────────────────────────────────────
function mkBuf(sec = DUR) { return new Float32Array(Math.ceil(SR * sec)); }

function writeWav(name, buf) {
  const bps = 16, dSize = buf.length * 2;
  const out = Buffer.alloc(44 + dSize);
  out.write('RIFF', 0); out.writeUInt32LE(36 + dSize, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28); out.writeUInt16LE(2, 32);
  out.writeUInt16LE(bps, 34); out.write('data', 36); out.writeUInt32LE(dSize, 40);
  for (let i = 0; i < buf.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(path.join(OUT, name), out);
  console.log(`  ${name}: ${(out.length/1024).toFixed(0)} KB, ${(buf.length/SR).toFixed(1)}s`);
}

// ── Shared primitives ─────────────────────────────────────────────────────────
function norm(buf, peak = 0.82) {
  let mx = 0;
  for (let i = 0; i < buf.length; i++) mx = Math.max(mx, Math.abs(buf[i]));
  if (mx > 0) for (let i = 0; i < buf.length; i++) buf[i] = buf[i] / mx * peak;
}
function fade(buf, fi = 1.5, fo = 2.0) {
  const fiN = Math.round(fi * SR), foN = Math.round(fo * SR);
  for (let i = 0; i < fiN && i < buf.length; i++) buf[i] *= i / fiN;
  for (let i = 0; i < foN && buf.length - 1 - i >= 0; i++) buf[buf.length-1-i] *= i / foN;
}
// Simple comb reverb
function reverb(buf, taps) {
  const src = buf.slice();
  for (const [ms, fb] of taps) {
    const d = Math.round(ms / 1000 * SR);
    for (let i = d; i < buf.length; i++) buf[i] += src[i - d] * fb;
  }
}

// Envelope helper
function envVal(n, durN, atkN, relN, sustain = 1.0) {
  if (n < atkN) return n / Math.max(1, atkN);
  if (n < durN) return sustain;
  return Math.max(0, sustain * (1 - (n - durN) / Math.max(1, relN)));
}

// Generic additive tone writer
function addTone(buf, hz, amp, startSec, durSec, opts = {}) {
  const {atk=0.06, rel=0.5, osc='sine', detune=0, sustain=1.0, harmonics=null} = opts;
  const s0 = Math.round(startSec * SR);
  const durN = Math.round(durSec * SR);
  const atkN = Math.round(atk * SR);
  const relN = Math.round(rel * SR);
  const h = harmonics || [[1,1.0]];
  for (let n = 0; n < durN + relN; n++) {
    const idx = s0 + n;
    if (idx < 0 || idx >= buf.length) continue;
    const t = n / SR;
    let s = 0;
    for (const [mult, w] of h) {
      const f = hz * mult * (1 + detune * (mult - 1) * 0.001);
      if (osc === 'sine') s += Math.sin(TAU * f * t) * w;
      else if (osc === 'tri') s += (2*Math.abs(2*(f*t%1)-1)-1) * w;
      else if (osc === 'sq') s += ((f*t%1)<0.5?1:-1) * w;
      else if (osc === 'saw') s += (2*(f*t%1)-1) * w;
    }
    s /= h.reduce((a,[,w])=>a+w,0); // normalize harmonic sum
    buf[idx] += s * amp * envVal(n, durN, atkN, relN, sustain);
  }
}

// ── Note table ────────────────────────────────────────────────────────────────
const N = {
  A1:55, Bb1:58.27, B1:61.74,
  C2:65.41, D2:73.42, Eb2:77.78, E2:82.41, F2:87.31, G2:98,
  Ab2:103.83, A2:110, Bb2:116.54, B2:123.47,
  C3:130.81, D3:146.83, Eb3:155.56, E3:164.81, F3:174.61, G3:196, Ab3:207.65,
  A3:220, Bb3:233.08, B3:246.94,
  C4:261.63, D4:293.66, Eb4:311.13, E4:329.63, F4:349.23, G4:392, Ab4:415.3,
  A4:440, Bb4:466.16, B4:493.88,
  C5:523.25, D5:587.33, E5:659.25, F5:698.46, G5:783.99, A5:880,
  C6:1046.5, D6:1174.66,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TENSION — ominous/atmospheric (early game pre-battle)
// Character: heartbeat pulse, low growling drone, dissonant stabs, no melody
// ═══════════════════════════════════════════════════════════════════════════════
function genTension() {
  const buf = mkBuf();
  const beat = 60 / 70;

  // Sub-bass rumble (A1=55Hz) — continuous, heavy tremolo
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const trem = 0.65 + 0.35 * Math.sin(TAU * 0.22 * t);
    const vib  = Math.sin(TAU * 0.15 * t) * 1.2;
    buf[i] += Math.sin(TAU * (55 + vib) * t) * 0.18 * trem;
    buf[i] += Math.sin(TAU * (55.5 + vib * 0.8) * t) * 0.08 * trem; // slight detune
  }

  // Heartbeat: two thumps, pause (repeats every 2 beats)
  for (let b = 0; b * beat * 2 < DUR - 1; b++) {
    const t = b * beat * 2;
    // Thump 1
    const d1 = Math.round(0.22 * SR), s1 = Math.round(t * SR);
    for (let n = 0; n < d1; n++) {
      const idx = s1 + n; if (idx >= buf.length) break;
      const tt = n / SR;
      buf[idx] += Math.sin(TAU * (90 - tt * 200) * tt) * Math.exp(-tt * 22) * 0.45;
    }
    // Thump 2 (softer, 0.3s later)
    const t2 = t + 0.30;
    const s2 = Math.round(t2 * SR);
    const d2 = Math.round(0.18 * SR);
    for (let n = 0; n < d2; n++) {
      const idx = s2 + n; if (idx >= buf.length) break;
      const tt = n / SR;
      buf[idx] += Math.sin(TAU * (80 - tt * 160) * tt) * Math.exp(-tt * 28) * 0.28;
    }
  }

  // Mid tension pad — Am cluster (A2+C3+E3), very slow swell, sine with strong detune
  for (const [hz, a] of [[N.A2,0.10],[N.C3,0.08],[N.E3,0.07]]) {
    for (let i = 0; i < buf.length; i++) {
      const t = i / SR;
      const swell = 0.6 + 0.4 * Math.sin(TAU * 0.04 * t);
      buf[i] += Math.sin(TAU * hz * t) * a * swell;
      buf[i] += Math.sin(TAU * hz * 1.006 * t) * a * 0.4 * swell; // detuned layer
    }
  }

  // Dissonant stabs — Eb4 (tritone against A), irregular timing
  const stabTimes = [6, 11.5, 16, 20.5, 25, 29.5, 33, 38, 42];
  for (const t of stabTimes) {
    if (t + 2 < DUR) {
      addTone(buf, N.Eb4, 0.07, t, 1.4, {atk:0.15, rel:1.5, osc:'sine'});
      addTone(buf, N.Bb2, 0.05, t + 0.1, 1.2, {atk:0.2, rel:1.3, osc:'sine'});
    }
  }

  // Eerie high whistle (A5) with deep tremolo and vibrato
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const vib  = Math.sin(TAU * 0.5 * t) * 3;
    const trem = 0.3 + 0.7 * Math.max(0, Math.sin(TAU * 0.18 * t));
    const gf   = Math.min(1, t / 6) * Math.min(1, (DUR-t) / 5);
    buf[i] += Math.sin(TAU * (N.A5 + vib) * t) * 0.028 * trem * gf;
  }

  reverb(buf, [[220,0.45],[380,0.32],[560,0.20],[800,0.11],[1100,0.06]]);
  fade(buf, 2.5, 3.0);
  norm(buf, 0.78);
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFEAT — melancholic piano ballad (loss screen)
// Character: clear triangle-wave piano melody, minimal accompaniment, intimate
// ═══════════════════════════════════════════════════════════════════════════════
function genDefeat() {
  const buf = mkBuf();
  const beat = 60 / 54, bar = beat * 4;

  // Piano timbre: triangle (warmer than sine, piano-like)
  const pianoH = [[1,1.0],[2,0.30],[3,0.10],[4,0.04]];

  // Chords: Am-F-C-G × 2 + Am-F-Em-Am (fills ~45s at 54 BPM)
  const prog = [
    {root:N.A2, notes:[N.A3,N.C4,N.E4]},    // Am
    {root:N.F2, notes:[N.F3,N.A3,N.C4]},    // F
    {root:N.C3, notes:[N.C4,N.E4,N.G4]},    // C
    {root:N.G2, notes:[N.G3,N.B3,N.D4]},    // G
    {root:N.A2, notes:[N.A3,N.C4,N.E4]},    // Am
    {root:N.F2, notes:[N.F3,N.A3,N.C4]},    // F
    {root:N.E2, notes:[N.E3,N.G3,N.B3]},    // Em
    {root:N.A2, notes:[N.A3,N.C4,N.E4]},    // Am
    {root:N.A2, notes:[N.A3,N.C4,N.E4]},    // Am (tail)
    {root:N.F2, notes:[N.F3,N.A3,N.C4]},    // F
    {root:N.C3, notes:[N.C4,N.E4,N.G4]},    // C
  ];

  // Soft sine pad for each chord (barely audible — just warmth)
  for (let i = 0; i < prog.length; i++) {
    const t = i * bar; if (t >= DUR - 0.5) break;
    const dur = Math.min(bar * 0.88, DUR - t - 0.4);
    for (const hz of prog[i].notes) {
      addTone(buf, hz, 0.085, t, dur, {atk:0.50, rel:0.90, osc:'sine', sustain:0.75});
    }
    // Soft bass note
    addTone(buf, prog[i].root, 0.16, t, beat * 0.6, {atk:0.03, rel:0.55, osc:'sine'});
  }

  // Piano melody — triangle, clear and prominent, slightly dry
  // Descending: A4→G4→F4→E4→D4→C4→B3→A3 (one per bar, twice + extension)
  const mel = [N.A4,N.G4,N.F4,N.E4,N.D4,N.C4,N.B3,N.A3, N.A4,N.G4,N.F4];
  for (let i = 0; i < mel.length; i++) {
    const t = i * bar + beat * 0.5; if (t >= DUR - 1) break;
    addTone(buf, mel[i], 0.32, t, beat * 2.4, {atk:0.015, rel:0.70, osc:'tri', harmonics:pianoH});
    // Ghost note (octave below, half volume, offset by one beat)
    addTone(buf, mel[i]*0.5, 0.12, t + beat, beat * 1.6, {atk:0.020, rel:0.60, osc:'tri', harmonics:pianoH});
  }

  // Very soft upper counter-melody enters halfway (A5 range, just shimmer)
  for (let i = 4; i < mel.length - 1; i++) {
    const t = i * bar + beat * 1.8; if (t >= DUR - 1) break;
    addTone(buf, mel[i] * 2, 0.06, t, beat * 1.5, {atk:0.06, rel:0.7, osc:'sine'});
  }

  // Light reverb only on pads (melody stays relatively dry — intimacy)
  reverb(buf, [[130,0.22],[280,0.14],[450,0.08]]);
  fade(buf, 2.0, 2.5);
  norm(buf, 0.79);
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EPIC — orchestral triumph (conquest / campaign victories)
// Character: strings + brass swells + timpani, dynamic buildup, no e-drums
// ═══════════════════════════════════════════════════════════════════════════════
function genEpic() {
  const buf = mkBuf();
  const BPM = 72; // slower = more grand/weighty
  const beat = 60 / BPM, bar = beat * 4;
  const numBars = Math.floor(DUR / bar);

  // ── Orchestral strings: 5-voice detuned chorus, sine+triangle blend ──
  function strings(hz, amp, startSec, durSec, atk) {
    atk = atk || 0.45;
    const s0 = Math.round(startSec * SR);
    const durN = Math.round(durSec * SR);
    const atkN = Math.round(atk * SR);
    const relN = Math.round(1.2 * SR);
    const voices = [[0,0.34],[0.003,0.22],[-0.003,0.22],[0.006,0.12],[-0.002,0.10]];
    for (let n = 0; n < durN + relN; n++) {
      const idx = s0 + n; if (idx < 0 || idx >= buf.length) continue;
      const t = n / SR;
      const e = envVal(n, durN, atkN, relN, 0.90);
      let s = 0;
      for (const [det, w] of voices) {
        const f = hz * (1 + det);
        s += (Math.sin(TAU * f * t) * 0.60 + (2*Math.abs(2*(f*t%1)-1)-1) * 0.40) * w;
      }
      buf[idx] += s * amp * e;
    }
  }

  // ── Brass: triangle-based with harmonics (warm, not harsh sawtooth) ──
  const brassH = [[1,1.0],[2,0.45],[3,0.22],[4,0.10],[5,0.05]];
  function brass(hz, amp, startSec, durSec) {
    addTone(buf, hz, amp, startSec, durSec, {atk:0.07, rel:0.55, osc:'tri', harmonics:brassH, sustain:0.75});
  }

  // ── Timpani: pitch-dropping resonant low sine ──
  function timpani(hz, amp, t) {
    const s0 = Math.round(t * SR);
    const total = Math.round(2.0 * SR);
    for (let n = 0; n < total; n++) {
      const idx = s0 + n; if (idx >= buf.length) break;
      const tt = n / SR;
      buf[idx] += Math.sin(TAU * hz * (1 + 0.35 * Math.exp(-tt * 18)) * tt)
        * amp * Math.exp(-tt * 3.5) * Math.min(1, tt / 0.018);
    }
  }

  // ── Chord progression C – G – Am – F ──
  const chords = [
    { tHz:N.C2*0.5, bass:[N.C2,N.G2], low:[N.C3,N.E3,N.G3], hi:[N.C4,N.E4,N.G4] },
    { tHz:N.G2*0.5, bass:[N.G2,N.D3], low:[N.G3,N.B3,N.D4], hi:[N.G4,N.B4,N.D5] },
    { tHz:N.A2*0.5, bass:[N.A2,N.E3], low:[N.A3,N.C4,N.E4], hi:[N.A4,N.C5,N.E5] },
    { tHz:N.F2*0.5, bass:[N.F2,N.C3], low:[N.F3,N.A3,N.C4], hi:[N.F4,N.A4,N.C5] },
  ];

  for (let b = 0; b < numBars; b++) {
    const t = b * bar; if (t >= DUR - 0.5) break;
    const ch = chords[b % 4];
    const dur = Math.min(bar * 0.96, DUR - t - 0.4);
    const buildFull = Math.min(1, t / 18);
    const buildMid  = Math.min(1, Math.max(0, (t - bar * 2) / 10));

    // Low strings (always, anchor the sound)
    for (const hz of ch.bass) strings(hz, 0.16, t, dur, 0.55);
    // Mid strings (enter after bar 2)
    for (const hz of ch.low)  strings(hz, 0.13 * buildMid, t, dur, 0.42);
    // High strings (enter after bar 4)
    for (const hz of ch.hi)   strings(hz, 0.10 * buildFull, t, dur, 0.35);

    // Brass swells on beat 1
    for (const hz of ch.low) brass(hz, 0.13 * buildFull, t, beat * 0.85);
    for (const hz of ch.hi)  brass(hz, 0.09 * buildFull, t, beat * 0.80);
    // Brass echo beat 3
    if (t + beat*2 < DUR - 0.5) {
      for (const hz of ch.low) brass(hz, 0.08 * buildFull, t + beat*2, beat * 0.70);
    }

    // Timpani on beat 1 every bar; beat 3 on alternate bars
    timpani(ch.tHz, 0.42, t);
    if (b % 2 === 0 && t + beat*2 < DUR - 0.5)
      timpani(ch.tHz, 0.26, t + beat*2);
  }

  // ── French horn melody — fades in after bar 3 ──
  const melH = [[1,1.0],[2,0.28],[3,0.10],[4,0.04]];
  const mel   = [N.C5,N.E5,N.G5,N.E5,N.D5,N.C5,N.B4,N.C5,N.C5,N.E5,N.G5,N.E5];
  for (let i = 0; i < mel.length; i++) {
    const t = i * bar; if (t >= DUR - 0.5) break;
    const amp = 0.22 * Math.min(1, Math.max(0, (t - bar*2) / (bar*3)));
    if (amp <= 0) continue;
    addTone(buf, mel[i],     amp,      t,           bar*0.82, {atk:0.14, rel:0.55, osc:'sine', harmonics:melH});
    addTone(buf, mel[i]*0.5, amp*0.42, t+beat*0.3,  bar*0.65, {atk:0.10, rel:0.50, osc:'sine', harmonics:melH});
  }

  // ── Cymbal swell every 4 bars (orchestral grandeur) ──
  const cymFreqs = [3500,4800,6200,8000,10500];
  for (let b = 0; b < numBars; b += 4) {
    const t = b * bar; if (t >= DUR - 1) break;
    const s0 = Math.round(t * SR), cymN = Math.round(bar * SR);
    for (let n = 0; n < cymN; n++) {
      const idx = s0 + n; if (idx >= buf.length) break;
      const tt = n / SR;
      const e = Math.min(1, tt / 0.5) * Math.exp(-tt * 0.75) * 0.055;
      let s = 0;
      for (let k = 0; k < cymFreqs.length; k++) s += Math.sin(TAU * cymFreqs[k] * tt + k * 2.1) / cymFreqs.length;
      buf[idx] += s * e;
    }
  }

  // Warm hall reverb
  reverb(buf, [[90,0.28],[180,0.18],[320,0.11],[520,0.06],[780,0.03]]);
  fade(buf, 2.0, 2.5);
  norm(buf, 0.72);
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AMBIENT — peaceful harp + pads (faction select)
// Character: plucked harp notes, gentle pads, D major, open and airy
// ═══════════════════════════════════════════════════════════════════════════════
function genAmbient() {
  const buf = mkBuf();
  const bar = (60 / 48) * 4;

  // Proper pluck: exponential decay from peak (no sustain bug)
  function pluck(hz, amp, t) {
    const s0 = Math.round(t * SR);
    const total = Math.round(3.0 * SR);
    const harmonics = [[1,1.0],[2,0.45],[3,0.22],[4,0.12],[5,0.06],[6,0.03]];
    const hSum = harmonics.reduce((a,[,w])=>a+w, 0);
    for (let n = 0; n < total; n++) {
      const idx = s0 + n; if (idx < 0 || idx >= buf.length) continue;
      const tt = n / SR;
      const atkRamp = Math.min(1, tt / 0.003); // 3ms attack
      const decay = Math.exp(-tt * 3.2);        // exponential decay ~0.8s half-life
      let s = 0;
      for (const [mult, w] of harmonics) s += Math.sin(TAU * hz * mult * tt) * w;
      buf[idx] += (s / hSum) * amp * decay * atkRamp;
    }
  }

  // Harp arpeggio in D major — clearly audible, moderate amplitude
  const harpSeq = [
    [N.D4,  0.00], [N.Gb4, 0.38], [N.A4,  0.76], [N.D5,  1.15],
    [N.A4,  1.55], [N.Gb4, 1.90], [N.E4,  2.28], [N.D4,  2.65],
    [N.G4,  3.10], [N.B3,  3.50], [N.D4,  3.90], [N.Gb4, 4.35],
    [N.A4,  4.75], [N.D5,  5.10],
  ];
  const seqDur = 5.5;
  const numCycles = Math.ceil(DUR / seqDur);
  for (let c = 0; c < numCycles; c++) {
    for (const [hz, dt] of harpSeq) {
      const t = c * seqDur + dt;
      if (t < DUR - 2.5) pluck(hz, 0.55, t);
    }
  }

  // Gentle pad chords — D major progression, faster attack than before
  const pads = [
    [N.D3, N.Gb3, N.A3, N.D4],   // D
    [N.G3, N.B3,  N.D4],          // G
    [N.A3, N.Db4, N.E4],          // A
    [N.B2, N.D3,  N.Gb3, N.B3],  // Bm
    [N.G3, N.B3,  N.D4],          // G
    [N.A3, N.Db4, N.E4],          // A
    [N.D3, N.Gb3, N.A3, N.D4],   // D
  ];
  for (let i = 0; i < pads.length; i++) {
    const t = i * bar * 1.4; if (t >= DUR - 1.5) break;
    const dur = Math.min(bar * 1.4 - 0.2, DUR - t - 1.0);
    for (const hz of pads[i]) {
      addTone(buf, hz, 0.14, t, dur, {atk:0.40, rel:1.20, osc:'sine', sustain:0.80});
    }
  }

  // Bass drone D2 — audible anchor
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const swell = 0.75 + 0.25 * Math.sin(TAU * 0.07 * t);
    buf[i] += Math.sin(TAU * N.D2 * t) * 0.18 * swell;
    buf[i] += Math.sin(TAU * N.A2 * t) * 0.11 * swell;
  }

  // Shimmer: D5 + A5, clearly present
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const gf   = Math.min(1, t / 3) * Math.min(1, (DUR - t) / 3);
    const trem = 0.5 + 0.5 * Math.sin(TAU * 0.28 * t);
    buf[i] += Math.sin(TAU * N.D5 * t) * 0.055 * trem * gf;
    buf[i] += Math.sin(TAU * N.A5 * t) * 0.032 * trem * gf;
  }

  // Moderate reverb (spacious but not drowning everything)
  reverb(buf, [[200,0.35],[380,0.22],[620,0.12],[950,0.07]]);
  fade(buf, 2.5, 3.0);
  norm(buf, 0.82);
  return buf;
}

// ── Generate ──────────────────────────────────────────────────────────────────
console.log('Generating distinct music tracks...');
writeWav('tension.wav', genTension());
writeWav('defeat.wav',  genDefeat());
writeWav('epic.wav',    genEpic());
writeWav('ambient.wav', genAmbient());
console.log('Done.');
