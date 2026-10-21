/* ================================================================
 *  settings.js —— 玩家偏好设置（本地持久化）
 *  开放世界常见设置：滑动/视角灵敏度、反转、相机距离、音量、画质。
 *  所有设置存于 localStorage，供 Player / World / SFX 实时读取。
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const LS_KEY = 'sahel_settings_v1';

  const DEFAULTS = {
    lookSensitivity: 1.0,   // 视角拖动灵敏度系数（0.3 – 2.5）
    moveSensitivity: 1.0,   // 摇杆移动灵敏度系数（0.4 – 2.0）
    invertY: false,         // 反转视角上下
    invertX: false,         // 反转视角左右
    invertMove: false,      // 反转移动方向（前后）
    cameraDist: 1.0,        // 相机距离系数（0.6 – 1.6，越大越远）
    volume: 0.8,            // 音量 0 – 1
    quality: 'high'         // high | medium | low
  };

  const Settings = {
    data: Object.assign({}, DEFAULTS),

    load() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          this.data = Object.assign({}, DEFAULTS, p);
        }
      } catch (e) { /* 忽略损坏的存档 */ }
      return this.data;
    },

    save() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); } catch (e) { /* 隐私模式可能失败 */ }
    },

    set(key, value) {
      this.data[key] = value;
      this.save();
      this.apply(key);
    },

    reset() {
      this.data = Object.assign({}, DEFAULTS);
      this.save();
      this.applyAll();
    },

    // 单项即时生效
    apply(key) {
      const d = this.data;
      if (key === 'volume' && S.UI && S.UI.SFX) { S.UI.SFX.master = d.volume; }
      if (key === 'quality' && S.World && S.World.applyQuality) { S.World.applyQuality(d.quality); }
      // lookSensitivity / moveSensitivity / invert* / cameraDist 由 Player 每帧读取，无需即时生效
    },

    applyAll() {
      Object.keys(this.data).forEach(k => this.apply(k));
    }
  };

  global.SOS.Settings = Settings;
})(window);
