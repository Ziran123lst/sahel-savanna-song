/* ================================================================
 *  萨赫勒之歌 · Song of the Sahel
 *  config.js —— 世界常量、区域定义、数学与噪声工具
 * ================================================================ */
(function (global) {
  'use strict';

  const WORLD = {
    size: 460,          // 地形边长（世界单位）
    seg: 150,           // 地形细分
    half: 230,          // 半径
    water: { x: -155, z: 46 }   // 旱谷水塘中心（低洼）
  };

  /* ---------- 据点（Sites）：决定地形、植被与建筑布局 ---------- */
  const SITES = [
    { id: 'village', name: '科多戈村',   x:   0, z:  48, r: 40, kind: 'village' },
    { id: 'farm',    name: '自家农田',   x: -52, z: -14, r: 34, kind: 'farm'    },
    { id: 'demo',    name: '示范田',     x:  44, z: -34, r: 28, kind: 'demo'    },
    { id: 'well',    name: '老井与旱谷', x:-140, z:  52, r: 30, kind: 'well'    },
    { id: 'mare',    name: '季节性水塘', x: 108, z: -58, r: 32, kind: 'mare'    },
    { id: 'camp',    name: '牧民营地',   x: 128, z:-118, r: 28, kind: 'camp'    },
    { id: 'nursery', name: '绿色长城苗圃', x:-30, z:-152, r: 34, kind: 'nursery' },
    { id: 'dunes',   name: '沙丘前线',   x:  74, z:-180, r: 52, kind: 'dunes'   },
    { id: 'market',  name: '卡亚镇集市', x:   6, z: 172, r: 42, kind: 'market'  },
    { id: 'station', name: '南下车站',   x: 104, z: 196, r: 26, kind: 'station' }
  ];

  /* ---------- 调色板 ---------- */
  const COLOR = {
    soil:      0x8a4b23,
    soilDry:   0xb07a43,
    sand:      0xe0bd85,
    sandPale:  0xf0d9a8,
    grass:     0x6d7f3a,
    grassDry:  0xa8944f,
    scrub:     0x4c6b2c,
    rock:      0x8d8375,
    mud:       0xa9663a,
    mudWall:   0xb5794a,
    thatch:    0xc9a05e,
    trunk:     0x6b4a2a,
    canopy:    0x4f6b2b,
    canopyDry: 0x7d7a3a,
    baobab:    0x6f5a3c,
    water:     0x2f6f8f,
    cloth:     [0xd94f3d, 0x2f7fb5, 0xe0a520, 0x4a8f5b, 0xb04a8f, 0xe07020],
    skin:      [0x6b4326, 0x7d5432, 0x54331e, 0x8a5c36]
  };

  /* =================== 数学 / 噪声 =================== */
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);
  const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
  // NPC/设施交互统一半径，提示与 F/E 键触发必须使用同一阈值。
  const INTERACTION_RADIUS = 4.6;

  // 确定性伪随机
  function hash2(x, y) {
    let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return h - Math.floor(h);
  }
  function valueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm(x, y, oct) {
    let v = 0, amp = 0.5, fx = x, fy = y;
    for (let i = 0; i < (oct || 4); i++) {
      v += amp * valueNoise(fx, fy);
      fx *= 2.03; fy *= 2.01; amp *= 0.5;
    }
    return v;
  }
  // 可复现随机数生成器
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /* =================== 地形高度场 ===================
   *  z 越小 = 越北 = 越干旱（沙丘）
   *  z 越大 = 越南 = 越湿润（镇、农田）
   */
  function baseHeight(x, z) {
    // 1) 纬度梯度：北高（沙丘起伏）、南低平
    const t = clamp((z + WORLD.half) / WORLD.size, 0, 1);      // 0=北 1=南
    const aridity = 1 - t;                                     // 北=1
    // 2) 大尺度起伏
    let h = (fbm(x * 0.0075, z * 0.0075, 4) - 0.5) * 16;
    // 3) 沙丘波纹（北部强）
    const dune = Math.sin(x * 0.055 + fbm(x * 0.02, z * 0.02, 2) * 6.0) *
                 Math.cos(z * 0.035 + x * 0.012) * 5.2;
    h += dune * aridity;
    h += (fbm(x * 0.05, z * 0.05, 3) - 0.5) * 2.0;
    // 4) 北部整体抬高
    h += aridity * aridity * 5.0;
    return h;
  }

  // 低洼：旱谷水塘
  function pondBasin(x, z) {
    const d = Math.sqrt(dist2(x, z, WORLD.water.x, WORLD.water.z));
    const r = 34;
    if (d > r) return 0;
    const k = 1 - d / r;
    return -9.5 * smooth(k);       // 下沉
  }

  // 聚落平整
  function flatten(x, z) {
    let f = 0;
    for (const s of SITES) {
      if (s.kind === 'dunes') continue;
      const d = Math.sqrt(dist2(x, z, s.x, s.z));
      if (d < s.r) {
        const k = 1 - d / s.r;
        let target = 0;
        if (s.kind === 'village') target = 0;
        else if (s.kind === 'market') target = -1.2;
        else if (s.kind === 'well' || s.kind === 'mare') target = -2.2;
        else target = -0.4;
        f += (target) * smooth(k) * 0.9;
      }
    }
    return f;
  }

  function heightAt(x, z) {
    return baseHeight(x, z) + pondBasin(x, z) + flatten(x, z);
  }

  /* 干旱度（0=湿润南 1=沙漠北）：用于选植被与地面颜色 */
  function aridityAt(x, z) {
    const t = clamp((z + WORLD.half) / WORLD.size, 0, 1);
    let a = 1 - t;
    a += (fbm(x * 0.012 + 40, z * 0.012 + 11, 3) - 0.5) * 0.28;
    // 水塘周边较湿润
    const dp = Math.sqrt(dist2(x, z, WORLD.water.x, WORLD.water.z));
    if (dp < 70) a -= 0.30 * (1 - dp / 70);
    return clamp(a, 0, 1);
  }

  /* 某点所属区域名（用于横幅） */
  function zoneAt(x, z) {
    let best = null, bd = 1e9;
    for (const s of SITES) {
      const d = Math.sqrt(dist2(x, z, s.x, s.z));
      if (d < s.r * 1.25 && d < bd) { bd = d; best = s; }
    }
    if (best) return best;
    const a = aridityAt(x, z);
    if (a > 0.82) return { name: '沙漠边缘 · 撒哈拉南缘', kind: 'dunes' };
    if (a > 0.6) return { name: '萨赫勒灌木草原', kind: 'bush' };
    return { name: '稀树草原带', kind: 'savanna' };
  }

  global.SOS = {
    WORLD, SITES, COLOR, INTERACTION_RADIUS,
    clamp, lerp, smooth, dist2, hash2, valueNoise, fbm, makeRng,
    heightAt, aridityAt, zoneAt
  };
})(window);
