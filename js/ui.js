/* ================================================================
 *  ui.js —— 界面：HUD · 對話 · 問答 · 日誌 · 筆記 · 小遊戲 · 小地圖
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const $ = id => document.getElementById(id);

  /* ---------------- 音效（WebAudio 合成，無外部資源） ---------------- */
  const SFX = {
    ctx: null, on: true, master: 0.8,
    _init() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.on = false; } } },
    tone(freq, dur, type, gain, slideTo) {
      if (!this.on) return;
      this._init(); if (!this.ctx) return;
      const ctx = this.ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, ctx.currentTime);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
      const peak = (gain || 0.08) * this.master;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), ctx.currentTime + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + dur + 0.02);
    },
    dig() { this.tone(150, 0.16, 'triangle', 0.10, 90); },
    stone() { this.tone(220, 0.12, 'square', 0.05, 160); },
    plant() { this.tone(430, 0.22, 'sine', 0.07, 660); },
    good() { this.tone(520, 0.14, 'sine', 0.08); setTimeout(() => this.tone(780, 0.18, 'sine', 0.07), 110); },
    bad() { this.tone(240, 0.22, 'sawtooth', 0.05, 150); },
    talk() { this.tone(320, 0.06, 'sine', 0.03); },
    open() { this.tone(600, 0.1, 'sine', 0.05, 800); },
    rain() { this.tone(1200, 0.5, 'noise' in this ? 'sine' : 'sine', 0.02, 300); },

    /* 喚牛口哨：兩聲上滑短哨，加輕微顫音，聽起來才像「吹哨」而非按鍵音。
     * stop=true 時音高稍低，用來區分「收哨停止趕牛」。 */
    whistle(stop) {
      if (!this.on) return;
      this._init(); const ctx = this.ctx; if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      const base = stop ? 640 : 880, t0 = ctx.currentTime;
      [0, 0.21].forEach((off, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        const vib = ctx.createOscillator(), vibG = ctx.createGain();
        const f = base * (i ? 1.18 : 1);
        o.type = 'sine';
        o.frequency.setValueAtTime(f * 0.80, t0 + off);
        o.frequency.exponentialRampToValueAtTime(f, t0 + off + 0.055);
        o.frequency.setValueAtTime(f, t0 + off + 0.10);
        o.frequency.exponentialRampToValueAtTime(f * 0.94, t0 + off + 0.19);
        vib.frequency.value = 17; vibG.gain.value = f * 0.009;
        vib.connect(vibG); vibG.connect(o.frequency);
        const peak = 0.10 * this.master;
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + off + 0.03);
        g.gain.setValueAtTime(Math.max(0.0002, peak), t0 + off + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.22);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0 + off); o.stop(t0 + off + 0.24);
        vib.start(t0 + off); vib.stop(t0 + off + 0.24);
      });
    }
  };

  /* ---------------- 環境音樂（WebAudio 程序化合成） ----------------
   * 不引入任何外部音訊檔，因此沒有授權與來源問題，也不增加下載體積。
   * 三層：草原風聲（低通噪聲）＋ 五聲音階柔和墊音 ＋ 偶發的遠處鈴音；
   * 雨季自動把風聲轉成細雨。整體音量刻意壓低，只作背景，不蓋過對話與音效。
   */
  const Ambient = {
    ctx: null, on: true, running: false, season: 'dry',
    master: 0.8, level: 0.20,
    out: null, windGain: null, windFilter: null, rainGain: null,
    pads: [], sources: [], timer: null, chordTimer: null,
    chordIndex: 0, _chime: null, _shift: null,

    _ctx() { if (!this.ctx) { SFX._init(); this.ctx = SFX.ctx; } return this.ctx; },

    _noise(seconds) {
      const ctx = this.ctx, len = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    },

    _build() {
      if (this.out) return;
      const ctx = this._ctx(); if (!ctx) return;

      const out = ctx.createGain();
      out.gain.value = 0.0001;
      out.connect(ctx.destination);
      this.out = out;

      // 風聲：白噪聲 → 低通 → 增益，慢速 LFO 讓風有起伏
      const wind = ctx.createBufferSource();
      wind.buffer = this._noise(3); wind.loop = true;
      const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 340; wf.Q.value = 0.6;
      const wg = ctx.createGain(); wg.gain.value = 0.50;
      wind.connect(wf); wf.connect(wg); wg.connect(out);
      const wl = ctx.createOscillator(); wl.frequency.value = 0.06;
      const wlg = ctx.createGain(); wlg.gain.value = 0.26;
      wl.connect(wlg); wlg.connect(wg.gain);
      wind.start(); wl.start();
      this.windFilter = wf; this.windGain = wg;
      this.sources.push(wind, wl);

      // 雨聲：高頻噪聲，旱季增益為 0
      const rain = ctx.createBufferSource();
      rain.buffer = this._noise(3); rain.loop = true;
      const rf = ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 1800;
      const rg = ctx.createGain(); rg.gain.value = 0.0001;
      rain.connect(rf); rf.connect(rg); rg.connect(out);
      rain.start(); this.sources.push(rain); this.rainGain = rg;

      // 墊音：三個振盪器構成柔和和弦，各自緩慢呼吸
      this.pads = [146.83, 220.00, 293.66].map((f, i) => {
        const o = ctx.createOscillator(); o.type = i === 1 ? 'triangle' : 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = 0.022;
        o.connect(g); g.connect(out);
        const l = ctx.createOscillator(); l.frequency.value = 0.035 + i * 0.017;
        const lg = ctx.createGain(); lg.gain.value = 0.016;
        l.connect(lg); lg.connect(g.gain);
        o.start(); l.start();
        this.sources.push(o, l);
        return { o, g };
      });

      // 偶發鈴音：五聲音階單音，像遠處的牛鈴
      const scale = [293.66, 329.63, 392.00, 440.00, 587.33];
      this._chime = () => {
        if (!this.on || !this.running || !this.ctx || !this.out) return;
        const c = this.ctx, now = c.currentTime, f = scale[Math.floor(Math.random() * scale.length)];
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.045 * this.master), now + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);
        o.connect(g); g.connect(this.out);
        o.start(now); o.stop(now + 2.5);
        this.timer = setTimeout(this._chime, 9000 + Math.random() * 9000);
      };

      // 和弦緩慢移動，避免長時間聽起來完全不變
      const chords = [[146.83, 220.00, 293.66], [130.81, 196.00, 261.63], [164.81, 246.94, 329.63]];
      this._shift = () => {
        if (!this.on || !this.running || !this.ctx) return;
        this.chordIndex = (this.chordIndex + 1) % chords.length;
        const c = this.ctx, now = c.currentTime;
        chords[this.chordIndex].forEach((f, i) => {
          if (this.pads[i]) this.pads[i].o.frequency.setTargetAtTime(f, now, 2.5);
        });
        this.chordTimer = setTimeout(this._shift, 16000 + Math.random() * 8000);
      };
    },

    // 從設定讀取開關與音量；在用戶手勢之後呼叫才會真正發聲
    syncSettings() {
      const d = (S.Settings && S.Settings.data) || {};
      this.master = typeof d.volume === 'number' ? d.volume : 0.8;
      this.on = d.ambient !== false;
    },

    start() {
      if (!this.on) return;
      this._build();
      const ctx = this._ctx(); if (!ctx || !this.out) return;
      if (ctx.state === 'suspended') ctx.resume();
      this.running = true;
      const t = ctx.currentTime;
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), t);
      this.out.gain.linearRampToValueAtTime(Math.max(0.0002, this.level * this.master), t + 2.5);
      clearTimeout(this.timer); clearTimeout(this.chordTimer);
      this.timer = setTimeout(this._chime, 6000 + Math.random() * 6000);
      this.chordTimer = setTimeout(this._shift, 14000);
      this.setSeason(this.season);
    },

    stop() {
      this.running = false;
      clearTimeout(this.timer); clearTimeout(this.chordTimer);
      if (!this.ctx || !this.out) return;
      const t = this.ctx.currentTime;
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), t);
      this.out.gain.linearRampToValueAtTime(0.0001, t + 0.8);
    },

    setOn(v) {
      this.on = !!v;
      if (this.on) this.start(); else this.stop();
      if (S.Settings) S.Settings.set('ambient', this.on);
    },

    setVolume(v) {
      this.master = v;
      if (!this.ctx || !this.out || !this.running) return;
      const t = this.ctx.currentTime;
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setTargetAtTime(Math.max(0.0002, this.level * this.master), t, 0.3);
    },

    // 雨季：風聲變亮、加入細雨；旱季還原
    setSeason(s) {
      this.season = s === 'rain' ? 'rain' : 'dry';
      if (!this.ctx || !this.out) return;
      const t = this.ctx.currentTime, rain = this.season === 'rain';
      this.windFilter.frequency.setTargetAtTime(rain ? 640 : 340, t, 1.5);
      this.windGain.gain.setTargetAtTime(rain ? 0.26 : 0.50, t, 1.5);
      this.rainGain.gain.setTargetAtTime(rain ? 0.14 : 0.0001, t, 1.5);
    }
  };

  const UI = {
    mode: null,           // null | 'dialogue' | 'quiz' | 'overlay' | 'minigame'
    game: null,
    _dlgHandler: null,
    _quizHandler: null,
    _lastZone: null
  };

  UI.init = function (game) {
    this.game = game;

    $('btn-journal').onclick = () => this.journal();
    $('btn-notes').onclick = () => this.notes();
    $('btn-view').onclick = () => this.game.toggleView();
    $('btn-help').onclick = () => this.help();
    $('btn-settings').onclick = () => this.openSettings();
    $('btn-inventory').onclick = () => this.inventory();

    const bm = $('btn-music');
    if (bm) bm.onclick = () => this.toggleMusic();
    this.syncMusicButton();

    // 地段懸浮標示：小地圖標記、世界地圖、世界上方浮空標籤
    this.buildSiteMarkers();
    this.buildWorldLabels();
    const me = $('mm-expand');
    if (me) me.onclick = () => this.toggleWorldMap();
    const wmc = $('wm-close');
    if (wmc) wmc.onclick = () => this.closeWorldMap();
    const wmbg = $('world-map');
    if (wmbg) wmbg.addEventListener('click', e => { if (e.target === wmbg) this.closeWorldMap(); });

    $('dlg-continue').onclick = () => this._continue();
    $('quiz-close').onclick = () => this._closeQuiz();

    // 小地圖背景預渲染（小地圖 200px 帶地名；世界地圖 520px 高清版、不重複標地名）
    this._mmBase = this._renderMinimapBase(200, true);
    this._wmBase = this._renderMinimapBase(520, false);
    // 導航箭頭元素
    this._navArrow = $('nav-arrow');
  };

  /* 環境音樂快捷開關（HUD 的 ♫ 按鍵與 M 鍵共用） */
  UI.syncMusicButton = function () {
    const b = $('btn-music');
    if (!b) return;
    b.textContent = Ambient.on ? '♫ 音樂' : '♫ 靜音';
    b.classList.toggle('off', !Ambient.on);
    b.title = Ambient.on ? '環境音樂：開（按 M 關閉）' : '環境音樂：關（按 M 開啟）';
  };

  UI.toggleMusic = function () {
    Ambient.setOn(!Ambient.on);
    this.syncMusicButton();
    if (this.toast) this.toast(Ambient.on ? '♫ 環境音樂已開啟' : '♫ 環境音樂已關閉', 'good');
  };

  /* ---------------- 地段懸浮標示（生活模擬風格） ----------------
   * 名稱與描述只取材自 C5《農業與饑荒》5.1–5.8；圖形與配色全部自製。
   * 三處呈現：小地圖標記＋資訊卡、全屏世界地圖、世界上方浮空標籤。
   */
  const SITE_META = {
    village: { kind: '村落', color: '#e8871e', desc: '村民聚居之處，集會仙人掌下討論農事與畜牧季移。' },
    farm:    { kind: '農地', color: '#5c9a3f', desc: '種植作物的耕地；休耕期長短直接影響土壤養分。' },
    demo:    { kind: '耕地', color: '#7ab648', desc: '練習覆蓋耕作、等高耕作等土壤保育方式的耕地。' },
    well:    { kind: '水源', color: '#3b8fb5', desc: '抽取地下水供人畜飲用；井旁牲畜聚集易致過度放牧。' },
    mare:    { kind: '水源', color: '#3b8fb5', desc: '旱季為畜羣取水的地方，也是牲畜集聚之處。' },
    camp:    { kind: '放牧', color: '#d9a520', desc: '隨季節遷移的牧民與畜欄所在，牛羣歸欄的地方。' },
    nursery: { kind: '林地', color: '#3f7a45', desc: '種植防風林以減慢土壤侵蝕、保護表土。' },
    dunes:   { kind: '荒漠', color: '#c89a55', desc: '土地退化與荒漠化流程的起點，植被難以恢復。' },
    market:  { kind: '市場', color: '#9a5fb0', desc: '買賣糧食、以工作換取糧食的地方。' },
    station: { kind: '村口', color: '#8a8f86', desc: '村落出入口，村民往來與訊息交流之處。' }
  };
  const siteMeta = s => SITE_META[s.kind] || { kind: '地段', color: '#57c9b0', desc: '' };
  const sitePct = v => (v + S.WORLD.half) / S.WORLD.size * 100;
  const siteDist = (p, s) => p ? Math.round(Math.hypot(p.x - s.x, p.z - s.z)) : 0;

  UI.buildSiteMarkers = function () {
    const wrap = $('mm-sites');
    if (!wrap) return;
    wrap.innerHTML = '';
    S.SITES.forEach(s => {
      const m = siteMeta(s);
      const pin = document.createElement('div');
      pin.className = 'mm-pin';
      pin.dataset.id = s.id;
      pin.style.left = sitePct(s.x) + '%';
      pin.style.top = sitePct(s.z) + '%';
      pin.style.setProperty('--pin', m.color);
      pin.innerHTML = '<i class="sims-gem"></i>';
      pin.addEventListener('mouseenter', () => this.showSiteTip(s));
      pin.addEventListener('mouseleave', () => this.hideSiteTip());
      pin.addEventListener('click', () => this.showSiteTip(s));
      wrap.appendChild(pin);
    });
  };

  UI.showSiteTip = function (s) {
    clearTimeout(this._tipTimer);
    const tip = $('mm-tip');
    if (!tip) return;
    const m = siteMeta(s), d = siteDist(this._playerPos, s);
    tip.innerHTML =
      '<div class="st-top"><span class="st-kind">' + m.kind + '</span></div>' +
      '<h4>' + s.name + '</h4><p>' + m.desc + '</p>' +
      '<div class="st-foot"><span class="st-dist">距你 ' + d + ' 步</span>' +
      '<button type="button">設為目標 ▸</button></div>';
    tip.classList.remove('hidden');
    tip.onmouseenter = () => clearTimeout(this._tipTimer);
    tip.onmouseleave = () => this.hideSiteTip();
    tip.querySelector('button').onclick = () => this.setMapTarget(s);
    const wrap = $('mm-sites');
    if (wrap) wrap.querySelectorAll('.mm-pin').forEach(p =>
      p.classList.toggle('active', p.dataset.id === s.id));
    this._tipSite = s;
  };

  UI.hideSiteTip = function () {
    clearTimeout(this._tipTimer);
    this._tipTimer = setTimeout(() => {
      const t = $('mm-tip');
      if (t) t.classList.add('hidden');
      const wrap = $('mm-sites');
      if (wrap) wrap.querySelectorAll('.mm-pin').forEach(p => p.classList.remove('active'));
      this._tipSite = null;
    }, 180);
  };

  UI.setMapTarget = function (s) {
    // 再點同一地段＝取消導航，方便玩家隨時改主意
    if (this.game && this.game._mapTarget && this.game._mapTarget.siteId === s.id) {
      this.game._mapTarget = null;
      this.hideSiteTip();
      this.closeWorldMap();
      if (this.toast) this.toast('🧭 已取消導航目標', 'good');
      return;
    }
    if (this.game) {
      this.game._mapTarget = { x: s.x, z: s.z, siteId: s.id, name: s.name };
    }
    this.hideSiteTip();
    this.closeWorldMap();
    if (this.toast) this.toast('🧭 已把「' + s.name + '」設為導航目標，跟着箭頭走', 'good');
  };

  UI.updateSiteMarkers = function (playerPos) {
    const wrap = $('mm-sites');
    if (!wrap || !playerPos) return;
    wrap.querySelectorAll('.mm-pin').forEach(p => {
      const s = S.SITES.find(x => x.id === p.dataset.id);
      if (s) p.classList.toggle('here', siteDist(playerPos, s) < s.r);
    });
    // 資訊卡開着時同步距離
    if (this._tipSite && $('mm-tip') && !$('mm-tip').classList.contains('hidden')) {
      const d = $('mm-tip').querySelector('.st-dist');
      if (d) d.textContent = '距你 ' + siteDist(playerPos, this._tipSite) + ' 步';
    }
  };

  /* ---------- 全屏世界地圖 ---------- */
  UI.worldMap = function () {
    if (this.mode && this.mode !== 'worldmap') return;
    const panel = $('world-map');
    if (!panel) return;
    const navId = this.game && this.game._mapTarget ? this.game._mapTarget.siteId : null;
    // 底圖：世界地圖用 520px 高清底圖，與畫布 1:1，放大後依然清晰
    const cv = $('wm-canvas');
    const base = this._wmBase || this._mmBase;
    if (cv && base) {
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = true;
      c.clearRect(0, 0, cv.width, cv.height);
      c.drawImage(base, 0, 0, cv.width, cv.height);
    }
    const pins = $('wm-pins'), cards = $('wm-cards');
    if (pins) {
      pins.innerHTML = S.SITES.map(s => {
        const m = siteMeta(s);
        const cls = 'wm-pin' + (siteDist(this._playerPos, s) < s.r ? ' here' : '') +
          (navId === s.id ? ' nav' : '');
        return '<div class="' + cls + '" data-id="' + s.id + '" style="left:' + sitePct(s.x) + '%;top:' +
          sitePct(s.z) + '%;--pin:' + m.color + '"><i class="sims-gem"></i>' +
          '<span class="wm-pin-name">' + s.name + '</span></div>';
      }).join('');
      pins.querySelectorAll('.wm-pin').forEach(el => {
        el.onclick = () => {
          const card = cards && cards.querySelector('.wm-card[data-id="' + el.dataset.id + '"]');
          if (card) { card.click(); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        };
      });
    }
    if (cards) {
      cards.innerHTML = S.SITES.map(s => {
        const m = siteMeta(s), d = siteDist(this._playerPos, s);
        return '<div class="wm-card' + (navId === s.id ? ' nav' : '') + '" data-id="' + s.id + '" style="--pin:' + m.color + '">' +
          '<i class="sims-gem"></i><div class="wc-body">' +
          '<div class="wc-top"><h4>' + s.name + '</h4><span class="wc-dist">' + d + ' m</span></div>' +
          '<div class="wc-kind">' + m.kind + '</div><p>' + m.desc + '</p>' +
          (d < s.r ? '<span class="wc-here">你在此處</span>' : '') +
          '<button type="button" class="wc-go">前往 ▸</button>' +
          '</div></div>';
      }).join('');
      cards.querySelectorAll('.wm-card').forEach(el => {
        const s = S.SITES.find(x => x.id === el.dataset.id);
        el.onclick = () => {
          cards.querySelectorAll('.wm-card').forEach(x => x.classList.remove('active'));
          if (pins) pins.querySelectorAll('.wm-pin').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
          const pin = pins && pins.querySelector('.wm-pin[data-id="' + s.id + '"]');
          if (pin) pin.classList.add('active');
        };
        el.querySelector('.wc-go').onclick = ev => { ev.stopPropagation(); this.setMapTarget(s); };
      });
    }
    panel.classList.remove('hidden');
    this.mode = 'worldmap';
  };

  UI.closeWorldMap = function () {
    const p = $('world-map');
    if (p) p.classList.add('hidden');
    if (this.mode === 'worldmap') this.mode = null;
  };

  UI.toggleWorldMap = function () {
    if (this.mode === 'worldmap') this.closeWorldMap();
    else this.worldMap();
  };

  /* ---------- 世界上方的浮空地段標籤 ---------- */
  UI.buildWorldLabels = function () {
    const layer = $('world-labels');
    if (!layer) return;
    layer.innerHTML = '';
    this._wlItems = {};
    S.SITES.forEach(s => {
      const m = siteMeta(s);
      const el = document.createElement('div');
      el.className = 'wl-item';
      el.style.setProperty('--pin', m.color);
      el.style.opacity = '0';
      el.innerHTML = '<i class="sims-gem"></i><span>' + s.name + '</span><span class="wl-dist"></span>';
      layer.appendChild(el);
      this._wlItems[s.id] = el;
    });
  };

  UI.updateWorldLabels = function (playerPos, camera) {
    if (!this._wlItems || !camera || !window.THREE || !playerPos) return;
    const w = window.innerWidth, h = window.innerHeight;
    const v = new THREE.Vector3();
    const W = S.World;
    const MAXD = 140;                      // 只標近處地段：遠景名牌會貼住地平線，意義不大
    for (const s of S.SITES) {
      const el = this._wlItems[s.id];
      if (!el) continue;
      const d = Math.hypot(playerPos.x - s.x, playerPos.z - s.z);
      // 太遠、太近或面板開啟時淡出，避免遮蔽畫面與對話
      if (d > MAXD || d < 18 || this.mode) { el.style.opacity = '0'; continue; }
      const gy = W && W.groundY ? W.groundY(s.x, s.z) : 0;
      v.set(s.x, gy + 6, s.z).project(camera);
      if (v.z < -1 || v.z > 1) { el.style.opacity = '0'; continue; }
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      if (sx < -120 || sx > w + 120 || sy < -80 || sy > h + 80) { el.style.opacity = '0'; continue; }
      // 夾進安全區：名牌不會壓住頂部 HUD 與邊緣
      const cx = Math.max(84, Math.min(w - 84, sx));
      const cy = Math.max(112, Math.min(h - 26, sy));
      // 左下任務面板所在區域直接淡出，避免蓋住任務提示
      if (cx < 300 && cy > h - 272) { el.style.opacity = '0'; continue; }
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.opacity = String(Math.min(1, (MAXD - d) / 40, (d - 16) / 12));
      const dd = el.querySelector('.wl-dist');
      if (dd) dd.textContent = Math.round(d) + ' m';
      el.classList.toggle('wl-here', d < s.r);
    }
  };

  /* ---------------- 設置面板 ---------------- */
  UI.openSettings = function () {
    const panel = $('settings-panel');
    if (!panel) return;
    const D = S.Settings.data;
    const block = (title, hint) =>
      '<div class="set-block"><div class="set-title">' + title + '</div>' +
      (hint ? '<div class="set-hint">' + hint + '</div>' : '') + '<div class="set-rows"></div></div>';

    // 滑塊行
    const slider = (key, label, min, max, step, fmt) => {
      const v = D[key];
      return '<label class="set-row"><span class="set-label">' + label + '</span>' +
        '<input type="range" data-k="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + v + '">' +
        '<b class="set-val" data-v="' + key + '">' + (fmt ? fmt(v) : v) + '</b></label>';
    };
    // 開關行
    const toggle = (key, label) =>
      '<label class="set-row"><span class="set-label">' + label + '</span>' +
      '<input type="checkbox" data-k="' + key + '" class="set-chk"' + (D[key] ? ' checked' : '') + '></label>';
    // 下拉行
    const select = (key, label, opts) =>
      '<label class="set-row"><span class="set-label">' + label + '</span>' +
      '<select data-k="' + key + '" class="set-sel">' +
      opts.map(o => '<option value="' + o.v + '"' + (D[key] === o.v ? ' selected' : '') + '>' + o.t + '</option>').join('') +
      '</select></label>';

    panel.innerHTML =
      '<div class="set-head"><span class="set-h1">設置</span><button id="set-close" class="set-close">✕</button></div>' +
      '<div class="set-scroll">' +
      block('視角與操作', '開放世界常見手感調節') +
      block('畫面與聲音') +
      '</div>' +
      '<div class="set-foot"><button id="set-reset" class="set-reset">恢復默認</button>' +
      '<span class="set-tip">設置自動保存到本機</span></div>';

    const r1 = panel.querySelector('.set-block:nth-child(1) .set-rows');
    r1.innerHTML =
      slider('lookSensitivity', '滑動視角靈敏度', 0.3, 3.0, 0.1, v => v.toFixed(1) + '×') +
      slider('moveSensitivity', '移動靈敏度', 0.4, 2.0, 0.1, v => v.toFixed(1) + '×') +
      slider('cameraDist', '相機距離', 0.6, 1.6, 0.1, v => v.toFixed(1) + '×') +
      toggle('invertY', '反轉視角（上下）') +
      toggle('invertX', '反轉視角（左右）') +
      toggle('invertMove', '反轉移動方向');

    const r2 = panel.querySelector('.set-block:nth-child(2) .set-rows');
    r2.innerHTML =
      slider('volume', '音量', 0, 1, 0.05, v => Math.round(v * 100) + '%') +
      toggle('ambient', '環境音樂（草原風聲與墊音）') +
      select('quality', '畫質', [
        { v: 'high', t: '高（陰影·高像素比）' },
        { v: 'medium', t: '中（平衡）' },
        { v: 'low', t: '低（更流暢）' }
      ]);

    // 綁定事件
    panel.querySelectorAll('input[data-k]').forEach(inp => {
      const k = inp.dataset.k;
      const handler = () => {
        let val;
        if (inp.type === 'checkbox') val = inp.checked;
        else if (inp.type === 'range') val = parseFloat(inp.value);
        else val = inp.value;
        S.Settings.set(k, val);
        const vEl = panel.querySelector('.set-val[data-v="' + k + '"]');
        if (vEl) {
          const fmt = k === 'volume' ? (v => Math.round(v * 100) + '%')
            : (v => (typeof v === 'number' ? v.toFixed(1) + '×' : v));
          vEl.textContent = fmt(val);
        }
      };
      inp.addEventListener('input', handler);
      inp.addEventListener('change', handler);
    });
    panel.querySelectorAll('select[data-k]').forEach(sel => {
      sel.addEventListener('change', () => S.Settings.set(sel.dataset.k, sel.value));
    });

    $('set-close').onclick = () => this.closeSettings();
    $('set-reset').onclick = () => {
      S.Settings.reset();
      this.openSettings();   // 重建以反映默認值
    };

    // Esc 關閉（先移除舊監聽，避免重複打開/重置時疊加多個監聽器）
    if (this._setEsc) window.removeEventListener('keydown', this._setEsc);
    this._setEsc = e => { if (e.code === 'Escape') this.closeSettings(); };
    window.addEventListener('keydown', this._setEsc);

    this._settingsOpen = true;
    this.mode = 'settings';     // 佔用 UI.mode，使玩家移動/交互在設置期間暫停
    panel.classList.remove('hidden');
    SFX.open();
  };

  UI.closeSettings = function () {
    const panel = $('settings-panel');
    if (panel) panel.classList.add('hidden');
    this._settingsOpen = false;
    if (this.mode === 'settings') this.mode = null;
    if (this._setEsc) { window.removeEventListener('keydown', this._setEsc); this._setEsc = null; }
  };

  UI.isSettingsOpen = function () { return !!this._settingsOpen; };

  /* 趕牛進度條：只在吹哨趕牛時顯示 */
  UI.setHerd = function (st) {
    const el = $('herd-chip');
    if (!el) return;
    if (!st || !st.active) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const b = $('herd-count');
    const n = Math.min(st.penned, st.goal);
    if (b) b.textContent = st.done
      ? '✅ 牛羣已歸欄 ' + n + '/' + st.goal
      : '跟隨 ' + st.following + ' · 歸欄 ' + n + '/' + st.goal;
  };

  /* 任務導航箭頭：根據目標在屏幕上的投影，指向並提示距離。
   * sx,sy 為目標屏幕座標；onScreen 表示目標是否落在可視範圍內 */
  UI.navArrow = function (sx, sy, onScreen, distText) {
    const el = this._navArrow;
    if (!el) return;
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W / 2, cy = H / 2;
    const ang = Math.atan2(sy - cy, sx - cx);
    const edge = Math.min(W, H) / 2 - 60;
    const r = onScreen
      ? Math.min(edge, Math.hypot(sx - cx, sy - cy) * 0.9)   // 屏內：貼近目標
      : edge;                                                  // 屏外：貼邊緣當指南針
    el.classList.remove('hidden');
    el.style.left = (cx + Math.cos(ang) * r) + 'px';
    el.style.top = (cy + Math.sin(ang) * r) + 'px';
    el.style.transform = 'translate(-50%,-50%) rotate(' + (ang + Math.PI / 2) + 'rad)';
    const db = el.querySelector('#nav-dist');
    if (db) db.textContent = distText || '';
  };

  UI.hideNavArrow = function () { if (this._navArrow) this._navArrow.classList.add('hidden'); };

  /* ---------------- HUD ---------------- */
  UI.setHUD = function (st) {
    const pct = (v, m) => Math.max(0, Math.min(100, (v / m) * 100));
    $('bar-water').style.width = pct(st.water, 220) + '%';
    $('bar-food').style.width = pct(st.food, 900) + '%';
    $('bar-cash').style.width = pct(st.cash, 60000) + '%';
    $('bar-fert').style.width = pct(st.fertility, 100) + '%';
    $('bar-sus').style.width = pct(st.sustain, 100) + '%';
    $('val-water').textContent = Math.round(st.water);
    $('val-food').textContent = Math.round(st.food);
    $('val-cash').textContent = Math.round(st.cash).toLocaleString('en-US');
    $('val-fert').textContent = Math.round(st.fertility);
    $('val-sus').textContent = Math.round(st.sustain);
    $('val-notes').textContent = st.notes.size;
    const nt = $('notes-total');
    if (nt) nt.textContent = '/' + (S.NOTES ? S.NOTES.length : 59);
    $('season-name').textContent = st.season === 'rain' ? '雨季' : '旱季';
    $('season-icon').textContent = st.season === 'rain' ? '🌧' : '☀';
    $('season-day').textContent = '第 ' + st.day + ' 天';
  };

  UI.objective = function (chapter, title, steps) {
    $('obj-chapter').textContent = chapter;
    $('obj-title').textContent = title;
    const ul = $('obj-steps');
    ul.innerHTML = '';
    (steps || []).forEach(s => {
      const li = document.createElement('li');
      li.className = s.done ? 'done' : '';
      li.innerHTML = s.text;
      ul.appendChild(li);
    });
  };

  UI.zoneBanner = function (name) {
    if (name === this._lastZone) return;
    this._lastZone = name;
    const b = $('zone-banner');
    b.querySelector('span').textContent = name;
    b.classList.remove('hidden');
    // 重啓動畫
    const s = b.querySelector('span');
    s.style.animation = 'none'; void s.offsetWidth; s.style.animation = '';
    clearTimeout(this._zoneT);
    this._zoneT = setTimeout(() => b.classList.add('hidden'), 3000);
  };

  UI.prompt = function (text) {
    const p = $('interact-prompt');
    if (!text) { p.classList.add('hidden'); return; }
    $('interact-text').textContent = text;
    p.classList.remove('hidden');
  };

  UI.toast = function (text, kind) {
    const w = $('toast-wrap');
    const d = document.createElement('div');
    d.className = 'toast ' + (kind || '');
    d.innerHTML = text;
    w.appendChild(d);
    setTimeout(() => d.remove(), 3100);
  };

  UI.flash = function (on) {
    const f = $('fx-flash');
    f.classList.toggle('on', !!on);
  };

  /* ---------------- 對話 ---------------- */
  UI.showDialogue = function (spec, node, handler) {
    const who = spec || { face: '👤', name: '村民', role: '' };
    // 兼容舊版 HTML：優先按 id 取，取不到再按類名取，避免 null.style 拋錯
    const nextEl = $('dlg-next') || document.querySelector('.dlg-next');
    $('dlg-avatar').textContent = who.face || '👤';
    $('dlg-name').textContent = who.name || '';
    $('dlg-role').textContent = who.role || '';
    $('dlg-text').innerHTML = (node.text || '').replace(/\n/g, '<br>');
    const ch = $('dlg-choices');
    ch.innerHTML = '';
    if (node.opts && node.opts.length) {
      if (nextEl) nextEl.style.display = 'none';
      node.opts.forEach(o => {
        const b = document.createElement('button');
        b.className = 'choice';
        b.innerHTML = o.t;
        b.onclick = () => { SFX.talk(); handler(o); };
        ch.appendChild(b);
      });
    } else {
      if (nextEl) nextEl.style.display = 'flex';
    }
    $('dialogue').classList.remove('hidden');
    // 所有 DOM 操作成功後再佔用模態：中途異常不會把 UI.mode 永久卡在 dialogue
    this.mode = 'dialogue';
    this._dlgHandler = handler;
    this._dlgNode = node;
    SFX.talk();
  };

  UI._continue = function () {
    const node = this._dlgNode;
    this.hideDialogue();
    if (this._dlgHandler) this._dlgHandler({ to: node ? node.to : null, act: node ? node.act : null, isContinue: true });
  };

  UI.hideDialogue = function () {
    $('dialogue').classList.add('hidden');
    if (this.mode === 'dialogue') this.mode = null;
  };

  /* ---------------- 問答 ---------------- */
  UI.showQuiz = function (item, onDone) {
    this.mode = 'quiz';
    this._quizHandler = onDone;
    $('quiz-tag').textContent = item.groupLabel;
    // 來源標示只用 C5 筆記的小節，不引用筆記以外的課程單元。
    $('quiz-src').textContent = item.src || 'C5 農業與饑荒 · 課堂筆記';
    $('quiz-stem').innerHTML = item.q.replace(/\n/g, '<br>');
    const fig = $('quiz-figure');
    if (item.fig) { fig.textContent = item.fig; fig.classList.remove('hidden'); }
    else fig.classList.add('hidden');

    const box = $('quiz-opts');
    box.innerHTML = '';
    const letters = ['A', 'B', 'C', 'D'];
    item.o.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.innerHTML = '<span class="k">' + letters[i] + '</span><span>' + opt + '</span>';
      b.onclick = () => this._answer(item, i, box, b);
      box.appendChild(b);
    });
    $('quiz-feedback').classList.add('hidden');
    $('quiz').classList.remove('hidden');
    this._answered = false;
    this._quizOk = false;
    SFX.open();
  };

  UI._answer = function (item, i, box, btn) {
    if (this._answered) return;
    this._answered = true;
    const btns = box.querySelectorAll('.opt');
    btns.forEach((b, k) => {
      b.classList.add('locked');
      if (k === item.a) b.classList.add('correct');
      else if (k === i) b.classList.add('wrong');
    });
    const ok = i === item.a;
    const fb = $('quiz-feedback');
    const head = $('fb-head');
    head.className = 'fb-head ' + (ok ? 'ok' : 'no');
    head.textContent = ok ? '✔ 答對了' : '✘ 正確答案：' + ['A', 'B', 'C', 'D'][item.a];
    $('fb-body').innerHTML = item.exp;
    $('fb-reward').textContent = ok
      ? '＋ 知識點「' + item.note.t + '」　＋ 可持續指數 2'
      : '知識點仍會記錄「' + item.note.t + '」，但可持續指數不增加';
    fb.classList.remove('hidden');
    ok ? SFX.good() : SFX.bad();
    this._quizOk = ok;
  };

  UI._closeQuiz = function () {
    $('quiz').classList.add('hidden');
    const ok = this._quizOk;
    const item = this._currentQuiz;
    this._answered = false;
    this.mode = null;
    if (this._quizHandler) { const h = this._quizHandler; this._quizHandler = null; h(ok, item); }
  };

  /* ---------------- 遮罩面板 ---------------- */
  UI.overlay = function (html, buttons, onClose) {
    this.mode = 'overlay';
    // 可選關閉回調：讓「標題 → 操作説明 → 返回標題」這類流程在點擊按鈕或按 Esc 時都能回到來處
    this._overlayOnClose = onClose || null;
    const p = $('ov-panel');
    p.innerHTML = html;
    const row = document.createElement('div');
    row.className = 'ov-btn-row';
    (buttons || []).forEach(b => {
      const el = document.createElement('button');
      el.className = 'ov-btn' + (b.ghost ? ' ghost' : '');
      el.textContent = b.label;
      el.onclick = () => { if (b.onClick) b.onClick(); };
      row.appendChild(el);
    });
    p.appendChild(row);
    $('overlay').classList.remove('hidden');
    $('overlay').scrollTop = 0;
    p.scrollTop = 0;
  };

  UI.closeOverlay = function () {
    $('overlay').classList.add('hidden');
    if (this.mode === 'overlay') this.mode = null;
    const cb = this._overlayOnClose;
    this._overlayOnClose = null;
    if (cb) { try { cb(); } catch (e) { console.error('[UI] overlay onClose 失敗：', e); } }
  };

  /* ---------------- 本地市場：集市與商店 ---------------- */
  // 在本地市場（market 區域）按 F 打開。集市的「賣」與商店的「買」放在同一面板，
  // 形成「賣糧／賣牛 → 賺法郎 → 買肥料／種子／課堂筆記」的經濟循環。
  UI.market = function () {
    if (!this.game) return;
    this.mode = 'overlay';
    this._overlayOnClose = null;
    this._renderMarket();
    const ov = $('overlay');
    ov.classList.remove('hidden');
    ov.scrollTop = 0;
    const p = $('ov-panel');
    if (p) p.scrollTop = 0;
  };

  UI._renderMarket = function () {
    const g = this.game, st = g.state;
    const own = (label, v) => '<span class="mi-own">' + label + ' ' + v + '</span>';
    let h = '<h1>本地市場 · 集市與商店</h1>' +
      '<div class="sub">MARKET · 賺來的法郎（F）可以買種子、肥料，也別忘了買一本課堂筆記溫習</div>' +
      '<div class="mkt-sec"><h2>集市（賣）</h2>';
    h += '<div class="mkt-item"><div class="mi-l"><b>賣糧食</b>' +
      '<span>小米 · 62 F / kg（一次賣出一批，會留作家裏口糧）</span></div>' +
      '<div class="mi-r">' + own('現有', Math.round(st.food) + ' kg') +
      '<button class="mkt-buy" data-act="sell-grain">賣出</button></div></div>';
    h += '<div class="mkt-item"><div class="mi-l"><b>賣牛</b>' +
      '<span>肉牛 · 850 F / 頭</span></div>' +
      '<div class="mi-r">' + own('可售', (st.cattle || 0) + ' 頭') +
      '<button class="mkt-buy" data-act="sell-cattle">賣出</button></div></div>';
    h += '</div><div class="mkt-sec"><h2>商店（買）</h2>';
    h += '<div class="mkt-item"><div class="mi-l"><b>肥料</b>' +
      '<span>施加化學肥料，提升土壤肥力（代價見 5.8 使用農業科技的代價）</span></div>' +
      '<div class="mi-r"><span class="mi-price">300 F</span>' +
      '<button class="mkt-buy" data-act="buy-fert">購買</button></div></div>';
    h += '<div class="mkt-item"><div class="mi-l"><b>種子</b>' +
      '<span>樹苗種子 5 份；有種子時在防風林可免費領樹苗</span></div>' +
      '<div class="mi-r"><span class="mi-price">200 F</span>' +
      '<button class="mkt-buy" data-act="buy-seeds">購買</button></div></div>';
    h += '<div class="mkt-item"><div class="mi-l"><b>地理筆記</b>' +
      '<span>《C5 農業與饑荒》課堂筆記一本，買下即可溫習全部知識點</span></div>' +
      '<div class="mi-r">' + (st.notebook
        ? '<span class="mi-own">已擁有</span>'
        : '<span class="mi-price">500 F</span><button class="mkt-buy" data-act="buy-note">購買</button>') +
      '</div></div>';
    h += '</div>';
    h += '<div class="mkt-foot"><span>現金 <b>' + Math.round(st.cash).toLocaleString('en-US') + ' F</b></span>' +
      '<button class="mkt-close" data-act="close">離開市場</button></div>';
    const p = $('ov-panel');
    p.innerHTML = h;
    p.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = () => {
        const a = b.getAttribute('data-act');
        if (a === 'sell-grain') g.sellGrain();
        else if (a === 'sell-cattle') g.sellCattle();
        else if (a === 'buy-fert') g.buyFertilizer();
        else if (a === 'buy-seeds') g.buySeeds();
        else if (a === 'buy-note') g.buyNotebook();
        else if (a === 'close') { this.closeOverlay(); return; }
        if (a !== 'close') this._renderMarket();   // 交易後刷新金額與持有
      };
    });
  };

  /* ---------------- 背包 ---------------- */
  // 按 I 或 HUD「🎒 背包」打開。列出資源與從本地市場商店買來的東西。
  UI.inventory = function () {
    const g = this.game, st = g.state;
    const cell = (ic, name, val, note) =>
      '<div class="inv-cell"><span class="ic">' + ic + '</span><b>' + name + '</b>' +
      '<i>' + val + '</i>' + (note ? '<span class="inv-note">' + note + '</span>' : '') + '</div>';
    let h = '<h1>背包</h1>' +
      '<div class="sub">INVENTORY · 你擁有的資源與從商店買來的東西</div>' +
      '<h2>資源</h2><div class="inv-grid">' +
      cell('🐄', '肉牛', (st.cattle || 0) + ' 頭', '可在本地市場賣出') +
      cell('🌾', '糧食', Math.round(st.food) + ' kg', '家裏的口糧與小米') +
      cell('🪙', '現金', Math.round(st.cash).toLocaleString('en-US') + ' F', '西非法郎，用於買賣') +
      cell('🟤', '土壤肥力', Math.round(st.fertility) + ' / 100', '自家田的養分') +
      '</div>' +
      '<h2>商店物品</h2><div class="inv-grid">' +
      cell('🌱', '樹苗種子', (st.seeds || 0) + ' 份', '耕地耕田可播種；防風林可領苗') +
      cell('🧪', '肥料', '已施用 ' + (st.fertBought || 0) + ' 份', '買下即施用，提升肥力（5.8 代價）') +
      cell('📘', '課堂筆記', st.notebook ? '已擁有' : '未擁有', '《C5 農業與饑荒》全部知識點') +
      '</div>';
    this.overlay(h, [{ label: '關閉', ghost: true, onClick: () => this.closeOverlay() }]);
  };

  /* ---------------- 章節引言 ---------------- */
  UI.chapterCard = function (act, onStart) {
    const html =
      '<div class="sub">CHAPTER · ' + act.chapter + '</div>' +
      '<h1>' + act.title + '</h1>' +
      '<div class="lead" style="margin-top:14px">' + act.intro.replace(/\n/g, '<br>') + '</div>';
    this.overlay(html, [{ label: '進入本章 ▸', onClick: () => { this.closeOverlay(); onStart(); } }]);
  };

  /* ---------------- 任務日誌 ---------------- */
  UI.journal = function () {
    const g = this.game;
    let html = '<h1>任務日誌</h1><div class="sub">JOURNAL · 阿馬杜的選擇</div>';
    S.ACTS.forEach(act => {
      const st = g.actState[act.id];
      const state = !st ? '未開始' : (st.done ? '已完成' : '進行中');
      html += '<h2>' + act.chapter + ' · ' + act.title + '　<span class="badge">' + state + '</span></h2>';
      act.steps.forEach((s, i) => {
        const done = st && i < st.step;
        html += '<div class="log-item' + (done ? ' done' : '') + '"><div class="lt">' +
          (done ? '✔ ' : '○ ') + (s.desc || s.k) + '</div>';
        html += '</div>';
      });
    });
    html += '<h2>關鍵決定</h2>';
    const flags = g.flags;
    const flagRows = [
      ['見過祖母 Aïcha', flags.met_aicha],
      ['問過牧草的去處', flags.ask_grass],
      ['認識土地負載力', flags.learned_load],
      ['弄清畜牧季移方向', flags.learned_season],
      ['意願：留下', flags.wish_stay],
      ['意願：外出', flags.wish_go]
    ];
    html += flagRows.map(r => '<div class="kv"><span>' + r[0] + '</span><b>' + (r[1] ? '是' : '—') + '</b></div>').join('');
    this.overlay(html, [{ label: '關閉', ghost: true, onClick: () => this.closeOverlay() }]);
  };

  /* ---------------- 地理筆記 ---------------- */
  UI.notes = function () {
    const g = this.game;
    const groups = {};
    S.NOTES.forEach(n => { (groups[n.g] = groups[n.g] || { label: n.label, items: [] }).items.push(n); });
    let html = '<h1>地理筆記</h1><div class="sub">DSE GEOGRAPHY NOTES · 已收集 ' + g.state.notes.size + ' / ' + S.NOTES.length + '</div>';
    html += '<p style="margin-bottom:12px">答對題目可解鎖知識點。考試前可以回來複習——這裏的每一條都可能出現在資料為本題裏。</p>';
    Object.keys(groups).forEach(k => {
      const gr = groups[k];
      html += '<h2>' + gr.label + '</h2>';
      gr.items.forEach(n => {
        const got = g.state.notes.has(n.id);
        html += '<div class="note-card' + (got ? '' : ' locked') + '">' +
          '<div class="nt">' + (got ? '' : '🔒 ') + n.t + '</div>' +
          (got ? '<div class="nd">' + n.d + '</div>' : '<div class="nd">完成相關題目後解鎖</div>') +
          '</div>';
      });
    });
    this.overlay(html, [{ label: '關閉', ghost: true, onClick: () => this.closeOverlay() }]);
  };

  /* ---------------- 操作説明 ---------------- */
  UI.help = function (fromTitle) {
    const rows = [
      ['W A S D / 方向鍵', '移動'],
      ['Shift（按住）', '奔跑'],
      ['空格', '跳躍 / 對話繼續 / 關閉面板'],
      ['鼠標左鍵拖動', '旋轉視角'],
      ['滾輪', '拉近／拉遠鏡頭'],
      ['F / E', '與人交談、調查'],
      ['Tab 或 J', '任務日誌'],
      ['N', '地理筆記'],
      ['H', '操作説明'],
      ['G', '吹哨趕牛／停止趕牛'],
      ['M', '環境音樂 開／關'],
      ['B', '世界地圖／地段懸浮標示'],
      ['Esc', '關閉當前面板']
    ];
    let html = '<h1>操作説明</h1><div class="sub">CONTROLS</div><div style="margin-top:10px">';
    html += rows.map(r => '<div class="help-key"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>').join('');
    html += '</div><h2>關於這個遊戲</h2>' +
      '<p>你是 Amadou，薩赫勒地區一名隨季節放牧的牧民。跟着祖母、村民與長者，' +
      '把課堂筆記《C5 農業與饑荒》從<b>農業系統</b>一路走到<b>農業科技的代價</b>。</p>' +
      '<p style="margin-top:10px">所有對話、任務、題目與筆記條目<b>只取材自 C5《農業與饑荒》5.1–5.8</b>：' +
      '農業系統、農業的分類、薩赫勒遊牧業、南加州灌溉農業、饑荒的定義與成因、解決方法、農業科技的代價。' +
      '答錯也會記下解析——這是學習的一部分。</p>' +
      '<h2>放牛玩法</h2>' +
      '<p>按 <b>G</b>，或點畫面右上角的 <b>🎵 吹哨</b> 鍵（手機在右下角），就會吹一聲喚牛口哨，' +
      '附近的牛會跟着你走；把牠們帶到<b>牧民營地的畜欄</b>，' +
      '歸欄 6 頭即可獲得家計與可持續發展指數獎勵。再吹一次哨停止趕牛。</p>' +
      '<h2>環境音樂</h2>' +
      '<p>背景是即時合成的草原風聲與輕柔墊音，雨季會轉為細雨聲，不需要額外下載音訊檔。' +
      '可用 <b>M</b> 鍵、右上角的 <b>♫ 音樂</b> 鍵，或「設置 → 環境音樂」隨時開關；音量跟隨「音量」滑塊。</p>' +
      '<h2>地段與世界地圖</h2>' +
      '<p>小地圖上的菱形標記代表各個地段，把鼠標移上去會顯示用途與距離；草原上也會浮起地段名牌。' +
      '按 <b>B</b> 或點小地圖下方的 <b>⤢ 世界地圖</b> 可打開全屏地圖，' +
      '點「前往」把地段設為導航目標，跟着畫面上的箭頭走即可；抵達後會自動解除，再點一次同一地段也能取消。</p>' +
      '<h2>資產與授權</h2>' +
      '<p>場景模型全部來自 <a href="https://poly.pizza/" target="_blank" rel="noopener">Poly Pizza</a>，' +
      '並逐一以 SHA-256 比對原始下載檔確認來源。' +
      '<b>Quaternius</b> 與 <b>hat_my_guy</b> 的模型為 <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener">CC0 1.0</a>（公有領域）。' +
      '下列模型採 <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener">CC BY 3.0</a>，特此署名：' +
      '<b>Poly by Google</b>（Schoolhouse）、<b>jeremy</b>（Camel、Goat）、' +
      '<b>madtrollstudio</b>（Cow）、<b>Kawin Kongwong</b>（Bang Luang Mosque）。' +
      '完整作者、來源、授權、SHA-256 及修改記錄見 <code>vendor/models/ATTRIBUTION.json</code>。</p>';
    const btns = [
      { label: '音效：' + (SFX.on ? '開' : '關'), ghost: true, onClick: () => { SFX.on = !SFX.on; this.help(fromTitle); } },
      { label: '環境音樂：' + (Ambient.on ? '開' : '關'), ghost: true, onClick: () => { this.toggleMusic(); this.help(fromTitle); } },
      { label: fromTitle ? '返回標題' : '關閉', onClick: () => this.closeOverlay() }
    ];
    // 從標題頁進來時，無論點「返回標題」還是按 Esc，都回到標題，避免遊戲卡在未開始狀態
    const back = fromTitle
      ? () => this.title(this._titleArgs && this._titleArgs.onStart, this._titleArgs && this._titleArgs.onSkipStory)
      : null;
    this.overlay(html, btns, back);
  };

  /* ---------------- 小遊戲 ---------------- */
  /* 五個練習只演示筆記 C5 提過的耕作／放牧方式；type 標識保持不變，
   * 以免影響任務鏈、設施交互與狀態欄。 */
  const MINI = {
    zai: {
      title: '覆蓋耕作',
      sub: '把禾稈殘株蓋在表土上',
      cols: 6, rows: 4, need: 8, cls: 'dug', icon: '🌾',
      hint: '筆記 5.8「其他土壤保育方式」：<b>覆蓋耕作——保護表土免受侵蝕</b>。\n點擊格子把禾稈、殘株覆蓋在表土上，替土壤擋住雨打與風蝕。',
      tip: '土壤侵蝕是筆記 5.3 裏荒漠化流程的中間一步；先護住表土，才談得上保住養分。'
    },
    stone: {
      title: '等高耕作',
      sub: '沿等高線耕作，讓水慢下來',
      cols: 6, rows: 4, need: 4, cls: 'stone', icon: '🪨',
      hint: '筆記 5.8：<b>等高耕作——減少地表徑流、減慢土壤侵蝕</b>。\n點擊<b>同一列</b>的格子連成一道（共需 4 道），沿等高線耕作，雨水就不會順坡把表土沖走。',
      tip: '要沿等高線才有效；順坡耕作會讓徑流加劇，反而沖出蝕溝。'
    },
    tree: {
      title: '種植防風林',
      sub: '筆記 5.8 的土壤保育方式',
      cols: 6, rows: 4, need: 5, cls: 'tree', icon: '🌳',
      hint: '筆記 5.8：<b>種植防風林——減慢土壤侵蝕</b>。\n點擊 5 個格子種下樹苗，一排樹把風速降下來，表土便不易被吹走。',
      tip: '筆記 5.7 亦提醒：引入農業科技未必百利而無害，在薩赫勒挖水井也可能令環境退化。'
    },
    water: {
      title: '打水',
      sub: '旱季為畜羣取水',
      cols: 6, rows: 4, need: 6, cls: 'dug', icon: '💧',
      hint: '筆記 5.3：牧民要隨季節尋找牧草和水源。\n點擊格子把桶放下去再提上來，為畜羣備好旱季的水。',
      tip: '筆記 5.6／5.7：誤用水資源（例如在薩赫勒大量挖井）會令地下水位下降、土壤鹽化。'
    },
    graze: {
      title: '練習畜牧季移',
      sub: '點還有草的格子，別把同一塊啃禿',
      cols: 6, rows: 4, need: 8, cls: 'grazed', icon: '🌿',
      hint: '筆記 5.3：<b>畜牧季移</b>——牲畜吃光一地的牧草就換一地，原本的牧地得以休養生息。\n<b>點綠格</b>把草吃了；<b>同一格點兩次</b>就會啃禿（不計數）。',
      tip: '筆記 5.3：<b>過度放牧</b>會引致土壤結實、自然植被減少，是荒漠化的起點。'
    }
  };

  UI.minigame = function (type, need, onDone) {
    if (type === 'graze') { this._grazeGame(need || 8, onDone); return; }
    const cfg = MINI[type] || MINI.zai;
    cfg.need = need || cfg.need;
    this.mode = 'minigame';
    let count = 0;
    const colsDone = {};
    let html = '<h1>' + cfg.title + '</h1><div class="sub">' + cfg.sub + '</div>' +
      '<div class="mg-bar"><i id="mg-bar"></i></div>' +
      '<div class="mg-grid" id="mg-grid"></div>' +
      '<div class="mg-hint">' + cfg.hint.replace(/\n/g, '<br>') + '</div>' +
      '<div class="mg-hint" style="margin-top:8px;opacity:.6">💡 ' + cfg.tip + '</div>';
    this.overlay(html, []);
    const grid = $('mg-grid');
    const total = cfg.cols * cfg.rows;
    for (let i = 0; i < total; i++) {
      const c = document.createElement('div');
      c.className = 'mg-cell';
      c.dataset.i = i;
      c.onclick = () => {
        if (c.classList.contains('done')) return;
        c.classList.add('done', cfg.cls);
        c.textContent = cfg.icon;
        count++;
        const col = i % cfg.cols;
        colsDone[col] = (colsDone[col] || 0) + 1;
        $('mg-bar').style.width = Math.min(100, (count / cfg.need) * 100) + '%';
        if (type === 'zai') SFX.dig();
        else if (type === 'stone') SFX.stone();
        else if (type === 'tree') SFX.plant();
        else SFX.dig();
        if (count >= cfg.need) {
          setTimeout(() => {
            SFX.good();
            this.closeOverlay();
            onDone(count);
          }, 420);
        }
      };
      grid.appendChild(c);
    }
    // 加"放棄"按鈕
    const row = document.createElement('div');
    row.className = 'ov-btn-row';
    const b = document.createElement('button');
    b.className = 'ov-btn ghost';
    b.textContent = '先離開（進度保留）';
    b.onclick = () => { this.closeOverlay(); onDone(count, true); };
    row.appendChild(b);
    $('ov-panel').appendChild(row);
  };

  /* 畜牧季移小遊戲：點綠格吃草，同一格點兩次會啃禿（不計數），對應筆記 5.3 避免過度放牧、讓牧地休養生息 */
  UI._grazeGame = function (need, onDone) {
    let fresh = 0, over = 0;
    const total = 6 * 4;
    let html = '<h1>練習畜牧季移</h1><div class="sub">點還有草的格子，別把同一塊啃禿</div>' +
      '<div class="mg-bar"><i id="mg-bar"></i></div>' +
      '<div class="mg-grid" id="mg-grid"></div>' +
      '<div class="mg-hint">筆記 5.3：<b>畜牧季移</b>——牲畜吃光一地牧草就換一地，原本的牧地得以休養生息。<b>點綠格</b>把草吃了；<b>同一格點兩次</b>會啃禿（不計數）。</div>' +
      '<div class="mg-hint" style="margin-top:8px;opacity:.6">💡 筆記 5.3：<b>過度放牧</b>會引致土壤結實、自然植被減少，是荒漠化的起點。</div>';
    this.overlay(html, []);
    const grid = $('mg-grid');
    const state = new Array(total).fill('grass');
    // 預先把 5 塊隨機設為已禿（展示"超載"現狀）
    const idxs = [];
    for (let i = 0; i < total; i++) idxs.push(i);
    for (let i = idxs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idxs[i], idxs[j]] = [idxs[j], idxs[i]]; }
    idxs.slice(0, 5).forEach(i => { state[i] = 'bare'; });
    const cells = [];
    for (let i = 0; i < total; i++) {
      const c = document.createElement('div');
      c.className = 'mg-cell';
      if (state[i] === 'bare') { c.classList.add('bare'); c.textContent = '🟫'; }
      else { c.textContent = '🌿'; }
      c.onclick = () => {
        if (c.classList.contains('grazed') || c.classList.contains('over')) return;
        if (state[i] === 'bare') { SFX.bad(); UI.toast('這塊已經禿了，別再啃', 'bad'); return; }
        if (!c.classList.contains('grazed')) {
          c.classList.add('grazed'); c.textContent = '🌾'; fresh++;
          $('mg-bar').style.width = Math.min(100, (fresh / need) * 100) + '%';
          SFX.plant();
        }
        // 第二次點同一格：啃禿
        c.onclick = () => {
          if (c.classList.contains('over')) return;
          c.classList.remove('grazed'); c.classList.add('over'); c.textContent = '🟫';
          fresh = Math.max(0, fresh - 1); over++;
          $('mg-bar').style.width = Math.min(100, (fresh / need) * 100) + '%';
          SFX.bad(); UI.toast('啃禿了！要讓牧地休養生息', 'bad');
          updateDone();
        };
        updateDone();
      };
      cells.push(c);
      grid.appendChild(c);
    }
    function updateDone() {
      if (fresh >= need) {
        setTimeout(() => {
          SFX.good();
          UI.closeOverlay();
          onDone(fresh);
        }, 380);
      }
    }
    const row = document.createElement('div');
    row.className = 'ov-btn-row';
    const b = document.createElement('button');
    b.className = 'ov-btn ghost';
    b.textContent = '先離開（進度保留）';
    b.onclick = () => { UI.closeOverlay(); onDone(fresh, true); };
    row.appendChild(b);
    $('ov-panel').appendChild(row);
  };

  /* ---------------- 結局 ---------------- */
  UI.ending = function (ending, stats, onRestart) {
    let html = '<div class="sub">' + ending.sub + '</div><h1>' + ending.title + '</h1>' +
      '<div class="lead" style="margin-top:14px">' + ending.text.replace(/\n/g, '<br>') + '</div>' +
      '<h2>地理分析</h2><p>' + ending.analysis + '</p>' +
      '<h2>本作涉及的 DSE 考點</h2><ul>' + ending.dse.map(d => '<li>' + d + '</li>').join('') + '</ul>' +
      '<h2>你的成績</h2>' +
      '<div class="kv"><span>答題正確率</span><b>' + stats.correct + ' / ' + stats.total + '（' + stats.rate + '%）</b></div>' +
      '<div class="kv"><span>知識點收集</span><b>' + stats.notes + ' / ' + stats.notesTotal + '</b></div>' +
      '<div class="kv"><span>土壤肥力（自家田）</span><b>' + Math.round(stats.fertility) + ' / 100</b></div>' +
      '<div class="kv"><span>可持續發展指數</span><b>' + Math.round(stats.sustain) + ' / 100</b></div>' +
      '<div class="kv"><span>存糧 / 現金</span><b>' + Math.round(stats.food) + ' kg · ' + Math.round(stats.cash).toLocaleString('en-US') + ' F</b></div>' +
      '<h2>課程對照 · C5 農業與饑荒</h2><div>' +
      ['5.1 農業系統', '5.2 農業的分類', '5.3 薩赫勒遊牧業', '5.4 南加州灌溉農業', '5.5 饑荒的定義', '5.6 饑荒的原因', '5.7 解決方法', '5.8 農業科技的代價']
        .map(t => '<span class="badge">' + t + '</span>').join('') + '</div>';
    this.overlay(html, [
      { label: '再玩一次（重新開始）', onClick: () => { this.closeOverlay(); onRestart(); } },
      { label: '查看地理筆記', ghost: true, onClick: () => this.notes() }
    ]);
  };

  /* ---------------- 小地圖 ---------------- */
  /* 底圖預渲染：size 決定解析度，labels 決定是否畫舊式地名。
   * 小地圖用 200px（帶地名，保留方位感）；世界地圖用 520px 高清版，
   * 不再重複寫地名，改由菱形標記與名牌呈現，畫面更乾淨。 */
  UI._renderMinimapBase = function (size, labels) {
    size = size || 200;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const c = cv.getContext('2d');
    const toMM = (x, z) => [(x + 230) / 460 * size, (z + 230) / 460 * size];
    const k = size / 200;                       // 線寬、圓點、文字的縮放倍率
    // 底色（按乾旱度）
    for (let i = 0; i < size; i += 4) {
      for (let j = 0; j < size; j += 4) {
        const x = (i / size) * 460 - 230, z = (j / size) * 460 - 230;
        const a = S.aridityAt(x, z);
        let r, g, b;
        if (a < 0.42) { r = lerp3(109, 168, a / 0.42); g = lerp3(127, 148, a / 0.42); b = lerp3(58, 79, a / 0.42); }
        else if (a < 0.72) { const t = (a - 0.42) / 0.3; r = lerp3(168, 176, t); g = lerp3(148, 116, t); b = lerp3(79, 58, t); }
        else { const t = (a - 0.72) / 0.28; r = lerp3(176, 224, t); g = lerp3(116, 189, t); b = lerp3(58, 133, t); }
        c.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
        c.fillRect(i, j, 4, 4);
      }
    }
    // 水塘
    const [wx, wz] = toMM(S.WORLD.water.x, S.WORLD.water.z);
    c.fillStyle = '#2f6f8f';
    c.beginPath(); c.arc(wx, wz, 11 * k, 0, 6.283); c.fill();
    // 道路
    c.strokeStyle = 'rgba(230,200,150,0.55)';
    c.lineWidth = 1.4 * k;
    // 簡易：連接站點
    const roads = [
      ['village', 'market'], ['village', 'farm'], ['village', 'well'], ['farm', 'demo'],
      ['demo', 'mare'], ['mare', 'camp'], ['village', 'nursery'], ['nursery', 'dunes'], ['market', 'station']
    ];
    const site = id => S.SITES.find(s => s.id === id);
    roads.forEach(p => {
      const A = site(p[0]), B = site(p[1]);
      if (!A || !B) return;
      const [ax, az] = toMM(A.x, A.z), [bx, bz] = toMM(B.x, B.z);
      c.beginPath(); c.moveTo(ax, az); c.lineTo(bx, bz); c.stroke();
    });
    // 站點圓點與地名（世界地圖用菱形標記＋名牌，故可關閉）
    if (labels !== false) {
      c.font = (7 * k) + 'px sans-serif'; c.textAlign = 'center';
      S.SITES.forEach(s => {
        const [x, z] = toMM(s.x, s.z);
        c.fillStyle = 'rgba(255,235,190,0.9)';
        c.beginPath(); c.arc(x, z, 2.4 * k, 0, 6.283); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.62)';
        c.fillText(s.name.slice(0, 4), x, z - 5 * k);
      });
    }
    return cv;
  };
  function lerp3(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

  UI.drawMinimap = function (playerPos, yaw, targets) {
    const cv = $('minimap');
    if (!cv || !this._mmBase) return;
    this._playerPos = playerPos;
    this.updateSiteMarkers(playerPos);
    const c = cv.getContext('2d');
    c.clearRect(0, 0, 200, 200);
    c.drawImage(this._mmBase, 0, 0);
    const toMM = (x, z) => [(x + 230) / 460 * 200, (z + 230) / 460 * 200];
    // 當前目標
    (targets || []).forEach(t => {
      const [x, z] = toMM(t.x, t.z);
      c.strokeStyle = '#ffd477';
      c.lineWidth = 1.6;
      c.beginPath(); c.arc(x, z, 5 + Math.sin(performance.now() / 260) * 1.6, 0, 6.283); c.stroke();
    });
    // NPC
    S.NPCS.forEach(n => {
      const [x, z] = toMM(n.x, n.z);
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.fillRect(x - 1, z - 1, 2, 2);
    });
    // 玩家
    const [px, pz] = toMM(playerPos.x, playerPos.z);
    c.save();
    c.translate(px, pz);
    // 玩家前進向量為 (mx,mz)=(-sin yaw,-cos yaw)，地圖上 +x 右、+z 下，
    // 三角形尖端預設朝 -y（上），旋轉 -yaw 才會指向玩家前進方向（指南針式）。
    c.rotate(-yaw);
    c.fillStyle = '#e8871e';
    c.beginPath();
    c.moveTo(0, -5); c.lineTo(3.4, 4); c.lineTo(0, 2); c.lineTo(-3.4, 4);
    c.closePath(); c.fill();
    c.restore();
    // 邊框刻度
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, 199, 199);
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.font = '9px sans-serif'; c.textAlign = 'center';
    c.fillText('北 ▲', 100, 12);
  };

  /* ---------------- 標題畫面 ---------------- */
  UI.title = function (onStart, onSkipStory) {
    this._titleArgs = { onStart, onSkipStory };
    const html =
      '<div class="sub">DSE GEOGRAPHY · OPEN WORLD ADVENTURE</div>' +
      '<h1>薩赫勒之歌</h1>' +
      '<p style="margin-top:10px">Song of the Sahel —— 一羣隨季節遷移的牛，和一本《C5 農業與饑荒》的課堂筆記。</p>' +
      '<div class="grid2" style="margin-top:20px">' +
      '<div class="card"><div class="t">你將扮演</div><div class="d">Amadou，薩赫勒地區一名牧民。跟着祖母、村民與長者，' +
      '把筆記裏的<b>農業系統</b>、<b>遊牧業</b>、<b>饑荒</b>與<b>農業科技</b>，一節一節走成眼前這片草原。</div></div>' +
      '<div class="card"><div class="t">你將面對</div><div class="d">農業系統的投入與產出、薩赫勒的自然環境與土地負載力、' +
      '畜牧季移、近年轉變引致的環境退化、南加州灌溉農業、饑荒的成因與解決方法，以及使用農業科技的代價。</div></div>' +
      '</div>' +
      '<h2>對應課堂筆記《C5 農業與饑荒》</h2>' +
      '<div>' + ['5.1 農業系統', '5.2 農業的分類', '5.3 薩赫勒遊牧業', '5.4 南加州灌溉農業', '5.5 饑荒的定義', '5.6 饑荒的原因', '5.7 解決方法', '5.8 農業科技的代價'].map(t => '<span class="badge">' + t + '</span>').join('') + '</div>' +
      '<h2>玩法</h2>' +
      '<ul>' +
      '<li>在<b>開放世界</b>裏放牧：村落、南部農田、水井、水源地、牧民營地、防風林、荒漠邊緣、本地市場、村口</li>' +
      '<li>與村民交談推進劇情，每個關鍵節點都有<b>只取材自筆記的選擇題</b>（答錯也有詳細解析）</li>' +
      '<li>按 <b>G</b> 吹哨趕牛，把牛帶回牧民營地的畜欄——這是一款放牛遊戲</li>' +
      '<li>按 <b>B</b> 打開世界地圖，懸浮查看<b>村落、農田、水井、水源地、本地市場</b>等地段並設定導航目標</li>' +
      '<li>親手練習<b>等高耕作、種植防風林、畜牧季移</b>等筆記裏的耕作與放牧方式</li>' +
      '<li>季節會推進：旱季與雨季交替；多種結局取決於你的選擇與<b>可持續發展指數</b></li>' +
      '</ul>' +
      '<p style="margin-top:14px;opacity:.7;font-size:13px">建議先按 <b>H</b> 查看操作説明。全程約 25–35 分鐘。</p>';
    this.overlay(html, [
      { label: '開始故事 ▸', onClick: () => { this.closeOverlay(); onStart(); } },
      { label: '操作説明', ghost: true, onClick: () => this.help(true) }
    ]);
  };

  UI.SFX = SFX;
  UI.Ambient = Ambient;
  global.SOS.UI = UI;
})(window);
