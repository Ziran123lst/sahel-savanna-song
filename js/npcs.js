/* ================================================================
 *  npcs.js —— 村民模型、名字标签与交互检测
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const { COLOR, heightAt, dist2, clamp } = S;

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
    c.font = 'bold 44px "PingFang SC","Microsoft YaHei",sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, cv.width / 2, 48);
    c.fillStyle = 'rgba(232,201,143,0.72)';
    c.font = '26px "PingFang SC","Microsoft YaHei",sans-serif';
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

    // 长袍/衣裙
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

    // 头巾 / 小帽
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
    g.userData.h = h;
    return g;
  }

  NPCs.create = function (scene) {
    const rng = S.makeRng(777);
    for (const spec of S.NPCS) {
      // 避开建筑
      const c = S.World.collide(spec.x, spec.z, 0.7);
      const cl = S.World.clampToWorld(c.x, c.z);
      const g = buildPerson(spec, rng);
      const y = heightAt(cl.x, cl.z);
      g.position.set(cl.x, y, cl.z);
      g.rotation.y = Math.atan2(0 - cl.x, 0 - cl.z) + (rng() - 0.5) * 0.6;

      const label = makeLabel(spec.name, spec.role);
      label.position.y = 2.45 * g.userData.h;
      g.add(label);

      // 交互提示标记
      const mkGeo = new THREE.ConeGeometry(0.22, 0.5, 4);
      mkGeo.rotateX(Math.PI);
      const mk = new THREE.Mesh(mkGeo, new THREE.MeshBasicMaterial({ color: 0xffd477 }));
      mk.position.y = 2.15 * g.userData.h;
      mk.visible = false;
      g.add(mk);

      scene.add(g);
      const sitting = (spec.id === 'aicha');
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
        baseY: g.position.y
      });
    }
    return NPCs.list;
  };

  NPCs.get = function (id) { return NPCs.list.find(n => n.spec.id === id); };

  NPCs.nearest = function (pos, maxD) {
    let best = null, bd = (maxD || 3.6) * (maxD || 3.6);
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
      const p = n.group.userData.parts;
      const near = Math.sqrt(dist2(playerPos.x, playerPos.z, n.x, n.z)) < 3.6;
      n.marker.visible = near && !!interactEnabled;
      n.marker.rotation.y += dt * 2.2;
      n.marker.position.y = 2.15 * n.group.userData.h + Math.sin(n.phase * 2) * 0.14;
      if (!n.sitting) {
        const sw = Math.sin(n.phase * 0.55) * 0.05;
        p.armL.rotation.x = sw;
        p.armR.rotation.x = -sw;
        p.torso.rotation.y = Math.sin(n.phase * 0.35) * 0.10;
      }
      // 面向玩家（近距离）
      if (near) {
        const want = Math.atan2(playerPos.x - n.x, playerPos.z - n.z);
        let d = want - n.group.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        n.group.rotation.y += d * Math.min(dt * 4, 1);
        p.head.rotation.y = 0;
      }
      // 标签距离淡出
      const d = Math.sqrt(dist2(playerPos.x, playerPos.z, n.x, n.z));
      n.label.material.opacity = clamp(1.35 - d / 34, 0, 1);
      n.label.visible = d < 40;
      const sc = clamp(0.6 + d * 0.055, 0.8, 2.2);
      n.label.scale.set(3.0 * sc, 0.75 * sc, 1);
    }
  };

  global.SOS.NPCs = NPCs;
})(window);
