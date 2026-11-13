/* ================================================================
 *  loader.js —— GLB 模型預加載（基於 GLTFLoader）
 *  通過 window.GLTFLoader 加載；preloadAll 並行加載並回報進度。
 *  場景中的動物用 instance() 克隆（SkeletonUtils）；玩家與 NPC 統一通過公開接口取模型。
 * ================================================================ */
(function (global) {
  'use strict';

  // 版本號：每次發佈都會改變，強制瀏覽器重新拉取最新 JS 與模型，
  // 避免 GitHub Pages / 瀏覽器緩存導致“改動不生效”。
  const GAME_VER = 'v20261113c';
  const vurl = p => p + (p.indexOf('?') >= 0 ? '&' : '?') + 'v=' + GAME_VER;

  const Models = {
    _gltfs: {},
    loader: null,

    init() {
      this.loader = new window.GLTFLoader();
    },

    preload(path) {
      const url = vurl(path);
      return new Promise((resolve) => {
        if (Object.prototype.hasOwnProperty.call(this._gltfs, url)) return resolve(this._gltfs[url]);
        this.loader.load(
          url,
          g => { this._gltfs[url] = g; resolve(g); },
          undefined,
          err => {
            console.warn('[Models] 加載失敗，降級為佔位模型：', path, err);
            this._gltfs[url] = null;   // 標記失敗，避免重複請求
            resolve(null);
          }
        );
      });
    },

    async preloadAll(list, onProgress) {
      let done = 0;
      await Promise.all(list.map(p =>
        this.preload(p).then(() => {
          done++;
          if (onProgress) onProgress(done, list.length);
        })
      ));
    },

    // 取已預加載的 gltf（未加載返回 null）
    get(path) {
      return this._gltfs[vurl(path)] || null;
    },

    // 返回一個獨立克隆的場景（用於可重複放置的動物模型）。
    // 必須用 SkeletonUtils.clone，否則帶骨骼的 SkinnedMesh 用 .clone(true)
    // 會共用同一份 skeleton → 渲染錯位、體積巨大、原地亂轉。
    instance(path) {
      const g = this._gltfs[vurl(path)];
      if (!g) return null;
      let scene;
      try {
        scene = (window.SkeletonUtils ? window.SkeletonUtils.clone(g.scene) : g.scene.clone(true));
      } catch (e) {
        console.warn('[Models] 骨骼克隆失敗，回退普通克隆：', path, e);
        scene = g.scene.clone(true);
      }
      return { scene, animations: g.animations, src: g };
    }
  };

  global.SOS = global.SOS || {};
  global.SOS.Models = Models;
})(window);
