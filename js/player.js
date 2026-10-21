/* ================================================================
 *  player.js —— 阿马杜：角色模型 + 第三人称控制器 + 跟随相机
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const { clamp, lerp, heightAt } = S;

  const Player = {
    group: null,
    pos: new THREE.Vector3(4, 0, 68),
    vel: new THREE.Vector3(),
    yaw: Math.PI,          // 相机水平角
    pitch: 0.30,
    dist: 6.4,
    facing: Math.PI,
    speed: 0,
    moving: false,
    running: false,
    enabled: true,
    _anim: 0,
    _bob: 0,
    _vy: 0,
    _onGround: true,
    keys: {},
    camTarget: new THREE.Vector3(),
    _camPos: new THREE.Vector3(0, 8, 80),
    _camInit: false
  };

  /* ---------------- 建模 ---------------- */
  function buildAvatar() {
    const g = new THREE.Group();
    const skin = new THREE.MeshLambertMaterial({ color: 0x6b4326 });
    const robe = new THREE.MeshLambertMaterial({ color: 0x3f6ea8 });   // 蓝长袍 boubou
    const white = new THREE.MeshLambertMaterial({ color: 0xefe6d2 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x3a2a1c });

    // 下肢
    const legL = new THREE.Group(), legR = new THREE.Group();
    [legL, legR].forEach((leg, i) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.5, 3, 6), skin);
      m.position.y = -0.34;
      m.castShadow = true;
      leg.add(m);
      leg.position.set(i === 0 ? -0.16 : 0.16, 0.78, 0);
      g.add(leg);
    });

    // 长袍（躯干）
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.40, 0.86, 8), robe);
    torso.position.y = 1.20;
    torso.castShadow = true;
    g.add(torso);

    // 肩部布
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.30, 0.22, 8), white);
    shoulder.position.y = 1.60;
    g.add(shoulder);

    // 手臂
    const armL = new THREE.Group(), armR = new THREE.Group();
    [armL, armR].forEach((arm, i) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.44, 3, 6), skin);
      m.position.y = -0.30;
      m.castShadow = true;
      arm.add(m);
      arm.position.set(i === 0 ? -0.34 : 0.34, 1.55, 0);
      g.add(arm);
    });

    // 头
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), skin);
    head.position.y = 1.86;
    head.castShadow = true;
    g.add(head);
    // 小帽 kufi
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.215, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), white);
    cap.position.y = 1.90;
    g.add(cap);
    // 眼
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.035, 0.02), dark);
    eye.position.set(0, 1.87, 0.20);
    g.add(eye);

    // 腰间小包
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.16, 0.10), new THREE.MeshLambertMaterial({ color: 0x8a5a2a }));
    bag.position.set(0.28, 0.98, 0.06);
    g.add(bag);

    g.userData.parts = { legL, legR, armL, armR, torso, head };
    return g;
  }

  Player.create = function (scene) {
    this.group = buildAvatar();
    scene.add(this.group);
    this.pos.set(4, heightAt(4, 68), 68);
    this.group.position.copy(this.pos);
    return this.group;
  };

  /* ---------------- 输入 ---------------- */
  Player.bindInput = function (canvas) {
    const kd = e => {
      this.keys[e.code] = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) e.preventDefault();
    };
    const ku = e => { this.keys[e.code] = false; };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => { this.keys = {}; });

    let dragging = false, lastX = 0, lastY = 0, lastT = 0;
    const down = e => {
      if (e.target && e.target.closest && e.target.closest('.panel-ui')) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
    };
    const move = e => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.yaw -= dx * 0.0045;
      this.pitch = clamp(this.pitch + dy * 0.0032, -0.12, 0.95);
    };
    const up = () => { dragging = false; };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    canvas.addEventListener('wheel', e => {
      this.dist = clamp(this.dist + e.deltaY * 0.006, 2.6, 15);
      e.preventDefault();
    }, { passive: false });

    // 触屏摇杆
    const stick = document.getElementById('stick');
    if (stick) {
      const knob = stick.querySelector('i');
      let sid = null, cx = 0, cy = 0;
      stick.addEventListener('pointerdown', e => {
        sid = e.pointerId; stick.setPointerCapture(sid);
        const r = stick.getBoundingClientRect();
        cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      });
      stick.addEventListener('pointermove', e => {
        if (sid !== e.pointerId) return;
        let dx = e.clientX - cx, dy = e.clientY - cy;
        const m = Math.hypot(dx, dy), max = 46;
        if (m > max) { dx = dx / m * max; dy = dy / m * max; }
        knob.style.transform = `translate(${dx}px,${dy}px)`;
        this._touch = { x: dx / max, y: dy / max };
      });
      const endTouch = e => {
        if (sid !== e.pointerId) return;
        sid = null; knob.style.transform = 'translate(0,0)'; this._touch = null;
      };
      stick.addEventListener('pointerup', endTouch);
      stick.addEventListener('pointercancel', endTouch);
    }

    // 双指旋转视角
    let pinch = null;
    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinch = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', e => {
      if (pinch && e.touches.length === 2) {
        const x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        this.yaw -= (x - pinch.x) * 0.006;
        this.pitch = clamp(this.pitch + (y - pinch.y) * 0.004, -0.12, 0.95);
        pinch.x = x; pinch.y = y;
      }
    }, { passive: true });
    canvas.addEventListener('touchend', () => { pinch = null; }, { passive: true });
  };

  /* ---------------- 每帧 ---------------- */
  Player.update = function (dt, camera) {
    const k = this.keys;
    let ix = 0, iz = 0;
    if (this.enabled) {
      if (k['KeyW'] || k['ArrowUp']) iz += 1;
      if (k['KeyS'] || k['ArrowDown']) iz -= 1;
      if (k['KeyA'] || k['ArrowLeft']) ix -= 1;
      if (k['KeyD'] || k['ArrowRight']) ix += 1;
      if (this._touch) { ix += this._touch.x; iz -= this._touch.y; }
    }
    const mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; }
    this.running = this.enabled && !!(k['ShiftLeft'] || k['ShiftRight']) && mag > 0.1;

    // 方向
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const mx = fx * iz + rx * ix;
    const mz = fz * iz + rz * ix;

    const maxSpeed = this.running ? 8.6 : 4.2;
    const target = Math.hypot(mx, mz) > 0.02 ? maxSpeed : 0;
    this.speed = lerp(this.speed, target, Math.min(dt * 9, 1));
    this.moving = this.speed > 0.35;

    if (this.moving) {
      const nx = this.pos.x + mx * this.speed * dt;
      const nz = this.pos.z + mz * this.speed * dt;
      const c = S.World.collide(nx, nz, 0.42);
      const cl = S.World.clampToWorld(c.x, c.z);
      this.pos.x = cl.x; this.pos.z = cl.z;
      this.facing = Math.atan2(mx, mz);
    }

    // 跳跃（空格在非对话时）
    if (this.enabled && k['Space'] && this._onGround) { this._vy = 4.6; this._onGround = false; }
    if (!this._onGround) {
      this._vy -= 15 * dt;
      this.pos.y += this._vy * dt;
      if (this.pos.y <= heightAt(this.pos.x, this.pos.z)) {
        this.pos.y = heightAt(this.pos.x, this.pos.z);
        this._vy = 0; this._onGround = true;
      }
    } else {
      const gy = heightAt(this.pos.x, this.pos.z);
      this.pos.y = lerp(this.pos.y, gy, Math.min(dt * 12, 1));
    }

    // 角色姿态
    this.group.position.copy(this.pos);
    let d = this.facing - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * Math.min(dt * 10, 1);

    // 动画
    const p = this.group.userData.parts;
    if (this.moving) {
      this._anim += dt * (this.running ? 12.5 : 7.6);
      const sw = Math.sin(this._anim);
      p.legL.rotation.x = sw * (this.running ? 0.85 : 0.62);
      p.legR.rotation.x = -sw * (this.running ? 0.85 : 0.62);
      p.armL.rotation.x = -sw * (this.running ? 0.7 : 0.5);
      p.armR.rotation.x = sw * (this.running ? 0.7 : 0.5);
      this._bob += dt * (this.running ? 12.5 : 7.6);
      this.group.position.y += Math.abs(Math.sin(this._bob)) * (this.running ? 0.09 : 0.05);
      p.torso.rotation.x = -0.06 - (this.running ? 0.08 : 0.03);
    } else {
      this._anim += dt * 1.6;
      const br = Math.sin(this._anim) * 0.035;
      p.legL.rotation.x = lerp(p.legL.rotation.x, 0, Math.min(dt * 8, 1));
      p.legR.rotation.x = lerp(p.legR.rotation.x, 0, Math.min(dt * 8, 1));
      p.armL.rotation.x = lerp(p.armL.rotation.x, br, Math.min(dt * 8, 1));
      p.armR.rotation.x = lerp(p.armR.rotation.x, -br, Math.min(dt * 8, 1));
      p.torso.rotation.x = lerp(p.torso.rotation.x, 0, Math.min(dt * 8, 1));
      p.armL.rotation.z = lerp(p.armL.rotation.z, 0.06, Math.min(dt * 6, 1));
      p.armR.rotation.z = lerp(p.armR.rotation.z, -0.06, Math.min(dt * 6, 1));
    }
    if (!this._onGround) {
      p.legL.rotation.x = -0.4; p.legR.rotation.x = 0.3;
      p.armL.rotation.x = -1.1; p.armR.rotation.x = -1.1;
    }

    // 相机
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    const wantX = this.pos.x + Math.sin(this.yaw) * cosP * this.dist;
    const wantZ = this.pos.z + Math.cos(this.yaw) * cosP * this.dist;
    const wantY = this.pos.y + 1.65 + sinP * this.dist;
    if (!this._camInit) { this._camPos.set(wantX, wantY, wantZ); this._camInit = true; }
    this._camPos.x = lerp(this._camPos.x, wantX, Math.min(dt * 11, 1));
    this._camPos.y = lerp(this._camPos.y, wantY, Math.min(dt * 11, 1));
    this._camPos.z = lerp(this._camPos.z, wantZ, Math.min(dt * 11, 1));
    // 防止穿地
    const gy = heightAt(this._camPos.x, this._camPos.z) + 1.3;
    if (this._camPos.y < gy) this._camPos.y = gy;
    camera.position.copy(this._camPos);
    this.camTarget.set(this.pos.x, this.pos.y + 1.45, this.pos.z);
    camera.lookAt(this.camTarget);
  };

  Player.teleport = function (x, z) {
    this.pos.set(x, heightAt(x, z), z);
    this.group.position.copy(this.pos);
    this._camInit = false;
  };

  global.SOS.Player = Player;
})(window);
