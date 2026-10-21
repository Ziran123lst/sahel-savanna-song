/* ================================================================
 *  world.js —— 3D 开放世界：地形 · 植被 · 聚落 · 天空 · 季节
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const { WORLD, SITES, COLOR, clamp, lerp, dist2, fbm, makeRng, heightAt, aridityAt } = S;

  /* 道路网络（折线，用于给地形上色） */
  const ROADS = [
    [[0, 48], [2, 92], [4, 132], [6, 172], [50, 186], [104, 196]],
    [[0, 48], [-18, 22], [-40, 4], [-52, -14]],
    [[0, 48], [-58, 46], [-100, 50], [-140, 52]],
    [[-52, -14], [-10, -24], [20, -30], [44, -34]],
    [[44, -34], [78, -46], [108, -58]],
    [[108, -58], [118, -92], [128, -118]],
    [[0, 48], [-12, -20], [-22, -80], [-30, -152]],
    [[-30, -152], [16, -170], [74, -180]],
    [[-140, 52], [-120, 20], [-90, -30], [-40, -120], [-30, -152]]
  ];
  function distToRoad(x, z) {
    let best = 1e9;
    for (const road of ROADS) {
      for (let i = 0; i < road.length - 1; i++) {
        const ax = road[i][0], az = road[i][1], bx = road[i + 1][0], bz = road[i + 1][1];
        const dx = bx - ax, dz = bz - az;
        const len2 = dx * dx + dz * dz;
        let t = len2 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
        t = clamp(t, 0, 1);
        const px = ax + dx * t, pz = az + dz * t;
        const d = Math.sqrt(dist2(x, z, px, pz));
        if (d < best) best = d;
      }
    }
    return best;
  }

  const World = {
    scene: null, camera: null, renderer: null,
    sun: null, hemi: null, sky: null, skyMat: null,
    obstacles: [],       // {x,z,r}
    markers: [],         // 动态交互标记
    ground: null,
    season: 'dry',
    storm: 0,
    time: 0,
    _waterMesh: null,
    _canopyMats: [],
    _grassMat: null,
    _skyTop: new THREE.Color(), _skyBot: new THREE.Color()
  };

  /* ============ 初始化渲染器与场景 ============ */
  World.init = function (canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: window.devicePixelRatio < 2 });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.3, 1200);
    camera.position.set(0, 12, 80);
    this.camera = camera;

    // 光
    const hemi = new THREE.HemisphereLight(0xf3e2bd, 0x7a5a34, 0.75);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe6bc, 1.35);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera;
    sc.near = 1; sc.far = 320; sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80;
    sun.shadow.bias = -0.0016;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun; this.hemi = hemi;

    // 天空
    const skyGeo = new THREE.SphereGeometry(700, 32, 18);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4a86bd) },
        midColor: { value: new THREE.Color(0xd7c9a4) },
        botColor: { value: new THREE.Color(0xe8c27a) },
        sunDir: { value: new THREE.Vector3(0.6, 0.55, 0.4).normalize() },
        sunColor: { value: new THREE.Color(0xffe0a8) }
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor; uniform vec3 midColor; uniform vec3 botColor;
        uniform vec3 sunDir; uniform vec3 sunColor;
        varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y*1.15+0.06, -1.0, 1.0);
          vec3 c = h > 0.0 ? mix(midColor, topColor, pow(h,0.62)) : mix(botColor, midColor, clamp(h+1.0,0.0,1.0));
          float sd = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          c += sunColor * pow(sd, 64.0) * 0.85;
          c += sunColor * pow(sd, 6.0) * 0.10;
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.skyMat = skyMat;

    scene.fog = new THREE.Fog(0xdcc79b, 90, 420);

    window.addEventListener('resize', () => this.onResize());
    return { scene, camera, renderer };
  };

  World.onResize = function () {
    if (!this.renderer) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  /* ============ 地形 ============ */
  function buildGround() {
    const geo = new THREE.PlaneGeometry(WORLD.size, WORLD.size, WORLD.seg, WORLD.seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(), cB = new THREE.Color(), cC = new THREE.Color(), tmp = new THREE.Color();
    const cGrass = new THREE.Color(COLOR.grass);
    const cGrassDry = new THREE.Color(COLOR.grassDry);
    const cSoil = new THREE.Color(COLOR.soil);
    const cSand = new THREE.Color(COLOR.sand);
    const cSandPale = new THREE.Color(COLOR.sandPale);
    const cRock = new THREE.Color(COLOR.rock);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = heightAt(x, z);
      pos.setY(i, h);
      const a = aridityAt(x, z);
      // 底色调：湿→干
      if (a < 0.42) { cA.copy(cGrass).lerp(cGrassDry, a / 0.42); }
      else if (a < 0.72) { cA.copy(cGrassDry).lerp(cSoil, (a - 0.42) / 0.30); }
      else { cA.copy(cSoil).lerp(cSand, (a - 0.72) / 0.28); }
      // 高处偏沙/岩
      if (h > 7) cA.lerp(cSandPale, clamp((h - 7) / 12, 0, 0.6));
      // 斑驳
      const n = fbm(x * 0.06 + 7, z * 0.06 + 3, 3);
      cA.offsetHSL(0, (n - 0.5) * 0.06, (n - 0.5) * 0.09);
      // 道路
      const dr = distToRoad(x, z);
      if (dr < 4.2) {
        tmp.setHex(0xd8b483);
        cA.lerp(tmp, clamp(1 - dr / 4.2, 0, 1) * 0.78);
      }
      // 沙丘顶部泛白
      if (a > 0.8 && h > 9) cA.lerp(cSandPale, 0.35);
      colors[i * 3] = cA.r; colors[i * 3 + 1] = cA.g; colors[i * 3 + 2] = cA.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  /* ============ 水塘 ============ */
  function buildWater() {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: COLOR.water, transparent: true, opacity: 0.86 });
    const geo = new THREE.CircleGeometry(26, 40);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(WORLD.water.x, -4.4, WORLD.water.z);
    m.receiveShadow = false;
    g.add(m);
    // 湿泥边
    const ringGeo = new THREE.RingGeometry(24, 33, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshLambertMaterial({ color: 0x6d5a34 }));
    ring.position.set(WORLD.water.x, -3.6, WORLD.water.z);
    g.add(ring);
    return g;
  }

  /* ============ 树 ============ */
  /* kinds: 0 金合欢(伞形) 1 猴面包 2 棕榈 3 灌木 */
  function placeTrees(scene, rng) {
    const treeSpots = [];
    const N = 300;
    let guard = 0;
    while (treeSpots.length < N && guard < N * 40) {
      guard++;
      const x = (rng() - 0.5) * WORLD.size * 0.96;
      const z = (rng() - 0.5) * WORLD.size * 0.96;
      if (Math.abs(x) > 216 || Math.abs(z) > 216) continue;
      const a = aridityAt(x, z);
      const dr = distToRoad(x, z);
      // 密度随干旱度下降
      const density = clamp(1.15 - a * 1.25, 0.03, 1);
      if (rng() > density * 0.55) continue;
      if (dr < 4.5 && rng() > 0.12) continue;
      // 离建筑远一点
      let nearSite = false;
      for (const s of SITES) {
        if ((s.kind === 'village' || s.kind === 'market' || s.kind === 'camp') &&
            Math.sqrt(dist2(x, z, s.x, s.z)) < s.r * 0.55) { nearSite = true; break; }
      }
      if (nearSite) continue;
      let kind = 0;
      const r = rng();
      if (a < 0.34 && r < 0.12) kind = 1;          // 猴面包（南部）
      else if (Math.sqrt(dist2(x, z, WORLD.water.x, WORLD.water.z)) < 55 && r < 0.4) kind = 2;
      else if (a > 0.62 && r < 0.55) kind = 3;     // 灌木
      treeSpots.push({ x, z, kind, a });
    }

    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
    const coneGeo = new THREE.ConeGeometry(1, 1, 7);
    coneGeo.translate(0, 0.5, 0);
    const bushGeo = new THREE.IcosahedronGeometry(1, 0);

    const trunkMat = new THREE.MeshLambertMaterial({ color: COLOR.trunk });
    const canopyMat = new THREE.MeshLambertMaterial({ color: COLOR.canopy });
    const palmMat = new THREE.MeshLambertMaterial({ color: 0x5e7d34 });
    const bushMat = new THREE.MeshLambertMaterial({ color: COLOR.scrub });
    World._canopyMats.push(canopyMat, palmMat, bushMat);

    const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    treeSpots.forEach(t => counts[t.kind]++);

    /* ---- 真实 GLB 树（来自 Poly Pizza / Quaternius，CC0）---- */
    const gltfTree = S.Models.get('vendor/models/tree.glb');
    const treeNodes = [];
    if (gltfTree) {
      gltfTree.scene.traverse(o => { if (/^NormalTree_\d+$/.test(o.name || '')) treeNodes.push(o); });
      treeNodes.sort((a, b) => a.name.localeCompare(b.name));
    }

    const placeOneTree = (srcNode, x, z, targetH) => {
      let node;
      try { node = window.SkeletonUtils ? window.SkeletonUtils.clone(srcNode) : srcNode.clone(true); }
      catch (e) { node = srcNode.clone(true); }
      node.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      const box = new THREE.Box3().setFromObject(node);
      const sz = new THREE.Vector3(); box.getSize(sz);
      node.scale.setScalar(targetH / (sz.y || targetH));
      const box2 = new THREE.Box3().setFromObject(node);
      node.position.set(x, heightAt(x, z) - box2.min.y, z);
      node.rotation.y = rng() * 6.283;
      scene.add(node);
    };

    // 模型缺失时的程序化降级（极少触发）
    if (!treeNodes.length) {
      const tMat = new THREE.MeshLambertMaterial({ color: COLOR.trunk });
      const cMat = new THREE.MeshLambertMaterial({ color: COLOR.canopy });
      treeSpots.forEach(t => {
        const g = new THREE.Group();
        const tg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 3.4, 6), tMat); tg.position.y = 1.7; tg.castShadow = true;
        const cg = new THREE.Mesh(new THREE.IcosahedronGeometry(1.8, 0), cMat); cg.position.y = 3.6; cg.castShadow = true;
        g.add(tg, cg); g.position.set(t.x, heightAt(t.x, t.z), t.z); scene.add(g);
      });
      return treeSpots;
    }

    let ti = 0;
    for (const t of treeSpots) {
      const src = treeNodes[ti++ % treeNodes.length];
      if (t.kind === 0) {        // 金合欢：伞形
        placeOneTree(src, t.x, t.z, 4.0 + rng() * 2.4);
        if (rng() < 0.3) World.obstacles.push({ x: t.x, z: t.z, r: 1.1 });
      } else if (t.kind === 1) { // 猴面包：巨干
        placeOneTree(src, t.x, t.z, 5.6 + rng() * 1.4);
        World.obstacles.push({ x: t.x, z: t.z, r: 1.9 });
      } else if (t.kind === 2) { // 棕榈
        placeOneTree(src, t.x, t.z, 5.2 + rng() * 2.0);
      } else {                   // 灌木：用最小的树缩小
        placeOneTree(treeNodes[treeNodes.length - 1], t.x, t.z, 1.6 + rng() * 1.0);
      }
    }
    return treeSpots;
  }

  /* ============ 草丛 / 石头 ============ */
  function placeGroundCover(scene, rng) {
    // 草：只在较湿润区
    const grassGeo = new THREE.ConeGeometry(0.28, 0.62, 4);
    grassGeo.translate(0, 0.31, 0);
    const grassMat = new THREE.MeshLambertMaterial({ color: 0x9aa457 });
    World._grassMat = grassMat;
    const G = 4200;
    const grass = new THREE.InstancedMesh(grassGeo, grassMat, G);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), SC = new THREE.Vector3();
    const col = new THREE.Color(), cDry = new THREE.Color(0xc2ac68);
    let n = 0, guard = 0;
    while (n < G && guard < G * 12) {
      guard++;
      const x = (rng() - 0.5) * WORLD.size * 0.95, z = (rng() - 0.5) * WORLD.size * 0.95;
      const a = aridityAt(x, z);
      const d = clamp(1.1 - a * 1.35, 0, 1);
      if (rng() > d) continue;
      const y = heightAt(x, z);
      const s = 0.6 + rng() * 0.9;
      P.set(x, y, z); Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
      SC.set(s, s * (0.8 + rng() * 0.7), s);
      M.compose(P, Q, SC); grass.setMatrixAt(n, M);
      col.setHex(0x8fa052).lerp(cDry, clamp(a * 1.15, 0, 1)).offsetHSL(0, 0, (rng() - 0.5) * 0.1);
      grass.setColorAt(n, col);
      n++;
    }
    grass.count = n;
    grass.instanceMatrix.needsUpdate = true;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    scene.add(grass);

    // 石头
    const rockGeo = new THREE.IcosahedronGeometry(0.5, 0);
    const rockMat = new THREE.MeshLambertMaterial({ color: COLOR.rock, flatShading: true });
    const R = 700;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, R);
    rocks.castShadow = true;
    let rn = 0; guard = 0;
    while (rn < R && guard < R * 12) {
      guard++;
      const x = (rng() - 0.5) * WORLD.size * 0.96, z = (rng() - 0.5) * WORLD.size * 0.96;
      const a = aridityAt(x, z);
      if (rng() > 0.25 + a * 0.75) continue;
      const y = heightAt(x, z);
      const s = 0.3 + rng() * (0.6 + a * 0.9);
      P.set(x, y + s * 0.25, z); Q.setFromAxisAngle(new THREE.Vector3(rng(), 1, rng()).normalize(), rng() * 6.28);
      SC.set(s * (1 + rng() * 0.6), s * (0.6 + rng() * 0.5), s * (1 + rng() * 0.6));
      M.compose(P, Q, SC); rocks.setMatrixAt(rn, M);
      col.setHex(COLOR.rock).offsetHSL(0, 0, (rng() - 0.5) * 0.12);
      rocks.setColorAt(rn, col);
      rn++;
    }
    rocks.count = rn;
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    scene.add(rocks);
  }

  /* ============ 建筑系统 ============ */
  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  wallGeo.translate(0, 0.5, 0);
  const roofGeo = new THREE.ConeGeometry(0.78, 0.62, 8);
  roofGeo.translate(0, 0.5, 0);

  function makeBuildings(scene, rng) {
    const wallMat = new THREE.MeshLambertMaterial({ color: COLOR.mudWall });
    const roofMat = new THREE.MeshLambertMaterial({ color: COLOR.thatch });
    const houseSpecs = [];

    /* --- 村庄科多戈 --- */
    const vil = SITES.find(s => s.id === 'village');
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * 6.283 + rng() * 0.4;
      const rad = 11 + rng() * 22;
      const x = vil.x + Math.cos(ang) * rad, z = vil.z + Math.sin(ang) * rad * 0.9;
      if (distToRoad(x, z) < 6) continue;
      const w = 3.4 + rng() * 2.4, d = 3.2 + rng() * 2.2, h = 2.4 + rng() * 0.9;
      houseSpecs.push({ x, z, w, d, h, kind: 'house', rot: rng() * 6.283 });
      World.obstacles.push({ x, z, r: Math.max(w, d) * 0.55 });
    }
    // 粮仓（圆柱）
    houseSpecs.push({ x: vil.x + 16, z: vil.z + 6, w: 2.6, d: 2.6, h: 3.4, kind: 'granary', rot: 0.3 });
    World.obstacles.push({ x: vil.x + 16, z: vil.z + 6, r: 2.0 });
    houseSpecs.push({ x: vil.x + 19, z: vil.z + 11, w: 2.2, d: 2.2, h: 3.0, kind: 'granary', rot: -0.2 });
    // 清真寺（尖塔）
    houseSpecs.push({ x: vil.x - 14, z: vil.z + 20, w: 6.5, d: 6.5, h: 3.4, kind: 'mosque', rot: 0 });
    World.obstacles.push({ x: vil.x - 14, z: vil.z + 20, r: 4.2 });
    // 小学
    houseSpecs.push({ x: vil.x + 30, z: vil.z + 22, w: 7, d: 5, h: 3.0, kind: 'school', rot: 0.1 });
    World.obstacles.push({ x: vil.x + 30, z: vil.z + 22, r: 4.5 });

    /* --- 集市卡亚镇 --- */
    const mk = SITES.find(s => s.id === 'market');
    for (let i = 0; i < 14; i++) {
      const x = mk.x + (rng() - 0.5) * 58, z = mk.z + (rng() - 0.5) * 44;
      if (distToRoad(x, z) < 5) continue;
      houseSpecs.push({ x, z, w: 3 + rng() * 2, d: 3 + rng() * 1.6, h: 2.4 + rng() * 0.8, kind: 'house', rot: rng() * 6.28 });
      World.obstacles.push({ x, z, r: 2.0 });
    }
    // 摊档（矮台 + 遮阳棚）
    for (let i = 0; i < 12; i++) {
      const x = mk.x + (rng() - 0.5) * 52, z = mk.z + (rng() - 0.5) * 30;
      houseSpecs.push({ x, z, w: 2.4 + rng() * 1.2, d: 2.0, h: 0.9, kind: 'stall', rot: rng() * 6.28 });
    }

    /* --- 牧民营地（帐篷） --- */
    const camp = SITES.find(s => s.id === 'camp');
    for (let i = 0; i < 8; i++) {
      const ang = rng() * 6.283, rad = rng() * 18;
      houseSpecs.push({ x: camp.x + Math.cos(ang) * rad, z: camp.z + Math.sin(ang) * rad, w: 3.2, d: 3.2, h: 2.0, kind: 'tent', rot: rng() * 6.28 });
    }
    // 畜栏
    houseSpecs.push({ x: camp.x - 14, z: camp.z + 8, w: 12, d: 0.4, h: 1.2, kind: 'fence', rot: 0.2 });

    /* --- 苗圃 --- */
    const nur = SITES.find(s => s.id === 'nursery');
    houseSpecs.push({ x: nur.x, z: nur.z + 6, w: 6, d: 4.5, h: 2.6, kind: 'nursery', rot: 0 });
    World.obstacles.push({ x: nur.x, z: nur.z + 6, r: 3.4 });
    for (let i = 0; i < 10; i++) {
      houseSpecs.push({ x: nur.x - 18 + i * 4, z: nur.z - 8, w: 3, d: 1.2, h: 0.5, kind: 'bed', rot: 0 });
    }

    /* --- 车站 --- */
    const st = SITES.find(s => s.id === 'station');
    houseSpecs.push({ x: st.x, z: st.z + 8, w: 7, d: 4, h: 2.8, kind: 'school', rot: 0 });
    World.obstacles.push({ x: st.x, z: st.z + 8, r: 4 });

    /* --- 农田田埂（矮墙段） --- */
    const farm = SITES.find(s => s.id === 'farm');
    for (let i = 0; i < 6; i++) {
      houseSpecs.push({ x: farm.x - 20 + i * 8, z: farm.z + 14, w: 7, d: 0.5, h: 0.55, kind: 'fence', rot: 0 });
    }

    /* --- 真实 GLB 泥屋（house / granary / stall / nursery 用 hut 模型）--- */
    const gltfHut = S.Models.get('vendor/models/hut.glb');
    const hutKinds = new Set(['house', 'granary', 'stall', 'nursery']);
    const hutSpecs = houseSpecs.filter(h => hutKinds.has(h.kind));
    if (gltfHut) {
      for (const h of hutSpecs) {
        let node;
        try { node = window.SkeletonUtils ? window.SkeletonUtils.clone(gltfHut.scene) : gltfHut.scene.clone(true); }
        catch (e) { node = gltfHut.scene.clone(true); }
        node.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        const box = new THREE.Box3().setFromObject(node);
        const sz = new THREE.Vector3(); box.getSize(sz);
        const targetW = Math.max(h.w, h.d) * 0.92;
        const s = targetW / (Math.max(sz.x, sz.z) || targetW);
        const sH = 2.7 / (sz.y || 2.7);
        node.scale.setScalar(Math.min(s, sH));
        const box2 = new THREE.Box3().setFromObject(node);
        const y = heightAt(h.x, h.z);
        node.position.set(h.x, y - box2.min.y, h.z);
        node.rotation.y = h.rot;
        scene.add(node);
      }
    }

    /* --- 其余建筑（清真寺 / 小学 / 帐篷 / 田埂 / 苗床）程序化实例化 --- */
    // hut 模型缺失时，全部回退到程序化方块，避免房屋消失
    const otherSpecs = gltfHut ? houseSpecs.filter(h => !hutKinds.has(h.kind)) : houseSpecs;
    const walls = new THREE.InstancedMesh(wallGeo, wallMat, Math.max(otherSpecs.length, 1));
    const roofs = new THREE.InstancedMesh(roofGeo, roofMat, Math.max(otherSpecs.length, 1));
    walls.castShadow = true; walls.receiveShadow = true;
    roofs.castShadow = true;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), SC = new THREE.Vector3();
    const col = new THREE.Color();
    const palette = [0xb5794a, 0xa96a3e, 0xc08a56, 0x9c6034, 0xb98c62];
    const roofPalette = [0xc9a05e, 0xb8914c, 0xd8b478];
    otherSpecs.forEach((h, i) => {
      const y = heightAt(h.x, h.z);
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.rot);
      let roofScale = 1;
      if (h.kind === 'stall') { SC.set(h.w, h.h, h.d); P.set(h.x, y, h.z); M.compose(P, Q, SC); walls.setMatrixAt(i, M); roofScale = 0; }
      else if (h.kind === 'fence') { SC.set(h.w, h.h, h.d); P.set(h.x, y, h.z); M.compose(P, Q, SC); walls.setMatrixAt(i, M); roofScale = 0; }
      else if (h.kind === 'bed') { SC.set(h.w, h.h, h.d); P.set(h.x, y, h.z); M.compose(P, Q, SC); walls.setMatrixAt(i, M); roofScale = 0; }
      else { SC.set(h.w, h.h, h.d); P.set(h.x, y, h.z); M.compose(P, Q, SC); walls.setMatrixAt(i, M); }
      if (roofScale === 0) { SC.set(0.001, 0.001, 0.001); P.set(h.x, y, h.z); M.compose(P, Q, SC); roofs.setMatrixAt(i, M); }
      else {
        const r = Math.max(h.w, h.d) * 0.72;
        if (h.kind === 'tent') SC.set(r * 1.15, h.h * 1.1, r * 1.15);
        else if (h.kind === 'mosque') SC.set(r * 0.9, 1.6, r * 0.9);
        else SC.set(r, h.h * 0.62 + 0.6, r);
        P.set(h.x, y + h.h, h.z); M.compose(P, Q, SC); roofs.setMatrixAt(i, M);
      }
      col.setHex(palette[i % palette.length]).offsetHSL(0, 0, (rng() - 0.5) * 0.05);
      if (h.kind === 'stall' || h.kind === 'fence' || h.kind === 'bed') col.setHex(h.kind === 'bed' ? 0x6b4a2a : 0x8a6a44);
      walls.setColorAt(i, col);
      col.setHex(h.kind === 'tent' ? 0xcbb894 : roofPalette[i % 2]);
      roofs.setColorAt(i, col);
    });
    walls.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true;
    if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
    scene.add(walls); scene.add(roofs);

    // 清真寺尖塔
    const minGeo = new THREE.CylinderGeometry(0.85, 1.25, 8, 8);
    const minaret = new THREE.Mesh(minGeo, new THREE.MeshLambertMaterial({ color: 0xc79a63 }));
    minaret.position.set(vil.x - 14, heightAt(vil.x - 14, vil.z + 20) + 4, vil.z + 20);
    minaret.castShadow = true;
    scene.add(minaret);

    // 集会树（巨猴面包）
    const gt = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.6, 7, 10), new THREE.MeshLambertMaterial({ color: COLOR.baobab }));
    trunk.position.y = 3.5; trunk.castShadow = true;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(6.4, 1), new THREE.MeshLambertMaterial({ color: 0x5f7c36 }));
    crown.position.y = 7.6; crown.scale.set(1, 0.62, 1); crown.castShadow = true;
    gt.add(trunk); gt.add(crown);
    const gx = vil.x + 2, gz = vil.z + 2;
    gt.position.set(gx, heightAt(gx, gz), gz);
    scene.add(gt);
    World.obstacles.push({ x: gx, z: gz, r: 3.4 });
  }

  /* ============ 水井 ============ */
  function makeWell(scene) {
    const s = SITES.find(v => v.id === 'well');
    const g = new THREE.Group();
    const y = heightAt(s.x, s.z);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 1.0, 16, 1, true),
      new THREE.MeshLambertMaterial({ color: 0x8a7a63, side: THREE.DoubleSide }));
    ring.position.set(0, 0.5, 0);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(1.4, 16), new THREE.MeshLambertMaterial({ color: 0x1b1410 }));
    inner.rotation.x = -Math.PI / 2; inner.position.y = 0.05;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a2a }));
    post.position.set(1.1, 1.6, 0);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.12), new THREE.MeshLambertMaterial({ color: 0x6b4a2a }));
    arm.position.set(0, 3.1, 0);
    const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.4, 8), new THREE.MeshLambertMaterial({ color: 0x3a2c1e }));
    bucket.position.set(-0.9, 2.0, 0);
    g.add(ring, inner, post, arm, bucket);
    g.position.set(s.x, y, s.z);
    scene.add(g);
    World.obstacles.push({ x: s.x, z: s.z, r: 2.0 });
    // 饮牛槽
    const trough = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 1.6), new THREE.MeshLambertMaterial({ color: 0x7d6a52 }));
    trough.position.set(s.x + 7, y + 0.25, s.z + 5);
    trough.rotation.y = 0.5;
    scene.add(trough);
    World._wellBucket = bucket;
  }

  /* ============ 牲畜（真实 GLB 模型） ============ */
  /* 牛 / 公牛 / 山羊 / 绵羊 / 骆驼 / 鸡，散布在牧民营地与水塘周边。
   * 不同作者对模型使用的「单位」不一致（有的 1 单位=1 米，有的 1 单位≈800 米），
   * 所以统一用包围盒把每只动物归一化到真实身高，避免巨大/过小。
   * 目标身高（米）由各模型真实比例给定。 */
  const ANIMAL_TARGET_H = {
    'vendor/models/cow.glb': 1.5, 'vendor/models/bull.glb': 1.7,
    'vendor/models/goat.glb': 0.7, 'vendor/models/sheep.glb': 0.9,
    'vendor/models/camel.glb': 2.2, 'vendor/models/chicken.glb': 0.42
  };
  function placeAnimals(scene) {
    const g = new THREE.Group();
    const defs = [
      ['vendor/models/cow.glb',    4, 108,  -58, 18],
      ['vendor/models/bull.glb',   1, 108,  -58, 12],
      ['vendor/models/goat.glb',   4, 120,  -74, 12],
      ['vendor/models/sheep.glb',  5, 126, -110, 16],
      ['vendor/models/camel.glb',  2, 132, -124, 14],
      ['vendor/models/chicken.glb', 7, 100,  -50, 10]
    ];
    defs.forEach(([path, count, cx, cz, rad]) => {
      const targetH = ANIMAL_TARGET_H[path] || 1.5;
      for (let i = 0; i < count; i++) {
        const inst = S.Models.instance(path);
        if (!inst) continue;
        const m = inst.scene;
        // 按包围盒归一化到目标身高
        const box = new THREE.Box3().setFromObject(m);
        const size = new THREE.Vector3(); box.getSize(size);
        const s = targetH / (size.y || targetH);
        m.scale.setScalar(s);
        m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = true; } });
        const ang = Math.random() * 6.283, rr = rad * (0.25 + Math.random() * 0.75);
        const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
        m.position.set(x, heightAt(x, z), z);
        m.rotation.y = Math.random() * 6.283;
        m.userData.phase = Math.random() * 6.283;
        m.userData.baseYaw = m.rotation.y;       // 基准朝向，仅做轻微摇摆，不再原地乱转
        m.userData.bob = Math.random() * 6.283;
        g.add(m);
      }
    });
    scene.add(g);
    World._animals = g;
  }

  /* ============ 沙尘粒子 ============ */
  function makeDust(scene) {
    const N = 900;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 260;
      pos[i * 3 + 1] = Math.random() * 26;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 260;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xe0c79b, size: 0.5, transparent: true, opacity: 0.0,
      depthWrite: false, sizeAttenuation: true
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    scene.add(p);
    World._dust = p;
  }

  /* ============ 构建全部 ============ */
  World.build = function (onProgress) {
    const rng = makeRng(20240721);
    const steps = [
      ['正在隆起萨赫勒的土地…', () => { this.ground = buildGround(); this.scene.add(this.ground); }],
      ['正在灌注旱谷的水…', () => { this.scene.add(buildWater()); }],
      ['正在种下金合欢与猴面包树…', () => { placeTrees(this.scene, rng); }],
      ['正在铺开草丛与砾石…', () => { placeGroundCover(this.scene, rng); }],
      ['正在砌起泥砖的村庄…', () => { makeBuildings(this.scene, rng); }],
      ['正在打一口老井…', () => { makeWell(this.scene); }],
      ['正在赶来牛群…', () => { placeAnimals(this.scene); }],
      ['正在起风…', () => { makeDust(this.scene); }]
    ];
    let i = 0;
    return new Promise(resolve => {
      const tick = () => {
        if (i >= steps.length) { resolve(); return; }
        const [label, fn] = steps[i];
        if (onProgress) onProgress(label, i / steps.length);
        fn();
        i++;
        setTimeout(tick, 16);
      };
      tick();
    });
  };

  /* ============ 季节与天气 ============ */
  const SKY = {
    dry: { top: 0x3f83c0, mid: 0xd8cdae, bot: 0xe8c27a, sun: 0xfff0d0, fog: 0xdcc79b, fogN: 95, fogF: 430, hemi: 0.78, sunI: 1.45 },
    rain: { top: 0x5b7fa6, mid: 0xa9b3a4, bot: 0x8fa06f, sun: 0xdce6d2, fog: 0xa8b298, fogN: 60, fogF: 300, hemi: 0.62, sunI: 1.05 }
  };
  const STORM = { top: 0xa07a44, mid: 0xc79a55, bot: 0xd8a860, sun: 0xe8b96a, fog: 0xc79a55, fogN: 16, fogF: 130, hemi: 0.55, sunI: 0.55 };

  World.setSeason = function (season) {
    this.season = season;
    const p = SKY[season] || SKY.dry;
    this._skyTop.setHex(p.top); this._skyBot.setHex(p.bot);
    this.skyMat.uniforms.topColor.value.setHex(p.top);
    this.skyMat.uniforms.midColor.value.setHex(p.mid);
    this.skyMat.uniforms.botColor.value.setHex(p.bot);
    this.skyMat.uniforms.sunColor.value.setHex(p.sun);
    this.scene.fog.color.setHex(p.fog);
    this.scene.fog.near = p.fogN; this.scene.fog.far = p.fogF;
    this.hemi.intensity = p.hemi;
    this.sun.intensity = p.sunI;
    // 植被：雨季更绿
    const green = season === 'rain';
    if (this._grassMat) this._grassMat.color.setHex(green ? 0x7d9440 : 0x9aa457);
    if (this._canopyMats[0]) this._canopyMats[0].color.setHex(green ? 0x4c7a2a : COLOR.canopy);
    if (this._canopyMats[2]) this._canopyMats[2].color.setHex(green ? 0x53763a : COLOR.scrub);
    if (this._waterMesh !== null) { /* 雨季水面略涨 */ }
  };

  World.setStorm = function (on) {
    this.stormTarget = on ? 1 : 0;
  };

  /* ============ 碰撞 ============ */
  World.collide = function (x, z, r) {
    let px = x, pz = z;
    for (let i = 0; i < 3; i++) {
      let moved = false;
      for (const o of this.obstacles) {
        const dx = px - o.x, dz = pz - o.z;
        const rr = o.r + r;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          px = o.x + (dx / d) * rr;
          pz = o.z + (dz / d) * rr;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return { x: px, z: pz };
  };

  World.clampToWorld = function (x, z) {
    const L = WORLD.half - 14;
    return { x: clamp(x, -L, L), z: clamp(z, -L, L) };
  };

  /* ============ 交互标记 ============ */
  World.addMarker = function (x, z, color, type) {
    const y = heightAt(x, z);
    const g = new THREE.Group();
    let mesh;
    if (type === 'probe') {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.85, 5.5, 10, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false })
      );
      beam.position.y = 2.75;
      const spin = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color }));
      spin.position.y = 0.9;
      g.add(beam, spin);
      g.userData.spin = spin;
    } else if (type === 'pit') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.14, 6, 14), new THREE.MeshLambertMaterial({ color }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1;
      const dirt = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 0.28, 10), new THREE.MeshLambertMaterial({ color: 0x5a3a1c }));
      dirt.position.y = -0.1;
      g.add(ring, dirt);
    } else if (type === 'stone') {
      for (let i = 0; i < 7; i++) {
        const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28 + Math.random() * 0.16, 0),
          new THREE.MeshLambertMaterial({ color: 0x9a8f7c, flatShading: true }));
        s.position.set((i - 3) * 0.42, 0.2, 0);
        s.rotation.set(Math.random(), Math.random(), Math.random());
        s.castShadow = true;
        g.add(s);
      }
    } else if (type === 'tree') {
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.5, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a2a }));
      tr.position.y = 0.75; tr.castShadow = true;
      const cr = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 0), new THREE.MeshLambertMaterial({ color: 0x5c7a34 }));
      cr.position.y = 1.7; cr.scale.set(1.25, 0.7, 1.25); cr.castShadow = true;
      g.add(tr, cr);
    } else {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), new THREE.MeshBasicMaterial({ color }));
      mesh.position.y = 1.2;
      g.add(mesh);
    }
    g.position.set(x, y, z);
    g.userData.baseY = y;
    g.userData.t = Math.random() * 6.28;
    this.scene.add(g);
    this.markers.push(g);
    return g;
  };

  World.removeMarker = function (g) {
    if (!g) return;
    this.scene.remove(g);
    const i = this.markers.indexOf(g);
    if (i >= 0) this.markers.splice(i, 1);
  };

  World.clearMarkers = function () {
    this.markers.slice().forEach(m => this.removeMarker(m));
  };

  /* ============ 每帧更新 ============ */
  World.update = function (dt, playerPos) {
    this.time += dt;
    const t = this.time;

    // 标记浮动
    for (const m of this.markers) {
      m.userData.t += dt;
      if (m.userData.spin) {
        m.userData.spin.rotation.y += dt * 1.6;
        m.userData.spin.rotation.x += dt * 0.8;
        m.userData.spin.position.y = 0.9 + Math.sin(m.userData.t * 2) * 0.22;
      }
    }

    // 牲畜：原地轻微摇摆 / 呼吸，不再持续累积旋转（避免「原地乱转」）
    if (this._animals) {
      for (const c of this._animals.children) {
        c.userData.phase += dt * 0.6;
        c.userData.bob += dt * 1.4;
        c.position.y = heightAt(c.position.x, c.position.z) + Math.abs(Math.sin(c.userData.bob)) * 0.04;
        c.rotation.y = c.userData.baseYaw + Math.sin(c.userData.phase) * 0.18;
      }
    }
    // 井桶
    if (this._wellBucket) this._wellBucket.position.y = 2.0 + Math.sin(t * 0.8) * 0.35;

    // 沙尘
    if (this._dust) {
      const target = (this.stormTarget || 0);
      this.storm += (target - this.storm) * Math.min(dt * 1.2, 1);
      const st = this.storm;
      this._dust.material.opacity = st * 0.55;
      this._dust.material.size = 0.4 + st * 0.5;
      if (st > 0.01) {
        const arr = this._dust.geometry.attributes.position.array;
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] += dt * 26;
          arr[i + 2] += dt * 9;
          if (arr[i] > 130) arr[i] -= 260;
          if (arr[i + 2] > 130) arr[i + 2] -= 260;
        }
        this._dust.geometry.attributes.position.needsUpdate = true;
        this._dust.position.set(playerPos.x, 0, playerPos.z);
      }
      // 雾与光的插值
      const dry = SKY[this.season] || SKY.dry;
      const f = this.scene.fog;
      f.color.lerpColors(new THREE.Color(dry.fog), new THREE.Color(STORM.fog), st);
      f.near = lerp(dry.fogN, STORM.fogN, st);
      f.far = lerp(dry.fogF, STORM.fogF, st);
      this.sun.intensity = lerp(dry.sunI, STORM.sunI, st);
      this.hemi.intensity = lerp(dry.hemi, STORM.hemi, st);
      this.skyMat.uniforms.topColor.value.lerpColors(new THREE.Color(dry.top), new THREE.Color(STORM.top), st);
      this.skyMat.uniforms.midColor.value.lerpColors(new THREE.Color(dry.mid), new THREE.Color(STORM.mid), st);
      this.skyMat.uniforms.botColor.value.lerpColors(new THREE.Color(dry.bot), new THREE.Color(STORM.bot), st);
      // 太阳角度（沙尘暴时压低）
      const ang = 0.5 + Math.sin(t * 0.02) * 0.1;
      this.sun.position.set(Math.cos(ang) * 90, lerp(95, 55, st), Math.sin(ang) * 70);
    }

    // 阴影相机跟随玩家
    if (playerPos) {
      this.sun.target.position.set(playerPos.x, 0, playerPos.z);
      this.sun.position.set(playerPos.x + 60, 90, playerPos.z + 40);
      this.sun.target.updateMatrixWorld();
    }
    // 天空跟随相机
    if (this.sky && this.camera) this.sky.position.copy(this.camera.position);
  };

  global.SOS.World = World;
})(window);
