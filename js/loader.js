/* ================================================================
 *  loader.js —— GLB 模型预加载（基于 GLTFLoader）
 *  通过 window.GLTFLoader 加载；preloadAll 并行加载并回报进度。
 *  场景中的动物用 instance() 克隆；玩家（Soldier）直接用 _gltfs 原实例。
 * ================================================================ */
(function (global) {
  'use strict';

  const Models = {
    _gltfs: {},
    loader: null,

    init() {
      this.loader = new window.GLTFLoader();
    },

    preload(path) {
      return new Promise((resolve) => {
        if (Object.prototype.hasOwnProperty.call(this._gltfs, path)) return resolve(this._gltfs[path]);
        this.loader.load(
          path,
          g => { this._gltfs[path] = g; resolve(g); },
          undefined,
          err => {
            console.warn('[Models] 加载失败，降级为占位模型：', path, err);
            this._gltfs[path] = null;   // 标记失败，避免重复请求
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

    // 取已预加载的 gltf（未加载返回 null）
    get(path) {
      return this._gltfs[path] || null;
    },

    // 返回一个独立克隆的场景（用于可重复放置的静态动物模型）
    instance(path) {
      const g = this._gltfs[path];
      if (!g) return null;
      const scene = g.scene.clone(true);
      return { scene, animations: g.animations, src: g };
    }
  };

  global.SOS = global.SOS || {};
  global.SOS.Models = Models;
})(window);
