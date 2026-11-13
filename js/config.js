/* ================================================================
 *  薩赫勒之歌 · Song of the Sahel
 *  config.js —— 世界常量、區域定義、數學與噪聲工具
 * ================================================================ */
(function (global) {
  'use strict';

  const WORLD = {
    size: 460,          // 地形邊長（世界單位）
    seg: 150,           // 地形細分
    half: 230,          // 半徑
    water: { x: -155, z: 46 }   // 低窪水源地中心
  };

  /* ---------- 據點（Sites）：決定地形、植被與建築佈局 ---------- */
  /* 地點名稱只用 C5 筆記內或中性的地理用語；id 保持不變以免影響世界與任務鏈。 */
  const SITES = [
    { id: 'village', name: '薩赫勒村落', x:   0, z:  48, r: 40, kind: 'village' },
    { id: 'farm',    name: '南部農田',   x: -52, z: -14, r: 34, kind: 'farm'    },
    { id: 'demo',    name: '南部耕地',   x:  44, z: -34, r: 28, kind: 'demo'    },
    { id: 'well',    name: '水井',       x:-140, z:  52, r: 30, kind: 'well'    },
    { id: 'mare',    name: '水源地',     x: 108, z: -58, r: 32, kind: 'mare'    },
    { id: 'camp',    name: '牧民營地',   x: 128, z:-118, r: 28, kind: 'camp'    },
    { id: 'nursery', name: '防風林',     x:-30, z:-152, r: 34, kind: 'nursery' },
    { id: 'dunes',   name: '荒漠邊緣',   x:  74, z:-180, r: 52, kind: 'dunes'   },
    { id: 'market',  name: '本地市場',   x:   6, z: 172, r: 42, kind: 'market'  },
    { id: 'station', name: '村口',       x: 104, z: 196, r: 26, kind: 'station' }
  ];

  /* ---------- 調色板 ---------- */
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

  /* =================== 數學 / 噪聲 =================== */
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);
  const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
  // NPC/設施交互統一半徑，提示與 F/E 鍵觸發必須使用同一閾值。
  const INTERACTION_RADIUS = 4.6;

  // 確定性偽隨機
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
  // 可復現隨機數生成器
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /* =================== 地形高度場 ===================
   *  z 越小 = 越北 = 越乾旱（沙丘）
   *  z 越大 = 越南 = 越濕潤（鎮、農田）
   */
  function baseHeight(x, z) {
    // 1) 緯度梯度：北高（沙丘起伏）、南低平
    const t = clamp((z + WORLD.half) / WORLD.size, 0, 1);      // 0=北 1=南
    const aridity = 1 - t;                                     // 北=1
    // 2) 大尺度起伏
    let h = (fbm(x * 0.0075, z * 0.0075, 4) - 0.5) * 16;
    // 3) 沙丘波紋（北部強）
    const dune = Math.sin(x * 0.055 + fbm(x * 0.02, z * 0.02, 2) * 6.0) *
                 Math.cos(z * 0.035 + x * 0.012) * 5.2;
    h += dune * aridity;
    h += (fbm(x * 0.05, z * 0.05, 3) - 0.5) * 2.0;
    // 4) 北部整體抬高
    h += aridity * aridity * 5.0;
    return h;
  }

  // 低窪：水源地
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

  /* 乾旱度（0=濕潤南 1=沙漠北）：用於選植被與地面顏色 */
  function aridityAt(x, z) {
    const t = clamp((z + WORLD.half) / WORLD.size, 0, 1);
    let a = 1 - t;
    a += (fbm(x * 0.012 + 40, z * 0.012 + 11, 3) - 0.5) * 0.28;
    // 水塘周邊較濕潤
    const dp = Math.sqrt(dist2(x, z, WORLD.water.x, WORLD.water.z));
    if (dp < 70) a -= 0.30 * (1 - dp / 70);
    return clamp(a, 0, 1);
  }

  /* 某點所屬區域名（用於橫幅） */
  function zoneAt(x, z) {
    let best = null, bd = 1e9;
    for (const s of SITES) {
      const d = Math.sqrt(dist2(x, z, s.x, s.z));
      if (d < s.r * 1.25 && d < bd) { bd = d; best = s; }
    }
    if (best) return best;
    const a = aridityAt(x, z);
    if (a > 0.82) return { name: '沙漠邊緣 · 撒哈拉南緣', kind: 'dunes' };
    if (a > 0.6) return { name: '薩赫勒灌木草原', kind: 'bush' };
    return { name: '稀樹草原帶', kind: 'savanna' };
  }

  global.SOS = {
    WORLD, SITES, COLOR, INTERACTION_RADIUS,
    clamp, lerp, smooth, dist2, hash2, valueNoise, fbm, makeRng,
    heightAt, aridityAt, zoneAt
  };
})(window);
