// ============================================================
// Living ink for the hero background.
// A small GPU fluid simulation: ink is poured in along the 45°
// angle of the MT mark, sinks, branches into threads and fades into
// the paper. The pointer stirs it. No video, no images, no libraries.
//
// INK — the only values you should need to touch:
// ============================================================
const INK = {
  strength: 1.0,      // overall darkness of the ink (0.5 light … 1.5 heavy)
  behindText: 0.1,    // how much ink may show behind the text (0 … 1)
  every: 2.1,         // seconds between pours
  blueEvery: 3,       // one pour in this many is the accent blue
  fade: 0.115         // how fast ink dissolves (higher = cleaner paper)
};

function startInk(canvas, hero, content, options) {
  const still = options && options.still;
  const gl = canvas.getContext('webgl2', { alpha: false, depth: false, stencil: false, antialias: false, powerPreference: 'low-power' });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null; // plain paper, page is unaffected

  // ---------- Shaders ----------
  const VERT = `#version 300 es
  precision highp float; out vec2 uv;
  void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); uv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
  const HEAD = `#version 300 es
  precision highp float; precision highp sampler2D; in vec2 uv; out vec4 o;
  uniform vec2 px; uniform float dt; uniform float aspect;
  `;
  const SRC = {
    advect: `uniform sampler2D vel, src; uniform float fade;
      void main(){ vec2 c = uv - dt * texture(vel, uv).xy / vec2(aspect, 1.); o = texture(src, c) / (1. + fade * dt); }`,
    // A capsule-shaped brush, so fast pointer moves leave a stroke and not dots
    splat: `uniform sampler2D src; uniform vec2 a, b; uniform float r; uniform vec3 val;
      void main(){ vec2 s = vec2(aspect, 1.), p = uv * s, A = a * s, d = b * s - A;
        float t = clamp(dot(p - A, d) / max(dot(d, d), 1e-6), 0., 1.); vec2 q = p - A - d * t;
        o = texture(src, uv) + vec4(val * exp(-dot(q, q) / (r * r)), 0.); }`,
    curl: `uniform sampler2D vel;
      void main(){ float l = texture(vel, uv - vec2(px.x, 0.)).y, r = texture(vel, uv + vec2(px.x, 0.)).y,
        b = texture(vel, uv - vec2(0., px.y)).x, t = texture(vel, uv + vec2(0., px.y)).x; o = vec4(.5 * (r - l - t + b)); }`,
    forces: `uniform sampler2D vel, curlT; uniform sampler2D dye; uniform float time, swirl;
      void main(){ float l = abs(texture(curlT, uv - vec2(px.x, 0.)).x), r = abs(texture(curlT, uv + vec2(px.x, 0.)).x),
        b = abs(texture(curlT, uv - vec2(0., px.y)).x), t = abs(texture(curlT, uv + vec2(0., px.y)).x), c = texture(curlT, uv).x;
        vec2 g = vec2(t - b, l - r); g /= length(g) + 1e-4;
        vec2 p = uv * vec2(aspect, 1.);
        vec2 drift = vec2(sin(p.y * 4.1 + time * .21) + .6 * sin(p.y * 7.3 - time * .33 + 1.7),
                          sin(p.x * 3.7 - time * .18 + .6) + .6 * sin(p.x * 6.1 + time * .27));
        drift += .9 * vec2(sin(p.y * 17. + p.x * 5. + time * .5), sin(p.x * 15. - p.y * 6. - time * .43));
        // Ink is heavier than water: it sinks, leaning outward and away from the text
        vec2 k = texture(dye, uv).xy; float heavy = min(k.x + k.y, 1.6);
        vec2 down = vec2(.42 * smoothstep(-.25, .25, uv.x - .5) * 2. - .42, -1.);
        vec2 v = texture(vel, uv).xy + dt * (g * c * swirl + drift * .02 + down * heavy * .085);
        vec2 e = smoothstep(vec2(0.), vec2(.06), uv) * smoothstep(vec2(0.), vec2(.06), 1. - uv);
        o = vec4(v * e.x * e.y, 0., 1.); }`,
    div: `uniform sampler2D vel;
      void main(){ float l = texture(vel, uv - vec2(px.x, 0.)).x, r = texture(vel, uv + vec2(px.x, 0.)).x,
        b = texture(vel, uv - vec2(0., px.y)).y, t = texture(vel, uv + vec2(0., px.y)).y; o = vec4(.5 * (r - l + t - b)); }`,
    pressure: `uniform sampler2D p, d;
      void main(){ o = vec4((texture(p, uv - vec2(px.x, 0.)).x + texture(p, uv + vec2(px.x, 0.)).x + texture(p, uv - vec2(0., px.y)).x
        + texture(p, uv + vec2(0., px.y)).x - texture(d, uv).x) * .25); }`,
    project: `uniform sampler2D vel, p;
      void main(){ vec2 g = .5 * vec2(texture(p, uv + vec2(px.x, 0.)).x - texture(p, uv - vec2(px.x, 0.)).x,
        texture(p, uv + vec2(0., px.y)).x - texture(p, uv - vec2(0., px.y)).x); o = vec4(texture(vel, uv).xy - g, 0., 1.); }`,
    show: `uniform sampler2D dye; uniform vec4 box; uniform vec2 res; uniform float strength, behind, topPx, view;
      float h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main(){
        vec2 su = .5 + (uv - .5) * view, d = texture(dye, su).xy, s = vec2(aspect, 1.);
        // Pigment settles at the edge of a wash
        vec2 gx = texture(dye, su + vec2(px.x, 0.)).xy - texture(dye, su - vec2(px.x, 0.)).xy,
             gy = texture(dye, su + vec2(0., px.y)).xy - texture(dye, su - vec2(0., px.y)).xy;
        d += .3 * sqrt(gx * gx + gy * gy) * smoothstep(0., .25, d);
        // Quiet zone behind the text: rounded box measured from the page
        vec2 q = abs((uv - box.xy) * s) - box.zw * s; float sd = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
        float zone = mix(behind, 1., smoothstep(-.05, aspect > 1. ? .27 : .1, sd));
        float ends = smoothstep(0., aspect > 1. ? .2 : .13, uv.y) * mix(.12, 1., smoothstep(topPx, topPx + .14, 1. - uv.y));
        vec2 f = gl_FragCoord.xy;
        float grain = 1. + .22 * (n(f * .55) - .5) + .16 * (n(f * .11) - .5);
        d = max(d, 0.) * strength * zone * ends * grain;
        d = d / (1. + d * .3);
        vec3 paper = vec3(250., 249., 246.) / 255.;
        o = vec4(paper * exp(-(d.x * vec3(1.62, 1.6, 1.56) + d.y * vec3(1.25, .84, .66))), 1.);
        o.rgb += (h(f) - .5) / 255. * step(.002, d.x + d.y);
      }`
  };
  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  let P, quad;
  function buildPrograms() {
    const vs = shader(gl.VERTEX_SHADER, VERT); P = {};
    for (const k in SRC) {
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, HEAD + SRC[k])); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
      P[k] = { p, u };
    }
    quad = gl.createVertexArray(); gl.bindVertexArray(quad);
  }

  // ---------- Buffers ----------
  function target(w, h, internal, format) {
    const tex = gl.createTexture(), fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }
  const free = (t) => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); };
  const pair = (w, h, i, f) => ({ a: target(w, h, i, f), b: target(w, h, i, f), swap() { const t = this.a; this.a = this.b; this.b = t; } });

  let aspect = 1, vel, dye, prs, dvg, crl, quality = 1, box = [0.5, 0.5, 0.3, 0.3], topPx = 0.1;
  function use(name, out, uniforms) {
    const { p, u } = P[name]; gl.useProgram(p);
    const w = out ? out.w : canvas.width, h = out ? out.h : canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null); gl.viewport(0, 0, w, h);
    if (u.aspect) gl.uniform1f(u.aspect, aspect);
    let unit = 0;
    for (const k in uniforms) {
      const v = uniforms[k]; if (!u[k]) continue;
      if (v.tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.tex); gl.uniform1i(u[k], unit++); }
      else if (typeof v === 'number') gl.uniform1f(u[k], v);
      else gl['uniform' + v.length + 'f'](u[k], ...v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const texel = (t) => [1 / t.w, 1 / t.h];

  function measure() {
    const H = hero.getBoundingClientRect(), C = content.getBoundingClientRect();
    if (!H.width || !C.width) return;
    box = [(C.left + C.width / 2 - H.left) / H.width, 1 - (C.top + C.height / 2 - H.top) / H.height,
      Math.max(0.02, C.width / 2 / H.width - 0.02), Math.max(0.02, C.height / 2 / H.height - 0.03)];
    topPx = 84 / H.height;
  }
  function resize() {
    const w = hero.clientWidth, h = hero.clientHeight; if (!w || !h) return;
    measure();
    const scale = Math.min(devicePixelRatio || 1, 1.5) * (quality < 1 ? 0.7 : 1);
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const oldAspect = aspect; aspect = w / h;
    const changed = !dye || Math.abs(oldAspect - aspect) > 0.04;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    if (changed) allocate();
    draw();
  }
  function allocate() {
    const grid = (short) => aspect > 1 ? [Math.round(short * aspect), short] : [short, Math.round(short / aspect)];
    const small = Math.min(hero.clientWidth, hero.clientHeight) < 600;
    const [sw, sh] = grid(Math.round((small ? 112 : 176) * Math.sqrt(quality)));
    const [dw, dh] = grid(Math.round((small ? 400 : 720) * quality));
    if (dye) [vel.a, vel.b, dye.a, dye.b, prs.a, prs.b, dvg, crl].forEach(free);
    vel = pair(sw, sh, gl.RG16F, gl.RG); dye = pair(dw, dh, gl.RG16F, gl.RG); prs = pair(sw, sh, gl.R16F, gl.RED);
    dvg = target(sw, sh, gl.R16F, gl.RED); crl = target(sw, sh, gl.R16F, gl.RED);
  }

  // The simulated sheet is larger than the visible one, so its walls stay out of sight
  const VIEW = 0.84, toSheet = (v) => 0.5 + (v - 0.5) * VIEW;

  // ---------- Simulation ----------
  let time = 0, sinceDrop = 99, count = 0, drops = [];
  function splat(field, a, b, r, val) { use('splat', field.b, { src: field.a, a, b, r, val }); field.swap(); }

  // Poured in around the rim, along the diagonals of the mark
  const WIDE = [[0.1, 0.8, 1, -1], [0.89, 0.72, -1, -1], [0.17, 0.5, -1, -1], [0.82, 0.84, 1, -1], [0.05, 0.62, 1, -1], [0.95, 0.5, -1, -1], [0.22, 0.84, -1, -1]];
  const TALL = [[0.14, 0.87, 1, -1], [0.82, 0.25, -1, -1], [0.86, 0.88, -1, -1], [0.2, 0.22, 1, -1], [0.5, 0.2, 1, -1]];
  const rnd = (a, b) => a + Math.random() * (b - a);
  function newDrop() {
    const wide = aspect > 1, set = wide ? WIDE : TALL, s = set[count % set.length], bloom = count % 2 === 0;
    const blue = count % INK.blueEvery === INK.blueEvery - 1, parts = bloom ? 8 : 3;
    for (let i = 0; i < parts; i++) {
      const spread = bloom ? 0.085 : 0.03;
      drops.push({
        x: toSheet(s[0] + rnd(-spread, spread) / (wide ? aspect : 1)), y: toSheet(s[1] + rnd(-spread, spread)),
        dx: s[2] * rnd(bloom ? -0.7 : 0.5, 1.2), dy: s[3] * rnd(bloom ? -0.5 : 0.5, 1.2), age: -rnd(0, bloom ? 1.1 : 1),
        life: bloom ? rnd(0.7, 1.4) : rnd(2, 3.2), r: (bloom ? rnd(0.01, 0.027) : rnd(0.007, 0.012)) * (wide ? 1 : 0.62),
        rate: bloom ? 2.1 : 3.4, speed: bloom ? 0.04 : 0.075, kick: bloom ? 0.42 : 0.75, blue, a: rnd(0, 6), b: rnd(2, 4)
      });
    }
    count++;
  }
  function step(dt) {
    time += dt; sinceDrop += dt;
    if (sinceDrop > INK.every) { sinceDrop = 0; newDrop(); if (count === 1) { newDrop(); newDrop(); } }
    drops = drops.filter((d) => {
      d.age += dt; if (d.age < 0) return true;
      const k = Math.sin(Math.min(1, d.age / d.life) * Math.PI), bend = Math.sin(d.age * d.b + d.a) * 0.9;
      const vx = d.dx - d.dy * bend * 0.7, vy = d.dy + d.dx * bend * 0.7, x = d.x, y = d.y;
      d.x += vx * d.speed * dt / aspect; d.y += vy * d.speed * dt;
      splat(vel, [x, y], [d.x, d.y], d.r * 1.3, [vx * d.kick * k * dt, vy * d.kick * k * dt, 0]);
      const ink = d.rate * k * dt;
      splat(dye, [x, y], [d.x, d.y], d.r, d.blue ? [ink * 0.1, ink, 0] : [ink, ink * 0.08, 0]);
      return d.age < d.life;
    });
    if (stir) {
      const [a, b, v] = stir; stir = null;
      splat(vel, a, b, 0.06, [v[0], v[1], 0]);
      const m = Math.min(0.085, Math.hypot(v[0], v[1]) * 0.12);
      splat(dye, a, b, 0.022, [m, m * 0.5, 0]);
    }
    if (push) { splat(vel, [0.5, 0.5], [0.5, 0.5], 0.9, [0, push, 0]); push = 0; }

    const tx = texel(vel.a);
    use('curl', crl, { px: tx, vel: vel.a });
    use('forces', vel.b, { px: tx, dt, time, swirl: 4.5, vel: vel.a, curlT: crl, dye: dye.a }); vel.swap();
    use('div', dvg, { px: tx, vel: vel.a });
    for (let i = 0; i < 14; i++) { use('pressure', prs.b, { px: tx, p: prs.a, d: dvg }); prs.swap(); }
    use('project', vel.b, { px: tx, vel: vel.a, p: prs.a }); vel.swap();
    use('advect', vel.b, { dt, fade: 0.42, vel: vel.a, src: vel.a }); vel.swap();
    use('advect', dye.b, { dt, fade: INK.fade, vel: vel.a, src: dye.a }); dye.swap();
  }
  function draw() {
    if (!dye) return;
    use('show', null, { px: texel(dye.a), dye: dye.a, box, res: [canvas.width, canvas.height], strength: INK.strength, behind: INK.behindText * (aspect > 1 ? 1 : 1.5), topPx, view: VIEW });
  }

  // ---------- Pointer + scroll ----------
  let stir = null, push = 0, last = null, lastY = scrollY;
  hero.addEventListener('pointermove', (e) => {
    if (still) return;
    const r = hero.getBoundingClientRect(), p = [toSheet((e.clientX - r.left) / r.width), toSheet(1 - (e.clientY - r.top) / r.height)], now = performance.now();
    if (last && now - last.t < 120) {
      const lim = (v) => Math.max(-0.5, Math.min(0.5, v));
      const from = stir ? stir[0] : last.p, pv = stir ? stir[2] : [0, 0];
      stir = [from, p, [lim(pv[0] + (p[0] - last.p[0]) * aspect * 3.2), lim(pv[1] + (p[1] - last.p[1]) * 3.2)]];
    }
    last = { p, t: now };
  }, { passive: true });
  addEventListener('scroll', () => {
    push = Math.max(-0.06, Math.min(0.06, push + (scrollY - lastY) * 0.0005)); lastY = scrollY;
  }, { passive: true });

  // ---------- Loop: runs only while the hero is on screen ----------
  let raf = 0, prev = 0, visible = true, lost = false, slow = 0, frames = 0, dead = false;
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden || lost || dead) return;
    const ms = prev ? now - prev : 16; prev = now;
    if (!document.documentElement.classList.contains('case-study-locked')) {
      step(Math.min(ms / 1000, 1 / 30)); draw();
      // Weak graphics: lower the resolution, and as a last resort hold a still frame
      if (++frames > 20) { slow += (ms > 34 ? 1 : 0); }
      if (frames === 110) {
        if (slow > 55) {
          if (quality > 0.4) { quality *= 0.65; aspect = -1; resize(); } else if (count > 4) dead = true;
        }
        frames = 0; slow = 0;
      }
    }
    if (!dead) raf = requestAnimationFrame(frame);
  }
  function run() { if (!raf && !still && !dead) { prev = 0; raf = requestAnimationFrame(frame); } }

  function boot() {
    buildPrograms(); dye = null; aspect = -1; resize();
    for (let i = 0; i < (still ? 330 : 0); i++) step(1 / 60);
    draw(); run();
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; gl.getExtension('EXT_color_buffer_float'); boot(); });
  try { boot(); } catch (e) { console.warn('Ink background disabled:', e.message); return null; }

  new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) run(); }).observe(hero);
  document.addEventListener('visibilitychange', run);
  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => {
    const before = aspect; resize();
    if (still && Math.abs(before - aspect) > 0.04) { count = 0; sinceDrop = 99; drops = []; for (let i = 0; i < 330; i++) step(1 / 60); draw(); }
  }, 120); }).observe(hero);
  return { info: () => ({ count, quality, dead, time, dye: [dye.a.w, dye.a.h] }) };
}
