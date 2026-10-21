/* ================================================================
 *  ui.js —— 界面：HUD · 对话 · 问答 · 日志 · 笔记 · 小游戏 · 小地图
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const $ = id => document.getElementById(id);

  /* ---------------- 音效（WebAudio 合成，无外部资源） ---------------- */
  const SFX = {
    ctx: null, on: true,
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
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(gain || 0.08, ctx.currentTime + 0.012);
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

    $('dlg-continue').onclick = () => this._continue();
    $('quiz-close').onclick = () => this._closeQuiz();

    // 小地图背景预渲染
    this._renderMinimapBase();
  };

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
    // 重启动画
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

  /* ---------------- 对话 ---------------- */
  UI.showDialogue = function (spec, node, handler) {
    this.mode = 'dialogue';
    this._dlgHandler = handler;
    this._dlgNode = node;
    $('dlg-avatar').textContent = spec.face;
    $('dlg-name').textContent = spec.name;
    $('dlg-role').textContent = spec.role;
    $('dlg-text').innerHTML = (node.text || '').replace(/\n/g, '<br>');
    const ch = $('dlg-choices');
    ch.innerHTML = '';
    if (node.opts && node.opts.length) {
      $('dlg-next').style.display = 'none';
      node.opts.forEach(o => {
        const b = document.createElement('button');
        b.className = 'choice';
        b.innerHTML = o.t;
        b.onclick = () => { SFX.talk(); handler(o); };
        ch.appendChild(b);
      });
    } else {
      $('dlg-next').style.display = 'flex';
    }
    $('dialogue').classList.remove('hidden');
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

  /* ---------------- 问答 ---------------- */
  UI.showQuiz = function (item, onDone) {
    this.mode = 'quiz';
    this._quizHandler = onDone;
    $('quiz-tag').textContent = item.groupLabel;
    $('quiz-src').textContent = item.group === 'sahel_climate' ? 'DSE 地理 · 天气与气候 / 旱地环境'
      : item.group === 'desertification' ? 'DSE 地理 · 消失中的绿色植被'
        : item.group === 'soil' ? 'DSE 地理 · 旱地环境 / 土壤'
          : item.group === 'techniques' ? 'DSE 地理 · 可持续土地管理'
            : item.group === 'food' ? 'DSE 地理 · 农业与粮食安全'
              : item.group === 'people' ? 'DSE 地理 · 人地关系 / 资源管理'
                : item.group === 'migration' ? 'DSE 地理 · 人口迁移 / 可持续城市'
                  : 'DSE 地理 · 可持续发展';
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
    head.textContent = ok ? '✔ 答对了' : '✘ 正确答案：' + ['A', 'B', 'C', 'D'][item.a];
    $('fb-body').innerHTML = item.exp;
    $('fb-reward').textContent = ok
      ? '＋ 知识点「' + item.note.t + '」　＋ 可持续指数 2'
      : '知识点仍会记录「' + item.note.t + '」，但可持续指数不增加';
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
  UI.overlay = function (html, buttons) {
    this.mode = 'overlay';
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
  };

  /* ---------------- 章节引言 ---------------- */
  UI.chapterCard = function (act, onStart) {
    const html =
      '<div class="sub">CHAPTER · ' + act.chapter + '</div>' +
      '<h1>' + act.title + '</h1>' +
      '<div class="lead" style="margin-top:14px">' + act.intro.replace(/\n/g, '<br>') + '</div>';
    this.overlay(html, [{ label: '进入本章 ▸', onClick: () => { this.closeOverlay(); onStart(); } }]);
  };

  /* ---------------- 任务日志 ---------------- */
  UI.journal = function () {
    const g = this.game;
    let html = '<h1>任务日志</h1><div class="sub">JOURNAL · 阿马杜的选择</div>';
    S.ACTS.forEach(act => {
      const st = g.actState[act.id];
      const state = !st ? '未开始' : (st.done ? '已完成' : '进行中');
      html += '<h2>' + act.chapter + ' · ' + act.title + '　<span class="badge">' + state + '</span></h2>';
      act.steps.forEach((s, i) => {
        const done = st && i < st.step;
        html += '<div class="log-item' + (done ? ' done' : '') + '"><div class="lt">' +
          (done ? '✔ ' : '○ ') + (s.desc || s.k) + '</div>';
        html += '</div>';
      });
    });
    html += '<h2>关键决定</h2>';
    const flags = g.flags;
    const flagRows = [
      ['与牧民达成协议', flags.peace_deal],
      ['与牧民关系紧张', flags.conflict],
      ['向放贷人借了钱', flags.debt],
      ['学会 zaï 技术', flags.learned_zai],
      ['意愿：留下', flags.wish_stay],
      ['意愿：外出', flags.wish_go]
    ];
    html += flagRows.map(r => '<div class="kv"><span>' + r[0] + '</span><b>' + (r[1] ? '是' : '—') + '</b></div>').join('');
    this.overlay(html, [{ label: '关闭', ghost: true, onClick: () => this.closeOverlay() }]);
  };

  /* ---------------- 地理笔记 ---------------- */
  UI.notes = function () {
    const g = this.game;
    const groups = {};
    S.NOTES.forEach(n => { (groups[n.g] = groups[n.g] || { label: n.label, items: [] }).items.push(n); });
    let html = '<h1>地理笔记</h1><div class="sub">DSE GEOGRAPHY NOTES · 已收集 ' + g.state.notes.size + ' / ' + S.NOTES.length + '</div>';
    html += '<p style="margin-bottom:12px">答对题目可解锁知识点。考试前可以回来复习——这里的每一条都可能出现在资料为本题里。</p>';
    Object.keys(groups).forEach(k => {
      const gr = groups[k];
      html += '<h2>' + gr.label + '</h2>';
      gr.items.forEach(n => {
        const got = g.state.notes.has(n.id);
        html += '<div class="note-card' + (got ? '' : ' locked') + '">' +
          '<div class="nt">' + (got ? '' : '🔒 ') + n.t + '</div>' +
          (got ? '<div class="nd">' + n.d + '</div>' : '<div class="nd">完成相关题目后解锁</div>') +
          '</div>';
      });
    });
    this.overlay(html, [{ label: '关闭', ghost: true, onClick: () => this.closeOverlay() }]);
  };

  /* ---------------- 操作说明 ---------------- */
  UI.help = function () {
    const rows = [
      ['W A S D / 方向键', '移动'],
      ['Shift（按住）', '奔跑'],
      ['空格', '跳跃 / 对话继续 / 关闭面板'],
      ['鼠标左键拖动', '旋转视角'],
      ['滚轮', '拉近／拉远镜头'],
      ['F / E', '与人交谈、调查'],
      ['Tab 或 J', '任务日志'],
      ['N', '地理笔记'],
      ['H', '操作说明'],
      ['Esc', '关闭当前面板']
    ];
    let html = '<h1>操作说明</h1><div class="sub">CONTROLS</div><div style="margin-top:10px">';
    html += rows.map(r => '<div class="help-key"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>').join('');
    html += '</div><h2>关于这个游戏</h2>' +
      '<p>你是 Amadou，萨赫勒地区科多戈村的农民。旱季比往年更长，粮仓只剩两袋小米，父亲十一年前去了南方。' +
      '你要在<b>修复土地</b>、<b>维持家计</b>与<b>是否离开</b>之间做决定。</p>' +
      '<p style="margin-top:10px">所有题目按<b>香港中学文凭试（DSE）地理科</b>的课程框架设计：' +
      '旱地环境、荒漠化、农业与粮食安全、人口迁移、可持续发展。答错也会记下解析——这是学习的一部分。</p>';
    const btns = [
      { label: '音效：' + (SFX.on ? '开' : '关'), ghost: true, onClick: () => { SFX.on = !SFX.on; this.help(); } },
      { label: '关闭', onClick: () => this.closeOverlay() }
    ];
    this.overlay(html, btns);
  };

  /* ---------------- 小游戏 ---------------- */
  const MINI = {
    zai: {
      title: '挖 zaï 坑',
      sub: '一拃深，两拃宽，坑里放一把粪',
      cols: 6, rows: 4, need: 8, cls: 'dug', icon: '🕳',
      hint: '点击格子挖坑。zaï 坑能<b>破除土壤结皮</b>、<b>集中雨水</b>，坑里的堆肥还会引来白蚁打洞，让水渗得更深。\n每挖一个坑消耗 3 升水（和泥、保墒）。',
      tip: '真实数据：一公顷大约要挖 20,000 个坑——你在这里挖 8 个，只是开始。'
    },
    stone: {
      title: '摆石线',
      sub: '沿等高线铺石，让水慢下来',
      cols: 6, rows: 4, need: 4, cls: 'stone', icon: '🪨',
      hint: '点击<b>同一列</b>的格子连成一道石线（共需 4 道）。石线增加地表粗糙度，<b>减慢径流、促进入渗</b>，把泥沙与有机质留在田里。',
      tip: '沿等高线摆放才有效——否则水会沿着石线冲走，反而冲出新的沟。'
    },
    tree: {
      title: '种白相思',
      sub: 'Faidherbia albida · 反向物候的奇迹树',
      cols: 6, rows: 4, need: 5, cls: 'tree', icon: '🌳',
      hint: '点击 5 个格子种下树苗。白相思<b>雨季落叶</b>（不遮作物）、<b>旱季长叶</b>（供饲料），还能固氮增肥。每棵消耗 12 升水。',
      tip: '成活率取决于前两年的护理。现实中苗圃会先育苗 6–12 个月再移栽。'
    },
    water: {
      title: '打水',
      sub: '井深二十一米三',
      cols: 6, rows: 4, need: 6, cls: 'dug', icon: '💧',
      hint: '井绳很长。点击格子把桶放下去再提上来——每一桶都要拉很久。',
      tip: '旱季末，村里的井每天要排两小时的队。'
    }
  };

  UI.minigame = function (type, need, onDone) {
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
    // 加"放弃"按钮
    const row = document.createElement('div');
    row.className = 'ov-btn-row';
    const b = document.createElement('button');
    b.className = 'ov-btn ghost';
    b.textContent = '先离开（进度保留）';
    b.onclick = () => { this.closeOverlay(); onDone(count, true); };
    row.appendChild(b);
    $('ov-panel').appendChild(row);
  };

  /* ---------------- 结局 ---------------- */
  UI.ending = function (ending, stats, onRestart) {
    let html = '<div class="sub">' + ending.sub + '</div><h1>' + ending.title + '</h1>' +
      '<div class="lead" style="margin-top:14px">' + ending.text.replace(/\n/g, '<br>') + '</div>' +
      '<h2>地理分析</h2><p>' + ending.analysis + '</p>' +
      '<h2>本作涉及的 DSE 考点</h2><ul>' + ending.dse.map(d => '<li>' + d + '</li>').join('') + '</ul>' +
      '<h2>你的成绩</h2>' +
      '<div class="kv"><span>答题正确率</span><b>' + stats.correct + ' / ' + stats.total + '（' + stats.rate + '%）</b></div>' +
      '<div class="kv"><span>知识点收集</span><b>' + stats.notes + ' / ' + stats.notesTotal + '</b></div>' +
      '<div class="kv"><span>土壤肥力（自家田）</span><b>' + Math.round(stats.fertility) + ' / 100</b></div>' +
      '<div class="kv"><span>可持续发展指数</span><b>' + Math.round(stats.sustain) + ' / 100</b></div>' +
      '<div class="kv"><span>存粮 / 现金</span><b>' + Math.round(stats.food) + ' kg · ' + Math.round(stats.cash).toLocaleString('en-US') + ' F</b></div>' +
      '<h2>课程对照</h2><div>' +
      ['旱地环境与荒漠化', '水土保持技术', '土壤侵蚀过程', '农业与粮食安全', '人口与土地压力', '牧农关系与权属', '迁移与生计多元化', '气候变化与可持续发展']
        .map(t => '<span class="badge">' + t + '</span>').join('') + '</div>';
    this.overlay(html, [
      { label: '再玩一次（重新开始）', onClick: () => { this.closeOverlay(); onRestart(); } },
      { label: '查看地理笔记', ghost: true, onClick: () => this.notes() }
    ]);
  };

  /* ---------------- 小地图 ---------------- */
  UI._renderMinimapBase = function () {
    const cv = document.createElement('canvas');
    cv.width = 200; cv.height = 200;
    const c = cv.getContext('2d');
    const toMM = (x, z) => [(x + 230) / 460 * 200, (z + 230) / 460 * 200];
    // 底色（按干旱度）
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
    // 简易：连接站点
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
    // 站点
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
    // 当前目标
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
    // 边框刻度
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, 199, 199);
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.font = '9px sans-serif'; c.textAlign = 'center';
    c.fillText('北 ▲', 100, 12);
  };

  /* ---------------- 标题画面 ---------------- */
  UI.title = function (onStart, onSkipStory) {
    const html =
      '<div class="sub">DSE GEOGRAPHY · OPEN WORLD ADVENTURE</div>' +
      '<h1>萨赫勒之歌</h1>' +
      '<p style="margin-top:10px">Song of the Sahel —— 一个农夫、一公顷裂开的红土，和一整片正在改变的大陆。</p>' +
      '<div class="grid2" style="margin-top:20px">' +
      '<div class="card"><div class="t">你将扮演</div><div class="d">Amadou，26 岁，萨赫勒地区科多戈村的农民。父亲十一年前去了南方城市；祖父留下一公顷越来越硬的地。旱季比往年长了两个月，粮仓只剩两袋小米。</div></div>' +
      '<div class="card"><div class="t">你将面对</div><div class="d">荒漠化的诊断、zaï 坑与石线、井水的深度、牧民与农人的边界、集市的价格、车站的车票——以及最后那个问题：<b>留下，还是走？</b></div></div>' +
      '</div>' +
      '<h2>对应 DSE 地理科课程</h2>' +
      '<div>' + ['旱地环境与荒漠化', '水土保持与土地修复', '土壤侵蚀过程', '农业与粮食安全', '人口与土地压力', '牧农关系与土地权属', '迁移与生计多元化', '气候变化与可持续发展'].map(t => '<span class="badge">' + t + '</span>').join('') + '</div>' +
      '<h2>玩法</h2>' +
      '<ul>' +
      '<li>在<b>开放世界</b>里行走：村庄、农田、旱谷、水塘、牧民营地、苗圃、沙丘、集市、车站</li>' +
      '<li>与村民交谈推进剧情，每个关键节点都有<b>DSE 风格的选择题</b>（答错也有详细解析）</li>' +
      '<li>亲手<b>挖 zaï 坑、摆石线、种树</b>——土地肥力会真的改变</li>' +
      '<li>季节会推进：旱季与雨季交替，哈马丹风随时可能到来</li>' +
      '<li>三种结局，取决于你的选择与<b>可持续发展指数</b></li>' +
      '</ul>' +
      '<p style="margin-top:14px;opacity:.7;font-size:13px">建议先按 <b>H</b> 查看操作说明。全程约 25–35 分钟。</p>';
    this.overlay(html, [
      { label: '开始故事 ▸', onClick: () => { this.closeOverlay(); onStart(); } },
      { label: '操作说明', ghost: true, onClick: () => this.help() }
    ]);
  };

  UI.SFX = SFX;
  global.SOS.UI = UI;
})(window);
