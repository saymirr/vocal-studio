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

  await check('no errors were logged during the whole run', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close(); server.close();
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
})();
