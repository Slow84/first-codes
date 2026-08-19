import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const container = document.getElementById('hero-orb');
if (container && window.WebGLRenderingContext) {

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 2, 14);

  const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 40);

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

  // ---- a genuinely curved tunnel: left -> up through the upper-right -> back down,
  // built by extruding a tube along a bent path (not a straight cone) ----
  const curvePoints = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1.2, 1.6, -5),
    new THREE.Vector3(2.6, 2.6, -10.5),
    new THREE.Vector3(3.2, 1.2, -16),
    new THREE.Vector3(3.0, -1.5, -21.5),
    new THREE.Vector3(2.2, -3.6, -27),
    new THREE.Vector3(1.6, -4.8, -32)
  ];
  const path = new THREE.CatmullRomCurve3(curvePoints);
  path.curveType = 'catmullrom';
  path.tension = 0.5;

  const TUBE_RADIUS = 2.3;
  const tubeGeo = new THREE.TubeGeometry(path, 220, TUBE_RADIUS, 28, false);
  const tubeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5, fog: true, side: THREE.BackSide });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  scene.add(tube);

  // ---- countless background stars, loosely following the tunnel's bend ----
  const STAR_COUNT = 900;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const u = Math.random();
    const center = path.getPointAt(Math.min(u, 0.98));
    const angle = Math.random() * Math.PI * 2;
    const r = TUBE_RADIUS * 0.4 + Math.random() * TUBE_RADIUS * 1.8;
    starPos[i * 3] = center.x + Math.cos(angle) * r;
    starPos[i * 3 + 1] = center.y + Math.sin(angle) * r;
    starPos[i * 3 + 2] = center.z;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.026, transparent: true, opacity: 0.8, fog: true });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  fitRenderer();
  window.addEventListener('resize', fitRenderer);

  // look at ONE fixed distant point the whole time (not the next step of
  // the path) — this is what keeps the vanishing point off to one side as
  // the camera's position sweeps along the bend, instead of the camera
  // re-aiming itself to center the tunnel every frame
  const farTarget = path.getPointAt(1);

  const clock = new THREE.Clock();
  const up = new THREE.Vector3(0, 1, 0);
  let progress = 0;
  let frame;

  function animate() {
    frame = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    // travel slowly along the curved path, looping well before the
    // (fog-hidden) far end so the reset is invisible
    progress += 0.015 * dt;
    if (progress > 0.82) progress = 0;

    const pos = path.getPointAt(progress);
    camera.position.copy(pos);
    camera.up.copy(up);
    camera.lookAt(farTarget);

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
