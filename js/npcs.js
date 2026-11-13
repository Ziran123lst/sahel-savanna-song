/* ================================================================
 *  npcs.js —— 村民模型、名字標籤與交互檢測
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const { COLOR, heightAt, dist2, clamp, INTERACTION_RADIUS } = S;

  const NPCs = { list: [] };

  function makeLabel(text, role) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(24,14,8,0.82)';
    const r = 26;
    c.beginPath();
    c.moveTo(r, 8); c.lineTo(cv.width - r, 8);
    c.quadraticCurveTo(cv.width - 8, 8, cv.width - 8, 8 + r);
    c.lineTo(cv.width - 8, cv.height - 8 - r);
    c.quadraticCurveTo(cv.width - 8, cv.height - 8, cv.width - 8 - r, cv.height - 8);
    c.lineTo(r, cv.height - 8);
    c.quadraticCurveTo(8, cv.height - 8, 8, cv.height - 8 - r);
    c.lineTo(8, 8 + r);
    c.quadraticCurveTo(8, 8, r, 8);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(232,201,143,0.5)'; c.lineWidth = 3; c.stroke();
    c.fillStyle = '#f6e6c3';
    c.font = 'bold 44px "PingFang TC","Microsoft JhengHei","PingFang SC","Microsoft YaHei",sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, cv.width / 2, 48);
    c.fillStyle = 'rgba(232,201,143,0.72)';
    c.font = '26px "PingFang TC","Microsoft JhengHei","PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText(role, cv.width / 2, 92);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(3.0, 0.75, 1);
    return sp;
  }

  function buildPerson(spec, rng) {
    const g = new THREE.Group();
    const clothCol = COLOR.cloth[spec.cloth % COLOR.cloth.length];
    const skinCol = COLOR.skin[spec.skin % COLOR.skin.length];
    const skin = new THREE.MeshLambertMaterial({ color: skinCol });
    const cloth = new THREE.MeshLambertMaterial({ color: clothCol });
    const white = new THREE.MeshLambertMaterial({ color: 0xefe6d2 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x33231a });

    const h = 0.94 + (spec.id === 'issa' ? -0.04 : 0) + (spec.id === 'aicha' ? -0.10 : 0);

    const legL = new THREE.Group(), legR = new THREE.Group();
    [legL, legR].forEach((leg, i) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.10, 0.44, 3, 6), skin);
      m.position.y = -0.30; m.castShadow = true;
      leg.add(m);
      leg.position.set(i === 0 ? -0.15 : 0.15, 0.72 * h, 0);
      g.add(leg);
    });

    // 長袍/衣裙
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.44, 0.92, 8), cloth);
    torso.position.y = 1.16 * h; torso.castShadow = true;
    g.add(torso);

    const armL = new THREE.Group(), armR = new THREE.Group();
    [armL, armR].forEach((arm, i) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.40, 3, 6), skin);
      m.position.y = -0.28; m.castShadow = true;
      arm.add(m);
      arm.position.set(i === 0 ? -0.33 : 0.33, 1.50 * h, 0);
      g.add(arm);
    });

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.20, 12, 10), skin);
    head.position.y = 1.80 * h; head.castShadow = true;
    g.add(head);

    // 頭巾 / 小帽
    if (spec.id === 'aicha' || spec.id === 'brahim' || spec.id === 'halima' || spec.id === 'fatima' || spec.id === 'kadi' || spec.id === 'fatou') {
      const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.075, 6, 14), cloth);
      wrap.rotation.x = Math.PI / 2;
      wrap.position.y = 1.90 * h;
      g.add(wrap);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.42, 0.06), cloth);
      tail.position.set(0.17, 1.66 * h, -0.06);
      tail.rotation.z = 0.22;
      g.add(tail);
    } else {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.205, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), white);
      cap.position.y = 1.84 * h;
      g.add(cap);
    }
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.02), dark);
    eye.position.set(0, 1.81 * h, 0.19);
    g.add(eye);

    g.userData.parts = { legL, legR, armL, armR, torso, head };
    g.userData.height = h * 2.0;
    g.userData.h = g.userData.height;
    return g;
  }

  /* 每個 NPC 使用的 GLB 角色（來自 Poly Pizza / Quaternius，CC0）。
   * 女性統一用 woman，男性用 farmer / adventurer 兩類以增加多樣性。 */
  const MODEL_KEYS = {
    aicha: 'woman', fatima: 'woman', aminata: 'woman', awa: 'woman',
    brahim: 'woman', brahime: 'woman', halima: 'woman', kadi: 'woman', fatou: 'woman',
    moussa: 'farmer', boubacar: 'farmer', souleymane: 'farmer',
    issa: 'adventurer', idrissa: 'adventurer'
  };
  const TARGET_H = 1.8;   // 按真實成年人身高歸一化

  // 從已預加載的 GLB 克隆一個可獨立動畫的角色；失敗返回 null
  function buildGLBPerson(spec, rng) {
    if (!window.SkeletonUtils || !S.Models) return null;
    const key = MODEL_KEYS[spec.id] || 'farmer';
    const gltf = S.Models.get('vendor/models/' + key + '.glb');
    if (!gltf) return null;
    let g;
    try {
      g = window.SkeletonUtils.clone(gltf.scene);
    } catch (e) {
      console.warn('[NPCs] 骨骼克隆失敗，降級方塊人：', spec.id, e);
      return null;
    }
    // 關鍵：克隆後蒙皮網格骨骼世界矩陣尚未就緒，必須顯式更新，
    // 否則 Box3.setFromObject 用到的 boneMatrices 是錯的→尺寸/腳底全算歪（懸空）。
    g.updateMatrixWorld(true);
    g.traverse(o => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update(); });
    g.updateMatrixWorld(true);
    // 歸一化到目標身高，並把腳底對齊到本地 y=0
    const box = new THREE.Box3().setFromObject(g);
    const size = new THREE.Vector3(); box.getSize(size);
    const s = TARGET_H / (size.y || TARGET_H);
    const variation = 0.94 + (rng() - 0.5) * 0.1;
    g.scale.setScalar(s * variation);
    // 縮放後必須顯式刷新世界矩陣，否則 Box3 用到的是舊 scale 的 boneMatrices，
    // 導致 size/min.y 算錯 → NPC 腳底偏移懸空。
    g.updateMatrixWorld(true);
    g.traverse(o => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update(); });
    g.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(g);
    g.position.y = -box2.min.y;

    // 播放 Idle 動畫
    let mixer = null;
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(g);
      const idle = gltf.animations.find(a => /idle/i.test(a.name)) || gltf.animations[0];
      mixer.clipAction(idle).play();
    }
    g.userData.mixer = mixer;
    g.userData.height = TARGET_H * variation;
    g.userData.h = g.userData.height;
    return g;
  }

  NPCs.create = function (scene) {
    const rng = S.makeRng(777);
    for (const spec of S.NPCS) {
      // 避開建築
      const c = S.World.collide(spec.x, spec.z, 0.7);
      const cl = S.World.clampToWorld(c.x, c.z);

      let g = buildGLBPerson(spec, rng);
      let fromGLB = !!g;
      if (!g) g = buildPerson(spec, rng);   // 模型缺失時降級

      // 放到地面座標（先設 x/z，y 稍後二次校正）
      g.position.x = cl.x;
      g.position.z = cl.z;
      const groundY0 = S.World.groundY(cl.x, cl.z);
      g.position.y += groundY0;             // 腳底落到地面
      g.rotation.y = Math.atan2(0 - cl.x, 0 - cl.z) + (rng() - 0.5) * 0.6;

      const label = makeLabel(spec.name, spec.role);
      label.position.y = g.userData.height + 0.28;
      g.add(label);

      // 交互提示標記
      const mkGeo = new THREE.ConeGeometry(0.22, 0.5, 4);
      mkGeo.rotateX(Math.PI);
      const mk = new THREE.Mesh(mkGeo, new THREE.MeshBasicMaterial({ color: 0xffd477 }));
      mk.position.y = g.userData.height + 0.20;
      mk.visible = false;
      g.add(mk);

      scene.add(g);

      // 腳下接觸陰影：半透明深色圓片，讓 NPC 在任何角度都"踩"在地上
      const shadowGeo = new THREE.CircleGeometry(0.42, 18);
      shadowGeo.rotateX(-Math.PI / 2);
      const shadowMat = new THREE.MeshBasicMaterial({
        color: 0x1a0e05, transparent: true, opacity: 0.35, depthWrite: false
      });
      const blobShadow = new THREE.Mesh(shadowGeo, shadowMat);
      blobShadow.position.y = 0.02;
      g.add(blobShadow);

      // 二次落地校正：NPC 加入場景後，用世界包圍盒實測腳底高度，
      // 與地形射線點對齊，消除蒙皮骨骼矩陣殘留導致的懸空。
      g.updateMatrixWorld(true);
      const footBox = new THREE.Box3().setFromObject(g);
      const groundNow = S.World.groundY(cl.x, cl.z);
      if (isFinite(footBox.min.y)) {
        g.position.y += (groundNow - footBox.min.y);
      }

      const sitting = (spec.id === 'aicha') && !fromGLB;
      if (sitting) {
        g.userData.parts.legL.rotation.x = -1.35;
        g.userData.parts.legR.rotation.x = -1.35;
        g.position.y -= 0.42;
      }
      NPCs.list.push({
        spec, group: g, label, marker: mk,
        x: cl.x, z: cl.z,
        phase: rng() * 6.28,
        sitting,
        mixer: g.userData.mixer || null,
        baseY: g.position.y
      });
    }
    return NPCs.list;
  };

  NPCs.get = function (id) { return NPCs.list.find(n => n.spec.id === id); };

  NPCs.nearest = function (pos, maxD) {
    const radius = maxD || INTERACTION_RADIUS;
    let best = null, bd = radius * radius;
    for (const n of NPCs.list) {
      const dy = Math.abs(pos.y - n.group.position.y);
      if (dy > 4) continue;
      const d = dist2(pos.x, pos.z, n.x, n.z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };

  NPCs.update = function (dt, playerPos, interactEnabled) {
    for (const n of NPCs.list) {
      n.phase += dt * 0.9;
      const p = n.group.userData.parts;          // GLB 角色無此字段
      const near = Math.sqrt(dist2(playerPos.x, playerPos.z, n.x, n.z)) < INTERACTION_RADIUS;
      n.marker.visible = near && !!interactEnabled;
      n.marker.rotation.y += dt * 2.2;
      n.marker.position.y = n.group.userData.height + 0.20 + Math.sin(n.phase * 2) * 0.10;
      if (p && !n.sitting) {
        // 方塊人：手臂/軀幹輕微擺動
        const sw = Math.sin(n.phase * 0.55) * 0.05;
        p.armL.rotation.x = sw;
        p.armR.rotation.x = -sw;
        p.torso.rotation.y = Math.sin(n.phase * 0.35) * 0.10;
      } else if (n.mixer) {
        // GLB 角色：推進 Idle 動畫
        n.mixer.update(dt);
      }
      // 面向玩家（近距離）
      if (near) {
        const want = Math.atan2(playerPos.x - n.x, playerPos.z - n.z);
        let d = want - n.group.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        n.group.rotation.y += d * Math.min(dt * 4, 1);
      }
      // 標籤距離淡出
      const d = Math.sqrt(dist2(playerPos.x, playerPos.z, n.x, n.z));
      n.label.material.opacity = clamp(1.55 - d / 60, 0, 1);
      n.label.visible = d < 60;
      const sc = clamp(0.6 + d * 0.055, 0.8, 2.2);
      n.label.scale.set(3.0 * sc, 0.75 * sc, 1);
    }
  };

  global.SOS.NPCs = NPCs;
})(window);
