/* ================================================================
 *  settings.js —— 玩家偏好設置（本地持久化）
 *  開放世界常見設置：滑動/視角靈敏度、反轉、相機距離、音量、畫質。
 *  所有設置存於 localStorage，供 Player / World / SFX 實時讀取。
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const LS_KEY = 'sahel_settings_v1';

  const DEFAULTS = {
    lookSensitivity: 1.0,   // 視角拖動靈敏度係數（0.3 – 2.5）
    moveSensitivity: 1.0,   // 搖桿移動靈敏度係數（0.4 – 2.0）
    invertY: false,         // 反轉視角上下
    invertX: false,         // 反轉視角左右
    invertMove: false,      // 反轉移動方向（前後）
    cameraDist: 1.0,        // 相機距離係數（0.6 – 1.6，越大越遠）
    volume: 0.8,            // 音量 0 – 1
    ambient: true,          // 環境音樂（WebAudio 合成的草原氛圍）
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
      } catch (e) { /* 忽略損壞的存檔 */ }
      return this.data;
    },

    save() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); } catch (e) { /* 隱私模式可能失敗 */ }
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

    // 單項即時生效
    apply(key) {
      const d = this.data;
      if (key === 'volume' && S.UI && S.UI.SFX) { S.UI.SFX.master = d.volume; }
      if (key === 'volume' && S.UI && S.UI.Ambient) { S.UI.Ambient.setVolume(d.volume); }
      if (key === 'ambient' && S.UI && S.UI.Ambient) {
        const A = S.UI.Ambient, want = !!d.ambient;
        // 只在狀態真的改變時執行，避免 Ambient.setOn 回寫設定時重複啟動／停止
        if (A.on !== want) {
          A.on = want;
          if (S.UI.game && S.UI.game.started) { if (want) A.start(); else A.stop(); }
        }
        if (S.UI.syncMusicButton) S.UI.syncMusicButton();
      }
      if (key === 'quality' && S.World && S.World.applyQuality) { S.World.applyQuality(d.quality); }
      // lookSensitivity / moveSensitivity / invert* / cameraDist 由 Player 每幀讀取，無需即時生效
    },

    applyAll() {
      Object.keys(this.data).forEach(k => this.apply(k));
    }
  };

  global.SOS.Settings = Settings;
})(window);
