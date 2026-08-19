import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const container = document.getElementById('hero-orb');
if (container && window.WebGLRenderingContext) {
  const size = container.clientWidth || 280;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 60);
  camera.position.set(0, 0, 1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size);
  container.appendChild(renderer.domElement);

  // soft round sprite for bokeh dots, drawn once onto a canvas
  function makeSoftDot() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }
  const dotTexture = makeSoftDot();

  const PALETTE = [0x22d3ee, 0x67e8f9, 0x8b85f5, 0x4338ca, 0xf0a86a];
  function pickColor() {
    return new THREE.Color(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  }

  // ---- warp streaks: short line segments flying toward the camera ----
  const STREAK_COUNT = 140;
  const TUNNEL_RADIUS = 1.1;
  const FAR_Z = -18;
  const NEAR_Z = 0.6;
  const streakLen = 0.9;

  const streakPositions = new Float32Array(STREAK_COUNT * 2 * 3);
  const streakColors = new Float32Array(STREAK_COUNT * 2 * 3);
  const streakData = [];

  function resetStreak(i) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * TUNNEL_RADIUS;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    const z = FAR_Z - Math.random() * 10;
    const speed = 5 + Math.random() * 6;
    const color = pickColor();
    streakData[i] = { x, y, z, speed, color };
  }
  for (let i = 0; i < STREAK_COUNT; i++) resetStreak(i);

  function writeStreakBuffers() {
    for (let i = 0; i < STREAK_COUNT; i++) {
      const d = streakData[i];
      const i6 = i * 6;
      // tail (farther) -> head (closer)
      streakPositions[i6] = d.x;
      streakPositions[i6 + 1] = d.y;
      streakPositions[i6 + 2] = d.z - streakLen;
      streakPositions[i6 + 3] = d.x;
      streakPositions[i6 + 4] = d.y;
      streakPositions[i6 + 5] = d.z;

      const fade = Math.max(0, Math.min(1, (d.z - FAR_Z) / (NEAR_Z - FAR_Z)));
      const c = d.color;
      streakColors[i6] = c.r * fade;
      streakColors[i6 + 1] = c.g * fade;
      streakColors[i6 + 2] = c.b * fade;
      streakColors[i6 + 3] = c.r;
      streakColors[i6 + 4] = c.g;
      streakColors[i6 + 5] = c.b;
    }
  }
  writeStreakBuffers();

  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPositions, 3));
  streakGeo.setAttribute('color', new THREE.BufferAttribute(streakColors, 3));
  const streakMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
  const streaks = new THREE.LineSegments(streakGeo, streakMat);
  scene.add(streaks);

  // ---- soft drifting bokeh points scattered around the tunnel mouth ----
  const BOKEH_COUNT = 40;
  const bokehPos = new Float32Array(BOKEH_COUNT * 3);
  for (let i = 0; i < BOKEH_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 0.6 + Math.random() * 1.6;
    bokehPos[i * 3] = Math.cos(angle) * r;
    bokehPos[i * 3 + 1] = Math.sin(angle) * r;
    bokehPos[i * 3 + 2] = -1 - Math.random() * 6;
  }
  const bokehGeo = new THREE.BufferGeometry();
  bokehGeo.setAttribute('position', new THREE.BufferAttribute(bokehPos, 3));
  const bokehMat = new THREE.PointsMaterial({
    size: 0.18,
    map: dotTexture,
    color: 0x9fe8ff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const bokeh = new THREE.Points(bokehGeo, bokehMat);
  scene.add(bokeh);

  function onResize() {
    const s = container.clientWidth || 280;
    renderer.setSize(s, s);
  }
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  let frame;
  function animate() {
    frame = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsedTime();

    for (let i = 0; i < STREAK_COUNT; i++) {
      const d = streakData[i];
      d.z += d.speed * dt;
      if (d.z > NEAR_Z) resetStreak(i);
    }
    writeStreakBuffers();
    streakGeo.attributes.position.needsUpdate = true;
    streakGeo.attributes.color.needsUpdate = true;

    bokeh.rotation.z = t * 0.02;
    scene.rotation.z = Math.sin(t * 0.15) * 0.06;

    renderer.render(scene, camera);
  }
  animate();

  // pause rendering when the tab isn't visible, to save battery/CPU
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelAnimationFrame(frame);
    } else {
      clock.getDelta(); // drop the paused-time gap
      animate();
    }
  });
}
