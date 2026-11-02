// End-to-end checks: load index.html in headless Chromium and exercise the audio engine with synthetic signals.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const OUT = path.resolve(__dirname, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(URL);
  await page.evaluate(() => window.__app.ensureCtx());

  // Shared synthetic-signal helpers inside the page.
  await page.evaluate(() => {
    window.harm = (sr, secs, fn) => {          // harmonic "voice": fn(t) -> {f, amp}
      const n = Math.round(sr * secs), b = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr }), d = b.getChannelData(0);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const { f, amp } = fn(i / sr); ph += 2 * Math.PI * f / sr;
        let s = 0; for (let k = 1; k <= 8; k++) s += Math.sin(k * ph) / k;
        d[i] = amp * s + 0.004 * (Math.random() * 2 - 1);
      }
      return b;
    };
    window.rmsDb = (b, a, z) => { const x = b.getChannelData(0); let s = 0; for (let i = a; i < z; i++) s += x[i] * x[i]; return 20 * Math.log10(Math.sqrt(s / (z - a)) + 1e-9); };
    window.medianF0 = an => { const v = []; for (let f = 0; f < an.nF; f++) if (an.voiced[f]) v.push(an.f0[f]); v.sort((a, b) => a - b); return v[v.length >> 1]; };
  });

  await check('page loads without console or page errors', async () => {
    assert.deepEqual(errors, []);
  });

  await check('noise gate removes the noise floor but keeps the vocal level', async () => {
    const r = await page.evaluate(() => {
      const sr = 48000, A = window.__app;
      const buf = harm(sr, 4, t => ({ f: 226, amp: t > .5 && t < 3.5 ? .2 : 0 }));
      const g = A.applyGate(buf, { ngT: -45, ngRange: -60, ngA: 3, ngH: 80, ngR: 150 });
      return { noise: rmsDb(buf, sr * 3.8 | 0, sr * 3.95 | 0) - rmsDb(g, sr * 3.8 | 0, sr * 3.95 | 0),
               sig: Math.abs(rmsDb(buf, sr, 2 * sr) - rmsDb(g, sr, 2 * sr)) };
    });
    assert.ok(r.noise > 30, 'noise reduced by ' + r.noise.toFixed(1) + ' dB');
    assert.ok(r.sig < .5, 'signal changed by ' + r.sig.toFixed(2) + ' dB');
  });

  await check('auto-tune pulls a sharp note onto the nearest scale note (226 Hz -> A3 220 Hz)', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, buf = harm(48000, 4, t => ({ f: 226 * (1 + .004 * Math.sin(2 * Math.PI * 5 * t)), amp: .2 }));
      const an = await A.analyzePitch(buf);
      const out = A.applyTune(buf, an, { atKey: 9, atScale: 0, atSpeed: 0, atAmt: 100 });
      return { before: medianF0(an), after: medianF0(await A.analyzePitch(out)) };
    });
    assert.ok(Math.abs(r.before - 226) < 3, 'detected ' + r.before);
    assert.ok(Math.abs(r.after - 220) < 3, 'tuned to ' + r.after);
  });

  await check('auto-level hits the loudness target within 1 LU', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0;
      const t = A.newTrack('tone', harm(48000, 3, () => ({ f: 220, amp: .25 })), 0);
      Object.assign(t.fx, { cT: -22, cR: 3, cM: 4, warm: 20, rMix: 15 });
      document.querySelector('#target').value = '-14';
      await A.doAuto();
      return A.measure(await A.renderMix());
    });
    assert.ok(Math.abs(r.lufs + 14) < 1, 'measured ' + r.lufs.toFixed(2) + ' LUFS');
    assert.ok(r.peak <= -0.9, 'peak ' + r.peak.toFixed(2) + ' dBFS exceeds the -1 dB ceiling');
  });

  await check('WAV export writes a valid RIFF header', async () => {
    const head = await page.evaluate(async () => {
      const A = window.__app, blob = A.encodeWav(await A.renderMix(), 24), b = new Uint8Array(await blob.arrayBuffer());
      return { riff: String.fromCharCode(...b.slice(0, 4)), wave: String.fromCharCode(...b.slice(8, 12)), bits: b[34], size: b.length };
    });
    assert.equal(head.riff, 'RIFF'); assert.equal(head.wave, 'WAVE'); assert.equal(head.bits, 24); assert.ok(head.size > 1000);
  });

  await check('project save / load round-trips audio and settings', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0;
      const t1 = A.newTrack('Lead', harm(48000, 2, () => ({ f: 226, amp: .2 })), .25);
      const t2 = A.newTrack('Beat', harm(44100, 2, () => ({ f: 110, amp: .2 })), 0);
      Object.assign(t1.fx, { atOn: 1, atKey: 9, atSpeed: 0, ngT: -60, midG: 3 }); t1.vol = -3; t1.pan = .4; t2.mute = true;
      A.S.master.drive = 5.5;
      await A.processTrack(t1);
      const sample = Array.from(t1.orig.getChannelData(0).slice(1000, 1010));
      const ab = await A.buildProjectBlob().arrayBuffer();
      A.S.tracks.length = 0; A.S.master.drive = 0;
      const n = await A.loadProjectBuffer(ab), [a, b] = A.S.tracks;
      return { n, names: A.S.tracks.map(t => t.name), vol: a.vol, pan: a.pan, off: a.offset, mute: b.mute, sr: b.orig.sampleRate,
               fx: [a.fx.atOn, a.fx.atKey, a.fx.ngT, a.fx.midG], drive: A.S.master.drive, tuned: a.buffer !== a.orig,
               exact: JSON.stringify(sample) === JSON.stringify(Array.from(a.orig.getChannelData(0).slice(1000, 1010))),
               bad: await A.loadProjectBuffer(new ArrayBuffer(40)).then(() => 'no error', e => e.message) };
    });
    assert.equal(r.n, 2); assert.deepEqual(r.names, ['Lead', 'Beat']);
    assert.equal(r.vol, -3); assert.equal(r.pan, .4); assert.equal(r.off, .25); assert.equal(r.mute, true); assert.equal(r.sr, 44100);
    assert.deepEqual(r.fx, [1, 9, -60, 3]); assert.equal(r.drive, 5.5);
    assert.ok(r.exact, 'original audio must be bit-exact'); assert.ok(r.tuned, 'auto-tune must be re-applied after load');
    assert.match(r.bad, /Not a Vocal Studio project/);
  });

  await check('pitch graph tab renders detected notes', async () => {
    await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0;
      const notes = [60, 62, 64, 65, 67, 64, 62, 60];
      const t = A.newTrack('Melody', harm(48000, 4.4, tm => { const k = Math.floor((tm - .2) / .5);
        return k >= 0 && k < 8 && ((tm - .2) % .5) < .44 ? { f: 440 * Math.pow(2, (notes[k] + .3 - 69) / 12), amp: .2 } : { f: 100, amp: 0 }; }), 0);
      t.fx.atKey = 0; t.fx.atScale = 1; t.fx.atSpeed = 0;
    });
    await page.click('[data-tab=pitch]');
    await page.click('text=Analyze pitch');
    await page.waitForFunction(() => window.__app.S.tracks[0].pitch, null, { timeout: 30000 });
    await page.evaluate(() => { const t = window.__app.S.tracks[0]; t.fx.atOn = 1; return window.__app.processTrack(t); });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'pitch-graph.png') });
    const px = await page.evaluate(() => { const c = document.querySelector('.pitchbox canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 180) n++; return n; });
    assert.ok(px > 500, 'expected violet note blocks on the canvas, found ' + px + ' px');
  });

  await check('no errors were logged during the whole run', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close();
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
})();
