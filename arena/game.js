/* Arena: a small first-person duel game in plain WebGL. No libraries. */
(function () {
  'use strict';
  const DEBUG = /[?&]debug\b/.test(location.search);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const gameEl = $('game'), canvas = $('view');
  const ui = {
    hud: $('hud'), menu: $('menu'), pause: $('pause'), over: $('over'),
    sYou: $('sYou'), sBot: $('sBot'), roundLabel: $('roundLabel'),
    enemy: $('enemy'), enemyBar: $('enemyBar'), cross: $('cross'), hitmark: $('hitmark'),
    dmgnums: $('dmgnums'), indicator: $('indicator'), feed: $('feed'), banner: $('banner'),
    scope: $('scope'), hurt: $('hurt'), hpNum: $('hpNum'), hpBar: $('hpBar'),
    wName: $('wName'), ammoNum: $('ammoNum'), slots: $('slots'),
    overTitle: $('overTitle'), overScore: $('overScore'), overStats: $('overStats'),
  };

  const gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
  if (!gl) { $('nogl').hidden = false; ui.menu.hidden = true; return; }

  if (window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) {
    $('touchNote').hidden = false;
  }

  // ---------- settings ----------
  const settings = { primary: 'rifle', diff: 'normal', sens: 1, fov: 90, vol: 0.6 };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('arena.settings') || '{}')); } catch (e) { /* ignore */ }
  function saveSettings() { try { localStorage.setItem('arena.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  function bindRadio(name, key) {
    document.querySelectorAll('input[name="' + name + '"]').forEach((r) => {
      r.checked = r.value === settings[key];
      r.addEventListener('change', () => { if (r.checked) { settings[key] = r.value; saveSettings(); } });
    });
  }
  bindRadio('primary', 'primary');
  bindRadio('diff', 'diff');
  function bindSlider(id, key, fmt) {
    const el = $(id), out = $(id + 'Out');
    el.value = settings[key];
    out.textContent = fmt(+el.value);
    el.addEventListener('input', () => { settings[key] = +el.value; out.textContent = fmt(+el.value); saveSettings(); if (master) master.gain.value = settings.vol; });
  }
  bindSlider('sens', 'sens', (v) => v.toFixed(2));
  bindSlider('fov', 'fov', (v) => String(v));
  bindSlider('vol', 'vol', (v) => String(Math.round(v * 100)));

  // ---------- math ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  function ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function persp(fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = (2 * f * n) / (n - f);
    return m;
  }
  function trans(x, y, z) { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; }
  function scl(x, y, z) { const m = ident(); m[0] = x; m[5] = y; m[10] = z; return m; }
  function rotX(a) { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
  function rotY(a) { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
  function rotZ(a) { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
  function chain() { let m = arguments[0]; for (let i = 1; i < arguments.length; i++) m = mul(m, arguments[i]); return m; }
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  };
  function dirFrom(yaw, pitch) { const c = Math.cos(pitch); return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c]; }
  // A box from `a` to `b` with width w, as a model matrix for the unit cube.
  function beam(a, b, w) {
    const d = v3.sub(b, a), len = v3.len(d) || 1e-4, z = v3.scale(d, 1 / len);
    const up = Math.abs(z[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const x = v3.norm(v3.cross(up, z)), y = v3.cross(z, x);
    const c = v3.scale(v3.add(a, b), 0.5), m = new Float32Array(16);
    m[0] = x[0] * w; m[1] = x[1] * w; m[2] = x[2] * w;
    m[4] = y[0] * w; m[5] = y[1] * w; m[6] = y[2] * w;
    m[8] = z[0] * len; m[9] = z[1] * len; m[10] = z[2] * len;
    m[12] = c[0]; m[13] = c[1]; m[14] = c[2]; m[15] = 1;
    return m;
  }

  // ---------- renderer ----------
  const VS = 'attribute vec3 aPos;attribute vec3 aNor;attribute vec3 aCol;' +
    'uniform mat4 uVP;uniform mat4 uM;uniform vec3 uTint;' +
    'varying vec3 vCol;varying vec3 vNor;varying vec3 vW;' +
    'void main(){vec4 w=uM*vec4(aPos,1.0);vW=w.xyz;vNor=(uM*vec4(aNor,0.0)).xyz;vCol=aCol*uTint;gl_Position=uVP*w;}';
  const FS = 'precision mediump float;' +
    'uniform vec3 uCam;uniform vec3 uFog;uniform float uFogD;uniform float uEmit;uniform float uGrid;uniform float uAlpha;' +
    'varying vec3 vCol;varying vec3 vNor;varying vec3 vW;' +
    'void main(){vec3 n=normalize(vNor);vec3 L=normalize(vec3(0.42,0.85,0.32));' +
    'float d=max(dot(n,L),0.0);float h=0.5+0.5*n.y;vec3 c=vCol*(0.34+0.24*h+0.55*d);' +
    'if(uGrid>0.0){vec2 uv=abs(n.y)>0.5?vW.xz:(abs(n.x)>0.5?vW.zy:vW.xy);vec2 g=abs(fract(uv)-0.5);' +
    'float ln=smoothstep(0.465,0.5,max(g.x,g.y));c*=1.0-0.13*ln*uGrid;}' +
    'c=mix(c,vCol,uEmit);float dist=length(vW-uCam);float f=1.0-exp(-uFogD*dist);' +
    'gl_FragColor=vec4(mix(c,uFog,clamp(f,0.0,0.85)),uAlpha);}';

  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const A = { pos: gl.getAttribLocation(prog, 'aPos'), nor: gl.getAttribLocation(prog, 'aNor'), col: gl.getAttribLocation(prog, 'aCol') };
  const U = {};
  ['uVP', 'uM', 'uTint', 'uCam', 'uFog', 'uFogD', 'uEmit', 'uGrid', 'uAlpha'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });

  const FACES = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]]],
    [[0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  function pushBox(out, mn, mx, col) {
    for (const [n, q] of FACES) {
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const c = q[i];
        out.push(c[0] ? mx[0] : mn[0], c[1] ? mx[1] : mn[1], c[2] ? mx[2] : mn[2], n[0], n[1], n[2], col[0], col[1], col[2]);
      }
    }
  }
  function makeMesh(data) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return { buf, count: data.length / 9 };
  }
  function bindMesh(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
    gl.enableVertexAttribArray(A.pos); gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(A.nor); gl.vertexAttribPointer(A.nor, 3, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(A.col); gl.vertexAttribPointer(A.col, 3, gl.FLOAT, false, 36, 24);
  }
  const cubeData = []; pushBox(cubeData, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], [1, 1, 1]);
  const cube = makeMesh(cubeData);

  // ---------- map ----------
  // Boxes are [minX, minY, minZ, maxX, maxY, maxZ, colorName]. The map is the same
  // for both sides when turned 180 degrees, so neither spawn has an edge.
  const COL = {
    floor: [0.42, 0.46, 0.52], wall: [0.62, 0.65, 0.71], crate: [0.9, 0.58, 0.26],
    teal: [0.32, 0.66, 0.7], stone: [0.74, 0.74, 0.78], dark: [0.38, 0.41, 0.48], blue: [0.36, 0.5, 0.82], red: [0.82, 0.36, 0.34],
  };
  const solids = [];
  function box(a, b, c, d, e, f, col) { solids.push([a, b, c, d, e, f, col]); }
  function pair(a, b, c, d, e, f, col) { box(a, b, c, d, e, f, col); box(-d, b, -f, -a, e, -c, col); }
  box(-20, -1, -14, 20, 0, 14, 'floor');
  box(-21, 0, -15, -20, 6, 15, 'wall'); box(20, 0, -15, 21, 6, 15, 'wall');
  box(-21, 0, -15, 21, 6, -14, 'wall'); box(-21, 0, 14, 21, 6, 15, 'wall');
  // center tower with stairs on both sides
  box(-2, 0, -2, 2, 2, 2, 'teal');
  pair(4, 0, -1, 5, 0.5, 1, 'stone'); pair(3, 0, -1, 4, 1, 1, 'stone'); pair(2, 0, -1, 3, 1.5, 1, 'stone');
  // cover, mirrored
  pair(-9, 0, -7, -7, 1.2, -5, 'crate');
  pair(-13, 0, -4, -12, 3, 2, 'wall');
  pair(-5, 0, -10, -3, 2.6, -9.4, 'dark');
  pair(-17, 0, -11, -15, 1.2, -9, 'crate'); pair(-17, 1.2, -11, -16, 2.4, -10, 'crate');
  pair(5, 0, -6, 6, 3.5, -5, 'stone');
  pair(-8, 0, 1, -6, 1, 3, 'crate');
  pair(9, 0, -12, 11, 1.2, -11, 'crate');
  pair(14, 0, -6, 15, 2, -2, 'dark');
  pair(-3, 0, 6, 3, 0.9, 6.6, 'stone');
  const mapData = [];
  solids.forEach((b, i) => {
    const base = COL[b[6]], j = b[6] === 'floor' || b[6] === 'wall' ? 0 : (((i * 37) % 7) - 3) * 0.012;
    pushBox(mapData, [b[0], b[1], b[2]], [b[3], b[4], b[5]], [base[0] + j, base[1] + j, base[2] + j]);
  });
  pushBox(mapData, [-1.5, 0.001, 11], [1.5, 0.02, 13.4], COL.blue);
  pushBox(mapData, [-1.5, 0.001, -13.4], [1.5, 0.02, -11], COL.red);
  const mapMesh = makeMesh(mapData);

  // ---------- nav grid for the bot ----------
  const NX = 40, NZ = 28, OX = -20, OZ = -14;
  const blocked = new Uint8Array(NX * NZ);
  for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
    const cx = OX + i + 0.5, cz = OZ + k + 0.5;
    for (const b of solids) {
      if (b[4] <= 0.6 || b[1] >= 1.9) continue;
      if (cx + 0.75 > b[0] && cx - 0.75 < b[3] && cz + 0.75 > b[2] && cz - 0.75 < b[5]) { blocked[i * NZ + k] = 1; break; }
    }
  }
  const cellOf = (x, z) => [clamp(Math.floor(x - OX), 0, NX - 1), clamp(Math.floor(z - OZ), 0, NZ - 1)];
  const field = new Int16Array(NX * NZ);
  let fieldTarget = -1;
  function buildField(x, z) {
    let [ti, tk] = cellOf(x, z);
    if (blocked[ti * NZ + tk]) {
      let best = null, bd = 1e9;
      for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
        if (blocked[i * NZ + k]) continue;
        const d = (i - ti) ** 2 + (k - tk) ** 2;
        if (d < bd) { bd = d; best = [i, k]; }
      }
      [ti, tk] = best;
    }
    const id = ti * NZ + tk;
    if (id === fieldTarget) return;
    fieldTarget = id;
    field.fill(-1);
    field[id] = 0;
    const q = [id];
    for (let h = 0; h < q.length; h++) {
      const c = q[h], ci = (c / NZ) | 0, ck = c % NZ;
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nk = ck + dk;
        if (ni < 0 || nk < 0 || ni >= NX || nk >= NZ) continue;
        const n = ni * NZ + nk;
        if (blocked[n] || field[n] >= 0) continue;
        field[n] = field[c] + 1; q.push(n);
      }
    }
  }
  function navStep(x, z) {
    const [ci, ck] = cellOf(x, z);
    const here = field[ci * NZ + ck];
    let best = null, bv = here >= 0 ? here : 1e9;
    for (let di = -2; di <= 2; di++) for (let dk = -2; dk <= 2; dk++) {
      const ni = ci + di, nk = ck + dk;
      if (ni < 0 || nk < 0 || ni >= NX || nk >= NZ) continue;
      const v = field[ni * NZ + nk];
      if (v < 0) continue;
      // only step to cells we can reach in a straight line
      if (Math.abs(di) + Math.abs(dk) > 1 && !clearLine(ci, ck, ni, nk)) continue;
      if (v < bv) { bv = v; best = [OX + ni + 0.5, OZ + nk + 0.5]; }
    }
    return best;
  }
  function clearLine(ai, ak, bi, bk) {
    const n = Math.max(Math.abs(bi - ai), Math.abs(bk - ak)) * 2;
    for (let s = 1; s <= n; s++) {
      const i = Math.round(lerp(ai, bi, s / n)), k = Math.round(lerp(ak, bk, s / n));
      if (blocked[i * NZ + k]) return false;
    }
    return true;
  }

  // ---------- physics ----------
  const GRAV = 22, STEP = 0.55;
  function makeBody(x, z) { return { p: [x, 0, z], v: [0, 0, 0], half: 0.32, h: 1.75, onGround: true }; }
  function hits(e, x, y, z, b) {
    return x + e.half > b[0] && x - e.half < b[3] && y + e.h > b[1] && y < b[4] && z + e.half > b[2] && z - e.half < b[5];
  }
  function freeAt(e, x, y, z) { for (const b of solids) if (hits(e, x, y, z, b)) return false; return true; }
  function moveBody(e, dt) {
    const steps = Math.ceil(dt / (1 / 120));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (const ax of [0, 2]) {
        const d = e.v[ax] * h;
        if (!d) continue;
        e.p[ax] += d;
        for (const b of solids) {
          if (!hits(e, e.p[0], e.p[1], e.p[2], b)) continue;
          const rise = b[4] - e.p[1];
          if (e.onGround && rise > 0 && rise <= STEP && freeAt(e, e.p[0], b[4] + 0.001, e.p[2])) { e.p[1] = b[4] + 0.001; continue; }
          e.p[ax] = d > 0 ? b[ax] - e.half - 1e-4 : b[ax + 3] + e.half + 1e-4;
          e.v[ax] = 0;
        }
      }
      e.v[1] = Math.max(e.v[1] - GRAV * h, -40);
      e.p[1] += e.v[1] * h;
      e.onGround = false;
      for (const b of solids) {
        if (!hits(e, e.p[0], e.p[1], e.p[2], b)) continue;
        if (e.v[1] <= 0) { e.p[1] = b[4]; e.onGround = true; } else { e.p[1] = b[1] - e.h - 1e-4; }
        e.v[1] = 0;
      }
    }
  }
  function rayBox(o, d, b) {
    let tmin = 0, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < b[i] || o[i] > b[i + 3]) return Infinity; continue; }
      let t1 = (b[i] - o[i]) / d[i], t2 = (b[i + 3] - o[i]) / d[i];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
    return tmin;
  }
  function rayWorld(o, d, max) { let best = max; for (const b of solids) { const t = rayBox(o, d, b); if (t < best) best = t; } return best; }
  function lineClear(a, b) { const d = v3.sub(b, a), l = v3.len(d); return rayWorld(a, v3.scale(d, 1 / l), l) >= l - 0.05; }
  function hitboxes(e) {
    const x = e.body.p[0], y = e.body.p[1], z = e.body.p[2], h = e.body.h, w = 0.36;
    return [
      { b: [x - 0.21, y + h - 0.42, z - 0.21, x + 0.21, y + h + 0.02, z + 0.21], head: true },
      { b: [x - w, y, z - w, x + w, y + h - 0.42, z + w], head: false },
    ];
  }
  function rayActor(o, d, actor, max) {
    let best = { t: max, head: false };
    for (const hb of hitboxes(actor)) { const t = rayBox(o, d, hb.b); if (t < best.t) best = { t, head: hb.head }; }
    return best;
  }

  // ---------- audio ----------
  let ac = null, master = null, noise = null;
  function audio() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain(); master.gain.value = settings.vol; master.connect(ac.destination);
      noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const ch = noise.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function burst(freq, decay, vol, type) {
    const a = audio(); if (!a) return;
    const t = a.currentTime, src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noise; f.type = type || 'lowpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(f); f.connect(g); g.connect(master); src.start(t, Math.random() * 0.5); src.stop(t + decay + 0.05);
  }
  function tone(f0, f1, dur, vol, type) {
    const a = audio(); if (!a) return;
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  const SFX = {
    rifle: (v) => { burst(3200, 0.13, 0.5 * v); tone(160, 50, 0.08, 0.35 * v); },
    shotgun: (v) => { burst(1700, 0.32, 0.8 * v); tone(120, 35, 0.18, 0.6 * v); },
    sniper: (v) => { burst(2600, 0.5, 0.8 * v); tone(110, 30, 0.3, 0.7 * v); },
    pistol: (v) => { burst(3800, 0.1, 0.45 * v); tone(220, 70, 0.06, 0.3 * v); },
    knife: (v) => burst(2400, 0.14, 0.25 * v, 'bandpass'),
    hit: () => tone(1100, 900, 0.06, 0.18, 'square'),
    head: () => { tone(1800, 1700, 0.09, 0.2, 'triangle'); tone(2600, 2500, 0.12, 0.12); },
    kill: () => { tone(660, 660, 0.25, 0.18, 'triangle'); tone(990, 990, 0.3, 0.12, 'triangle'); },
    hurt: () => tone(140, 70, 0.15, 0.3, 'sawtooth'),
    boom: () => { burst(700, 1.0, 1.0); tone(80, 25, 0.6, 0.8); },
    click: () => tone(900, 600, 0.04, 0.1, 'square'),
    beep: (hi) => tone(hi ? 1320 : 660, hi ? 1320 : 660, hi ? 0.35 : 0.15, 0.15, 'triangle'),
    reload: () => { tone(500, 300, 0.05, 0.1, 'square'); setTimeout(() => tone(700, 500, 0.05, 0.1, 'square'), 180); },
  };

  // ---------- weapons ----------
  const W = {
    rifle: { name: 'Rifle', auto: true, rate: 0.095, dmg: 21, head: 1.6, mag: 30, reload: 1.9, spread: 0.011, move: 0.03, bloom: 0.0045, maxBloom: 0.03, pellets: 1, fall: [30, 70, 0.65], kick: 0.007, zoom: 0.78, adsSpread: 0.45, sfx: 'rifle' },
    shotgun: { name: 'Scattergun', auto: false, rate: 0.8, dmg: 12, head: 1.3, mag: 6, reload: 2.1, spread: 0.07, move: 0.012, bloom: 0, maxBloom: 0, pellets: 9, fall: [7, 20, 0.25], kick: 0.045, zoom: 0.88, adsSpread: 0.75, sfx: 'shotgun' },
    sniper: { name: 'Longshot', auto: false, rate: 1.3, dmg: 90, head: 2.4, mag: 5, reload: 2.5, spread: 0.07, move: 0.05, bloom: 0, maxBloom: 0, pellets: 1, fall: null, kick: 0.05, zoom: 0.3, adsSpread: 0, scope: true, sfx: 'sniper' },
    pistol: { name: 'Sidearm', auto: false, rate: 0.17, dmg: 25, head: 1.6, mag: 12, reload: 1.4, spread: 0.013, move: 0.02, bloom: 0.006, maxBloom: 0.02, pellets: 1, fall: [20, 50, 0.7], kick: 0.013, zoom: 0.85, adsSpread: 0.55, sfx: 'pistol' },
    knife: { name: 'Knife', melee: true, rate: 0.55, dmg: 55, range: 2.5, zoom: 1, sfx: 'knife' },
  };
  const DIFF = {
    easy: { react: 0.75, turn: 3.5, err: 0.13, settle: 0.6, dmg: 0.45, rate: 1.7, jump: 0.05 },
    normal: { react: 0.45, turn: 6, err: 0.085, settle: 0.45, dmg: 0.65, rate: 1.4, jump: 0.15 },
    hard: { react: 0.25, turn: 10, err: 0.045, settle: 0.35, dmg: 0.85, rate: 1.15, jump: 0.3 },
  };
  function falloff(w, dist) {
    if (!w.fall) return 1;
    const [a, b, min] = w.fall;
    return dist <= a ? 1 : dist >= b ? min : lerp(1, min, (dist - a) / (b - a));
  }

  // ---------- state ----------
  const S = {
    mode: 'menu', // menu | play | paused | over
    phase: 'countdown', phaseT: 0, round: 1, you: 0, bot: 0, swap: false,
    time: 0, stats: null,
  };
  const player = {
    body: makeBody(0, 12), yaw: 0, pitch: 0, hp: 100, eye: 1.6, crouch: false,
    slide: 0, slots: ['rifle', 'pistol', 'knife'], cur: 0, ammo: {}, cool: 0, reloadT: 0, switchT: 0,
    ads: 0, bloom: 0, kick: 0, punch: 0, swing: 0, nades: 1, bob: 0, flash: 0, wantFire: false, firedThisPress: false,
  };
  const bot = {
    body: makeBody(0, -12), yaw: Math.PI, aimYaw: Math.PI, aimPitch: 0, hp: 100, weapon: 'rifle', ammo: 30,
    cool: 0, reloadT: 0, seen: 0, sawT: 0, react: 0, strafe: 1, strafeT: 0, errV: [0, 0], errT: 0,
    stuckT: 0, lastP: [0, 0], detour: null, detourT: 0, flash: 0, dead: false, deathT: 0, hurtT: 0,
  };
  const fx = { tracers: [], parts: [], nades: [], blasts: [] };

  function resetRound() {
    const a = S.swap ? -12 : 12;
    player.body = makeBody(0, a); player.yaw = S.swap ? Math.PI : 0; player.pitch = 0;
    player.hp = 100; player.crouch = false; player.slide = 0; player.nades = 1; player.cool = 0;
    player.reloadT = 0; player.switchT = 0.3; player.ads = 0; player.bloom = 0; player.kick = 0; player.punch = 0;
    player.slots = [settings.primary, 'pistol', 'knife']; player.cur = 0;
    for (const k of player.slots) if (W[k].mag) player.ammo[k] = W[k].mag;
    bot.body = makeBody(0, -a); bot.yaw = bot.aimYaw = S.swap ? 0 : Math.PI; bot.aimPitch = 0;
    bot.hp = 100; bot.dead = false; bot.seen = 0; bot.react = 0; bot.cool = 0.5; bot.reloadT = 0; bot.detour = null;
    const picks = ['rifle', 'rifle', 'shotgun', 'sniper'];
    bot.weapon = picks[(S.round + (S.you * 3) + (S.bot * 5)) % picks.length];
    bot.ammo = W[bot.weapon].mag;
    fx.tracers.length = 0; fx.parts.length = 0; fx.nades.length = 0; fx.blasts.length = 0;
    fieldTarget = -1;
    S.phase = 'countdown'; S.phaseT = 3;
    ui.roundLabel.textContent = 'Round ' + S.round;
    banner('Round ' + S.round, 'Bot has the ' + W[bot.weapon].name);
    lastBeep = 4;
    updateHud();
  }
  function startMatch() {
    S.round = 1; S.you = 0; S.bot = 0; S.swap = false;
    S.stats = { shots: 0, hits: 0, heads: 0, dealt: 0, taken: 0 };
    ui.sYou.textContent = '0'; ui.sBot.textContent = '0';
    resetRound();
  }

  // ---------- input ----------
  const keys = {};
  let mouseDown = false;
  let locked = false, lockFailed = false;
  function lockPointer() {
    try {
      const r = canvas.requestPointerLock && canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => { lockFailed = true; });
    } catch (e) { lockFailed = true; }
    if (!canvas.requestPointerLock) lockFailed = true;
  }
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (locked) lockFailed = false;
    if (!locked && S.mode === 'play' && !lockFailed) setMode('paused');
  });
  document.addEventListener('mousemove', (e) => {
    if (S.mode !== 'play' || (!locked && !lockFailed)) return;
    const zoom = lerp(1, curW().zoom, player.ads);
    const k = 0.0022 * settings.sens * zoom;
    player.yaw -= e.movementX * k;
    player.pitch = clamp(player.pitch - e.movementY * k, -1.5, 1.5);
  });
  canvas.addEventListener('mousedown', (e) => {
    if (S.mode !== 'play') return;
    if (!locked && !lockFailed) { lockPointer(); return; }
    if (e.button === 0) { mouseDown = true; player.firedThisPress = false; }
    if (e.button === 2) keys.ads = true;
  });
  document.addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; if (e.button === 2) keys.ads = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    if (S.mode !== 'play') return;
    e.preventDefault();
    switchTo((player.cur + (e.deltaY > 0 ? 1 : 2)) % 3);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (S.mode !== 'play') return;
    const k = e.code;
    if (k === 'Escape' && !locked) { setMode('paused'); return; }
    keys[k] = true;
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'ShiftLeft', 'KeyG', 'KeyR'].includes(k)) e.preventDefault();
    if (k === 'Digit1') switchTo(0);
    if (k === 'Digit2') switchTo(1);
    if (k === 'Digit3') switchTo(2);
    if (k === 'KeyQ') switchTo(player.last != null ? player.last : 1);
    if (k === 'KeyR') startReload();
    if (k === 'KeyG') throwNade();
    if (k === 'KeyC' && !e.repeat) tryCrouch();
  });
  document.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseDown = false; });

  function setMode(m) {
    S.mode = m;
    ui.menu.hidden = m !== 'menu';
    ui.pause.hidden = m !== 'paused';
    ui.over.hidden = m !== 'over';
    ui.hud.hidden = m === 'menu';
    gameEl.classList.toggle('playing', m === 'play' || m === 'paused' || m === 'over');
    if (m !== 'play') { mouseDown = false; for (const k in keys) keys[k] = false; }
    if ((m === 'menu' || m === 'over') && document.pointerLockElement) document.exitPointerLock();
    resize();
  }
  $('playBtn').addEventListener('click', () => { audio(); setMode('play'); startMatch(); lockPointer(); });
  $('resumeBtn').addEventListener('click', () => { setMode('play'); lockPointer(); });
  $('quitBtn').addEventListener('click', () => setMode('menu'));
  $('againBtn').addEventListener('click', () => { setMode('play'); startMatch(); lockPointer(); });
  $('loadoutBtn').addEventListener('click', () => setMode('menu'));

  // ---------- player actions ----------
  const curW = () => W[player.slots[player.cur]];
  function switchTo(i) {
    if (i === player.cur || S.phase === 'roundEnd') return;
    player.last = player.cur;
    player.cur = i; player.switchT = 0.32; player.reloadT = 0; player.ads = Math.min(player.ads, 0.3);
    SFX.click(); updateHud();
  }
  function startReload() {
    const k = player.slots[player.cur], w = W[k];
    if (w.melee || player.reloadT > 0 || player.ammo[k] >= w.mag || player.switchT > 0) return;
    player.reloadT = w.reload; SFX.reload();
  }
  function tryCrouch() {
    const b = player.body, sp = Math.hypot(b.v[0], b.v[2]);
    if (b.onGround && sp > 6.8 && player.slide <= 0) {
      player.slide = 0.75;
      const f = v3.norm([b.v[0], 0, b.v[2]]);
      b.v[0] = f[0] * 11.5; b.v[2] = f[2] * 11.5;
    }
  }
  function throwNade() {
    if (S.phase !== 'live' || player.nades <= 0) return;
    player.nades--;
    const d = dirFrom(player.yaw, player.pitch + 0.12), b = player.body;
    const o = [b.p[0], b.p[1] + player.eye - 0.1, b.p[2]];
    fx.nades.push({ p: v3.add(o, v3.scale(d, 0.4)), v: v3.add(v3.scale(d, 17), [b.v[0] * 0.5, 2, b.v[2] * 0.5]), t: 1.6, spin: 0, owner: 'you' });
    SFX.knife(0.6); updateHud();
  }
  function camBasis() {
    const f = dirFrom(player.yaw, player.pitch), r = [Math.cos(player.yaw), 0, -Math.sin(player.yaw)];
    return { f, r, u: v3.cross(r, f) };
  }
  function eyePos(e, eye) { return [e.body.p[0], e.body.p[1] + eye, e.body.p[2]]; }
  function curSpread() {
    const w = curW(); if (w.melee) return 0;
    const b = player.body, sp = Math.hypot(b.v[0], b.v[2]);
    let s = w.spread + player.bloom + w.move * clamp(sp / 6, 0, 1) + (b.onGround ? 0 : 0.05);
    if (player.crouch && b.onGround) s *= 0.8;
    if (w.scope) return player.ads > 0.95 ? (sp > 2 ? 0.01 : 0) + (b.onGround ? 0 : 0.04) : s;
    return s * lerp(1, w.adsSpread, player.ads);
  }
  function fire() {
    const k = player.slots[player.cur], w = W[k];
    const eye = eyePos(player, player.eye), cb = camBasis();
    player.cool = w.rate;
    if (w.melee) {
      player.swing = 1; SFX.knife(1);
      if (!bot.dead) {
        const h = rayActor(eye, cb.f, bot, w.range);
        if (h.t < w.range && h.t < rayWorld(eye, cb.f, w.range)) damageBot(w.dmg * (h.head ? 1.2 : 1), h.head, eye);
      }
      return;
    }
    if (player.ammo[k] <= 0) { SFX.click(); startReload(); return; }
    player.ammo[k]--; S.stats.shots++;
    const spread = curSpread();
    SFX[w.sfx](1);
    player.flash = 0.05; player.kick = 1;
    player.pitch = clamp(player.pitch + w.kick * rand(0.7, 1.1), -1.5, 1.5);
    player.yaw += w.kick * rand(-0.35, 0.35);
    player.punch = Math.min(player.punch + w.kick * 2, 0.12);
    player.bloom = Math.min(player.bloom + w.bloom, w.maxBloom);
    const muzzle = v3.add(v3.add(eye, v3.scale(cb.r, 0.18)), v3.add(v3.scale(cb.u, -0.14), v3.scale(cb.f, 0.6)));
    let total = 0, head = false, any = false;
    for (let i = 0; i < w.pellets; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * spread;
      const d = v3.norm(v3.add(cb.f, v3.add(v3.scale(cb.r, Math.cos(a) * rr), v3.scale(cb.u, Math.sin(a) * rr))));
      const tw = rayWorld(eye, d, 200);
      const hb = bot.dead ? { t: Infinity } : rayActor(eye, d, bot, tw);
      const t = Math.min(tw, hb.t), end = v3.add(eye, v3.scale(d, t));
      if (hb.t < tw) {
        any = true; head = head || hb.head;
        total += w.dmg * (hb.head ? w.head : 1) * falloff(w, hb.t);
        spark(end, [1, 0.35, 0.3], 4);
      } else if (tw < 200) spark(end, [1, 0.85, 0.5], 3);
      if (i < 4) fx.tracers.push({ a: muzzle, b: end, t: 0.06 });
    }
    if (any) { S.stats.hits++; if (head) S.stats.heads++; damageBot(total, head, eye); }
    if (player.ammo[k] === 0) setTimeout(() => { if (player.slots[player.cur] === k) startReload(); }, 250);
    updateHud();
  }
  function damageBot(amount, head, from) {
    if (bot.dead || S.phase !== 'live') return;
    amount = Math.round(amount);
    bot.hp -= amount; S.stats.dealt += Math.min(amount, bot.hp + amount);
    bot.hurtT = 0.12; bot.seen = Math.max(bot.seen, 0.5);
    bot.react = Math.min(bot.react, 0.15);
    if (from) bot.lastKnown = [player.body.p[0], player.body.p[2]];
    dmgNumber(amount, head);
    const kill = bot.hp <= 0;
    hitmark(head, kill);
    if (kill) {
      SFX.kill(); bot.hp = 0; bot.dead = true; bot.deathT = 0;
      for (let i = 0; i < 18; i++) spark([bot.body.p[0], bot.body.p[1] + rand(0.3, 1.7), bot.body.p[2]], [0.85, 0.3, 0.3], 1, 6);
      feed('You eliminated the Bot' + (head ? ' (headshot)' : ''));
      endRound(true);
    } else (head ? SFX.head : SFX.hit)();
    updateHud();
  }
  function damagePlayer(amount, from) {
    if (S.phase !== 'live') return;
    amount = Math.round(amount);
    player.hp -= amount; S.stats.taken += amount;
    SFX.hurt();
    ui.hurt.classList.add('on'); setTimeout(() => ui.hurt.classList.remove('on'), 60);
    if (from) {
      const cb = camBasis(), rel = v3.sub(from, player.body.p);
      const ang = Math.atan2(v3.dot(rel, cb.r), rel[0] * -Math.sin(player.yaw) + rel[2] * -Math.cos(player.yaw));
      ui.indicator.style.transform = 'rotate(' + ang + 'rad)';
      ui.indicator.classList.add('on'); setTimeout(() => ui.indicator.classList.remove('on'), 80);
    }
    if (player.hp <= 0) { player.hp = 0; feed('The Bot eliminated you'); endRound(false); }
    updateHud();
  }

  // ---------- bot brain ----------
  function botFire(dist) {
    const w = W[bot.weapon], D = DIFF[settings.diff];
    bot.cool = w.rate * D.rate * rand(0.9, 1.2);
    if (bot.ammo <= 0) { bot.reloadT = w.reload; return; }
    bot.ammo--;
    const eye = eyePos(bot, 1.6), aim = dirFrom(bot.aimYaw, bot.aimPitch);
    const r = [Math.cos(bot.aimYaw), 0, -Math.sin(bot.aimYaw)], u = v3.cross(r, aim);
    const vol = clamp(1.2 - dist / 45, 0.25, 1);
    SFX[w.sfx](vol);
    bot.flash = 0.05;
    const spread = w.scope ? 0.004 : w.spread + (bot.weapon === 'rifle' ? 0.012 : 0);
    let total = 0, head = false;
    const muzzle = v3.add(eye, v3.add(v3.scale(r, 0.25), v3.add(v3.scale(aim, 0.7), [0, -0.25, 0])));
    for (let i = 0; i < w.pellets; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * spread;
      const d = v3.norm(v3.add(aim, v3.add(v3.scale(r, Math.cos(a) * rr), v3.scale(u, Math.sin(a) * rr))));
      const tw = rayWorld(eye, d, 200), hb = rayActor(eye, d, player, tw);
      const t = Math.min(tw, hb.t), end = v3.add(eye, v3.scale(d, t));
      if (hb.t < tw) { total += w.dmg * (hb.head ? w.head : 1) * falloff(w, hb.t); head = head || hb.head; }
      else if (tw < 200) spark(end, [1, 0.85, 0.5], 2);
      if (i < 3) fx.tracers.push({ a: muzzle, b: end, t: 0.07, bot: true });
    }
    if (total > 0) damagePlayer(total * D.dmg, bot.body.p);
    if (bot.ammo <= 0) bot.reloadT = w.reload;
  }
  function updateBot(dt) {
    if (bot.dead) { bot.deathT += dt; return; }
    const D = DIFF[settings.diff], w = W[bot.weapon], b = bot.body;
    const eye = eyePos(bot, 1.6);
    const pHead = [player.body.p[0], player.body.p[1] + player.body.h - 0.15, player.body.p[2]];
    const pChest = [player.body.p[0], player.body.p[1] + player.body.h * 0.6, player.body.p[2]];
    const canSee = S.phase === 'live' && (lineClear(eye, pChest) || lineClear(eye, pHead));
    const toP = v3.sub(player.body.p, b.p), dist = Math.hypot(toP[0], toP[2]);

    if (canSee) {
      if (bot.seen <= 0) {
        const facing = Math.abs(angDiff(bot.yaw, Math.atan2(-toP[0], -toP[2])));
        bot.react = D.react * (facing > 1.2 ? 1.8 : 1) * rand(0.85, 1.2);
        bot.sawT = 0;
      }
      bot.seen = 1.2; bot.sawT += dt;
      bot.lastKnown = [player.body.p[0], player.body.p[2]];
    } else bot.seen -= dt;

    // aim
    if (bot.seen > 0) {
      bot.errT -= dt;
      if (bot.errT <= 0) {
        const settle = Math.max(D.settle, 1 - bot.sawT * 0.6);
        const e = D.err * settle * (w.scope ? 0.6 : 1);
        bot.errV = [rand(-e, e), rand(-e, e) * 0.7]; bot.errT = rand(0.25, 0.45);
      }
      const target = (settings.diff === 'hard' && w.scope) || Math.random() < 0.002 ? pHead : pChest;
      const d = v3.sub(target, eye);
      const wantYaw = Math.atan2(-d[0], -d[2]) + bot.errV[0];
      const wantPitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) + bot.errV[1];
      const turn = D.turn * dt;
      bot.aimYaw += clamp(angDiff(bot.aimYaw, wantYaw), -turn, turn);
      bot.aimPitch += clamp(wantPitch - bot.aimPitch, -turn, turn);
      bot.yaw = bot.aimYaw;
    }

    // shoot
    bot.cool -= dt;
    if (bot.reloadT > 0) { bot.reloadT -= dt; if (bot.reloadT <= 0) bot.ammo = w.mag; }
    else if (canSee && bot.react <= 0 && bot.cool <= 0) {
      const d = v3.sub(pChest, eye), wantYaw = Math.atan2(-d[0], -d[2]);
      const off = Math.abs(angDiff(bot.aimYaw, wantYaw));
      const ok = w.fall && dist > w.fall[1] * 1.3 ? false : off < 0.12;
      if (ok) botFire(dist);
    }
    if (canSee) bot.react -= dt;

    // move
    let wish = [0, 0];
    if (S.phase === 'live') {
      const want = bot.weapon === 'shotgun' ? 4 : bot.weapon === 'sniper' ? 20 : 12;
      if (canSee) {
        bot.strafeT -= dt;
        if (bot.strafeT <= 0) { bot.strafe = Math.random() < 0.5 ? -1 : 1; bot.strafeT = rand(0.5, 1.4); }
        const fw = [toP[0] / (dist || 1), toP[2] / (dist || 1)], side = [-fw[1] * bot.strafe, fw[0] * bot.strafe];
        const push = dist > want + 3 ? 1 : dist < want - 3 ? -0.8 : 0;
        wish = [side[0] + fw[0] * push, side[1] + fw[1] * push];
        if (b.onGround && Math.random() < D.jump * dt * 2) b.v[1] = 7.2;
        if (dist > want + 3) {
          buildField(player.body.p[0], player.body.p[2]);
          const n = navStep(b.p[0], b.p[2]);
          if (n) { const d = [n[0] - b.p[0], n[1] - b.p[2]], l = Math.hypot(d[0], d[1]) || 1; wish = [d[0] / l + side[0] * 0.6, d[1] / l + side[1] * 0.6]; }
        }
      } else {
        const goal = bot.lastKnown && bot.seen > -3 ? bot.lastKnown : [player.body.p[0], player.body.p[2]];
        if (bot.detour && bot.detourT > 0) {
          bot.detourT -= dt;
          wish = [bot.detour[0] - b.p[0], bot.detour[1] - b.p[2]];
        } else {
          buildField(goal[0], goal[1]);
          const n = navStep(b.p[0], b.p[2]);
          wish = n ? [n[0] - b.p[0], n[1] - b.p[2]] : [goal[0] - b.p[0], goal[1] - b.p[2]];
        }
        const l = Math.hypot(wish[0], wish[1]);
        if (l > 0.01) { bot.yaw = Math.atan2(-wish[0], -wish[1]); bot.aimYaw += clamp(angDiff(bot.aimYaw, bot.yaw), -4 * dt, 4 * dt); bot.aimPitch *= 0.95; }
      }
      // unstick
      bot.stuckT += dt;
      if (bot.stuckT > 0.8) {
        const moved = Math.hypot(b.p[0] - bot.lastP[0], b.p[2] - bot.lastP[1]);
        if (moved < 0.6 && !canSee) { bot.detour = [rand(-17, 17), rand(-12, 12)]; bot.detourT = 1.2; }
        bot.stuckT = 0; bot.lastP = [b.p[0], b.p[2]];
      }
    }
    const l = Math.hypot(wish[0], wish[1]);
    const speed = canSee ? 5.2 : 6.4;
    const tv = l > 0.01 ? [wish[0] / l * speed, wish[1] / l * speed] : [0, 0];
    const acc = (b.onGround ? 40 : 8) * dt;
    b.v[0] += clamp(tv[0] - b.v[0], -acc, acc);
    b.v[2] += clamp(tv[1] - b.v[2], -acc, acc);
    moveBody(b, dt);
  }
  function angDiff(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

  // ---------- round flow ----------
  let lastBeep = 4;
  function endRound(won) {
    if (S.phase !== 'live') return;
    S.phase = 'roundEnd'; S.phaseT = 2.6;
    if (won) S.you++; else S.bot++;
    ui.sYou.textContent = S.you; ui.sBot.textContent = S.bot;
    const done = S.you >= 5 || S.bot >= 5;
    banner(won ? 'Round won' : 'Round lost', done ? '' : S.you + ' to ' + S.bot);
  }
  function updateFlow(dt) {
    S.phaseT -= dt;
    if (S.phase === 'countdown') {
      const n = Math.ceil(S.phaseT);
      if (n !== lastBeep && n <= 3 && n >= 1) { lastBeep = n; banner(String(n)); SFX.beep(false); }
      if (S.phaseT <= 0) { S.phase = 'live'; banner('Fight'); SFX.beep(true); setTimeout(() => { if (S.phase === 'live') banner(''); }, 700); }
    } else if (S.phase === 'roundEnd' && S.phaseT <= 0) {
      if (S.you >= 5 || S.bot >= 5) return finishMatch();
      S.round++; S.swap = !S.swap; resetRound();
    }
  }
  function finishMatch() {
    banner('');
    const won = S.you > S.bot, st = S.stats;
    ui.overTitle.textContent = won ? 'You win' : 'The bot wins';
    ui.overScore.textContent = S.you + ' to ' + S.bot;
    const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : 0;
    ui.overStats.innerHTML = '';
    [['Accuracy', acc + '%'], ['Headshot hits', st.heads], ['Damage dealt', st.dealt], ['Damage taken', st.taken], ['Bot level', settings.diff[0].toUpperCase() + settings.diff.slice(1)]]
      .forEach(([k, v]) => { const li = document.createElement('li'); li.textContent = k + ': ' + v; ui.overStats.appendChild(li); });
    setMode('over');
  }

  // ---------- player update ----------
  function updatePlayer(dt) {
    const b = player.body, w = curW(), frozen = S.phase === 'countdown';
    const f = [-Math.sin(player.yaw), -Math.cos(player.yaw)], r = [Math.cos(player.yaw), -Math.sin(player.yaw)];
    let mx = 0, mz = 0;
    if (keys.KeyW) { mx += f[0]; mz += f[1]; }
    if (keys.KeyS) { mx -= f[0]; mz -= f[1]; }
    if (keys.KeyD) { mx += r[0]; mz += r[1]; }
    if (keys.KeyA) { mx -= r[0]; mz -= r[1]; }
    const ml = Math.hypot(mx, mz);
    if (ml > 0) { mx /= ml; mz /= ml; }

    // crouch, with a headroom check before standing up
    const wantCrouch = !!keys.KeyC || player.slide > 0;
    if (wantCrouch && !player.crouch) { player.crouch = true; b.h = 1.25; }
    else if (!wantCrouch && player.crouch) {
      b.h = 1.75;
      if (freeAt(b, b.p[0], b.p[1], b.p[2])) player.crouch = false; else b.h = 1.25;
    }
    player.eye = lerp(player.eye, player.crouch ? 1.1 : 1.6, Math.min(1, dt * 14));

    const sprint = keys.ShiftLeft && keys.KeyW && !player.crouch && player.ads < 0.3;
    let speed = sprint ? 7.6 : 5.8;
    if (player.crouch) speed = 3.2;
    speed *= lerp(1, w.scope ? 0.45 : 0.7, player.ads);
    if (frozen) speed = 0;

    if (player.slide > 0) {
      player.slide -= dt;
      const fr = Math.max(0, 1 - dt * 2.2);
      b.v[0] *= fr; b.v[2] *= fr;
      b.v[0] += mx * 6 * dt; b.v[2] += mz * 6 * dt;
      if (Math.hypot(b.v[0], b.v[2]) < 4) player.slide = 0;
    } else {
      const acc = (b.onGround ? 60 : 14) * dt;
      b.v[0] += clamp(mx * speed - b.v[0], -acc, acc);
      b.v[2] += clamp(mz * speed - b.v[2], -acc, acc);
    }
    if (keys.Space && b.onGround && !frozen) { b.v[1] = 7.6; b.onGround = false; if (player.slide > 0) player.slide = 0.01; }
    moveBody(b, dt);

    // weapon timers
    player.cool -= dt;
    if (player.switchT > 0) player.switchT -= dt;
    if (player.reloadT > 0) {
      player.reloadT -= dt;
      if (player.reloadT <= 0) { const k = player.slots[player.cur]; player.ammo[k] = W[k].mag; updateHud(); }
    }
    const canAds = !w.melee && player.reloadT <= 0 && player.switchT <= 0 && !sprint;
    player.ads = clamp(player.ads + (keys.ads && canAds ? dt : -dt) / 0.14, 0, 1);
    player.bloom = Math.max(0, player.bloom - dt * 0.09);
    player.kick = Math.max(0, player.kick - dt * 9);
    player.punch = Math.max(0, player.punch - dt * 0.5);
    player.swing = Math.max(0, player.swing - dt * 3.5);
    player.flash -= dt;
    const sp = Math.hypot(b.v[0], b.v[2]);
    if (b.onGround) player.bob += dt * sp * 1.7;

    if (mouseDown && S.phase === 'live' && player.cool <= 0 && player.switchT <= 0 && player.reloadT <= 0) {
      if (w.auto || !player.firedThisPress) { player.firedThisPress = true; fire(); }
    }
  }

  // ---------- effects ----------
  function spark(p, col, n, power) {
    for (let i = 0; i < n; i++) {
      const pw = power || 3;
      fx.parts.push({ p: p.slice(), v: [rand(-pw, pw), rand(0.5, pw * 1.2), rand(-pw, pw)], t: rand(0.25, 0.5), col, s: rand(0.04, 0.08) });
    }
  }
  function updateFx(dt) {
    fx.tracers = fx.tracers.filter((t) => (t.t -= dt) > 0);
    fx.parts = fx.parts.filter((q) => {
      q.v[1] -= 14 * dt; q.p = v3.add(q.p, v3.scale(q.v, dt));
      if (q.p[1] < 0.03) { q.p[1] = 0.03; q.v[1] *= -0.3; q.v[0] *= 0.7; q.v[2] *= 0.7; }
      return (q.t -= dt) > 0;
    });
    fx.blasts = fx.blasts.filter((x) => (x.t -= dt) > 0);
    fx.nades = fx.nades.filter((n) => {
      n.t -= dt; n.spin += dt * 10;
      n.v[1] -= GRAV * dt;
      for (let ax = 0; ax < 3; ax++) {
        n.p[ax] += n.v[ax] * dt;
        for (const b of solids) {
          if (n.p[0] > b[0] - 0.08 && n.p[0] < b[3] + 0.08 && n.p[1] > b[1] - 0.08 && n.p[1] < b[4] + 0.08 && n.p[2] > b[2] - 0.08 && n.p[2] < b[5] + 0.08) {
            n.p[ax] -= n.v[ax] * dt; n.v[ax] *= -0.42;
            if (ax === 1) { n.v[0] *= 0.7; n.v[2] *= 0.7; }
            break;
          }
        }
      }
      if (n.t <= 0) { explode(n.p); return false; }
      return true;
    });
  }
  function explode(p) {
    SFX.boom();
    fx.blasts.push({ p, t: 0.35 });
    for (let i = 0; i < 26; i++) spark(p, [1, rand(0.4, 0.8), 0.2], 1, 8);
    const R = 5.5;
    for (const who of [bot, player]) {
      if (who === bot && bot.dead) continue;
      const c = [who.body.p[0], who.body.p[1] + 1, who.body.p[2]], d = v3.len(v3.sub(c, p));
      if (d > R || !lineClear(p, c)) continue;
      const dmg = 100 * (1 - d / R) + 10;
      const push = v3.scale(v3.norm(v3.sub(c, p)), 9 * (1 - d / R));
      who.body.v = v3.add(who.body.v, [push[0], push[1] + 3, push[2]]);
      if (who === bot) damageBot(dmg, false, null); else damagePlayer(dmg * 0.5, p);
    }
  }

  // ---------- HUD ----------
  function banner(text, sub) {
    ui.banner.classList.remove('on');
    ui.banner.textContent = text;
    if (sub) { const s = document.createElement('small'); s.textContent = sub; ui.banner.appendChild(s); }
    if (text) { void ui.banner.offsetWidth; ui.banner.classList.add('on'); }
  }
  function feed(text) {
    const s = document.createElement('span'); s.textContent = text; ui.feed.appendChild(s);
    setTimeout(() => s.remove(), 4000);
  }
  function hitmark(head, kill) {
    ui.hitmark.className = 'hitmark';
    void ui.hitmark.offsetWidth;
    ui.hitmark.className = 'hitmark on' + (head ? ' head' : '') + (kill ? ' kill' : '');
  }
  function dmgNumber(n, head) {
    const s = document.createElement('span');
    s.textContent = n; if (head) s.className = 'head';
    s.style.left = 'calc(50% + ' + rand(18, 46) + 'px)'; s.style.top = 'calc(50% - ' + rand(10, 40) + 'px)';
    ui.dmgnums.appendChild(s); setTimeout(() => s.remove(), 760);
  }
  function updateHud() {
    ui.hpNum.textContent = Math.max(0, Math.ceil(player.hp));
    ui.hpBar.style.width = Math.max(0, player.hp) + '%';
    ui.hpBar.classList.toggle('low', player.hp <= 35);
    const k = player.slots[player.cur], w = W[k];
    ui.wName.textContent = w.name + (player.reloadT > 0 ? ' (reloading)' : '');
    if (w.melee) { ui.ammoNum.textContent = '-'; ui.ammoNum.classList.remove('empty'); }
    else { ui.ammoNum.textContent = player.ammo[k]; ui.ammoNum.classList.toggle('empty', player.ammo[k] === 0); }
    ui.ammoNum.nextElementSibling.style.visibility = w.melee ? 'hidden' : 'visible';
    ui.slots.innerHTML = '';
    player.slots.forEach((s, i) => {
      const e = document.createElement('span'); e.textContent = (i + 1) + ' ' + W[s].name;
      if (i === player.cur) e.className = 'on';
      ui.slots.appendChild(e);
    });
    const g = document.createElement('span'); g.textContent = 'G Grenade'; if (player.nades <= 0) g.className = 'used';
    ui.slots.appendChild(g);
    ui.enemyBar.style.width = Math.max(0, bot.hp) + '%';
  }
  let hudReload = false;
  function frameHud() {
    const w = curW(), scoped = w.scope && player.ads > 0.92;
    ui.scope.hidden = !scoped;
    ui.cross.classList.toggle('hide', scoped || (!!w.scope && player.ads > 0.4));
    ui.cross.classList.toggle('dot', !!w.melee);
    const fovNow = (settings.fov * Math.PI) / 180 * lerp(1, w.zoom, player.ads);
    const px = (curSpread() / Math.tan(fovNow / 2)) * (canvas.clientHeight / 2);
    ui.cross.style.setProperty('--gap', (4 + px).toFixed(1) + 'px');
    const vis = S.phase === 'live' && !bot.dead && lineClear(eyePos(player, player.eye), [bot.body.p[0], bot.body.p[1] + 1.2, bot.body.p[2]]);
    ui.enemy.classList.toggle('show', vis || bot.hurtT > 0);
    const r = player.reloadT > 0;
    if (r !== hudReload) { hudReload = r; updateHud(); }
  }

  // ---------- drawing ----------
  let VP = ident(), camPos = [0, 0, 0];
  function setFrame(vp, cam, fogD) {
    gl.uniformMatrix4fv(U.uVP, false, vp);
    gl.uniform3fv(U.uCam, cam);
    gl.uniform1f(U.uFogD, fogD);
  }
  function drawCube(m, col, emit, alpha) {
    gl.uniformMatrix4fv(U.uM, false, m);
    gl.uniform3fv(U.uTint, col);
    gl.uniform1f(U.uEmit, emit || 0);
    gl.uniform1f(U.uAlpha, alpha == null ? 1 : alpha);
    gl.drawArrays(gl.TRIANGLES, 0, cube.count);
  }
  function part(base, x, y, z, sx, sy, sz, col, emit) { drawCube(chain(base, trans(x, y, z), scl(sx, sy, sz)), col, emit); }

  const GUN = {
    rifle: [[0, 0, -0.05, 0.06, 0.08, 0.5, 'g'], [0, 0.01, -0.42, 0.028, 0.028, 0.32, 'd'], [0, -0.1, -0.08, 0.04, 0.14, 0.07, 'd'], [0, -0.01, 0.26, 0.05, 0.09, 0.18, 'a'], [0, 0.06, -0.06, 0.03, 0.03, 0.14, 'd'], [0, -0.075, 0.09, 0.04, 0.1, 0.05, 'd']],
    shotgun: [[0, 0, -0.02, 0.075, 0.085, 0.42, 'a'], [0, 0.015, -0.42, 0.05, 0.05, 0.42, 'd'], [0, -0.035, -0.34, 0.06, 0.05, 0.18, 'g'], [0, -0.02, 0.26, 0.06, 0.1, 0.2, 'g'], [0, -0.075, 0.1, 0.04, 0.1, 0.05, 'd']],
    sniper: [[0, 0, 0, 0.055, 0.075, 0.55, 'a'], [0, 0.01, -0.55, 0.026, 0.026, 0.55, 'd'], [0, 0.085, -0.03, 0.045, 0.045, 0.3, 'd'], [0, -0.02, 0.32, 0.055, 0.1, 0.2, 'g'], [0, -0.08, 0.12, 0.04, 0.1, 0.05, 'd']],
    pistol: [[0, 0, -0.06, 0.045, 0.06, 0.22, 'g'], [0, -0.08, 0.02, 0.04, 0.13, 0.06, 'd'], [0, 0.005, -0.19, 0.022, 0.022, 0.06, 'd']],
    knife: [[0, 0, 0.02, 0.035, 0.035, 0.12, 'd'], [0, 0.01, -0.14, 0.008, 0.05, 0.22, 's'], [0, 0, -0.045, 0.06, 0.05, 0.015, 'g']],
  };
  const GUNCOL = { g: [0.22, 0.24, 0.28], d: [0.12, 0.13, 0.15], a: [0.95, 0.6, 0.22], s: [0.85, 0.88, 0.92] };
  const ADSY = { rifle: -0.085, shotgun: -0.068, sniper: -0.12, pistol: -0.045 };
  const MUZZLE = { rifle: -0.6, shotgun: -0.65, sniper: -0.85, pistol: -0.24 };

  function drawBot() {
    const b = bot.body;
    let base = chain(trans(b.p[0], b.p[1], b.p[2]), rotY(bot.yaw));
    if (bot.dead) {
      const k = Math.min(1, bot.deathT * 3);
      base = chain(base, rotX(-k * 1.45));
      if (bot.deathT > 2) return;
    }
    const hurt = bot.hurtT > 0 ? 1 : 0;
    const shirt = hurt ? [1, 1, 1] : [0.86, 0.26, 0.26], pants = [0.24, 0.26, 0.33], skin = [0.93, 0.79, 0.62];
    const sp = Math.hypot(b.v[0], b.v[2]), sw = Math.sin(S.time * 11) * Math.min(1, sp / 5) * 0.6;
    drawCube(chain(base, trans(-0.13, 0.82, 0), rotX(sw), trans(0, -0.41, 0), scl(0.22, 0.82, 0.26)), pants, hurt);
    drawCube(chain(base, trans(0.13, 0.82, 0), rotX(-sw), trans(0, -0.41, 0), scl(0.22, 0.82, 0.26)), pants, hurt);
    part(base, 0, 1.12, 0, 0.56, 0.62, 0.3, shirt, hurt);
    part(base, 0, 1.6, 0, 0.36, 0.36, 0.36, skin, hurt);
    part(base, 0, 1.63, -0.185, 0.3, 0.09, 0.02, [0.1, 0.1, 0.12], 0);
    const arm = chain(base, trans(0.36, 1.36, 0), rotX(bot.aimPitch + Math.PI / 2));
    drawCube(chain(arm, trans(0, -0.28, 0), scl(0.16, 0.56, 0.18)), shirt, hurt);
    drawCube(chain(base, trans(-0.36, 1.36, 0), rotX(bot.aimPitch + Math.PI / 2.4), trans(0, -0.26, 0), scl(0.16, 0.52, 0.18)), shirt, hurt);
    const gun = chain(base, trans(0.22, 1.38, 0), rotX(bot.aimPitch), trans(0, -0.02, -0.45));
    for (const g of GUN[bot.weapon] || GUN.rifle) part(gun, g[0], g[1], g[2], g[3] * 1.4, g[4] * 1.4, g[5] * 1.4, GUNCOL[g[6]], 0);
    if (bot.flash > 0) part(gun, 0, 0.01, (MUZZLE[bot.weapon] || -0.6) * 1.4, 0.14, 0.14, 0.14, [1, 0.85, 0.4], 1);
  }

  function drawViewmodel(dt) {
    const k = player.slots[player.cur], w = W[k];
    if (w.scope && player.ads > 0.92) return;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const asp = canvas.width / canvas.height;
    setFrame(persp(1.05, asp, 0.01, 10), [0, 0, 0], 0);
    const ads = player.ads, sp = Math.hypot(player.body.v[0], player.body.v[2]);
    const bobA = player.body.onGround ? Math.min(1, sp / 6) * (1 - ads * 0.8) : 0;
    let x = lerp(0.19, 0, ads) + Math.sin(player.bob) * 0.012 * bobA;
    let y = lerp(-0.2, ADSY[k] || -0.1, ads) - Math.abs(Math.cos(player.bob)) * 0.012 * bobA;
    let z = lerp(-0.62, -0.5, ads) + player.kick * 0.05;
    let rx = player.kick * 0.12, ry = 0, rz = 0;
    if (player.switchT > 0) { const s = player.switchT / 0.32; y -= s * 0.3; rx -= s * 0.6; }
    if (player.reloadT > 0) { const p = 1 - player.reloadT / w.reload, s = Math.sin(Math.PI * p); y -= s * 0.12; rx -= s * 0.5; rz = s * 0.5; }
    if (w.melee) { const s = player.swing; x += 0.02; ry = 0.4 - s * 1.4; rx = -0.3 + s * 0.4; z -= s * 0.18; rz = 0.4 - s * 0.6; }
    if (player.slide > 0) rz += 0.25;
    const base = chain(trans(x, y, z), rotX(rx), rotY(ry), rotZ(rz), scl(0.85, 0.85, 0.85));
    // a glove under the grip
    if (!w.melee) part(base, 0.005, -0.12, 0.08, 0.075, 0.09, 0.1, [0.16, 0.18, 0.22], 0);
    for (const g of GUN[k]) part(base, g[0], g[1], g[2], g[3], g[4], g[5], GUNCOL[g[6]], 0);
    if (player.flash > 0 && MUZZLE[k]) part(base, 0, 0.01, MUZZLE[k], 0.09, 0.09, 0.09, [1, 0.88, 0.45], 1);
    void dt;
  }

  function render(dt) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.62, 0.74, 0.86, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.uniform3fv(U.uFog, [0.62, 0.74, 0.86]);

    const w = curW(), b = player.body;
    const fov = (settings.fov * Math.PI) / 180 * lerp(1, w.zoom, player.ads);
    let cam, yaw, pitch;
    if (S.mode === 'menu') {
      const t = S.time * 0.12;
      cam = [Math.sin(t) * 16, 7, Math.cos(t) * 16]; yaw = t; pitch = -0.38;
    } else {
      cam = [b.p[0], b.p[1] + player.eye, b.p[2]]; yaw = player.yaw; pitch = player.pitch + player.punch;
      if (player.slide > 0) cam[1] -= 0.1;
    }
    camPos = cam;
    const proj = persp(fov, canvas.width / canvas.height, 0.05, 200);
    VP = chain(proj, rotX(-pitch), rotY(-yaw), trans(-cam[0], -cam[1], -cam[2]));
    setFrame(VP, camPos, 0.006);

    bindMesh(mapMesh);
    gl.uniformMatrix4fv(U.uM, false, ident());
    gl.uniform3fv(U.uTint, [1, 1, 1]); gl.uniform1f(U.uEmit, 0); gl.uniform1f(U.uGrid, 1); gl.uniform1f(U.uAlpha, 1);
    gl.drawArrays(gl.TRIANGLES, 0, mapMesh.count);

    bindMesh(cube);
    gl.uniform1f(U.uGrid, 0);
    drawBot();
    for (const n of fx.nades) drawCube(chain(trans(n.p[0], n.p[1], n.p[2]), rotY(n.spin), rotX(n.spin * 0.7), scl(0.16, 0.16, 0.16)), [0.3, 0.55, 0.25], 0.2);
    for (const q of fx.parts) drawCube(chain(trans(q.p[0], q.p[1], q.p[2]), scl(q.s, q.s, q.s)), q.col, 0.7);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const t of fx.tracers) drawCube(beam(t.a, t.b, 0.025), t.bot ? [1, 0.55, 0.45] : [1, 0.92, 0.6], 1, Math.min(1, t.t / 0.05) * 0.8);
    for (const x of fx.blasts) {
      const s = (1 - x.t / 0.35) * 7 + 1;
      drawCube(chain(trans(x.p[0], x.p[1], x.p[2]), scl(s, s, s)), [1, 0.7, 0.3], 1, (x.t / 0.35) * 0.55);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    if (S.mode !== 'menu') drawViewmodel(dt);
  }

  // ---------- loop ----------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  window.addEventListener('resize', resize);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    resize();
    S.time += dt;
    if (S.mode === 'play') {
      updateFlow(dt);
      if (S.mode === 'play') {
        updatePlayer(dt);
        updateBot(dt);
        updateFx(dt);
        bot.flash -= dt; bot.hurtT -= dt;
        frameHud();
      }
    } else if (S.mode === 'menu') {
      bot.flash = 0;
    }
    render(dt);
    requestAnimationFrame(frame);
  }
  // A bot stands in the middle of the menu scene.
  bot.body = makeBody(0, 0); bot.body.p[1] = 2; bot.yaw = 0.6;
  updateHud();
  requestAnimationFrame(frame);

  // Test hook, only with ?debug in the URL.
  if (DEBUG) {
    window.__arena = { S, player, bot, keys, setMode, startMatch, fire, setMouse: (v) => { mouseDown = v; player.firedThisPress = false; }, settings, solids, lockless: () => { locked = true; } };
  }
})();
