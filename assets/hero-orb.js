import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const container = document.getElementById('hero-orb');
if (container && window.WebGLRenderingContext) {

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 3, 15);

  // camera is completely fixed for the whole animation — the composition
  // (where the vanishing point sits on screen) never changes
  const camera = new THREE.PerspectiveCamera(76, 1, 0.05, 40);
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

  // ---- static funnel silhouette, offset so the vanishing point sits in
  // the lower-right of frame (matches the reference photo) ----
  const funnelGroup = new THREE.Group();
  funnelGroup.position.set(3.1, -2.0, 0);
  scene.add(funnelGroup);

  const RINGS = 56;
  const SEGMENTS = 64;
  const DEPTH = 20;
  const R0 = 7.2;
  const POWER = 2.5;

  function radiusAt(t) {
    return Math.max(0.02, R0 * Math.pow(1 - t, POWER));
  }

  // build once at t=0..1, then each frame we re-derive (radius, y) per row
  // from a phase-shifted t — the ring silhouette (radius as a function of
  // y) never changes, only which physical ring sits at which depth, which
  // is what makes the rings appear to crawl inward and loop endlessly
  // while the overall static shape stays identical every frame.
  const positions = new Float32Array((RINGS + 1) * (SEGMENTS + 1) * 3);
  const rowT = new Float32Array(RINGS + 1);
  const colAngle = new Float32Array(SEGMENTS + 1);
  for (let j = 0; j <= RINGS; j++) rowT[j] = j / RINGS;
  for (let i = 0; i <= SEGMENTS; i++) colAngle[i] = (i / SEGMENTS) * Math.PI * 2;

  function writeFunnel(phase) {
    let p = 0;
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
      }
    }
  }
  writeFunnel(0);

  const funnelGeo = new THREE.BufferGeometry();
  funnelGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

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

  const funnelMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, fog: true });
  const funnel = new THREE.LineSegments(funnelGeo, funnelMat);
  funnelGroup.add(funnel);

  // ---- countless background stars, static ----
  const STAR_COUNT = 700;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 1 + Math.random() * 10;
    starPos[i * 3] = Math.cos(angle) * r;
    starPos[i * 3 + 1] = Math.sin(angle) * r;
    starPos[i * 3 + 2] = -Math.random() * DEPTH * 1.3;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.024, transparent: true, opacity: 0.75, fog: true });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

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
    phase = (phase + 0.018 * dt) % 1;
    writeFunnel(phase);
    funnelGeo.attributes.position.needsUpdate = true;

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
