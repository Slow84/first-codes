import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const container = document.getElementById('hero-orb');
if (container && window.WebGLRenderingContext) {

  const scene = new THREE.Scene();

  // orthographic camera: unlike a perspective camera, it never stretches a
  // circle into an oval just because it isn't at the center of frame — a
  // circle stays a circle no matter where we place it. this is what keeps
  // the warped hole perfectly round even when off-center.
  const VIEW_HEIGHT = 12;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 40);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  let halfW = 8, halfH = 6;
  function fitRenderer() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    halfH = VIEW_HEIGHT / 2;
    halfW = halfH * (w / h);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }

  // ---- flat grid, warped around a focus point like a black hole lensing
  // the space around it — lines outside the "horizon" bend and compress as
  // they approach it, lines far away stay almost straight ----
  const EXTENT = 18;          // half-size of the grid before warping
  const LINE_SPACING = 0.85;  // gap between grid lines
  const SEGMENTS = 60;        // samples per line, for a smooth bend
  const HORIZON = 1.0;        // radius of the empty void at the center
  const WARP_ZONE = 2.6;      // how wide the bending zone around the void is
  const SWIRL = 1.4;          // extra spiral twist right at the void's edge

  function warp(x, y) {
    const r = Math.hypot(x, y);
    if (r < HORIZON) return null; // inside the void — don't draw
    const d = r - HORIZON;
    const factor = d / (d + WARP_ZONE); // 0 at the horizon, ->1 far away
    const rp = HORIZON + d * factor;
    const twist = SWIRL * (1 - factor);
    const theta = Math.atan2(y, x) + twist;
    return [Math.cos(theta) * rp, Math.sin(theta) * rp];
  }

  const positions = [];
  const lineCount = Math.floor((EXTENT * 2) / LINE_SPACING);

  function addLine(fixed, axis) {
    // axis 'h' = horizontal line (y fixed, x varies), 'v' = vertical line (x fixed, y varies)
    let prev = null;
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * (EXTENT * 2) - EXTENT;
      const x = axis === 'h' ? t : fixed;
      const y = axis === 'h' ? fixed : t;
      const w = warp(x, y);
      if (!w) { prev = null; continue; }
      if (prev) positions.push(prev[0], prev[1], 0, w[0], w[1], 0);
      prev = w;
    }
  }

  for (let i = 0; i <= lineCount; i++) {
    const pos = i * LINE_SPACING - EXTENT;
    addLine(pos, 'h');
    addLine(pos, 'v');
  }

  const lensGeo = new THREE.BufferGeometry();
  lensGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const lensMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
  const lensLines = new THREE.LineSegments(lensGeo, lensMat);

  // group is centered on the focus point in local space, then placed so
  // that focus lands slightly left-of-center and slightly above center on
  // screen. rotating this group spins the warped grid like an accretion
  // disk without ever recomputing vertices (no per-frame reset = no pop).
  const lensGroup = new THREE.Group();
  lensGroup.add(lensLines);
  lensGroup.position.set(-1.6, 1.3, 0);
  scene.add(lensGroup);

  // ---- countless background stars, static ----
  const STAR_COUNT = 700;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    starPos[i * 3] = (Math.random() * 2 - 1) * 16;
    starPos[i * 3 + 1] = (Math.random() * 2 - 1) * 10;
    starPos[i * 3 + 2] = -Math.random() * 5;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.03, transparent: true, opacity: 0.7 });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  fitRenderer();
  window.addEventListener('resize', fitRenderer);

  const clock = new THREE.Clock();
  let frame;

  function animate() {
    frame = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    lensLines.rotation.z += 0.045 * dt; // slow, continuous spin — never resets
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
