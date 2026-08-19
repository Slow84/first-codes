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

  // core wireframe geodesic sphere
  const coreGeo = new THREE.IcosahedronGeometry(1, 2);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.9 });
  const core = new THREE.Mesh(coreGeo, coreMat);
  group.add(core);

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

  let frame;
  function animate() {
    frame = requestAnimationFrame(animate);
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
