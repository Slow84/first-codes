import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const container = document.getElementById('hero-orb');
if (container && window.WebGLRenderingContext) {

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 2, 13);

  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 40);
  camera.position.set(0, 0, 0);

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

  // ---- funnel: a revolved profile, rendered as wireframe so it reads
  // as a ring+spoke grid receding into the distance, like a gravity well ----
  const funnelGroup = new THREE.Group();
  scene.add(funnelGroup);

  const profile = [];
  const RINGS = 46;
  const DEPTH = 26;
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const radius = Math.max(0.03, 6.2 * Math.pow(1 - t, 2.1));
    const y = t * DEPTH;
    profile.push(new THREE.Vector2(radius, y));
  }
  const funnelGeo = new THREE.LatheGeometry(profile, 40);
  const funnelMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.45, fog: true });
  const funnel = new THREE.Mesh(funnelGeo, funnelMat);
  funnel.rotation.x = -Math.PI / 2; // lathe's axis (local Y) now points down -Z, into the screen
  funnelGroup.add(funnel);

  // ---- countless background stars ----
  const STAR_COUNT = 900;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 1.5 + Math.random() * 9;
    starPos[i * 3] = Math.cos(angle) * r;
    starPos[i * 3 + 1] = Math.sin(angle) * r;
    starPos[i * 3 + 2] = -Math.random() * DEPTH;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.028, transparent: true, opacity: 0.85, fog: true });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  fitRenderer();
  window.addEventListener('resize', fitRenderer);

  const clock = new THREE.Clock();
  let frame;
  function animate() {
    frame = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsedTime();

    // fly forward endlessly: dolly the camera into the funnel, loop before
    // it reaches the (fog-hidden) tapered end
    camera.position.z -= 1.6 * dt;
    if (camera.position.z < -DEPTH + 8) {
      camera.position.z = 0;
    }

    funnelGroup.rotation.z = Math.sin(t * 0.08) * 0.08 + t * 0.01;
    stars.rotation.z = -t * 0.01;

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
