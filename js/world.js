/* ================================================================
 *  world.js —— 3D 開放世界：地形 · 植被 · 聚落 · 天空 · 季節
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const { WORLD, SITES, COLOR, clamp, lerp, dist2, fbm, makeRng, heightAt, aridityAt } = S;

  /* 道路網絡（折線，用於給地形上色） */
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
    markers: [],         // 動態交互標記
    ground: null,
    season: 'dry',
    storm: 0,
    time: 0,
    _waterMesh: null,
    _canopyMats: [],
    _grassMat: null,
    _detailGrassMeshes: [],
    _skyTop: new THREE.Color(), _skyBot: new THREE.Color()
  };

  /* ============ 初始化渲染器與場景 ============ */
  World.init = function (canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: window.devicePixelRatio < 2 });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.3, 1200);
    camera.position.set(0, 12, 80);
    this.camera = camera;

    // 光：暖色調薩赫勒陽光 + 更柔和的環境光，讓陰影不死黑
    const hemi = new THREE.HemisphereLight(0xffe8c4, 0x6b4a2a, 0.95);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffd9a0, 1.55);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.near = 1; sc.far = 380; sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);
    // 補光：冷色環境反射，避免暗部死黑
    const fill = new THREE.DirectionalLight(0x9bb8d8, 0.28);
    fill.position.set(-40, 50, -30);
    scene.add(fill);
    this.sun = sun; this.hemi = hemi; this.fill = fill;

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

  /* 向下射線檢測地形網格，返回“可見表面”的真實高度。
   * 比 heightAt 更準：heightAt 是平滑解析面，而渲染網格在頂點之間是線性插值，
   * 二者在頂點之外略有差異；用射線貼合可見網格可徹底消除 NPC/物體“懸浮”。 */
  World.groundY = function (x, z) {
    if (!this._gRay) { this._gRay = new THREE.Raycaster(); this._gDown = new THREE.Vector3(0, -1, 0); }
    if (this.ground) {
      this.ground.updateMatrixWorld(true);
      this._gRay.set(new THREE.Vector3(x, 1000, z), this._gDown);
      const hits = this._gRay.intersectObject(this.ground, false);
      if (hits.length) return hits[0].point.y;
    }
    return heightAt(x, z);
  };

  /* 畫質設置：high / medium / low —— 實時調整像素比、陰影與陰影貼圖分辨率 */
  World.applyQuality = function (q) {
    if (!this.renderer) return;
    const dpr = window.devicePixelRatio || 1;
    const r = this.renderer;
    if (q === 'low') {
      r.setPixelRatio(1);
      r.shadowMap.enabled = false;
      if (this.sun) this.sun.castShadow = false;
    } else if (q === 'medium') {
      r.setPixelRatio(Math.min(dpr, 1.5));
      r.shadowMap.enabled = true;
      if (this.sun) { this.sun.castShadow = true; this.sun.shadow.mapSize.set(1024, 1024); }
    } else {
      r.setPixelRatio(Math.min(dpr, 2));
      r.shadowMap.enabled = true;
      if (this.sun) { this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); }
    }
    if (this.sun && this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    r.shadowMap.needsUpdate = true;
    const grassLimit = q === 'low' ? 220 : (q === 'medium' ? 420 : 720);
    (this._detailGrassMeshes || []).forEach(mesh => {
      mesh.count = Math.min(grassLimit, mesh.userData.placedCount || 0);
    });
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
      // 底色調：濕→幹
      if (a < 0.42) { cA.copy(cGrass).lerp(cGrassDry, a / 0.42); }
      else if (a < 0.72) { cA.copy(cGrassDry).lerp(cSoil, (a - 0.42) / 0.30); }
      else { cA.copy(cSoil).lerp(cSand, (a - 0.72) / 0.28); }
      // 高處偏沙/巖
      if (h > 7) cA.lerp(cSandPale, clamp((h - 7) / 12, 0, 0.6));
      // 斑駁
      const n = fbm(x * 0.06 + 7, z * 0.06 + 3, 3);
      cA.offsetHSL(0, (n - 0.5) * 0.06, (n - 0.5) * 0.09);
      // 道路
      const dr = distToRoad(x, z);
      if (dr < 4.2) {
        tmp.setHex(0xd8b483);
        cA.lerp(tmp, clamp(1 - dr / 4.2, 0, 1) * 0.78);
      }
      // 沙丘頂部泛白
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
    // 濕泥邊
    const ringGeo = new THREE.RingGeometry(24, 33, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshLambertMaterial({ color: 0x6d5a34 }));
    ring.position.set(WORLD.water.x, -3.6, WORLD.water.z);
    g.add(ring);
    return g;
  }

  /* ============ 樹 ============ */
  /* kinds: 0 金合歡(傘形) 1 猴麪包 2 棕櫚 3 灌木 */
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
      // 密度隨乾旱度下降
      const density = clamp(1.15 - a * 1.25, 0.03, 1);
      if (rng() > density * 0.55) continue;
      if (dr < 4.5 && rng() > 0.12) continue;
      // 離建築遠一點
      let nearSite = false;
      for (const s of SITES) {
        if ((s.kind === 'village' || s.kind === 'market' || s.kind === 'camp') &&
            Math.sqrt(dist2(x, z, s.x, s.z)) < s.r * 0.55) { nearSite = true; break; }
      }
      if (nearSite) continue;
      let kind = 0;
      const r = rng();
      if (a < 0.34 && r < 0.12) kind = 1;          // 猴麪包（南部）
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

    /* ---- 真實 GLB 樹（來自 Poly Pizza / Quaternius，CC0）---- */
    const gltfTree = S.Models.get('vendor/models/tree.glb');
    const treeNodes = [];
    if (gltfTree) {
      gltfTree.scene.traverse(o => { if (/^NormalTree_\d+$/.test(o.name || '')) treeNodes.push(o); });
      treeNodes.sort((a, b) => a.name.localeCompare(b.name));
    }
    // 增加薩赫勒樹種變體；模型共享 GLB 幾何/材質，場景中僅克隆節點。
    ['vendor/models/acacia.glb', 'vendor/models/savanna_tree.glb'].forEach(path => {
      const variant = S.Models.get(path);
      if (variant) treeNodes.push(variant.scene);
    });

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

    // 模型缺失時的程序化降級（極少觸發）
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
      if (t.kind === 0) {        // 金合歡：傘形
        placeOneTree(src, t.x, t.z, 4.0 + rng() * 2.4);
        if (rng() < 0.3) World.obstacles.push({ x: t.x, z: t.z, r: 1.1 });
      } else if (t.kind === 1) { // 猴麪包：巨幹
        placeOneTree(src, t.x, t.z, 5.6 + rng() * 1.4);
        World.obstacles.push({ x: t.x, z: t.z, r: 1.9 });
      } else if (t.kind === 2) { // 棕櫚
        placeOneTree(src, t.x, t.z, 5.2 + rng() * 2.0);
      } else {                   // 灌木：用最小的樹縮小
        placeOneTree(treeNodes[treeNodes.length - 1], t.x, t.z, 1.6 + rng() * 1.0);
      }
    }
    return treeSpots;
  }

  /* ============ 草叢 / 石頭 ============ */
  function placeGroundCover(scene, rng) {
    // 草：只在較濕潤區
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

    // 額外的真實草叢：保持批次 InstancedMesh，不為每株建立獨立場景物件。
    const grassAsset = S.Models.get('vendor/models/tall_grass.glb');
    if (grassAsset) {
      const quality = S.Settings && S.Settings.data ? S.Settings.data.quality : 'high';
      const qualityLimit = quality === 'low' ? 220 : (quality === 'medium' ? 420 : 720);
      const capacity = 720;
      World._detailGrassMeshes = [];
      const detailRng = makeRng(20251023);
      const sources = [];
      grassAsset.scene.updateMatrixWorld(true);
      grassAsset.scene.traverse(o => { if (o.isMesh && o.geometry && o.material) sources.push(o); });
      sources.forEach(src => {
        const patch = new THREE.InstancedMesh(src.geometry, src.material, capacity);
        patch.castShadow = false;
        patch.receiveShadow = false;
        const base = src.matrixWorld.clone();
        let placed = 0, attempts = 0;
        while (placed < capacity && attempts < capacity * 16) {
          attempts++;
          const x = (detailRng() - 0.5) * WORLD.size * 0.92;
          const z = (detailRng() - 0.5) * WORLD.size * 0.92;
          const aridity = aridityAt(x, z);
          const density = clamp(1.05 - aridity * 1.35, 0, 1);
          if (detailRng() > density * 0.72) continue;
          const scale = 0.3 + detailRng() * 0.3;
          P.set(x, heightAt(x, z), z);
          Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), detailRng() * 6.283);
          SC.set(scale, scale, scale);
          M.compose(P, Q, SC).multiply(base);
          patch.setMatrixAt(placed, M);
          col.setRGB(1, 1, 1).lerp(cDry, clamp(aridity * 0.55, 0, 0.5));
          patch.setColorAt(placed, col);
          placed++;
        }
        patch.userData.placedCount = placed;
        patch.count = Math.min(qualityLimit, placed);
        patch.instanceMatrix.needsUpdate = true;
        if (patch.instanceColor) patch.instanceColor.needsUpdate = true;
        patch.computeBoundingSphere();
        World._detailGrassMeshes.push(patch);
        scene.add(patch);
      });
    }

    // 石頭
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

  /* ============ 建築系統 ============ */
  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  wallGeo.translate(0, 0.5, 0);
  const roofGeo = new THREE.ConeGeometry(0.78, 0.62, 8);
  roofGeo.translate(0, 0.5, 0);

  function makeBuildings(scene, rng) {
    const wallMat = new THREE.MeshLambertMaterial({ color: COLOR.mudWall });
    const roofMat = new THREE.MeshLambertMaterial({ color: COLOR.thatch });
    const houseSpecs = [];

    /* --- 村莊科多戈 --- */
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
    // 糧倉（圓柱）
    houseSpecs.push({ x: vil.x + 16, z: vil.z + 6, w: 2.6, d: 2.6, h: 3.4, kind: 'granary', rot: 0.3 });
    World.obstacles.push({ x: vil.x + 16, z: vil.z + 6, r: 2.0 });
    houseSpecs.push({ x: vil.x + 19, z: vil.z + 11, w: 2.2, d: 2.2, h: 3.0, kind: 'granary', rot: -0.2 });
    // 清真寺（尖塔）
    houseSpecs.push({ x: vil.x - 14, z: vil.z + 20, w: 6.5, d: 6.5, h: 3.4, kind: 'mosque', rot: 0 });
    World.obstacles.push({ x: vil.x - 14, z: vil.z + 20, r: 4.2 });
    // 小學
    houseSpecs.push({ x: vil.x + 30, z: vil.z + 22, w: 7, d: 5, h: 3.0, kind: 'school', rot: 0.1 });
    World.obstacles.push({ x: vil.x + 30, z: vil.z + 22, r: 4.5 });

    /* --- 集市卡亞鎮 --- */
    const mk = SITES.find(s => s.id === 'market');
    for (let i = 0; i < 14; i++) {
      const x = mk.x + (rng() - 0.5) * 58, z = mk.z + (rng() - 0.5) * 44;
      if (distToRoad(x, z) < 5) continue;
      houseSpecs.push({ x, z, w: 3 + rng() * 2, d: 3 + rng() * 1.6, h: 2.4 + rng() * 0.8, kind: 'house', rot: rng() * 6.28 });
      World.obstacles.push({ x, z, r: 2.0 });
    }
    // 攤檔（矮台 + 遮陽棚）
    for (let i = 0; i < 12; i++) {
      const x = mk.x + (rng() - 0.5) * 52, z = mk.z + (rng() - 0.5) * 30;
      houseSpecs.push({ x, z, w: 2.4 + rng() * 1.2, d: 2.0, h: 0.9, kind: 'stall', rot: rng() * 6.28 });
    }

    /* --- 牧民營地（帳篷） --- */
    const camp = SITES.find(s => s.id === 'camp');
    for (let i = 0; i < 8; i++) {
      const ang = rng() * 6.283, rad = rng() * 18;
      houseSpecs.push({ x: camp.x + Math.cos(ang) * rad, z: camp.z + Math.sin(ang) * rad, w: 3.2, d: 3.2, h: 2.0, kind: 'tent', rot: rng() * 6.28 });
    }
    // 畜欄
    houseSpecs.push({ x: camp.x - 14, z: camp.z + 8, w: 12, d: 0.4, h: 1.2, kind: 'fence', rot: 0.2 });

    /* --- 苗圃 --- */
    const nur = SITES.find(s => s.id === 'nursery');
    houseSpecs.push({ x: nur.x, z: nur.z + 6, w: 6, d: 4.5, h: 2.6, kind: 'nursery', rot: 0 });
    World.obstacles.push({ x: nur.x, z: nur.z + 6, r: 3.4 });
    for (let i = 0; i < 10; i++) {
      houseSpecs.push({ x: nur.x - 18 + i * 4, z: nur.z - 8, w: 3, d: 1.2, h: 0.5, kind: 'bed', rot: 0 });
    }

    /* --- 車站 --- */
    const st = SITES.find(s => s.id === 'station');
    houseSpecs.push({ x: st.x, z: st.z + 8, w: 7, d: 4, h: 2.8, kind: 'school', rot: 0 });
    World.obstacles.push({ x: st.x, z: st.z + 8, r: 4 });

    /* --- 農田田埂（矮牆段） --- */
    const farm = SITES.find(s => s.id === 'farm');
    for (let i = 0; i < 6; i++) {
      houseSpecs.push({ x: farm.x - 20 + i * 8, z: farm.z + 14, w: 7, d: 0.5, h: 0.55, kind: 'fence', rot: 0 });
    }

    /* --- 真實 GLB 建築：house/granary/stall/nursery/mosque/school/tent 用真實模型；
           缺失該 GLB 時走程序化兜底，避免建築消失或錯位 --- */
    const M = {
      house: [
        S.Models.get('vendor/models/hut.glb'),
        S.Models.get('vendor/models/hut_variant_b.glb')
      ].filter(Boolean),
      granary:  S.Models.get('vendor/models/hut.glb'),
      nursery:  S.Models.get('vendor/models/hut.glb'),
      stall:    S.Models.get('vendor/models/stall.glb') || S.Models.get('vendor/models/hut.glb'),
      mosque:   S.Models.get('vendor/models/mosque.glb'),
      school:   S.Models.get('vendor/models/school.glb'),
      tent:     S.Models.get('vendor/models/tent.glb'),
      baobab:   S.Models.get('vendor/models/baobab.glb')
    };

    // 把 GLB 節點歸一化到目標尺寸、腳底對齊地面後襬放。
    // 統一縮放（sW 與 sH 取大值）：既鋪滿佔地又不矮於目標高度，絕不拉伸變形。
    const placeModel = (gltf, x, z, targetH, targetW, rot) => {
      let node;
      try { node = window.SkeletonUtils ? window.SkeletonUtils.clone(gltf.scene) : gltf.scene.clone(true); }
      catch (e) { node = gltf.scene.clone(true); }
      node.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      const box = new THREE.Box3().setFromObject(node);
      const sz = new THREE.Vector3(); box.getSize(sz);
      const sW = targetW / (Math.max(sz.x, sz.z) || targetW);
      const sH = targetH / (sz.y || targetH);
      const sc = Math.max(sW, sH);
      node.scale.setScalar(sc);
      const box2 = new THREE.Box3().setFromObject(node);
      const y = heightAt(x, z);
      node.position.set(x, y - box2.min.y, z);
      node.rotation.y = rot || 0;
      scene.add(node);
      return Math.max(sz.x, sz.z) * sc * 0.5;
    };

    houseSpecs.forEach(h => {
      const candidates = h.kind === 'house' ? M.house : [M[h.kind]];
      const model = candidates && candidates.length
        ? candidates[Math.floor(rng() * candidates.length)]
        : null;
      if (model) {
        const tw = (h.kind === 'stall' || h.kind === 'fence' || h.kind === 'bed') ? 0 : Math.max(h.w, h.d) * 0.92;
        const th = (h.kind === 'stall') ? 2.1 : h.h;
        const r = placeModel(model, h.x, h.z, th, tw, h.rot);
        if (h.kind === 'stall' || h.kind === 'tent') World.obstacles.push({ x: h.x, z: h.z, r: r || Math.max(h.w, h.d) * 0.5 });
        return;
      }
      // —— 程序化兜底（僅當對應 GLB 缺失）——
      const y = heightAt(h.x, h.z);
      const g = new THREE.Group();
      if (h.kind === 'fence' || h.kind === 'bed') {
        const m = new THREE.Mesh(new THREE.BoxGeometry(h.w, h.h, h.d),
          new THREE.MeshLambertMaterial({ color: h.kind === 'bed' ? 0x6b4a2a : 0x8a6a44 }));
        m.position.y = h.h / 2; m.castShadow = true; g.add(m);
      } else if (h.kind === 'stall') {
        const base = new THREE.Mesh(new THREE.BoxGeometry(h.w, 0.5, h.d), wallMat); base.position.y = 0.25; base.castShadow = true;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h.h + 0.6, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a2a }));
        post.position.set(h.w / 2 - 0.2, h.h / 2 + 0.3, h.d / 2 - 0.2);
        const post2 = post.clone(); post2.position.x = -(h.w / 2 - 0.2);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(h.w + 0.6, 0.12, h.d + 0.6), roofMat); roof.position.y = h.h + 0.5;
        g.add(base, post, post2, roof);
        World.obstacles.push({ x: h.x, z: h.z, r: Math.max(h.w, h.d) * 0.6 });
      } else if (h.kind === 'tent') {
        const tent = new THREE.Mesh(new THREE.ConeGeometry(Math.max(h.w, h.d) * 0.62, h.h * 1.35, 14),
          new THREE.MeshLambertMaterial({ color: 0xcbb894 }));
        tent.position.y = h.h * 0.67; tent.castShadow = true; g.add(tent);
        const door = new THREE.Mesh(new THREE.PlaneGeometry(h.w * 0.4, h.h * 0.7),
          new THREE.MeshLambertMaterial({ color: 0x7a5f3c, side: THREE.DoubleSide }));
        door.position.set(0, h.h * 0.35, Math.max(h.w, h.d) * 0.58); g.add(door);
        World.obstacles.push({ x: h.x, z: h.z, r: Math.max(h.w, h.d) * 0.6 });
      } else if (h.kind === 'mosque') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(h.w, h.h, h.d), wallMat); body.position.y = h.h / 2; body.castShadow = true;
        const dome = new THREE.Mesh(new THREE.SphereGeometry(h.w * 0.42, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshLambertMaterial({ color: 0xcdb286 })); dome.position.y = h.h; dome.castShadow = true;
        const minaret = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.95, h.h + 4, 10), wallMat);
        minaret.position.set(h.w * 0.5 + 1, (h.h + 4) / 2, 0); minaret.castShadow = true;
        g.add(body, dome, minaret);
      } else if (h.kind === 'school') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(h.w, h.h, h.d), wallMat); body.position.y = h.h / 2; body.castShadow = true;
        const roof = new THREE.Mesh(new THREE.BoxGeometry(h.w + 0.4, 0.4, h.d + 0.4), roofMat); roof.position.y = h.h;
        const door = new THREE.Mesh(new THREE.PlaneGeometry(1.4, h.h * 0.7), new THREE.MeshLambertMaterial({ color: 0x5a3a1c, side: THREE.DoubleSide }));
        door.position.set(0, h.h * 0.35, h.d / 2 + 0.01);
        g.add(body, roof, door);
      } else {
        // house / granary / nursery 兜底
        const body = new THREE.Mesh(new THREE.BoxGeometry(h.w, h.h, h.d), wallMat); body.position.y = h.h / 2; body.castShadow = true;
        const roof = new THREE.Mesh(roofGeo, roofMat); roof.scale.set(Math.max(h.w, h.d) * 0.72, h.h * 0.62 + 0.6, Math.max(h.w, h.d) * 0.72);
        roof.position.y = h.h; g.add(body, roof);
      }
      g.position.set(h.x, y, h.z); g.rotation.y = h.rot;
      scene.add(g);
    });

    // 集會猴麪包樹：真實猴麪包模型優先，否則程序化
    const gx = vil.x + 2, gz = vil.z + 2;
    if (M.baobab) {
      placeModel(M.baobab, gx, gz, 9.5, 9, 0);
      World.obstacles.push({ x: gx, z: gz, r: 3.6 });
    } else {
      const gt = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.6, 7, 10), new THREE.MeshLambertMaterial({ color: COLOR.baobab }));
      trunk.position.y = 3.5; trunk.castShadow = true;
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(6.4, 1), new THREE.MeshLambertMaterial({ color: 0x5f7c36 }));
      crown.position.y = 7.6; crown.scale.set(1, 0.62, 1); crown.castShadow = true;
      gt.add(trunk); gt.add(crown);
      gt.position.set(gx, heightAt(gx, gz), gz);
      scene.add(gt);
      World.obstacles.push({ x: gx, z: gz, r: 3.4 });
    }
  }

  /* ============ 水井 ============ */
  function makeWell(scene) {
    const s = SITES.find(v => v.id === 'well');
    const y = heightAt(s.x, s.z);
    const gltfWell = S.Models.get('vendor/models/well.glb');
    if (gltfWell) {
      let node;
      try { node = window.SkeletonUtils ? window.SkeletonUtils.clone(gltfWell.scene) : gltfWell.scene.clone(true); }
      catch (e) { node = gltfWell.scene.clone(true); }
      node.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      const box = new THREE.Box3().setFromObject(node);
      const sz = new THREE.Vector3(); box.getSize(sz);
      const sc = 1.5 / (sz.y || 1.5);          // 水井目標約 1.5m 高
      node.scale.setScalar(sc);
      const box2 = new THREE.Box3().setFromObject(node);
      node.position.set(s.x, y - box2.min.y, s.z);
      scene.add(node);
    } else {
      const g = new THREE.Group();
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
      World._wellBucket = bucket;
    }
    World.obstacles.push({ x: s.x, z: s.z, r: 2.0 });
    // 飲牛槽
    const trough = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 1.6), new THREE.MeshLambertMaterial({ color: 0x7d6a52 }));
    trough.position.set(s.x + 7, y + 0.25, s.z + 5);
    trough.rotation.y = 0.5;
    scene.add(trough);
  }

  /* ============ 牲畜（真實 GLB 模型） ============ */
  /* 牛 / 公牛 / 山羊 / 綿羊 / 駱駝 / 雞，散佈在牧民營地與水塘周邊。
   * 不同作者對模型使用的「單位」不一致（有的 1 單位=1 米，有的 1 單位≈800 米），
   * 所以統一用包圍盒把每隻動物歸一化到真實身高，避免巨大/過小。
   * 目標身高（米）由各模型真實比例給定。 */
  const ANIMAL_TARGET_H = {
    'vendor/models/cow.glb': 1.5, 'vendor/models/cow_quaternius.glb': 1.5,
    'vendor/models/cow_madtroll.glb': 1.5, 'vendor/models/bull.glb': 1.7,
    'vendor/models/goat.glb': 0.7, 'vendor/models/sheep.glb': 0.9,
    'vendor/models/camel.glb': 2.2, 'vendor/models/chicken.glb': 0.42
  };
  function makeCowFallback(isBull) {
    const animal = new THREE.Group();
    const coat = new THREE.MeshLambertMaterial({ color: isBull ? 0x76513b : 0xc7b28f });
    const dark = new THREE.MeshLambertMaterial({ color: 0x46352b });
    const light = new THREE.MeshLambertMaterial({ color: 0xe1d5bb });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), coat);
    body.scale.set(1.0, 0.72, 1.55); body.position.y = 0.78; animal.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 10, 8), coat);
    head.position.set(0, 1.04, 1.32); animal.add(head);
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 6), light);
    muzzle.scale.set(1.0, 0.72, 0.85); muzzle.position.set(0, 0.94, 1.57); animal.add(muzzle);
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.28, 6), light);
      horn.position.set(side * 0.2, 1.35, 1.27); horn.rotation.z = side * -0.25; animal.add(horn);
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.12), dark);
      ear.position.set(side * 0.32, 1.12, 1.18); ear.rotation.y = side * 0.2; animal.add(ear);
      for (const z of [-0.82, 0.82]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.53, 6), coat);
        leg.position.set(side * 0.32, 0.28, z); animal.add(leg);
      }
    }
    return animal;
  }

  // 模型加载失败时仍保留可见牲畜，避免某一份 GLB 失败让整类动物消失。
  function makeAnimalFallback(path) {
    const key = path.split('/').pop().replace(/\\.glb$/i, '');
    if (key === 'cow' || key === 'cow_quaternius' || key === 'cow_madtroll' || key === 'bull') {
      return makeCowFallback(key === 'bull');
    }
    const cfg = {
      goat: { color: 0xb98a61, dark: 0x5a3825, body: [0.38, 0.45, 0.72], head: 0.22, leg: 0.48 },
      sheep: { color: 0xd7d0bd, dark: 0x6e6252, body: [0.48, 0.52, 0.78], head: 0.2, leg: 0.42 },
      camel: { color: 0xb9874e, dark: 0x69462c, body: [0.62, 0.68, 1.18], head: 0.25, leg: 0.9 },
      chicken: { color: 0xc66a36, dark: 0x7d2e22, body: [0.22, 0.25, 0.34], head: 0.12, leg: 0.24 }
    }[key] || { color: 0xa8845e, dark: 0x5a3825, body: [0.42, 0.48, 0.72], head: 0.2, leg: 0.5 };
    const animal = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: cfg.color });
    const darkMat = new THREE.MeshLambertMaterial({ color: cfg.dark });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 7), bodyMat);
    body.scale.set(cfg.body[0] / 0.5, cfg.body[1] / 0.5, cfg.body[2] / 0.5);
    body.position.y = cfg.leg + cfg.body[1]; animal.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(cfg.head, 8, 6), bodyMat);
    head.position.set(0, cfg.leg + cfg.body[1] * 1.35, cfg.body[2] + cfg.head * 0.65); animal.add(head);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, cfg.leg, 6), darkMat);
      leg.position.set(side * cfg.body[0] * 0.62, cfg.leg * 0.5, 0); animal.add(leg);
    }
    if (key === 'camel') {
      const hump = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), bodyMat);
      hump.scale.set(1.1, 1.5, 0.9); hump.position.set(0, cfg.leg + cfg.body[1] * 1.75, -0.18); animal.add(hump);
    } else if (key === 'chicken') {
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 5), new THREE.MeshLambertMaterial({ color: 0xe1a12b }));
      beak.rotation.x = Math.PI / 2; beak.position.set(0, cfg.leg + cfg.body[1] * 1.55, cfg.body[2] + cfg.head * 1.35); animal.add(beak);
    } else {
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 5), darkMat);
        ear.position.set(side * cfg.head * 0.75, cfg.leg + cfg.body[1] * 1.65, cfg.body[2]); ear.rotation.z = side * -0.35; animal.add(ear);
      }
    }
    return animal;
  }

  function syncAnimalMatrices(node) {
    node.updateMatrixWorld(true);
    node.traverse(o => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update(); });
    node.updateMatrixWorld(true);
  }

  function animalClip(animations, names) {
    if (!animations || !animations.length) return null;
    for (const name of names) {
      // Idle 必须优先匹配完整片段，避免误播 Idle_HitReact 等受击动作。
      if (name.toLowerCase() === 'idle') {
        const exact = animations.find(c => /(?:^|[| .-])idle$/i.test(c.name.trim()));
        if (exact) return exact;
        continue;
      }
      const clip = animations.find(c => new RegExp('(?:^|[| ._-])' + name + '(?:$|[| ._-])', 'i').test(c.name));
      if (clip) return clip;
    }
    return null;
  }

  function isCowPath(path) {
    return /(?:^|\/)(?:cow|cow_quaternius|cow_madtroll|bull)\.glb$/i.test(path);
  }

  function setAnimalAction(actor, moving) {
    if (!actor.mixer) return;
    const next = moving ? (actor.walkAction || actor.idleAction) : actor.idleAction;
    if (!next || actor.currentAction === next) return;
    if (actor.currentAction) actor.currentAction.fadeOut(0.35);
    next.reset().fadeIn(0.35).play();
    actor.currentAction = next;
  }

  function chooseCowTarget(actor) {
    const homeR = Math.max(3, actor.homeRadius * 0.82);
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * 6.283;
      const radius = 1.5 + Math.random() * homeR;
      const target = World.clampToWorld(
        actor.homeX + Math.cos(angle) * radius,
        actor.homeZ + Math.sin(angle) * radius
      );
      const safe = World.collide(target.x, target.z, actor.radius);
      if (Math.hypot(safe.x - target.x, safe.z - target.z) < 0.5) {
        actor.targetX = target.x;
        actor.targetZ = target.z;
        actor.wanderState = 'walk';
        actor.wanderTimer = 2.5 + Math.random() * 5.0;
        setAnimalAction(actor, true);
        return;
      }
    }
    actor.wanderState = 'rest';
    actor.wanderTimer = 2.0 + Math.random() * 4.0;
    setAnimalAction(actor, false);
  }

  function placeAnimals(scene) {
    const g = new THREE.Group();
    World._animalMixers = [];
    World._animalActors = [];
    const defs = [
      ['vendor/models/cow.glb',           2,  28,  76,  9],
      ['vendor/models/cow.glb',           2, 108, -58, 18],
      ['vendor/models/cow_quaternius.glb', 3, 108, -58, 25],
      ['vendor/models/cow_madtroll.glb',   2, 108, -58, 29],
      ['vendor/models/bull.glb',           1, 108, -58, 13],
      ['vendor/models/goat.glb',           2,  16,  82,  8],
      ['vendor/models/goat.glb',           2, 120, -74, 12],
      ['vendor/models/sheep.glb',          2,  -8,  88,  8],
      ['vendor/models/sheep.glb',          3, 126, -110, 16],
      ['vendor/models/camel.glb',          2, 132, -124, 14],
      ['vendor/models/chicken.glb',         7, 100, -50, 10]
    ];
    defs.forEach(([path, count, cx, cz, rad]) => {
      const targetH = ANIMAL_TARGET_H[path] || 1.5;
      for (let i = 0; i < count; i++) {
        const inst = S.Models.instance(path);
        const m = inst ? inst.scene : makeAnimalFallback(path);
        // 先同步骨骼，再按真实包围盒归一化，避免模型被算成零高或错误贴地。
        syncAnimalMatrices(m);
        let box = new THREE.Box3().setFromObject(m);
        const size = new THREE.Vector3(); box.getSize(size);
        const s = Number.isFinite(size.y) && size.y > 0.0001 ? targetH / size.y : 1;
        m.scale.setScalar(s);
        m.rotation.y = Math.random() * 6.283;
        syncAnimalMatrices(m);
        box = new THREE.Box3().setFromObject(m);
        const groundOffset = -box.min.y;
        m.traverse(o => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            // 動物數量很少；關閉骨骼網格裁剪，避免動畫包圍球過期導致整隻消失。
            o.frustumCulled = false;
          }
        });
        const ang = Math.random() * 6.283, rr = rad * (0.25 + Math.random() * 0.75);
        const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
        const terrainY = World.groundY(x, z);
        m.position.set(x, terrainY + groundOffset, z);
        m.userData.phase = Math.random() * 6.283;
        m.userData.baseYaw = m.rotation.y;
        m.userData.bob = Math.random() * 6.283;
        m.userData.groundOffset = groundOffset;
        m.userData.groundY = terrainY;
        m.userData.modelPath = path;
        const canWander = isCowPath(path);
        m.userData.species = canWander ? 'cow' : path.split('/').pop().replace(/\.glb$/i, '');
        m.userData.canWander = canWander;

        let mixer = null, idleAction = null, walkAction = null;
        if (inst && inst.animations && inst.animations.length) {
          const idle = animalClip(inst.animations, ['idle']);
          const walk = animalClip(inst.animations, ['walkslow', 'walk', 'run', 'gallop']);
          if (idle || walk) {
            mixer = new THREE.AnimationMixer(m);
            idleAction = idle ? mixer.clipAction(idle) : null;
            walkAction = walk ? mixer.clipAction(walk) : null;
            if (idleAction) idleAction.play();
            else if (walkAction) walkAction.play();
            World._animalMixers.push(mixer);
          }
        }
        const actor = {
          group: m, mixer, idleAction, walkAction,
          currentAction: idleAction || walkAction,
          homeX: cx, homeZ: cz, homeRadius: rad,
          targetX: x, targetZ: z,
          wanderState: canWander ? 'rest' : 'static',
          wanderTimer: canWander ? 1.5 + Math.random() * 4.0 : Infinity,
          wanderSpeed: 0.55 + Math.random() * 0.3,
          radius: canWander ? 0.65 : 0,
          modelPath: path
        };
        m.userData.animalActor = actor;
        if (canWander) World._animalActors.push(actor);
        g.add(m);
      }
    });
    scene.add(g);
    World._animals = g;
  }

  /* ============ 沙塵粒子 ============ */
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

    // 常態漂浮微塵（比沙塵暴稀疏、顏色更淡，讓空氣有體積感）
    const N2 = 260;
    const pos2 = new Float32Array(N2 * 3);
    for (let i = 0; i < N2; i++) {
      pos2[i * 3] = (Math.random() - 0.5) * 120;
      pos2[i * 3 + 1] = Math.random() * 12 + 0.3;
      pos2[i * 3 + 2] = (Math.random() - 0.5) * 120;
    }
    const geo2 = new THREE.BufferGeometry();
    geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
    const mat2 = new THREE.PointsMaterial({
      color: 0xf0e0b8, size: 0.18, transparent: true, opacity: 0.35,
      depthWrite: false, sizeAttenuation: true
    });
    const p2 = new THREE.Points(geo2, mat2);
    p2.frustumCulled = false;
    scene.add(p2);
    World._ambientDust = p2;
  }

  /* ============ 構建全部 ============ */
  World.build = function (onProgress) {
    const rng = makeRng(20240721);
    const steps = [
      ['正在隆起薩赫勒的土地…', () => { this.ground = buildGround(); this.scene.add(this.ground); }],
      ['正在灌注旱谷的水…', () => { this.scene.add(buildWater()); }],
      ['正在種下金合歡與猴麪包樹…', () => { placeTrees(this.scene, rng); }],
      ['正在鋪開草叢與礫石…', () => { placeGroundCover(this.scene, rng); }],
      ['正在砌起泥磚的村莊…', () => { makeBuildings(this.scene, rng); }],
      ['正在打一口老井…', () => { makeWell(this.scene); }],
      ['正在趕來牛羣…', () => { placeAnimals(this.scene); }],
      ['正在起風…', () => { makeDust(this.scene); }]
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

  /* ============ 季節與天氣 ============ */
  const SKY = {
    dry: { top: 0x3a78b8, mid: 0xe0d4ae, bot: 0xf0c878, sun: 0xfff0d0, fog: 0xe0c898, fogN: 100, fogF: 460, hemi: 0.95, sunI: 1.55 },
    rain: { top: 0x5b7fa6, mid: 0xa9b3a4, bot: 0x8fa06f, sun: 0xdce6d2, fog: 0xa8b298, fogN: 65, fogF: 320, hemi: 0.72, sunI: 1.1 }
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
    // 植被：雨季更綠
    const green = season === 'rain';
    if (this._grassMat) this._grassMat.color.setHex(green ? 0x7d9440 : 0x9aa457);
    if (this._canopyMats[0]) this._canopyMats[0].color.setHex(green ? 0x4c7a2a : COLOR.canopy);
    if (this._canopyMats[2]) this._canopyMats[2].color.setHex(green ? 0x53763a : COLOR.scrub);
    if (this._waterMesh !== null) { /* 雨季水面略漲 */ }
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

  /* ============ 交互標記 ============ */
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

  function updateCowActors(dt) {
    const actors = World._animalActors || [];
    for (const actor of actors) {
      const c = actor.group;
      actor.wanderTimer -= dt;
      c.userData.phase += dt * (actor.wanderState === 'walk' ? 1.4 : 0.6);
      c.userData.bob += dt * 1.4;

      if (actor.wanderState === 'rest') {
        if (actor.wanderTimer <= 0) chooseCowTarget(actor);
      } else if (actor.wanderState === 'walk') {
        const dx = actor.targetX - c.position.x;
        const dz = actor.targetZ - c.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.75 || actor.wanderTimer <= 0) {
          actor.wanderState = 'rest';
          actor.wanderTimer = 1.5 + Math.random() * 4.0;
          setAnimalAction(actor, false);
        } else {
          const desiredYaw = Math.atan2(dx, dz);
          let turn = desiredYaw - c.rotation.y;
          while (turn > Math.PI) turn -= Math.PI * 2;
          while (turn < -Math.PI) turn += Math.PI * 2;
          c.rotation.y += clamp(turn, -dt * 1.8, dt * 1.8);
          const step = Math.min(distance, actor.wanderSpeed * dt);
          const nx = c.position.x + Math.sin(c.rotation.y) * step;
          const nz = c.position.z + Math.cos(c.rotation.y) * step;
          const safe = World.clampToWorld(nx, nz);
          const resolved = World.collide(safe.x, safe.z, actor.radius);
          if (Math.hypot(resolved.x - c.position.x, resolved.z - c.position.z) < 0.001) {
            actor.wanderState = 'rest';
            actor.wanderTimer = 0.8 + Math.random() * 1.6;
            setAnimalAction(actor, false);
          } else {
            c.position.x = resolved.x;
            c.position.z = resolved.z;
          }
        }
      }

      if (actor.wanderState !== 'static') {
        c.userData.groundY = World.groundY(c.position.x, c.position.z);
        c.position.y = c.userData.groundY + (c.userData.groundOffset || 0)
          + Math.abs(Math.sin(c.userData.bob)) * (actor.wanderState === 'walk' ? 0.025 : 0.04);
      }
    }
  }

  /* ============ 每幀更新 ============ */
  World.update = function (dt, playerPos) {
    this.time += dt;
    const t = this.time;

    // 標記浮動
    for (const m of this.markers) {
      m.userData.t += dt;
      if (m.userData.spin) {
        m.userData.spin.rotation.y += dt * 1.6;
        m.userData.spin.rotation.x += dt * 0.8;
        m.userData.spin.position.y = 0.9 + Math.sin(m.userData.t * 2) * 0.22;
      }
    }

    // 牛模型使用獨立 Mixer 播放 Idle/Walk；其他牲畜保留輕微呼吸搖擺。
    if (this._animalMixers) this._animalMixers.forEach(mixer => mixer.update(dt));
    updateCowActors(dt);
    if (this._animals) {
      for (const c of this._animals.children) {
        if (c.userData.canWander) continue;
        c.userData.phase += dt * 0.6;
        c.userData.bob += dt * 1.4;
        c.position.y = (c.userData.groundY === undefined ? heightAt(c.position.x, c.position.z) : c.userData.groundY) + (c.userData.groundOffset || 0) + Math.abs(Math.sin(c.userData.bob)) * 0.04;
        c.rotation.y = c.userData.baseYaw + Math.sin(c.userData.phase) * 0.18;
      }
    }
    // 井桶
    if (this._wellBucket) this._wellBucket.position.y = 2.0 + Math.sin(t * 0.8) * 0.35;

    // 沙塵
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
      // 霧與光的插值
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
      // 太陽角度（沙塵暴時壓低）
      const ang = 0.5 + Math.sin(t * 0.02) * 0.1;
      this.sun.position.set(Math.cos(ang) * 90, lerp(95, 55, st), Math.sin(ang) * 70);
    }

    // 常態漂浮微塵：緩慢漂移，跟隨玩家
    if (this._ambientDust) {
      const arr = this._ambientDust.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += dt * 0.6;
        arr[i + 2] += dt * 0.25;
        if (arr[i] > 60) arr[i] -= 120;
        if (arr[i + 2] > 60) arr[i + 2] -= 120;
      }
      this._ambientDust.geometry.attributes.position.needsUpdate = true;
      this._ambientDust.position.set(playerPos.x, 0, playerPos.z);
    }

    // 陰影相機跟隨玩家
    if (playerPos) {
      this.sun.target.position.set(playerPos.x, 0, playerPos.z);
      this.sun.position.set(playerPos.x + 60, 90, playerPos.z + 40);
      this.sun.target.updateMatrixWorld();
    }
    // 天空跟隨相機
    if (this.sky && this.camera) this.sky.position.copy(this.camera.position);
  };

  global.SOS.World = World;
})(window);
