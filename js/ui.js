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
    rain() { this.tone(1200, 0.5, 'noise' in this ? 'sine' : 'sine', 0.02, 300); }
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

    $('dlg-continue').onclick = () => this._continue();
    $('quiz-close').onclick = () => this._closeQuiz();

    // 小地圖背景預渲染
    this._renderMinimapBase();
    // 導航箭頭元素
    this._navArrow = $('nav-arrow');
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
    $('quiz-src').textContent = item.group === 'sahel_climate' ? 'DSE 地理 · 天氣與氣候 / 旱地環境'
      : item.group === 'desertification' ? 'DSE 地理 · 消失中的綠色植被'
        : item.group === 'soil' ? 'DSE 地理 · 旱地環境 / 土壤'
          : item.group === 'techniques' ? 'DSE 地理 · 可持續土地管理'
            : item.group === 'food' ? 'DSE 地理 · 農業與糧食安全'
              : item.group === 'people' ? 'DSE 地理 · 人地關係 / 資源管理'
                : item.group === 'migration' ? 'DSE 地理 · 人口遷移 / 可持續城市'
                  : 'DSE 地理 · 可持續發展';
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
      ['與牧民達成協議', flags.peace_deal],
      ['與牧民關係緊張', flags.conflict],
      ['向放貸人借了錢', flags.debt],
      ['學會 zaï 技術', flags.learned_zai],
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
      ['Esc', '關閉當前面板']
    ];
    let html = '<h1>操作説明</h1><div class="sub">CONTROLS</div><div style="margin-top:10px">';
    html += rows.map(r => '<div class="help-key"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>').join('');
    html += '</div><h2>關於這個遊戲</h2>' +
      '<p>你是 Amadou，薩赫勒地區科多戈村的農民。旱季比往年更長，糧倉只剩兩袋小米，父親十一年前去了南方。' +
      '你要在<b>修復土地</b>、<b>維持家計</b>與<b>是否離開</b>之間做決定。</p>' +
      '<p style="margin-top:10px">所有題目按<b>香港中學文憑試（DSE）地理科</b>的課程框架設計：' +
      '旱地環境、荒漠化、農業與糧食安全、人口遷移、可持續發展。答錯也會記下解析——這是學習的一部分。</p>';
    const btns = [
      { label: '音效：' + (SFX.on ? '開' : '關'), ghost: true, onClick: () => { SFX.on = !SFX.on; this.help(fromTitle); } },
      { label: fromTitle ? '返回標題' : '關閉', onClick: () => this.closeOverlay() }
    ];
    // 從標題頁進來時，無論點「返回標題」還是按 Esc，都回到標題，避免遊戲卡在未開始狀態
    const back = fromTitle
      ? () => this.title(this._titleArgs && this._titleArgs.onStart, this._titleArgs && this._titleArgs.onSkipStory)
      : null;
    this.overlay(html, btns, back);
  };

  /* ---------------- 小遊戲 ---------------- */
  const MINI = {
    zai: {
      title: '挖 zaï 坑',
      sub: '一拃深，兩拃寬，坑裏放一把糞',
      cols: 6, rows: 4, need: 8, cls: 'dug', icon: '🕳',
      hint: '點擊格子挖坑。zaï 坑能<b>破除土壤結皮</b>、<b>集中雨水</b>，坑裏的堆肥還會引來白蟻打洞，讓水滲得更深。\n每挖一個坑消耗 3 升水（和泥、保墒）。',
      tip: '真實數據：一公頃大約要挖 20,000 個坑——你在這裏挖 8 個，只是開始。'
    },
    stone: {
      title: '擺石線',
      sub: '沿等高線鋪石，讓水慢下來',
      cols: 6, rows: 4, need: 4, cls: 'stone', icon: '🪨',
      hint: '點擊<b>同一列</b>的格子連成一道石線（共需 4 道）。石線增加地表粗糙度，<b>減慢徑流、促進入滲</b>，把泥沙與有機質留在田裏。',
      tip: '沿等高線擺放才有效——否則水會沿着石線沖走，反而衝出新的溝。'
    },
    tree: {
      title: '種白相思',
      sub: 'Faidherbia albida · 反向物候的奇蹟樹',
      cols: 6, rows: 4, need: 5, cls: 'tree', icon: '🌳',
      hint: '點擊 5 個格子種下樹苗。白相思<b>雨季落葉</b>（不遮作物）、<b>旱季長葉</b>（供飼料），還能固氮增肥。每棵消耗 12 升水。',
      tip: '成活率取決於前兩年的護理。現實中苗圃會先育苗 6–12 個月再移栽。'
    },
    water: {
      title: '打水',
      sub: '井深二十一米三',
      cols: 6, rows: 4, need: 6, cls: 'dug', icon: '💧',
      hint: '井繩很長。點擊格子把桶放下去再提上來——每一桶都要拉很久。',
      tip: '旱季末，村裏的井每天要排兩小時的隊。'
    },
    graze: {
      title: '練習輪牧',
      sub: '點還有草的格子，別把同一塊啃禿',
      cols: 6, rows: 4, need: 8, cls: 'grazed', icon: '🌿',
      hint: '每一格是一塊草場。<b>點綠格</b>把草吃了（變成淺黃＝已吃）；<b>同一格點兩次</b>就會啃禿（變成土黃，不計數）。\n輪牧的訣竅：吃一塊、換一塊，給草留口氣重新長。',
      tip: '現實中一塊草場被啃的次數要有限度——超了就退化成裸地，雨一衝土也走。'
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

  /* 輪牧小遊戲：點綠格吃草，同一格點兩次會啃禿（不計數），教會"給草留口氣" */
  UI._grazeGame = function (need, onDone) {
    let fresh = 0, over = 0;
    const total = 6 * 4;
    let html = '<h1>練習輪牧</h1><div class="sub">點還有草的格子，別把同一塊啃禿</div>' +
      '<div class="mg-bar"><i id="mg-bar"></i></div>' +
      '<div class="mg-grid" id="mg-grid"></div>' +
      '<div class="mg-hint">每一格是一塊草場。<b>點綠格</b>把草吃了；<b>同一格點兩次</b>會啃禿（土黃，不計數）。吃一塊換一塊，給草留口氣。</div>' +
      '<div class="mg-hint" style="margin-top:8px;opacity:.6">💡 現實裏一塊草場被啃的次數要有限度——超了就退化成裸地。</div>';
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
          SFX.bad(); UI.toast('啃禿了！輪牧就是要給草留口氣', 'bad');
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
      '<h2>課程對照</h2><div>' +
      ['旱地環境與荒漠化', '水土保持技術', '土壤侵蝕過程', '農業與糧食安全', '人口與土地壓力', '牧農關係與權屬', '遷移與生計多元化', '氣候變化與可持續發展']
        .map(t => '<span class="badge">' + t + '</span>').join('') + '</div>';
    this.overlay(html, [
      { label: '再玩一次（重新開始）', onClick: () => { this.closeOverlay(); onRestart(); } },
      { label: '查看地理筆記', ghost: true, onClick: () => this.notes() }
    ]);
  };

  /* ---------------- 小地圖 ---------------- */
  UI._renderMinimapBase = function () {
    const cv = document.createElement('canvas');
    cv.width = 200; cv.height = 200;
    const c = cv.getContext('2d');
    const toMM = (x, z) => [(x + 230) / 460 * 200, (z + 230) / 460 * 200];
    // 底色（按乾旱度）
    for (let i = 0; i < 200; i += 4) {
      for (let j = 0; j < 200; j += 4) {
        const x = (i / 200) * 460 - 230, z = (j / 200) * 460 - 230;
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
    c.beginPath(); c.arc(wx, wz, 11, 0, 6.283); c.fill();
    // 道路
    c.strokeStyle = 'rgba(230,200,150,0.55)';
    c.lineWidth = 1.4;
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
    // 站點
    c.font = '7px sans-serif'; c.textAlign = 'center';
    S.SITES.forEach(s => {
      const [x, z] = toMM(s.x, s.z);
      c.fillStyle = 'rgba(255,235,190,0.9)';
      c.beginPath(); c.arc(x, z, 2.4, 0, 6.283); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.62)';
      c.fillText(s.name.slice(0, 4), x, z - 5);
    });
    this._mmBase = cv;
  };
  function lerp3(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

  UI.drawMinimap = function (playerPos, yaw, targets) {
    const cv = $('minimap');
    if (!cv || !this._mmBase) return;
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
    c.rotate(-yaw + Math.PI);
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
      '<p style="margin-top:10px">Song of the Sahel —— 一個農夫、一公頃裂開的紅土，和一整片正在改變的大陸。</p>' +
      '<div class="grid2" style="margin-top:20px">' +
      '<div class="card"><div class="t">你將扮演</div><div class="d">Amadou，26 歲，薩赫勒地區科多戈村的農民。父親十一年前去了南方城市；祖父留下一公頃越來越硬的地。旱季比往年長了兩個月，糧倉只剩兩袋小米。</div></div>' +
      '<div class="card"><div class="t">你將面對</div><div class="d">荒漠化的診斷、zaï 坑與石線、井水的深度、牧民與農人的邊界、集市的價格、車站的車票——以及最後那個問題：<b>留下，還是走？</b></div></div>' +
      '</div>' +
      '<h2>對應 DSE 地理科課程</h2>' +
      '<div>' + ['旱地環境與荒漠化', '水土保持與土地修復', '土壤侵蝕過程', '農業與糧食安全', '人口與土地壓力', '牧農關係與土地權屬', '遷移與生計多元化', '氣候變化與可持續發展'].map(t => '<span class="badge">' + t + '</span>').join('') + '</div>' +
      '<h2>玩法</h2>' +
      '<ul>' +
      '<li>在<b>開放世界</b>裏行走：村莊、農田、旱谷、水塘、牧民營地、苗圃、沙丘、集市、車站</li>' +
      '<li>與村民交談推進劇情，每個關鍵節點都有<b>DSE 風格的選擇題</b>（答錯也有詳細解析）</li>' +
      '<li>親手<b>挖 zaï 坑、擺石線、種樹</b>——土地肥力會真的改變</li>' +
      '<li>季節會推進：旱季與雨季交替，哈馬丹風隨時可能到來</li>' +
      '<li>三種結局，取決於你的選擇與<b>可持續發展指數</b></li>' +
      '</ul>' +
      '<p style="margin-top:14px;opacity:.7;font-size:13px">建議先按 <b>H</b> 查看操作説明。全程約 25–35 分鐘。</p>';
    this.overlay(html, [
      { label: '開始故事 ▸', onClick: () => { this.closeOverlay(); onStart(); } },
      { label: '操作説明', ghost: true, onClick: () => this.help(true) }
    ]);
  };

  UI.SFX = SFX;
  global.SOS.UI = UI;
})(window);
