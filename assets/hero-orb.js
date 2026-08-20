import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const container = document.getElementById('hero-orb');
if (container && window.WebGLRenderingContext) {

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 3, 15);

  // camera is completely fixed for the whole animation — the composition
  // (where the vanishing point sits on screen) never changes, and it never
  // rotates (no lookAt tilt), which is what keeps the hole circular instead
  // of stretching into an ellipse. positioning is done purely by offsetting
  // the funnel geometry itself (funnelGroup below).
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 40);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  function fitRenderer() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ---- static funnel silhouette, offset so the vanishing point sits
  // slightly left-of-center and slightly above center (matches reference) ----
  const funnelGroup = new THREE.Group();
  funnelGroup.position.set(-2.4, 1.7, 0);
  scene.add(funnelGroup);

  const RINGS = 56;
  const SEGMENTS = 64;
  const DEPTH = 20;
  const R0 = 11;
  const POWER = 6;

  function radiusAt(t) {
    return Math.max(0.02, R0 * Math.pow(1 - t, POWER));
  }

  // build once at t=0..1, then each frame we re-derive (radius, y) per row
  // from a phase-shifted t — the ring silhouette (radius as a function of
  // y) never changes, only which physical ring sits at which depth, which
  // is what makes the rings appear to crawl inward and loop endlessly
  // while the overall static shape stays identical every frame.
  const positions = new Float32Array((RINGS + 1) * (SEGMENTS + 1) * 3);
  const colors = new Float32Array((RINGS + 1) * (SEGMENTS + 1) * 3);
  const rowT = new Float32Array(RINGS + 1);
  const colAngle = new Float32Array(SEGMENTS + 1);
  for (let j = 0; j <= RINGS; j++) rowT[j] = j / RINGS;
  for (let i = 0; i <= SEGMENTS; i++) colAngle[i] = (i / SEGMENTS) * Math.PI * 2;

  // rings loop from t=1 straight back to t=0 (mouth). fade each ring in
  // over its first bit of life so the reset reads as a soft appear rather
  // than a pop, and fade the deep/far rings out well before the vanishing
  // point so that area reads as clean darkness instead of a busy, jittery
  // cluster of tightly-packed lines.
  const FADE_IN = 0.1;
  const FADE_OUT_START = 0.36;
  const FADE_OUT_END = 0.46;
  function brightnessAt(t) {
    if (t < FADE_IN) return t / FADE_IN;
    if (t > FADE_OUT_END) return 0;
    if (t > FADE_OUT_START) return 1 - (t - FADE_OUT_START) / (FADE_OUT_END - FADE_OUT_START);
    return 1;
  }

  function writeFunnel(phase) {
    let p = 0, c = 0;
    for (let i = 0; i <= SEGMENTS; i++) {
      const angle = colAngle[i];
      const cos = Math.cos(angle), sin = Math.sin(angle);
      for (let j = 0; j <= RINGS; j++) {
        const t = (rowT[j] + phase) % 1;
        const radius = radiusAt(t);
        const y = t * DEPTH;
        positions[p++] = cos * radius;
        positions[p++] = sin * radius;
        positions[p++] = -y; // into the screen
        const b = brightnessAt(t);
        colors[c++] = b; colors[c++] = b; colors[c++] = b;
      }
    }
  }
  writeFunnel(0);

  const funnelGeo = new THREE.BufferGeometry();
  funnelGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  funnelGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // wireframe index: connect each vertex to its neighbor along the ring
  // (same segment) and along the segment (same ring) — this reproduces the
  // classic ring + spoke grid without needing a filled lathe surface.
  const indices = [];
  const stride = RINGS + 1;
  for (let i = 0; i <= SEGMENTS; i++) {
    for (let j = 0; j <= RINGS; j++) {
      const idx = i * stride + j;
      if (j < RINGS) indices.push(idx, idx + 1); // along a spoke (depth)
      if (i < SEGMENTS) indices.push(idx, idx + stride); // along a ring
    }
  }
  funnelGeo.setIndex(indices);

  const funnelMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, fog: true });
  const funnel = new THREE.LineSegments(funnelGeo, funnelMat);
  funnelGroup.add(funnel);

  // ---- dense star field that flows into the hole along with the funnel
  // rings, using the same phase-shifted-t trick: each star has a random
  // depth offset and drifts inward, shrinking toward the vanishing point
  // and fading in/out exactly like the rings, then loops. parented to
  // funnelGroup so it shares the exact same off-center placement. ----
  const STAR_COUNT = 1800;
  const STAR_R0 = 15;
  const STAR_POWER = 1.3;
  const STAR_DEPTH = DEPTH * 1.4;
  const starT0 = new Float32Array(STAR_COUNT);
  const starAngle = new Float32Array(STAR_COUNT);
  const starR0 = new Float32Array(STAR_COUNT);
  const starTwinkle = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    starT0[i] = Math.random();
    starAngle[i] = Math.random() * Math.PI * 2;
    starR0[i] = 0.4 + Math.random() * STAR_R0;
    starTwinkle[i] = 0.4 + Math.random() * 0.6;
  }
  const starPos = new Float32Array(STAR_COUNT * 3);
  const starColors = new Float32Array(STAR_COUNT * 3);

  function writeStars(phase) {
    for (let i = 0; i < STAR_COUNT; i++) {
      const t = (starT0[i] + phase) % 1; // same speed as the funnel rings
      const r = Math.max(0.05, starR0[i] * Math.pow(1 - t, STAR_POWER));
      const y = t * STAR_DEPTH;
      starPos[i * 3] = Math.cos(starAngle[i]) * r;
      starPos[i * 3 + 1] = Math.sin(starAngle[i]) * r;
      starPos[i * 3 + 2] = -y;
      const b = brightnessAt(Math.min(t, 0.99)) * starTwinkle[i];
      starColors[i * 3] = b; starColors[i * 3 + 1] = b; starColors[i * 3 + 2] = b;
    }
  }
  writeStars(0);

  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));

  // a soft round dot, like a single star in a long-exposure night-sky photo
  // — a bright pinpoint core fading into a gentle glow, no hard edges.
  // drawn with canvas instead of a photo so there's no licensing question
  // and nothing that can go missing later.
  function makeStarSprite() {
    const size = 32;
    const c = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.2, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  const starMat = new THREE.PointsMaterial({
    vertexColors: true, size: 0.075, map: makeStarSprite(),
    transparent: true, opacity: 0.9, depthWrite: false, fog: true
  });
  const stars = new THREE.Points(starGeo, starMat);
  funnelGroup.add(stars);

  fitRenderer();
  window.addEventListener('resize', fitRenderer);

  const clock = new THREE.Clock();
  let phase = 0;
  let frame;

  function animate() {
    frame = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    // slow, continuous inward flow — camera/composition never move, only
    // the rings crawl from the mouth toward the vanishing point and loop
    phase = (phase + 0.011 * dt) % 1;
    writeFunnel(phase);
    funnelGeo.attributes.position.needsUpdate = true;
    funnelGeo.attributes.color.needsUpdate = true;

    writeStars(phase);
    starGeo.attributes.position.needsUpdate = true;
    starGeo.attributes.color.needsUpdate = true;

    renderer.render(scene, camera);
  }
  animate();

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelAnimationFrame(frame);
    } else {
      clock.getDelta();
      animate();
    }
  });
}
