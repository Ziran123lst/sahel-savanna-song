/* ================================================================
 *  player.js —— 阿马杜：GLB 角色模型 + 第三人称/第一人称控制器
 *  角色模型来自 Poly Pizza 的 farmer 模型（带动画），归一化到真实身高。
 *  速度较旧版更快；V 键 / 视角按钮可切换第一、第三人称。
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const { clamp, lerp, heightAt } = S;

  const Player = {
    group: null,
    model: null,
    mixer: null,
    _actions: {},
    _curAction: null,
    pos: new THREE.Vector3(4, 0, 68),
    yaw: Math.PI,          // 相机水平角
    pitch: 0.34,
    dist: 6.2,
    facing: Math.PI,
    speed: 0,
    moving: false,
    running: false,
    enabled: true,
    firstPerson: false,
    ready: false,
    keys: {},
    camTarget: new THREE.Vector3(),
    _camPos: new THREE.Vector3(0, 8, 80),
    _camInit: false,
    _vy: 0,
    _onGround: true,
    _touch: null,
    _bobPhase: 0,
    MODEL_YAW: Math.PI    // glTF 角色正面为 -Z，需 +PI 才能面向移动方向
  };

  /* ---------------- 建模（占位，模型就绪后替换） ---------------- */
  Player.create = function (scene) {
    this.group = new THREE.Group();
    const ph = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 0.9, 4, 8),
      new THREE.MeshLambertMaterial({ color: 0x3f6ea8 })
    );
    ph.position.y = 1.0; ph.castShadow = true;
    this._placeholder = ph;
    this.group.add(ph);
    scene.add(this.group);
    this.pos.set(4, heightAt(4, 68), 68);
    this.group.position.copy(this.pos);
    return this.group;
  };

  /* ---------------- 接入 GLB 动画模型 ---------------- */
  // TARGET_H：归一化到该身高（米），无论模型原生单位是多少
  Player.setupModel = function (gltf) {
    if (!gltf) { this.ready = true; return; }
    if (this._placeholder) { this.group.remove(this._placeholder); this._placeholder = null; }
    const m = gltf.scene;
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    // 按包围盒归一化身高，并把脚底对齐到本地 y=0（不同模型原生单位差异巨大）
    const box = new THREE.Box3().setFromObject(m);
    const size = new THREE.Vector3(); box.getSize(size);
    const TARGET_H = 1.78;
    const s = TARGET_H / (size.y || TARGET_H);
    m.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(m);
    m.position.y = -box2.min.y;            // 脚底落到 group 原点
    this.eyeY = box2.max.y - box2.min.y - 0.16;   // 眼睛高度 ≈ 头顶下 16cm
    this.model = m;
    this.group.add(m);

    this.mixer = new THREE.AnimationMixer(m);
    let idle = null, walk = null, run = null;
    (gltf.animations || []).forEach(clip => {
      const n = (clip.name || '').toLowerCase();
      if (n.includes('idle') || n.includes('stand')) idle = clip;
      else if (n.includes('run')) run = clip;
      else if (n.includes('walk')) walk = clip;
      else if (!idle) idle = clip;
    });
    const mk = c => (c ? this.mixer.clipAction(c) : null);
    this._actions = { idle: mk(idle), walk: mk(walk), run: mk(run || walk) };
    if (this._actions.idle) { this._actions.idle.play(); this._curAction = this._actions.idle; }
    this.ready = true;
  };

  Player.toggleView = function () {
    this.firstPerson = !this.firstPerson;
    this._camInit = false;
    if (this.model) this.model.visible = !this.firstPerson;
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
    window.addEventListener('blur', () => { this.keys = {}; this._touch = null; });

    // 触屏摇杆（独立，独占其 pointerId，不参与相机控制）
    const stick = document.getElementById('stick');
    if (stick) {
      const knob = stick.querySelector('i');
      let sid = null, cx = 0, cy = 0;
      stick.addEventListener('pointerdown', e => {
        sid = e.pointerId; this._joyId = sid; stick.setPointerCapture(sid);
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
        sid = null; this._joyId = null; knob.style.transform = 'translate(0,0)'; this._touch = null;
      };
      stick.addEventListener('pointerup', endTouch);
      stick.addEventListener('pointercancel', endTouch);
    }

    // 相机控制：鼠标 / 单指看向 / 双指看向+捏合缩放，统一用 pointer 事件
    const pts = new Map();          // pointerId -> {x,y}
    let glance = null;              // 单指看向：上一帧坐标
    let pinch = null;               // 双指：{mx,my,dist}
    const onCamDown = e => {
      if (e.pointerId === this._joyId) return;                     // 摇杆独占
      if (e.target && e.target.closest && e.target.closest('#stick,#btn-act,#btn-sprint')) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { glance = { x: e.clientX, y: e.clientY }; }
      else if (pts.size === 2) {
        const p = [...pts.values()];
        pinch = { mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2, dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
        glance = null;
      }
    };
    const onCamMove = e => {
      if (!pts.has(e.pointerId) || e.pointerId === this._joyId) return;
      const prev = pts.get(e.pointerId);
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2 && pinch) {
        // 双指：中点移动 → 旋转；间距变化 → 缩放（看向与缩放互不打架）
        const p = [...pts.values()];
        const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
        this.yaw -= (mx - pinch.mx) * 0.005;
        this.pitch = clamp(this.pitch - (my - pinch.my) * 0.004, -1.0, 1.2);
        const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        this.dist = clamp(this.dist + (pinch.dist - dist) * 0.02, 2.4, 15);
        pinch.mx = mx; pinch.my = my; pinch.dist = dist;
      } else if (pts.size === 1 && glance) {
        this.yaw -= dx * 0.0045;
        this.pitch = clamp(this.pitch + dy * 0.0034, -1.0, 1.2);
      }
    };
    const onCamUp = e => {
      pts.delete(e.pointerId);
      if (pts.size === 1) { const p = [...pts.values()][0]; glance = { x: p.x, y: p.y }; pinch = null; }
      else if (pts.size === 0) { glance = null; pinch = null; }
    };
    canvas.addEventListener('pointerdown', onCamDown);
    window.addEventListener('pointermove', onCamMove);
    window.addEventListener('pointerup', onCamUp);
    window.addEventListener('pointercancel', onCamUp);

    canvas.addEventListener('wheel', e => {
      this.dist = clamp(this.dist + e.deltaY * 0.006, 2.4, 15);
      e.preventDefault();
    }, { passive: false });

    // 疾跑：Shift（键盘）或移动端按钮（this._sprintTouch）
    const btnSprint = document.getElementById('btn-sprint');
    if (btnSprint) {
      const on = e => { e.preventDefault(); this._sprintTouch = true; };
      const off = e => { e.preventDefault(); this._sprintTouch = false; };
      btnSprint.addEventListener('pointerdown', on);
      btnSprint.addEventListener('pointerup', off);
      btnSprint.addEventListener('pointercancel', off);
      btnSprint.addEventListener('pointerleave', off);
    }
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
    this.running = this.enabled && !!(k['ShiftLeft'] || k['ShiftRight'] || this._sprintTouch) && mag > 0.1;

    // 方向（相对相机水平朝向）
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const mx = fx * iz + rx * ix;
    const mz = fz * iz + rz * ix;

    const maxSpeed = this.running ? 13.0 : 7.2;   // 较旧版更快
    const target = Math.hypot(mx, mz) > 0.02 ? maxSpeed : 0;
    this.speed = lerp(this.speed, target, Math.min(dt * 9, 1));
    this.moving = this.speed > 0.4;

    if (this.moving) {
      const nx = this.pos.x + mx * this.speed * dt;
      const nz = this.pos.z + mz * this.speed * dt;
      const c = S.World.collide(nx, nz, 0.42);
      const cl = S.World.clampToWorld(c.x, c.z);
      this.pos.x = cl.x; this.pos.z = cl.z;
      this.facing = Math.atan2(mx, mz);
    }

    // 跳跃
    if (this.enabled && k['Space'] && this._onGround) { this._vy = 4.8; this._onGround = false; }
    if (!this._onGround) {
      this._vy -= 16 * dt;
      this.pos.y += this._vy * dt;
      if (this.pos.y <= heightAt(this.pos.x, this.pos.z)) {
        this.pos.y = heightAt(this.pos.x, this.pos.z);
        this._vy = 0; this._onGround = true;
      }
    } else {
      const gy = heightAt(this.pos.x, this.pos.z);
      this.pos.y = lerp(this.pos.y, gy, Math.min(dt * 12, 1));
    }

    this.group.position.copy(this.pos);
    // 角色朝向（模型正面 -Z → 需 +PI）
    const targetRot = this.facing + this.MODEL_YAW;
    let d = targetRot - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * Math.min(dt * 12, 1);

    // 动画
    if (this.mixer) {
      const want = this.moving
        ? (this.running ? this._actions.run : this._actions.walk)
        : this._actions.idle;
      if (want && this._curAction !== want) {
        if (this._curAction) this._curAction.fadeOut(0.18);
        want.reset().fadeIn(0.18).play();
        this._curAction = want;
      }
      this.mixer.update(dt * (this.moving ? (this.running ? 1.15 : 0.85) : 1));
    } else if (this._placeholder && this.moving) {
      this._bobPhase += dt * 10;
      this._placeholder.position.y = 1.0 + Math.abs(Math.sin(this._bobPhase)) * 0.06;
    }

    // 相机
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    if (this.firstPerson) {
      const headY = this.pos.y + (this.eyeY || 1.62);
      this._camPos.set(this.pos.x, headY, this.pos.z);
      camera.position.copy(this._camPos);
      const dirX = -Math.sin(this.yaw) * cosP;
      const dirZ = -Math.cos(this.yaw) * cosP;
      const dirY = -sinP;   // 修正：pitch 为正时俯视（向下），与第三人称一致
      this.camTarget.set(this.pos.x + dirX * 12, headY + dirY * 12, this.pos.z + dirZ * 12);
      camera.lookAt(this.camTarget);
    } else {
      const wantX = this.pos.x + Math.sin(this.yaw) * cosP * this.dist;
      const wantZ = this.pos.z + Math.cos(this.yaw) * cosP * this.dist;
      const wantY = this.pos.y + 1.5 + sinP * this.dist;
      if (!this._camInit) { this._camPos.set(wantX, wantY, wantZ); this._camInit = true; }
      this._camPos.x = lerp(this._camPos.x, wantX, Math.min(dt * 11, 1));
      this._camPos.y = lerp(this._camPos.y, wantY, Math.min(dt * 11, 1));
      this._camPos.z = lerp(this._camPos.z, wantZ, Math.min(dt * 11, 1));
      const gy = heightAt(this._camPos.x, this._camPos.z) + 1.3;
      if (this._camPos.y < gy) this._camPos.y = gy;
      camera.position.copy(this._camPos);
      this.camTarget.set(this.pos.x, this.pos.y + 1.45, this.pos.z);
      camera.lookAt(this.camTarget);
    }
  };

  Player.teleport = function (x, z) {
    this.pos.set(x, heightAt(x, z), z);
    this.group.position.copy(this.pos);
    this._camInit = false;
  };

  global.SOS.Player = Player;
})(window);
