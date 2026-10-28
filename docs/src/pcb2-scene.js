import * as THREE from 'three';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

const smooth = (x, a, b) => { x = Math.max(0, Math.min(1, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
const mix = (a, b, t) => a + (b - a) * t;

export async function createScene(mount) {
  const baseURL = new URL('./', import.meta.url);
  const load = async name => {
    const response = await fetch(new URL(name, baseURL));
    if (!response.ok) throw new Error(`Model asset ${name}: ${response.status}`);
    return response;
  };
  const [board, mechanics, ...buffers] = await Promise.all([
    load('board.json').then(r => r.json()), load('mechanics.json').then(r => r.json()),
    ...['insert', 'base', 'cover', 'stencil_top'].map(n => load(n + '.bin').then(r => r.arrayBuffer()))
  ]);
  const renderer = new THREE.WebGLRenderer({alpha: true, antialias: true});
  const displayPixelRatio = Math.min(devicePixelRatio || 1, 2);
  renderer.setPixelRatio(displayPixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  mount.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-150, 150, 120, -120, .1, 2000);
  // Local studio reflections give the thin metal a finish without an external HDR download.
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(room, .06).texture;
  scene.environmentIntensity = .5;
  room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x89998a, 1.3));
  const light = new THREE.DirectionalLight(0xfff7e9, 1.8);
  light.position.set(-65, 400, 100); light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  Object.assign(light.shadow.camera, {left: -220, right: 220, top: 220, bottom: -220, near: 1, far: 650});
  light.shadow.bias = -.00015; light.shadow.normalBias = .12;
  scene.add(light);
  const fill = new THREE.DirectionalLight(0xdde8ff, .7);
  fill.position.set(150, 100, -140); scene.add(fill);
  const root = new THREE.Group(); scene.add(root);
  function shape(points, holes = []) {
    const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    holes.forEach(h => s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y)))));
    return s;
  }
  function plate(points, height, color, holes = []) {
    const geometry = new THREE.ExtrudeGeometry(shape(points, holes), {depth: height, bevelEnabled: false});
    geometry.rotateX(-Math.PI / 2);
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({color, roughness: .68, metalness: .02}));
  }
  const loader = new STLLoader();
  function model(index, color) {
    const geometry = loader.parse(buffers[index]); geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({color, roughness: .74, metalness: .015, envMapIntensity: .45}));
  }
  const pcb = new THREE.Group(); root.add(pcb);
  const pcbBody = plate(board.outline, 1.6, 0x285a47, board.holes);
  pcbBody.material.roughness = .42; pcb.add(pcbBody);
  const padParts = board.pads.flatMap(p => p.parts.filter(q => q.polarity !== 'C' && q.points.length >= 3));
  const positions = [], normals = [];
  for (const q of padParts) {
    const g = new THREE.ShapeGeometry(shape(q.points, q.holes || []));
    g.rotateX(-Math.PI / 2); g.translate(0, 1.625, 0);
    const flat = g.index ? g.toNonIndexed() : g;
    positions.push(...flat.attributes.position.array); normals.push(...flat.attributes.normal.array);
    if (flat !== g) flat.dispose(); g.dispose();
  }
  const padsGeometry = new THREE.BufferGeometry();
  padsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  padsGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const pads = new THREE.Mesh(padsGeometry, new THREE.MeshStandardMaterial({color: 0xc8b274, side: THREE.DoubleSide, roughness: .36, metalness: .6}));
  pcb.add(pads);
  const jig = new THREE.Group(); root.add(jig);
  const tray = model(0, 0x5a9b7f); jig.add(tray);
  const unit = new THREE.Group(); jig.add(unit);
  const base = model(1, 0x4c6f94);
  base.geometry.rotateX(Math.PI); base.geometry.translate(0, 4, 0); unit.add(base);
  const cover = model(2, 0xd9913d); unit.add(cover);
  const sx = board.stencilWidth, sy = board.stencilHeight;
  const metal = plate([[-sx/2, -sy/2], [sx/2, -sy/2], [sx/2, sy/2], [-sx/2, sy/2]], .3, 0xbfcac7, padParts.map(p => p.points));
  metal.material.dispose();
  metal.material = new THREE.MeshPhysicalMaterial({color: 0xc3cdce, metalness: .92, roughness: .32, anisotropy: .55, anisotropyRotation: Math.PI / 4, envMapIntensity: .9});
  unit.add(metal);
  const bolts = new THREE.Group(); unit.add(bolts);
  const boltMaterial = new THREE.MeshStandardMaterial({color: 0x5b6761, metalness: .85, roughness: .3});
  const shaftGeometry = new THREE.CylinderGeometry(1.45, 1.45, 7.3, 10);
  const headGeometry = new THREE.CylinderGeometry(2.8, 2.8, 1.7, 16);
  const shafts = new THREE.InstancedMesh(shaftGeometry, boltMaterial, mechanics.screws.length);
  const heads = new THREE.InstancedMesh(headGeometry, boltMaterial, mechanics.screws.length);
  const boltTransform = new THREE.Matrix4();
  mechanics.screws.forEach(([x, y], i) => {
    shafts.setMatrixAt(i, boltTransform.makeTranslation(x, 8.65, -y));
    heads.setMatrixAt(i, boltTransform.makeTranslation(x, 13.15, -y));
  });
  bolts.add(shafts, heads);
  const stencil = model(3, 0x5a9b7f); root.add(stencil);
  const boardOutline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...board.outline, board.outline[0]].map(([x,y]) => new THREE.Vector3(x, 1.7, -y))), new THREE.LineBasicMaterial({color: 0x1c6248}));
  pcb.add(boardOutline);

  // A real shadow catches the feet; a soft ambient footprint tightens as the assembly lands.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(650, 650), new THREE.ShadowMaterial({color: 0x30493c, opacity: .09}));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.35; ground.receiveShadow = true; scene.add(ground);
  const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
  const ctx = shadowCanvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(30,54,41,.3)'); gradient.addColorStop(.55, 'rgba(30,54,41,.14)'); gradient.addColorStop(1, 'rgba(30,54,41,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
  const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({map: shadowTexture, transparent: true, depthWrite: false, toneMapped: false}));
  contactShadow.rotation.x = -Math.PI / 2; contactShadow.position.y = -.2; root.add(contactShadow);
  const postFocus = new THREE.Group(); jig.add(postFocus);
  const ringMaterial = new THREE.MeshBasicMaterial({color: 0x3eaa83, transparent: true, depthWrite: false, toneMapped: false});
  const ringGeometry = new THREE.TorusGeometry(5.7, .38, 8, 40);
  const guideMaterial = new THREE.LineDashedMaterial({color: 0x48866d, transparent: true, depthWrite: false, dashSize: 2.2, gapSize: 2});
  const alignmentLines = [];
  for (const [x, y] of mechanics.posts) {
    const ring = new THREE.Mesh(ringGeometry, ringMaterial); ring.rotation.x = -Math.PI / 2; ring.position.set(x, 12.15, -y); postFocus.add(ring);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 12.2, -y), new THREE.Vector3(x, 38, -y)]), guideMaterial);
    line.computeLineDistances(); postFocus.add(line); alignmentLines.push(line);
  }
  const contentMaterials = new Map();
  for (const group of [pcb, jig, stencil]) {
    const materials = new Set();
    group.traverse(object => { if (object.material && !postFocus.children.includes(object)) materials.add(object.material); });
    // Keep one shader configuration across fades; depth writes prevent the stacked
    // CAD surfaces from all shading the same pixels while the tools appear.
    for (const material of materials) { material.transparent = true; material.forceSinglePass = true; }
    contentMaterials.set(group, materials);
  }
  const leader = mount.querySelector('#story-leader');
  const guideDot = mount.querySelector('#story-guide-dot');
  const guideLabel = mount.querySelector('#story-callout');
  const dimensions = mount.querySelector('#story-dimensions');
  const boardBounds = {
    left: Math.min(...board.outline.map(point => point[0])), right: Math.max(...board.outline.map(point => point[0])),
    front: -Math.min(...board.outline.map(point => point[1])), back: -Math.max(...board.outline.map(point => point[1]))
  };
  const dimensionPoint = new THREE.Vector3();
  const guidePoint = new THREE.Vector3();
  const orbitEye = new THREE.Vector3(), orbitTarget = new THREE.Vector3(), orbitOffset = new THREE.Vector3();
  const orbitMatrix = new THREE.Matrix4(), orbitQuaternion = new THREE.Quaternion();
  const fromQuaternion = new THREE.Quaternion(), targetQuaternion = new THREE.Quaternion();
  let currentStep = 0, currentPhase = 0, width = Math.max(1, mount.clientWidth), height = Math.max(1, mount.clientHeight);
  let state = null, transition = null, transitionFrame = 0, lost = false, warming = true;
  let inspection = null, orbit = null;
  let shadowPose = '';

  function pose(step, phase) {
    const s = {pcbX: 0, pcbY: 0, pcbScale: 1, pcbOpacity: 0, jigX: 0, jigScale: 1, jigOpacity: 0,
      stencilX: 0, stencilScale: 1, stencilOpacity: 0, unitY: 0, metalY: 8, coverY: 8.3, boltY: 0, boltOpacity: 0,
      angle: -.12, camX: 165, camY: 215, camZ: 235, halfHeight: 102, minWidth: 112, targetY: 6, clamp: 0, posts: 0, seated: 1, top: 0};
    if (step === 0 || step === 1) { s.pcbOpacity = 1; s.pcbScale = 1.8; }
    if (step === 1) Object.assign(s, {angle: 0, camX: 0, camY: 300, camZ: .01, top: 1});
    if (step === 2) Object.assign(s, {pcbOpacity: 1, jigOpacity: 1, stencilOpacity: 1, boltOpacity: 1,
      jigScale: .75, jigX: -65, pcbScale: .75, pcbX: -65, pcbY: 6.4 * .75, stencilX: 68,
      halfHeight: 110, minWidth: 170, camX: 60, camY: 300, camZ: 270});
    if (step === 3) {
      const closed = smooth(phase, .2, .44), seated = smooth(phase, .64, .88);
      Object.assign(s, {jigOpacity: 1, pcbOpacity: 1, pcbY: 6.4, unitY: mix(30, 0, seated),
        metalY: mix(39, 8, closed), coverY: mix(72, 8.3, closed), boltY: mix(5, 0, smooth(phase, .4, .5)),
        boltOpacity: smooth(closed, .9, 1), halfHeight: mix(117, 100, seated), targetY: mix(42, 14, seated),
        camX: 160, camY: 185, camZ: 245, minWidth: 122, seated,
        clamp: smooth(phase, .12, .28) * (1 - smooth(phase, .56, .66)),
        posts: smooth(phase, .56, .68) * (1 - .65 * smooth(phase, .9, 1))});
    }
    if (step === 4) Object.assign(s, {stencilOpacity: 1, stencilScale: 1.6});
    orbitEye.set(s.camX, s.camY, s.camZ); orbitTarget.set(0, s.targetY, 0);
    orbitQuaternion.setFromRotationMatrix(orbitMatrix.lookAt(orbitEye, orbitTarget, camera.up));
    Object.assign(s, {qx: orbitQuaternion.x, qy: orbitQuaternion.y, qz: orbitQuaternion.z, qw: orbitQuaternion.w,
      distance: orbitEye.distanceTo(orbitTarget)});
    return s;
  }
  function groupStyle(group, opacity) {
    group.visible = opacity > .002;
    for (const material of contentMaterials.get(group)) {
      material.opacity = opacity; material.depthWrite = true;
    }
    group.traverse(object => {
      if (object.isMesh && !postFocus.children.includes(object)) { object.castShadow = opacity > .98; object.receiveShadow = true; }
    });
  }
  function updateGuide(s) {
    mount.dataset.focus = currentStep === 3 ? (currentPhase >= .6 ? 'posts' : 'clamp') : 'none';
    if (!leader || !guideLabel || currentStep !== 3 || transition || warming) return;
    const locating = currentPhase >= .6;
    guidePoint.set(locating ? -64.5 : -65, locating ? 12.2 : s.coverY + 1, locating ? 64.5 : 40);
    (locating ? jig : unit).localToWorld(guidePoint);
    guidePoint.project(camera);
    const x = (guidePoint.x * .5 + .5) * width, y = (-guidePoint.y * .5 + .5) * height;
    const label = guideLabel.getBoundingClientRect(), bounds = mount.getBoundingClientRect();
    const startX = label.left - bounds.left + label.width * .7, startY = label.bottom - bounds.top + 3;
    leader.setAttribute('d', `M${startX},${startY} L${startX},${startY + 9} L${x},${y}`);
    guideDot.setAttribute('cx', x); guideDot.setAttribute('cy', y);
  }
  function updateDimensions() {
    if (!dimensions || warming || transition || currentStep > 1) return;
    const project = (x, z) => {
      dimensionPoint.set(x, 1.7, z); pcb.localToWorld(dimensionPoint); dimensionPoint.project(camera);
      return {x: (dimensionPoint.x * .5 + .5) * width, y: (-dimensionPoint.y * .5 + .5) * height};
    };
    const {left, right, front, back} = boardBounds, offset = 9;
    const center = project((left + right) / 2, (front + back) / 2);
    function dimension(name, a, b, edgeA, edgeB, value) {
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (length < 1) return;
      let nx = -dy / length, ny = dx / length;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (nx * (mx - center.x) + ny * (my - center.y) < 0) { nx *= -1; ny *= -1; }
      const tick = point => `M${point.x - nx * 3},${point.y - ny * 3} L${point.x + nx * 3},${point.y + ny * 3}`;
      mount.querySelector(`#story-${name}-line`).setAttribute('d',
        `M${edgeA.x},${edgeA.y} L${a.x},${a.y} M${a.x},${a.y} L${b.x},${b.y} M${edgeB.x},${edgeB.y} L${b.x},${b.y} ${tick(a)} ${tick(b)}`);
      const label = mount.querySelector(`#story-${name}-label`), x = mx + nx * 7, y = my + ny * 7;
      let angle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (angle > 90) angle -= 180; if (angle < -90) angle += 180;
      label.setAttribute('x', x); label.setAttribute('y', y);
      label.setAttribute('transform', `rotate(${angle},${x},${y})`);
      label.textContent = `${Number(value.toFixed(2))} mm`;
    }
    dimension('width', project(left, front + offset), project(right, front + offset), project(left, front), project(right, front), board.width);
    dimension('height', project(right + offset, front), project(right + offset, back), project(right, front), project(right, back), board.height);
  }
  function render(s) {
    if (lost) return;
    state = s;
    groupStyle(pcb, s.pcbOpacity); groupStyle(jig, s.jigOpacity); groupStyle(stencil, s.stencilOpacity);
    pcb.position.set(s.pcbX, s.pcbY, 0); pcb.scale.setScalar(s.pcbScale);
    jig.position.set(s.jigX, 0, 0); jig.scale.setScalar(s.jigScale);
    stencil.position.set(s.stencilX, 0, 0); stencil.scale.setScalar(s.stencilScale);
    unit.position.y = s.unitY; base.position.y = 4; metal.position.y = s.metalY; cover.position.y = s.coverY;
    bolts.position.y = s.boltY; bolts.visible = s.boltOpacity > .01;
    boltMaterial.opacity = s.jigOpacity * s.boltOpacity;
    root.rotation.y = s.angle;
    cover.material.emissive.set(0xc78636); cover.material.emissiveIntensity = s.clamp * .18;
    base.material.emissive.set(0x4f82a9); base.material.emissiveIntensity = s.clamp * .2;
    metal.material.emissive.set(0xa4c7b7); metal.material.emissiveIntensity = s.clamp * .14;
    ringMaterial.opacity = s.posts * .9; guideMaterial.opacity = s.posts * .45 * (1 - s.seated);
    postFocus.visible = s.posts > .001;
    if (postFocus.visible) for (const line of alignmentLines) {
      const end = Math.max(12.3, s.unitY + 5);
      if (line.geometry.attributes.position.getY(1) !== Math.fround(end)) {
        line.geometry.attributes.position.setY(1, end);
        line.geometry.attributes.position.needsUpdate = true; line.computeLineDistances();
      }
    }
    contactShadow.position.x = mix(s.pcbX, s.jigX, s.jigOpacity);
    const footprint = mix(160, 200 - s.seated * 25, s.jigOpacity);
    contactShadow.scale.set(footprint, footprint, 1); contactShadow.material.opacity = mix(.45, .85, s.seated);
    const aspect = width / height;
    const halfHeight = Math.max(s.halfHeight, s.minWidth / aspect);
    camera.quaternion.set(s.qx, s.qy, s.qz, s.qw);
    orbitOffset.set(0, 0, s.distance).applyQuaternion(camera.quaternion);
    camera.position.set(0, s.targetY, 0).add(orbitOffset);
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect; camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    pads.material.color.set(0xc8b274).lerp(new THREE.Color(0xacc3aa), s.top);
    // Camera motion can reuse its shadow map. Moving geometry updates it once
    // settled; the soft contact footprint remains continuous during the move.
    const nextShadowPose = [s.pcbX, s.pcbY, s.pcbScale, s.jigX, s.jigScale, s.stencilX, s.stencilScale,
      s.pcbOpacity, s.jigOpacity, s.stencilOpacity, s.unitY, s.metalY, s.coverY, s.boltY, s.boltOpacity, s.angle].join(',');
    if (!transition && nextShadowPose !== shadowPose) { renderer.shadowMap.needsUpdate = true; shadowPose = nextShadowPose; }
    light.shadow.intensity = transition ? 0 : 1;
    renderer.render(scene, camera); updateGuide(s); updateDimensions();
    mount.dataset.pose = JSON.stringify({step: currentStep, phase: currentPhase, unit: s.unitY, base: 4,
      metal: s.metalY, cover: s.coverY, clamp: s.clamp, posts: s.posts, shadow: contactShadow.material.opacity,
      camera: camera.position.toArray(), orientation: camera.quaternion.toArray(),
      pcb: [s.pcbX, s.pcbY, s.pcbScale], transitioning: Boolean(transition), transitionProgress: transition?.progress ?? 1});
  }
  function cancelTransition(restoreResolution = true) {
    cancelAnimationFrame(transitionFrame); transitionFrame = 0; transition = null; mount.dataset.transitioning = 'false';
    if (restoreResolution && renderer.getPixelRatio() !== displayPixelRatio) renderer.setPixelRatio(displayPixelRatio);
  }
  function draw(step = currentStep, phase = currentPhase) { cancelTransition(); currentStep = step; currentPhase = phase; render(pose(step, phase)); }
  function settle() { if (transition) draw(); }
  function transitionTo(step, phase) {
    const from = state;
    cancelTransition(false); currentStep = step; currentPhase = phase;
    if (!from) { draw(step, phase); return; }
    // A smaller backing buffer during motion leaves room for the complex CAD
    // tools; CSS dimensions stay fixed and the settled view restores full detail.
    const motionPixelRatio = Math.min(displayPixelRatio, .8);
    if (renderer.getPixelRatio() !== motionPixelRatio) renderer.setPixelRatio(motionPixelRatio);
    transition = {from, started: performance.now()}; mount.dataset.transitioning = 'true';
    function tick(now) {
      if (!transition || lost) return;
      const progress = Math.max(0, Math.min(1, (now - transition.started) / 640));
      transition.progress = progress;
      const eased = progress ** 3 * (progress * (progress * 6 - 15) + 10);
      const target = pose(currentStep, currentPhase), next = {};
      for (const key of Object.keys(target)) next[key] = mix(transition.from[key], target[key], eased);
      fromQuaternion.set(transition.from.qx, transition.from.qy, transition.from.qz, transition.from.qw);
      targetQuaternion.set(target.qx, target.qy, target.qz, target.qw);
      orbitQuaternion.slerpQuaternions(fromQuaternion, targetQuaternion, eased);
      Object.assign(next, {qx: orbitQuaternion.x, qy: orbitQuaternion.y, qz: orbitQuaternion.z, qw: orbitQuaternion.w});
      if (progress < 1) { render(next); transitionFrame = requestAnimationFrame(tick); }
      else { draw(); mount.dispatchEvent(new CustomEvent('preview-settled')); }
    }
    transitionFrame = requestAnimationFrame(tick);
  }
  const resize = new ResizeObserver(entries => {
    width = Math.max(1, entries[0].contentRect.width); height = Math.max(1, entries[0].contentRect.height);
    renderer.setSize(width, height, false);
    if (inspection) renderInspection(); else render(state || pose(currentStep, currentPhase));
  });
  resize.observe(mount);
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); lost = true; cancelTransition(); resize.disconnect(); orbit?.dispose();
    mount.dispatchEvent(new CustomEvent('preview-lost'));
  });
  // Compile and upload all tools while the viewer is hidden, including the fade
  // and shadow paths. Switching steps then only updates transforms and uniforms.
  render(pose(2, 0));
  postFocus.visible = true;
  await renderer.compileAsync(scene, camera);
  render(pose(3, .7));
  draw(0, 0); warming = false;
  function renderInspection() {
    if (lost || !inspection) return;
    const halfHeight = Math.max(inspection.halfHeight, (inspection.halfWidth ?? inspection.halfHeight * .85) / (width / height));
    camera.left = -halfHeight * width / height; camera.right = -camera.left;
    camera.top = halfHeight; camera.bottom = -halfHeight; camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    mount.dataset.inspection = JSON.stringify({preset: inspection.name, camera: camera.position.toArray(), zoom: camera.zoom, target: orbit.target.toArray()});
  }
  async function inspect(name) {
    if (lost) throw new Error('Model context unavailable');
    if (!orbit) {
      const {OrbitControls} = await import('three/addons/controls/OrbitControls.js');
      if (lost) throw new Error('Model context unavailable');
      if (orbit) return inspect(name);
      orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = false; orbit.enablePan = false;
      orbit.minZoom = .65; orbit.maxZoom = 4;
      orbit.minPolarAngle = .08; orbit.maxPolarAngle = Math.PI * .48;
      orbit.rotateSpeed = .65;
      orbit.addEventListener('change', renderInspection);
      renderer.domElement.tabIndex = 0;
      renderer.domElement.removeAttribute('aria-hidden');
      renderer.domElement.addEventListener('keydown', event => {
        if (!orbit.enabled) return;
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomInspection(1.2); }
        else if (event.key === '-') { event.preventDefault(); zoomInspection(1 / 1.2); }
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(orbit.target));
          spherical.theta += event.key === 'ArrowLeft' ? .13 : event.key === 'ArrowRight' ? -.13 : 0;
          spherical.phi = THREE.MathUtils.clamp(spherical.phi + (event.key === 'ArrowUp' ? -.1 : event.key === 'ArrowDown' ? .1 : 0), orbit.minPolarAngle, orbit.maxPolarAngle);
          camera.position.copy(orbit.target).add(new THREE.Vector3().setFromSpherical(spherical)); orbit.update();
        }
      });
    }
    inspection = null; orbit.enabled = false; camera.zoom = 1;
    const views = {
      overview: {step: 3, phase: 1, target: [0, 7, 0], offset: [160, 180, 245], halfHeight: 105, halfWidth: 118},
      posts: {step: 3, phase: .7, target: [-64.5, 18, 64.5], offset: [-90, 70, 125], halfHeight: 34},
      clamp: {step: 3, phase: 1, target: [0, 8.3, 63], offset: [70, 53, 140], halfHeight: 38},
      apertures: {step: 4, phase: 1, target: [10, 2, 0], offset: [30, 100, 75], halfHeight: 28}
    };
    const view = views[name] || views.posts;
    draw(view.step, view.phase);
    inspection = {...view, name};
    orbit.target.fromArray(view.target); camera.position.fromArray(view.offset).add(orbit.target);
    orbit.enabled = true; orbit.update(); renderInspection();
  }
  function zoomInspection(factor) {
    if (!inspection || lost) return;
    camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, orbit.minZoom, orbit.maxZoom);
    camera.updateProjectionMatrix(); orbit.update(); renderInspection();
  }
  function suspendInspection() { if (orbit) orbit.enabled = false; }
  function dispose() {
    lost = true; cancelTransition(); resize.disconnect(); orbit?.dispose();
    const geometries = new Set(), materials = new Set();
    scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m));
    });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
    scene.environment?.dispose(); light.shadow.map?.dispose(); renderer.dispose(); renderer.domElement.remove();
  }
  return {draw, transitionTo, settle, inspect, zoomInspection, suspendInspection, dispose};
}
