// End-to-end checks: load index.html in headless Chromium and exercise the audio engine with synthetic signals.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const http = require('node:http');
const { spawnSync } = require('node:child_process');
const INDEX = path.resolve(__dirname, '..', 'index.html');
// Served over http://localhost so IndexedDB (autosave) behaves like it does for real users.
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(fs.readFileSync(INDEX)); });
const OUT = path.resolve(__dirname, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const URL = 'http://127.0.0.1:' + server.address().port + '/';
  await page.goto(URL);
  await page.evaluate(() => window.__app.ensureCtx());

  // Shared synthetic-signal helpers; registered as an init script so they survive page reloads.
  await page.addInitScript(() => {
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

  await page.reload(); await page.evaluate(() => window.__app.ensureCtx());

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

  await check('stems: store-only ZIP with correct CRC, readable by a real unzip tool', async () => {
    const b64 = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0;
      const t1 = A.newTrack('Lead vox', harm(48000, 1, () => ({ f: 220, amp: .2 })), 0), t2 = A.newTrack('Beat', harm(48000, 2, () => ({ f: 110, amp: .2 })), .5);
      const len = A.S.tracks.reduce((m, t) => Math.max(m, t.offset + t.buffer.duration), 0) + A.mixTail();
      const files = [];
      for (const t of [t1, t2]) { const b = await A.renderStem(t, len); files.push({ name: t.name + '.wav', data: new Uint8Array(await A.encodeWav(b, 24).arrayBuffer()), n: b.length }); }
      if (files[0].n !== files[1].n) throw new Error('stems differ in length');
      const ab = await A.makeZip(files).arrayBuffer(), u = new Uint8Array(ab); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
      return btoa(s);
    });
    const crc = await page.evaluate(() => window.__app.crc32(new TextEncoder().encode('123456789')));
    assert.equal(crc, 0xCBF43926, 'CRC-32 check value');
    const f = path.join(OUT, 'stems.zip'); fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    const py = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip() or "OK");print("|".join(z.namelist()))', f], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    const [ok, names] = py.stdout.trim().split('\n');
    assert.equal(ok, 'OK'); assert.equal(names, 'Lead vox.wav|Beat.wav');
  });

  await check('loop region wraps playback back to its start', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.loop.a = .3; A.S.loop.b = .8; A.S.loop.on = true; A.play(.3);
      await new Promise(r => setTimeout(r, 1800));
      const pos = A.curPos(), playing = A.S.playing; A.S.loop.on = false; A.S.playing && document.querySelector('#btnStop').click();
      return { pos, playing };
    });
    assert.ok(r.playing, 'still playing'); assert.ok(r.pos < .95, 'position ' + r.pos.toFixed(2) + 's should stay inside the loop (would be ~2.1 s without it)');
  });

  await check('dragging a clip on the timeline moves its offset', async () => {
    await page.evaluate(() => { const A = window.__app; A.S.tracks.length = 0; A.newTrack('Drag me', harm(48000, 2, () => ({ f: 220, amp: .2 })), 0); });
    const box = await page.locator('.lane .area canvas').first().boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 40, { steps: 5 }); await page.mouse.move(box.x + 100, box.y + 40, { steps: 5 }); await page.mouse.up();
    const off = await page.evaluate(() => window.__app.S.tracks[0].offset);
    assert.ok(Math.abs(off - 1) < .08, 'offset ' + off + ' s (60 px at 60 px/s = 1 s)');
  });

  await check('autosave stores the session and offers to restore it after a reload', async () => {
    await page.evaluate(async () => { const A = window.__app; A.markDirty(); await A.autosave(); });
    const saved = await page.evaluate(async () => { const r = await window.__app.IDB.get('autosave'); return r && { tracks: r.tracks, size: r.blob.size }; });
    assert.ok(saved && saved.tracks === 1 && saved.size > 1000, 'autosave record: ' + JSON.stringify(saved));
    await page.reload(); await page.waitForSelector('#restoreBar:not([hidden])', { timeout: 5000 });
    await page.click('#restoreYes');
    await page.waitForFunction(() => window.__app.S.tracks.length === 1, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__app.S.tracks[0].name), 'Drag me');
    await page.evaluate(() => window.__app.IDB.del('autosave'));
  });

  await check('spectrum analyzer draws the live master output', async () => {
    await page.evaluate(() => { const A = window.__app; A.S.tracks.length = 0; A.newTrack('Tone', harm(48000, 3, () => ({ f: 440, amp: .3 })), 0); A.play(0); });
    await page.click('[data-tab=spectrum]'); await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, 'spectrum.png') });
    const px = await page.evaluate(() => { const c = document.querySelector('.pitchbox canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 150 && d[i] < 80) n++; return n; });
    await page.click('#btnStop');
    assert.ok(px > 150, 'expected a teal spectrum trace, found ' + px + ' px');
  });

  await check('undo / redo steps through track, master and delete changes', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.S.master.drive = 0; A.resetHistory();
      const undoDisabledAtStart = document.querySelector('#btnUndo').disabled;
      const t = A.newTrack('Vox', harm(48000, 2, () => ({ f: 226, amp: .2 })), 0), id = t.id, orig = t.orig; A.commitHistory();
      t.vol = -6; A.refreshAll(); A.commitHistory();
      t.fx.midG = 4; A.refreshAll(); A.commitHistory();
      A.S.master.drive = 7; A.refreshAll(); A.commitHistory();
      const o = { undoDisabledAtStart, steps: A.H.stack.length };
      A.undo(); o.drive = A.S.master.drive;
      A.undo(); o.midG = A.S.tracks[0].fx.midG;
      A.undo(); o.vol = A.S.tracks[0].vol;
      A.redo(); A.redo(); A.redo();
      o.redone = { vol: A.S.tracks[0].vol, midG: A.S.tracks[0].fx.midG, drive: A.S.master.drive };
      // delete the track, then bring it back
      document.querySelector('.lane .head .mini:last-child').click(); A.commitHistory();
      o.afterDelete = A.S.tracks.length;
      A.undo();
      const back = A.S.tracks[0];
      o.restored = { n: A.S.tracks.length, sameId: back && back.id === id, sameAudio: back && back.orig === orig, vol: back && back.vol, hasChain: back && !!window.__app.S && true };
      // a new edit after an undo discards the redo branch
      A.undo(); back.vol = -1; A.refreshAll(); A.commitHistory();
      o.redoDisabled = document.querySelector('#btnRedo').disabled;
      return o;
    });
    assert.equal(r.undoDisabledAtStart, true); assert.equal(r.steps, 5);
    assert.equal(r.drive, 0); assert.equal(r.midG, 0); assert.equal(r.vol, 0);
    assert.deepEqual(r.redone, { vol: -6, midG: 4, drive: 7 });
    assert.equal(r.afterDelete, 0);
    assert.deepEqual([r.restored.n, r.restored.sameId, r.restored.sameAudio, r.restored.vol], [1, true, true, -6]);
    assert.equal(r.redoDisabled, true);
  });

  await check('undo / redo re-derives noise-gate output instead of storing copies', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.resetHistory();
      const t = A.newTrack('Gated', harm(48000, 2, () => ({ f: 220, amp: .2 })), 0); A.commitHistory();
      const until = async f => { for (let i = 0; i < 60 && !f(); i++) await new Promise(r => setTimeout(r, 50)); return f(); };
      t.fx.ngT = -40; A.markDirty(); await A.processTrack(t); A.commitHistory();
      const o = { gated: t.buffer !== t.orig };
      A.undo(); o.ungated = await until(() => t.buffer === t.orig);
      A.redo(); o.regated = await until(() => t.buffer !== t.orig);
      return o;
    });
    assert.deepEqual(r, { gated: true, ungated: true, regated: true });
  });

  await check('undo / redo: slider drags merge into one step; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y work', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.resetHistory();
      const t = A.newTrack('Kb', harm(48000, 1, () => ({ f: 220, amp: .2 })), 0); A.commitHistory();
      const before = A.H.idx;
      for (const v of [-1, -2, -3, -4, -5]) { t.vol = v; A.refreshAll(); await new Promise(r => setTimeout(r, 60)); }   // one continuous drag
      await new Promise(r => setTimeout(r, 1000));
      document.activeElement && document.activeElement.blur();
      return { steps: A.H.idx - before };
    });
    assert.equal(r.steps, 1, 'five quick edits should be a single undo step');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => window.__app.S.tracks[0].vol), 0, 'Ctrl+Z');
    await page.keyboard.press('Control+Shift+Z');
    assert.equal(await page.evaluate(() => window.__app.S.tracks[0].vol), -5, 'Ctrl+Shift+Z');
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y');
    assert.equal(await page.evaluate(() => window.__app.S.tracks[0].vol), -5, 'Ctrl+Y');
  });

  await check('tempo grid: bars ruler and lane lines follow BPM and time signature', async () => {
    const r = await page.evaluate(() => {
      const A = window.__app; A.S.tracks.length = 0; A.S.pps = 60; A.setTempo({ bpm: 120, num: 4, den: 4, offset: 0, grid: true });
      A.newTrack('G', harm(48000, 2, () => ({ f: 220, amp: .2 })), 0);
      const bars = () => [...document.querySelectorAll('.ticks .tick.bar')].map(t => ({ lbl: t.textContent, x: parseFloat(t.style.left) }));
      const o = { beatSec: A.beatSec(), bars120: bars().slice(0, 3) };
      o.laneBg = document.querySelector('.lane .area').style.backgroundImage.includes('repeating-linear-gradient');
      A.setTempo({ bpm: 60 }); o.bars60 = bars().slice(0, 3);
      A.setTempo({ bpm: 90, num: 3, den: 8 }); o.beat38 = A.beatSec(); o.bars38 = bars().slice(0, 2);
      A.setTempo({ grid: false }); o.secondsRuler = document.querySelector('.ticks .tick').textContent;
      return o;
    });
    assert.equal(r.beatSec, .5);
    assert.deepEqual(r.bars120, [{ lbl: '1', x: 0 }, { lbl: '2', x: 120 }, { lbl: '3', x: 240 }]);
    assert.ok(r.laneBg, 'lane grid lines');
    assert.deepEqual(r.bars60.map(b => b.x), [0, 240, 480]);
    assert.ok(Math.abs(r.beat38 - 60 / 90 * .5) < 1e-9, '3/8 beat length'); assert.ok(Math.abs(r.bars38[1].x - 3 * r.beat38 * 60) < .01);
    assert.equal(r.secondsRuler, '0:00');
  });

  await check('snap: clip drags and loop regions land on beats; Shift bypasses snapping', async () => {
    await page.evaluate(() => { const A = window.__app; A.S.tracks.length = 0; A.S.pps = 60; A.setTempo({ bpm: 120, num: 4, den: 4, offset: 0, grid: true, snap: true }); A.newTrack('S', harm(48000, 2, () => ({ f: 220, amp: .2 })), 0); });
    const drag = async (dx, shift) => {
      const box = await page.locator('.lane .area canvas').first().boundingBox();
      await page.evaluate(() => { window.__app.S.tracks[0].offset = 0; });
      await page.mouse.move(box.x + 30, box.y + 40); await page.mouse.down();
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.move(box.x + 30 + dx / 2, box.y + 40, { steps: 4 }); await page.mouse.move(box.x + 30 + dx, box.y + 40, { steps: 4 });
      await page.mouse.up(); if (shift) await page.keyboard.up('Shift');
      return page.evaluate(() => window.__app.S.tracks[0].offset);
    };
    const snapped = await drag(95), free = await drag(95, true);
    assert.ok(Math.abs(snapped - 1.5) < 1e-6, 'snapped to 1.5 s, got ' + snapped);
    assert.ok(Math.abs(free - 95 / 60) < .06 && Math.abs(free - 1.5) > .02, 'free drag ~' + (95 / 60).toFixed(3) + ' s, got ' + free);
    const o = await page.evaluate(() => { const A = window.__app; return [A.snapT(.74), A.snapT(.76), A.snapT(.76, { shiftKey: true })]; });
    assert.deepEqual(o, [.5, 1, .76]);
  });

  await check('metronome clicks land exactly on the beat with the accent on beat 1', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.setTempo({ bpm: 240, num: 4, den: 4, offset: 0, click: true, grid: false });
      A.newTrack('M', harm(48000, 4, () => ({ f: 220, amp: .1 })), 0); A.ensureCtx();
      const log = [], orig = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () { const o = orig.call(this); const st = o.start.bind(o); o.start = w => { log.push({ w, f: o.frequency.value }); st(w); }; return o; };
      A.play(0); await new Promise(r => setTimeout(r, 1500));
      AudioContext.prototype.createOscillator = orig; document.querySelector('#btnStop').click(); A.setTempo({ click: false });
      return log;
    });
    assert.ok(r.length >= 5, 'got ' + r.length + ' clicks');
    for (let i = 1; i < 5; i++) assert.ok(Math.abs(r[i].w - r[i - 1].w - .25) < .002, 'spacing ' + (r[i].w - r[i - 1].w));
    assert.deepEqual(r.slice(0, 5).map(c => c.f), [1600, 1000, 1000, 1000, 1600]);
  });

  await check('count-in: clicks play for the chosen bars before the recording starts', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.setTempo({ bpm: 240, num: 4, den: 4, countIn: 1, click: false }); A.ensureCtx();
      let clicks = 0; const orig = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () { clicks++; return orig.call(this); };
      const t0 = performance.now(); document.querySelector('#btnRec').click();
      while (!A.S.recording && performance.now() - t0 < 8000) await new Promise(r => setTimeout(r, 20));
      const waited = (performance.now() - t0) / 1000, started = !!A.S.recording;
      await new Promise(r => setTimeout(r, 400)); AudioContext.prototype.createOscillator = orig;
      document.querySelector('#btnRec').click();
      for (let i = 0; i < 100 && !(A.S.tracks[0] && A.S.tracks[0].buffer); i++) await new Promise(r => setTimeout(r, 50));
      A.setTempo({ countIn: 0 });
      return { waited, started, countInClicks: clicks, gotAudio: !!(A.S.tracks[0] && A.S.tracks[0].buffer) };
    });
    assert.ok(r.started, 'recording started'); assert.ok(r.waited > .9 && r.waited < 2.5, 'waited ' + r.waited.toFixed(2) + ' s for a 1 s count-in');
    assert.equal(r.countInClicks, 4); assert.ok(r.gotAudio, 'recorded audio decoded');
  });

  await check('tap tempo, project save/load and undo all carry the tempo settings', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.setTempo({ bpm: 120, num: 4, den: 4, grid: false, countIn: 0, offset: 0, click: false });
      A.newTrack('T', harm(48000, 1, () => ({ f: 220, amp: .2 })), 0); A.resetHistory();
      const o = {};
      [0, 500, 1000, 1500, 2000].forEach(t => A.tapTempo(t)); o.tapped = A.S.tempo.bpm;
      A.tapTempo(9000); A.tapTempo(9400); o.tappedFast = A.S.tempo.bpm;        // a >2 s gap starts a fresh tap series
      A.setTempo({ bpm: 97.5, num: 3, den: 4, grid: true, offset: .25, countIn: 2 }); A.commitHistory();
      const ab = await A.buildProjectBlob().arrayBuffer();
      A.setTempo({ bpm: 140, num: 5, grid: false, offset: 0, countIn: 0 });
      await A.loadProjectBuffer(ab); o.loaded = { ...A.S.tempo };
      A.setTempo({ bpm: 111 }); A.commitHistory(); A.undo(); o.afterUndo = A.S.tempo.bpm; A.redo(); o.afterRedo = A.S.tempo.bpm;
      A.setTempo({ bpm: 120, num: 4, den: 4, grid: false, countIn: 0, offset: 0, click: false });
      return o;
    });
    assert.equal(r.tapped, 120); assert.equal(r.tappedFast, 150);
    assert.deepEqual([r.loaded.bpm, r.loaded.num, r.loaded.den, r.loaded.grid, r.loaded.offset, r.loaded.countIn], [97.5, 3, 4, true, .25, 2]);
    assert.equal(r.afterUndo, 97.5); assert.equal(r.afterRedo, 111);
  });

  await check('fades: exact gain at the edges and midpoints for linear, equal-power and S-curve', async () => {
    const r = await page.evaluate(() => {
      const A = window.__app, sr = 48000, N = sr, buf = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: sr });
      for (let c = 0; c < 2; c++) buf.getChannelData(c).fill(1);
      const run = curve => { const o = A.applyFades(buf, { fadeIn: .1, fadeOut: .2, fadeCurve: curve }), d = o.getChannelData(1);
        return { first: d[0], last: d[N - 1], inMid: d[2400], outMid: d[N - 1 - 4800], mid: d[N >> 1], len: o.length, ch: o.numberOfChannels }; };
      return { lin: run(0), eq: run(1), s: run(2), srcUntouched: buf.getChannelData(0)[0] === 1 && buf.getChannelData(0)[100] === 1 };
    });
    for (const k of ['lin', 'eq', 's']) { assert.equal(r[k].first, 0, k + ' starts silent'); assert.equal(r[k].last, 0, k + ' ends silent'); assert.equal(r[k].mid, 1, k + ' untouched in the middle'); assert.equal(r[k].len, 48000); assert.equal(r[k].ch, 2); }
    assert.ok(Math.abs(r.lin.inMid - .5) < 1e-6 && Math.abs(r.lin.outMid - .5) < 1e-6, 'linear half-way = 0.5');
    assert.ok(Math.abs(r.eq.inMid - Math.SQRT1_2) < 1e-6, 'equal power half-way = 0.7071');
    assert.ok(Math.abs(r.s.inMid - .5) < 1e-6, 'S-curve half-way = 0.5');
    assert.ok(r.srcUntouched, 'source buffer must not be modified');
  });

  await check('fades run through the track pipeline: applied, removed, and undone / redone', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.S.tempo.grid = false; A.resetHistory();
      const sr = 48000, b = new AudioBuffer({ length: sr * 2, numberOfChannels: 1, sampleRate: sr }); b.getChannelData(0).fill(.5);
      const t = A.newTrack('Fade', b, 0); A.commitHistory();
      const until = async f => { for (let i = 0; i < 60 && !f(); i++) await new Promise(r => setTimeout(r, 50)); return f(); };
      Object.assign(t.fx, { fadeIn: 1, fadeOut: .5, fadeCurve: 0 }); A.markDirty(); await A.processTrack(t); A.commitHistory();
      const d = t.buffer.getChannelData(0), o = { applied: t.buffer !== t.orig, first: d[0], quarter: d[sr >> 1], mid: d[sr * 1.2 | 0], last: d[d.length - 1], origIntact: t.orig.getChannelData(0)[0] === .5 };
      A.undo(); o.undone = await until(() => t.buffer === t.orig && t.fx.fadeIn === 0);
      A.redo(); o.redone = await until(() => t.buffer !== t.orig && t.fx.fadeIn === 1);
      t.fx.fadeIn = 0; t.fx.fadeOut = 0; A.markDirty(); await A.processTrack(t); o.removed = t.buffer === t.orig;
      return o;
    });
    assert.ok(r.applied); assert.equal(r.first, 0); assert.ok(Math.abs(r.quarter - .25) < 1e-6, 'quarter ' + r.quarter); assert.equal(r.mid, .5); assert.equal(r.last, 0); assert.ok(r.origIntact);
    assert.deepEqual([r.undone, r.redone, r.removed], [true, true, true]);
  });

  await check('dragging the fade handles on a clip sets the fade length', async () => {
    await page.evaluate(() => {
      const A = window.__app; A.S.tracks.length = 0; A.S.pps = 60; A.setTempo({ grid: false });
      const b = new AudioBuffer({ length: 96000, numberOfChannels: 1, sampleRate: 48000 }); b.getChannelData(0).fill(.5); A.newTrack('H', b, 0);
    });
    const drag = async (sel, dx) => {
      const bx = await page.locator(sel).first().boundingBox(), x = bx.x + bx.width / 2, y = bx.y + bx.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y, { steps: 4 }); await page.mouse.move(x + dx, y, { steps: 4 }); await page.mouse.up();
    };
    await drag('.fadehd >> nth=0', 60);                          // fade-in handle: +60 px at 60 px/s = 1 s
    await page.waitForFunction(() => window.__app.S.tracks[0].buffer !== window.__app.S.tracks[0].orig, null, { timeout: 5000 });
    await drag('.fadehd >> nth=1', -30);                         // fade-out handle: -30 px = 0.5 s
    await page.waitForFunction(() => { const t = window.__app.S.tracks[0]; return t.buffer.getChannelData(0)[t.buffer.length - 2] < .01 && t.fx.fadeOut > .4; }, null, { timeout: 5000 });
    const r = await page.evaluate(() => { const t = window.__app.S.tracks[0], d = t.buffer.getChannelData(0); return { fi: t.fx.fadeIn, fo: t.fx.fadeOut, atHalf: d[24000], first: d[0], sliders: document.querySelector('.fxhost') ? true : false }; });
    assert.ok(Math.abs(r.fi - 1) < .05, 'fade in ' + r.fi); assert.ok(Math.abs(r.fo - .5) < .05, 'fade out ' + r.fo);
    assert.equal(r.first, 0); assert.ok(Math.abs(r.atHalf - .5 * Math.SQRT1_2) < .02, 'equal-power at half of a 1 s fade-in: ' + r.atHalf);
  });

  await check('fades survive project save / load and are re-applied', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0;
      const b = new AudioBuffer({ length: 48000, numberOfChannels: 1, sampleRate: 48000 }); b.getChannelData(0).fill(.5);
      const t = A.newTrack('Persist', b, 0); Object.assign(t.fx, { fadeIn: .25, fadeOut: .25, fadeCurve: 2 }); A.markDirty(); await A.processTrack(t);
      const ab = await A.buildProjectBlob().arrayBuffer(); A.S.tracks.length = 0;
      await A.loadProjectBuffer(ab); const u = A.S.tracks[0], d = u.buffer.getChannelData(0);
      return { fx: [u.fx.fadeIn, u.fx.fadeOut, u.fx.fadeCurve], faded: u.buffer !== u.orig, first: d[0], last: d[d.length - 1], origDry: u.orig.getChannelData(0)[0] };
    });
    assert.deepEqual(r.fx, [.25, .25, 2]); assert.ok(r.faded); assert.equal(r.first, 0); assert.equal(r.last, 0); assert.equal(r.origDry, .5, 'the saved audio stays unfaded');
  });

  await check('split: halves are contiguous, keep settings, and fades stay on the outer edges only', async () => {
    const r = await page.evaluate(() => {
      const A = window.__app; A.S.tracks.length = 0; A.S.tempo.grid = false;
      const buf = harm(48000, 2, () => ({ f: 220, amp: .2 })), t = A.newTrack('Verse', buf, .5);
      Object.assign(t.fx, { midG: 3, rMix: 15, fadeIn: .2, fadeOut: .3 }); t.vol = -4; t.pan = .3; t.mute = false;
      const ok = A.splitTrack(t, 1.5), edge = A.splitTrack(t, .51), outside = A.splitTrack(t, 9);
      const [l, rt] = A.S.tracks, joined = new Float32Array(buf.length);
      joined.set(l.orig.getChannelData(0), 0); joined.set(rt.orig.getChannelData(0), l.orig.length);
      const orig = buf.getChannelData(0); let same = joined.length === orig.length; for (let i = 0; same && i < orig.length; i++) if (joined[i] !== orig[i]) same = false;
      return { n: A.S.tracks.length, edge: edge, outside: outside, names: A.S.tracks.map(x => x.name), offsets: A.S.tracks.map(x => x.offset), lens: [l.orig.length, rt.orig.length], same,
               left: { vol: l.vol, pan: l.pan, midG: l.fx.midG, rMix: l.fx.rMix, fi: l.fx.fadeIn, fo: l.fx.fadeOut }, right: { vol: rt.vol, pan: rt.pan, midG: rt.fx.midG, rMix: rt.fx.rMix, fi: rt.fx.fadeIn, fo: rt.fx.fadeOut }, ok: !!ok,
               third: (() => { const x = A.splitTrack(rt, 2); return x && x.name; })() };
    });
    assert.ok(r.ok); assert.equal(r.edge, null, 'cut at the very edge is refused'); assert.equal(r.outside, null, 'cut outside the clip is refused');
    assert.deepEqual(r.names, ['Verse', 'Verse (2)']); assert.deepEqual(r.offsets, [.5, 1.5]); assert.deepEqual(r.lens, [48000, 48000]); assert.ok(r.same, 'halves must concatenate to the original audio');
    assert.deepEqual(r.left, { vol: -4, pan: .3, midG: 3, rMix: 15, fi: .2, fo: 0 }); assert.deepEqual(r.right, { vol: -4, pan: .3, midG: 3, rMix: 15, fi: 0, fo: .3 });
    assert.equal(r.third, 'Verse (3)');
  });

  await check('split is seamless: the mix sounds the same before and after (EQ, delay, reverb)', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.S.master.drive = 0; A.S.master.gT = 0;
      const rate = A.ensureCtx().sampleRate;      // audio at the context rate, as decodeAudioData produces for real imports
      const t = A.newTrack('Seam', harm(rate, 2, tm => ({ f: 220 * (1 + .01 * Math.sin(tm * 6)), amp: .12 })), 0);
      Object.assign(t.fx, { midG: 4, highG: 3, dMix: 20, dT: 200, rMix: 25, rSize: 1.2 });
      const before = await A.renderMix(); A.splitTrack(t, .9); const after = await A.renderMix();
      const a = before.getChannelData(0), b = after.getChannelData(0); let maxDiff = 0, peak = 0;
      // compare up to the clip end: the ~40 ms after it is just the browser's compressors flushing their look-ahead delay
      for (let i = 0; i < Math.round(2 * rate); i++) { maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i])); peak = Math.max(peak, Math.abs(a[i])); }
      return { maxDiff, peak, lenSame: a.length === b.length, tracks: A.S.tracks.length };
    });
    assert.equal(r.tracks, 2); assert.ok(r.lenSame); assert.ok(r.peak > .05, 'signal present');
    assert.ok(r.maxDiff < 1e-3, 'max difference ' + r.maxDiff.toExponential(2) + ' vs peak ' + r.peak.toFixed(3));
  });

  await check('split: undo restores the whole clip, redo splits it again (with auto-tune re-derived)', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app; A.S.tracks.length = 0; A.S.master.drive = 0; A.resetHistory();
      const buf = harm(48000, 3, () => ({ f: 226, amp: .2 })), t = A.newTrack('Undo me', buf, 0); Object.assign(t.fx, { atOn: 1, atKey: 9, atSpeed: 0 }); A.commitHistory();
      const until = async f => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 50)); return f(); };
      A.markDirty(); await A.processTrack(t); A.commitHistory();
      const o = { orig: t.orig }; A.splitTrack(t, 1.5); A.commitHistory(); o.afterSplit = A.S.tracks.length;
      o.halvesTuned = await until(() => A.S.tracks.every(x => x.buffer !== x.orig));
      const msgSplit = document.querySelector('#status').textContent;
      A.undo(); o.afterUndo = A.S.tracks.length; o.sameOrig = A.S.tracks[0].orig === o.orig; o.undoLen = A.S.tracks[0].orig.length;
      o.retuned = await until(() => A.S.tracks[0].buffer !== A.S.tracks[0].orig && A.S.tracks[0].buffer.length === 144000);
      o.undoMsg = document.querySelector('#status').textContent;
      A.redo(); o.afterRedo = A.S.tracks.length; o.redoLens = A.S.tracks.map(x => x.orig.length);
      o.redoTuned = await until(() => A.S.tracks.every(x => x.buffer !== x.orig)); delete o.orig; return o;
    });
    assert.equal(r.afterSplit, 2); assert.ok(r.halvesTuned, 'both halves get gate/tune/fade processing');
    assert.equal(r.afterUndo, 1); assert.ok(r.sameOrig, 'undo brings back the identical full-length audio'); assert.equal(r.undoLen, 144000); assert.ok(r.retuned);
    assert.match(r.undoMsg, /Undid: split clip “Undo me”/);
    assert.equal(r.afterRedo, 2); assert.deepEqual(r.redoLens, [72000, 72000]); assert.ok(r.redoTuned);
  });

  await check('split from the UI: S key, Shift+S, the button and double-click', async () => {
    await page.evaluate(() => {
      const A = window.__app; A.S.tracks.length = 0; A.S.pps = 60; A.setTempo({ grid: false });
      A.newTrack('A', harm(48000, 4, () => ({ f: 220, amp: .1 })), 0); A.newTrack('B', harm(48000, 4, () => ({ f: 330, amp: .1 })), 0);
      A.S.selected = A.S.tracks[0].id; document.activeElement && document.activeElement.blur(); A.S.pos = 1;
    });
    await page.keyboard.press('s');                                                  // selected track only
    let n = await page.evaluate(() => window.__app.S.tracks.map(t => t.name).join('|'));
    assert.equal(n, 'A|A (2)|B', 'S splits only the selected track: ' + n);
    await page.evaluate(() => { window.__app.S.pos = 3; });
    await page.keyboard.press('Shift+S');                                            // every clip under the playhead
    n = await page.evaluate(() => window.__app.S.tracks.map(t => t.name).join('|'));
    assert.equal(n, 'A|A (2)|A (3)|B|B (2)', 'Shift+S splits every clip under the playhead: ' + n);
    await page.evaluate(() => { window.__app.S.pos = 3.5; window.__app.S.selected = window.__app.S.tracks[0].id; });
    await page.click('#btnSplit');                                                   // playhead outside the selected clip: refused with a hint
    assert.match(await page.evaluate(() => document.querySelector('#status').textContent), /Move the playhead inside/);
    await page.evaluate(() => { const A = window.__app; A.S.tracks.length = 0; A.newTrack('D', harm(48000, 4, () => ({ f: 220, amp: .1 })), 0); });
    const box = await page.locator('.lane .area canvas').first().boundingBox();
    await page.mouse.dblclick(box.x + 120, box.y + 40);                              // 2 s into the clip
    const r = await page.evaluate(() => window.__app.S.tracks.map(t => [t.name, +t.offset.toFixed(2), +(t.orig.length / 48000).toFixed(2)]));
    assert.equal(r.length, 2); assert.ok(Math.abs(r[0][2] - 2) < .05 && Math.abs(r[1][1] - 2) < .05, 'double-click split near 2 s: ' + JSON.stringify(r));
  });

  await check('doubler: each voice has the right detune, level and stereo side; the lead is untouched', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, sr = A.ensureCtx().sampleRate;
      const dry = harm(sr, 3, () => ({ f: 220, amp: .15 })), d = dry.getChannelData(0);
      const an = await A.analyzePitch(dry);
      const p = { dbVoices: 1, dbLevel: -6, dbDetune: 10, dbDrift: 0, dbDelay: 20, dbSpread: 100, dbTone: 16000 };
      const out = A.applyDoubler(dry, an, p), L = out.getChannelData(0), R = out.getChannelData(1), dly = Math.round(.02 * sr);
      const mk = f => { const b = new AudioBuffer({ length: d.length, numberOfChannels: 1, sampleRate: sr }); f(b.getChannelData(0)); return b; };
      const dl = mk(x => { for (let i = 0; i < d.length; i++) x[i] = L[i] - d[i]; }), dr = mk(x => { for (let i = 0; i < d.length; i++) x[i] = R[i] - d[i]; });
      const rms = (b, a0, a1) => { const x = b.getChannelData(0); let s2 = 0; for (let i = a0; i < a1; i++) s2 += x[i] * x[i]; return Math.sqrt(s2 / (a1 - a0)); };
      let preEq = true; for (let i = 0; i < dly; i++) if (L[i] !== d[i] || R[i] !== d[i]) preEq = false;
      return { ch: out.numberOfChannels, len: out.length === dry.length, preEq, fL: medianF0(await A.analyzePitch(dl)), fR: medianF0(await A.analyzePitch(dr)),
               gainL: rms(dl, sr, 2 * sr) / rms(dry, sr, 2 * sr), gainR: rms(dr, sr, 2 * sr) / rms(dry, sr, 2 * sr) };
    });
    assert.equal(r.ch, 2); assert.ok(r.len); assert.ok(r.preEq, 'nothing but the lead is audible before the first delay');
    assert.ok(Math.abs(r.fL - 220 * Math.pow(2, -10 / 1200)) < .6, 'left voice ' + r.fL.toFixed(2) + ' Hz (want 218.7)');
    assert.ok(Math.abs(r.fR - 220 * Math.pow(2, 10 / 1200)) < .6, 'right voice ' + r.fR.toFixed(2) + ' Hz (want 221.3)');
    for (const g of [r.gainL, r.gainR]) assert.ok(Math.abs(g - Math.pow(10, -6 / 20)) < .06, 'voice level ' + g.toFixed(3) + ' (want 0.501)');
  });

  await check('doubler: time offsets are exact (22 ms and 1.25x), measured on noise', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, sr = A.ensureCtx().sampleRate, n = sr, nz = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr }), d = nz.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * .2;
      const an = await A.analyzePitch(nz), out = A.applyDoubler(nz, an, { dbVoices: 1, dbLevel: 0, dbDetune: 0, dbDrift: 0, dbDelay: 22, dbSpread: 100, dbTone: 16000 });
      const lag = ch => { const x = out.getChannelData(ch), y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = x[i] - d[i]; let best = 0, bl = 0;
        for (let k = 0; k < 2000; k++) { let s2 = 0; for (let i = 3000; i < 23000; i++) s2 += d[i] * y[i + k]; if (s2 > best) { best = s2; bl = k; } } return bl; };
      return { L: lag(0), R: lag(1), want: [Math.round(.022 * sr), Math.round(.022 * sr * 1.25)], voiced: an.voicedPct };
    });
    assert.ok(r.voiced < .05, 'noise should be unvoiced (' + r.voiced + ')');
    assert.ok(Math.abs(r.L - r.want[0]) <= 3, 'left lag ' + r.L + ' want ~' + r.want[0]); assert.ok(Math.abs(r.R - r.want[1]) <= 3, 'right lag ' + r.R + ' want ~' + r.want[1]);
  });

  await check('doubler follows the tuned vocal and caches its analysis until tune settings change', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, sr = A.ensureCtx().sampleRate; A.S.tracks.length = 0;
      const t = A.newTrack('Tuned dbl', harm(sr, 3, () => ({ f: 226, amp: .15 })), 0);
      Object.assign(t.fx, { atOn: 1, atKey: 9, atScale: 0, atSpeed: 0, atAmt: 100, dbOn: 1, dbVoices: 0, dbLevel: -3, dbDetune: 10, dbDrift: 0, dbDelay: 20, dbSpread: 100, dbTone: 16000 });
      await A.processTrack(t);
      const L = t.buffer.getChannelData(0), R = t.buffer.getChannelData(1), v = new AudioBuffer({ length: L.length, numberOfChannels: 1, sampleRate: sr });
      const x = v.getChannelData(0); for (let i = 0; i < L.length; i++) x[i] = R[i] - L[i];          // single right voice: L is the lead, R - L the double
      const o = { ch: t.buffer.numberOfChannels, f: medianF0(await A.analyzePitch(v)), first: t.dblPitch };
      t.fx.dbDetune = 15; await A.processTrack(t); o.sameAfterDetune = t.dblPitch === o.first;
      t.fx.atKey = 0; await A.processTrack(t); o.newAfterTune = t.dblPitch !== o.first; delete o.first; return o;
    });
    assert.equal(r.ch, 2); assert.ok(Math.abs(r.f - 220 * Math.pow(2, 10 / 1200)) < .8, 'double at ' + r.f.toFixed(2) + ' Hz (tuned A3 + 10 cents = 221.3; untuned would be ~227.3)');
    assert.ok(r.sameAfterDetune, 'changing detune must reuse the cached analysis'); assert.ok(r.newAfterTune, 'changing the tune settings must re-analyze');
  });

  await check('doubler is repeatable, runs through the pipeline, and survives undo/redo, save/load and split', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, sr = A.ensureCtx().sampleRate; A.S.tracks.length = 0; A.S.master.drive = 0; A.resetHistory();
      const t = A.newTrack('Pipe', harm(sr, 2, () => ({ f: 220, amp: .15 })), 0); A.commitHistory();
      const until = async f => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 50)); return f(); };
      const an = await A.analyzePitch(t.orig), p = { dbVoices: 1, dbLevel: -6, dbDetune: 10, dbDrift: 8, dbDelay: 22, dbSpread: 80, dbTone: 9000 };
      const a = A.applyDoubler(t.orig, an, p), b = A.applyDoubler(t.orig, an, p); let identical = true;
      for (let c = 0; c < 2; c++) { const x = a.getChannelData(c), y = b.getChannelData(c); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { identical = false; break; } }
      const o = { identical }; Object.assign(t.fx, { dbOn: 1, dbDrift: 8 }); A.markDirty(); await A.processTrack(t); A.commitHistory();
      o.stereo = t.buffer.numberOfChannels === 2; o.origMono = t.orig.numberOfChannels === 1;
      A.undo(); o.undone = await until(() => t.buffer === t.orig && !t.fx.dbOn);
      A.redo(); o.redone = await until(() => t.buffer !== t.orig && t.buffer.numberOfChannels === 2 && t.fx.dbOn === 1);
      const ab = await A.buildProjectBlob().arrayBuffer(); A.S.tracks.length = 0; await A.loadProjectBuffer(ab);
      const u = A.S.tracks[0]; o.loaded = [u.fx.dbOn, u.fx.dbDrift, u.buffer.numberOfChannels, u.orig.numberOfChannels];
      A.splitTrack(u, 1); o.halves = await until(() => A.S.tracks.length === 2 && A.S.tracks.every(x => x.buffer !== x.orig && x.buffer.numberOfChannels === 2));
      u.fx.dbOn = 0; A.markDirty(); await A.processTrack(u); o.off = u.buffer === u.orig; return o;
    });
    assert.ok(r.identical, 'same settings must give identical audio'); assert.ok(r.stereo && r.origMono, 'the doubled clip is stereo; the source stays untouched');
    assert.ok(r.undone && r.redone, 'undo / redo'); assert.deepEqual(r.loaded, [1, 8, 2, 1]); assert.ok(r.halves, 'both halves of a split doubled clip are doubled'); assert.ok(r.off, 'disabling restores the original clip');
  });

  // helper for the harmonizer tests: a stepped melody (midi + cents offset per second), the voice isolated by subtracting the lead
  await page.addInitScript(() => {
    window.melody = (sr, notes) => {
      const n = Math.round(sr * notes.length), b = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr }), d = b.getChannelData(0); let ph = 0;
      for (let i = 0; i < n; i++) { const k = Math.min(notes.length - 1, Math.floor(i / sr)); ph += 2 * Math.PI * 440 * Math.pow(2, (notes[k] - 69) / 12) / sr; let s = 0; for (let h = 1; h <= 6; h++) s += Math.sin(h * ph) / h; d[i] = .15 * s; }
      return b;
    };
    window.voiceNotes = async (A, lead, out, ch, nNotes) => {      // median pitch of (channel - lead) in the steady middle of each second, as midi
      const sr = lead.sampleRate, d = lead.getChannelData(0), x = out.getChannelData(ch), v = new AudioBuffer({ length: d.length, numberOfChannels: 1, sampleRate: sr }), y = v.getChannelData(0);
      for (let i = 0; i < d.length; i++) y[i] = x[i] - d[i];
      const an = await A.analyzePitch(v), res = [];
      for (let k = 0; k < nNotes; k++) { const vals = []; for (let f = 0; f < an.nF; f++) { const t = f * an.hop / sr; if (an.voiced[f] && t > k + .25 && t < k + .8) vals.push(an.f0[f]); } vals.sort((a, b) => a - b); res.push(69 + 12 * Math.log2(vals[vals.length >> 1] / 440)); }
      return res;
    };
  });
  await page.reload(); await page.evaluate(() => window.__app.ensureCtx());

  await check('harmonizer: diatonic 3rds and 5ths land on the right scale notes (C major and A minor)', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, sr = A.ensureCtx().sampleRate, base = { hmLevel: -6, hmLock: 100, hmDelay: 0, hmSpread: 100, hmTone: 16000, hmDrift: 0, hmV3: 0 };
      const run = async (notes, key, scale, v1, v2) => {
        const lead = melody(sr, notes), an = await A.analyzePitch(lead), out = A.applyHarmonizer(lead, an, { ...base, hmKey: key, hmScale: scale, hmV1: v1, hmV2: v2 }, null);
        return { v1: await voiceNotes(A, lead, out, 0, notes.length), v2: await voiceNotes(A, lead, out, 1, notes.length), ch: out.numberOfChannels };
      };
      return { cmaj: await run([60, 64, 67], 0, 0, 6, 8), amin: await run([57, 60, 64], 9, 1, 6, 5) };   // C major: +3rd / +5th ;  A minor: +3rd / -3rd
    });
    const near = (got, want, what) => got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < .25, what + ' note ' + i + ': got midi ' + g.toFixed(2) + ', want ' + want[i]));
    assert.equal(r.cmaj.ch, 2);
    near(r.cmaj.v1, [64, 67, 71], 'C major +3rd (E G B)'); near(r.cmaj.v2, [67, 71, 74], 'C major +5th (G B D)');
    near(r.amin.v1, [60, 64, 67], 'A minor +3rd (C E G)'); near(r.amin.v2, [53, 57, 60], 'A minor -3rd (F A C)');
  });

  await check('harmonizer: octaves, pitch lock vs natural, and level', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, sr = A.ensureCtx().sampleRate, base = { hmKey: 0, hmScale: 0, hmLevel: -6, hmDelay: 0, hmSpread: 100, hmTone: 16000, hmDrift: 0, hmV3: 0 };
      const o = {};
      let lead = melody(sr, [60, 62]), an = await A.analyzePitch(lead), out = A.applyHarmonizer(lead, an, { ...base, hmLock: 100, hmV1: 10, hmV2: 1 }, null);
      o.oct = { up: await voiceNotes(A, lead, out, 0, 2), down: await voiceNotes(A, lead, out, 1, 2) };
      lead = melody(sr, [64.2, 64.2]); an = await A.analyzePitch(lead);                                    // E4, 20 cents sharp
      const g = async lock => (await voiceNotes(A, lead, A.applyHarmonizer(lead, an, { ...base, hmLock: lock, hmV1: 6, hmV2: 0 }, null), 0, 2))[0];
      o.locked = await g(100); o.natural = await g(0);
      const d = lead.getChannelData(0), out2 = A.applyHarmonizer(lead, an, { ...base, hmLock: 100, hmV1: 6, hmV2: 0 }, null), L = out2.getChannelData(0); let e1 = 0, e2 = 0;
      for (let i = sr; i < 2 * sr; i++) { e1 += d[i] * d[i]; e2 += (L[i] - d[i]) * (L[i] - d[i]); }
      o.gain = Math.sqrt(e2 / e1); return o;
    });
    assert.ok(Math.abs(r.oct.up[0] - 72) < .25 && Math.abs(r.oct.up[1] - 74) < .25, 'octave up ' + r.oct.up.map(x => x.toFixed(2)));
    assert.ok(Math.abs(r.oct.down[0] - 48) < .25 && Math.abs(r.oct.down[1] - 50) < .25, 'octave down ' + r.oct.down.map(x => x.toFixed(2)));
    assert.ok(Math.abs(r.locked - 67) < .15, 'pitch lock 100 puts the 3rd dead-on G4: ' + r.locked.toFixed(3));
    assert.ok(Math.abs(r.natural - 67.2) < .15, 'pitch lock 0 keeps the lead’s +20 cents: ' + r.natural.toFixed(3));
    assert.ok(Math.abs(r.gain - Math.pow(10, -6 / 20)) < .08, 'voice level ' + r.gain.toFixed(3));
  });

  await check('harmonizer runs in the pipeline with the doubler, shares its pitch analysis, and survives undo, save/load and split', async () => {
    const r = await page.evaluate(async () => {
      const A = window.__app, sr = A.ensureCtx().sampleRate; A.S.tracks.length = 0; A.S.master.drive = 0; A.resetHistory();
      const t = A.newTrack('Harm', melody(sr, [60, 64, 67, 64]), 0); A.commitHistory();
      const until = async f => { for (let i = 0; i < 300 && !f(); i++) await new Promise(r => setTimeout(r, 50)); return f(); };
      const o = {};
      Object.assign(t.fx, { hmOn: 1, hmV1: 0, hmV2: 0, hmV3: 0 }); A.markDirty(); await A.processTrack(t);
      o.allOff = t.buffer === t.orig && t.buffer.numberOfChannels === 1;                                    // no voices selected = untouched mono lead
      Object.assign(t.fx, { atOn: 1, atKey: 0, atScale: 1, atSpeed: 0, dbOn: 1, hmV1: 6, hmV2: 8 }); A.markDirty(); await A.processTrack(t);
      const an1 = t.dblPitch; o.both = t.buffer.numberOfChannels === 2 && t.buffer !== t.orig;
      t.fx.hmV3 = 10; await A.processTrack(t); o.cached = t.dblPitch === an1; A.commitHistory();
      A.undo(); o.undone = await until(() => t.fx.hmV3 === 0); A.redo(); o.redone = await until(() => t.fx.hmV3 === 10 && t.buffer.numberOfChannels === 2);
      const ab = await A.buildProjectBlob().arrayBuffer(); A.S.tracks.length = 0; await A.loadProjectBuffer(ab);
      const u = A.S.tracks[0]; o.loaded = [u.fx.hmOn, u.fx.hmV1, u.fx.hmV2, u.fx.hmV3, u.buffer.numberOfChannels];
      A.splitTrack(u, 2); o.split = await until(() => A.S.tracks.length === 2 && A.S.tracks.every(x => x.buffer !== x.orig && x.buffer.numberOfChannels === 2));
      let finite = true; for (const x of A.S.tracks) for (let c = 0; c < 2; c++) { const d = x.buffer.getChannelData(c); for (let i = 0; i < d.length; i += 97) if (!isFinite(d[i]) || Math.abs(d[i]) > 4) finite = false; }
      o.finite = finite; return o;
    });
    assert.ok(r.allOff, 'with every voice Off the lead is untouched'); assert.ok(r.both, 'doubler + harmonizer make a stereo clip'); assert.ok(r.cached, 'adding a voice reuses the cached analysis');
    assert.ok(r.undone && r.redone, 'undo / redo'); assert.deepEqual(r.loaded, [1, 6, 8, 10, 2]); assert.ok(r.split, 'both halves are harmonized'); assert.ok(r.finite, 'no NaN or runaway samples');
  });

  await check('no errors were logged during the whole run', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close(); server.close();
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
})();
