import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const container = document.getElementById('hero-orb');
if (container && window.WebGLRenderingContext) {
  const size = container.clientWidth || 280;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 3.4;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size);
  container.appendChild(renderer.domElement);

  const group = new THREE.Group();
  scene.add(group);

  // core wireframe geodesic sphere — vertices get pushed outward in
  // localized "spikes" that pulse in and out, like something alive
  const coreGeo = new THREE.IcosahedronGeometry(1, 3);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.9 });
  const core = new THREE.Mesh(coreGeo, coreMat);
  group.add(core);

  const corePos = coreGeo.attributes.position;
  const baseCore = corePos.array.slice();
  const vertexCount = corePos.count;
  const vertexDirs = [];
  for (let i = 0; i < vertexCount; i++) {
    const x = baseCore[i * 3], y = baseCore[i * 3 + 1], z = baseCore[i * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    vertexDirs.push([x / len, y / len, z / len]);
  }

  // a few independent "spike" directions, each pulsing on its own timer
  const spikes = [
    { dir: [0.8, 0.5, 0.33], speed: 0.9, phase: 0, sharpness: 10, amp: 0.55 },
    { dir: [-0.6, -0.2, 0.77], speed: 0.7, phase: 2.1, sharpness: 14, amp: 0.4 },
    { dir: [0.1, -0.9, -0.4], speed: 1.1, phase: 4.2, sharpness: 12, amp: 0.45 }
  ].map(s => {
    const len = Math.hypot(s.dir[0], s.dir[1], s.dir[2]);
    s.dir = [s.dir[0] / len, s.dir[1] / len, s.dir[2] / len];
    return s;
  });

  function updateSpikes(t) {
    for (let i = 0; i < vertexCount; i++) {
      const [dx, dy, dz] = vertexDirs[i];
      let push = 0;
      for (const s of spikes) {
        const dot = dx * s.dir[0] + dy * s.dir[1] + dz * s.dir[2];
        const lobe = Math.max(0, dot) ** s.sharpness;
        const pulse = Math.max(0, Math.sin(t * s.speed + s.phase));
        push += lobe * pulse * s.amp;
      }
      const scale = 1 + push;
      corePos.array[i * 3] = baseCore[i * 3] * scale;
      corePos.array[i * 3 + 1] = baseCore[i * 3 + 1] * scale;
      corePos.array[i * 3 + 2] = baseCore[i * 3 + 2] * scale;
    }
    corePos.needsUpdate = true;
  }

  // faint outer shell, slightly larger, rotates opposite direction
  const outerGeo = new THREE.IcosahedronGeometry(1.35, 1);
  const outerMat = new THREE.MeshBasicMaterial({ color: 0x4338ca, wireframe: true, transparent: true, opacity: 0.35 });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  group.add(outer);

  // scattered point cloud on a third shell for a "particle" feel
  const dotGeo = new THREE.IcosahedronGeometry(1.15, 4);
  const dotMat = new THREE.PointsMaterial({ color: 0x67e8f9, size: 0.02, transparent: true, opacity: 0.9 });
  const dots = new THREE.Points(dotGeo, dotMat);
  group.add(dots);

  function onResize() {
    const s = container.clientWidth || 280;
    renderer.setSize(s, s);
  }
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  let frame;
  function animate() {
    frame = requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    updateSpikes(t);
    core.rotation.y += 0.006;
    core.rotation.x += 0.002;
    outer.rotation.y -= 0.003;
    outer.rotation.x -= 0.0012;
    dots.rotation.y += 0.004;
    renderer.render(scene, camera);
  }
  animate();

  // pause rendering when the tab isn't visible, to save battery/CPU
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelAnimationFrame(frame);
    } else {
      animate();
    }
  });
}
