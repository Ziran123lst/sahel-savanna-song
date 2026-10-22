/* ================================================================
 *  loader.js —— GLB 模型预加载（基于 GLTFLoader）
 *  通过 window.GLTFLoader 加载；preloadAll 并行加载并回报进度。
 *  场景中的动物用 instance() 克隆（SkeletonUtils）；玩家与 NPC 直接用 _gltfs 原实例克隆。
 * ================================================================ */
(function (global) {
  'use strict';

  // 版本号：每次发布都会改变，强制浏览器重新拉取最新 JS 与模型，
  // 避免 GitHub Pages / 浏览器缓存导致“改动不生效”。
  const GAME_VER = 'v20251021c';
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
            console.warn('[Models] 加载失败，降级为占位模型：', path, err);
            this._gltfs[url] = null;   // 标记失败，避免重复请求
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
      return this._gltfs[vurl(path)] || null;
    },

    // 返回一个独立克隆的场景（用于可重复放置的动物模型）。
    // 必须用 SkeletonUtils.clone，否则带骨骼的 SkinnedMesh 用 .clone(true)
    // 会共用同一份 skeleton → 渲染错位、体积巨大、原地乱转。
    instance(path) {
      const g = this._gltfs[vurl(path)];
      if (!g) return null;
      let scene;
      try {
        scene = (window.SkeletonUtils ? window.SkeletonUtils.clone(g.scene) : g.scene.clone(true));
      } catch (e) {
        console.warn('[Models] 骨骼克隆失败，回退普通克隆：', path, e);
        scene = g.scene.clone(true);
      }
      return { scene, animations: g.animations, src: g };
    }
  };

  global.SOS = global.SOS || {};
  global.SOS.Models = Models;
})(window);
