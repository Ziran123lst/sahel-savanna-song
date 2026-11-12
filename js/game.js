/* ================================================================
 *  game.js —— 主狀態機：任務鏈 · 交互 · 資源 · 季節 · 結局
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const UI = S.UI, Player = S.Player, World = S.World, NPCs = S.NPCs;
  const { SITES, NPCS, DIALOGUE, ACTS, PROBES, ENDINGS, INTERACTION_RADIUS, clamp, dist2, heightAt } = S;

  const siteById = id => SITES.find(s => s.id === id);
  // NPCS 是 story.js 導出的純規格數組；NPCs（模塊）才有 .list（運行時實例）。
  // 優先取運行時 spec，NPC 尚未生成或列表為空時回退到靜態規格，
  // 保證對話資料永遠能取到（之前誤用 NPCS.list 會拋 TypeError）。
  const npcById = id => {
    const it = (NPCs && NPCs.list) ? NPCs.list.find(n => n.spec && n.spec.id === id) : null;
    return it ? it.spec : (NPCS.find(n => n.id === id) || null);
  };

  const Game = {
    state: {
      water: 65, food: 190, cash: 3600, fertility: 22, sustain: 50,
      day: 1, season: 'dry',
      notes: new Set(),
      quizTotal: 0, quizCorrect: 0,
      zai: 0, stones: 0, trees: 0
    },
    flags: {},
    actIndex: 0, stepIndex: 0, actState: {},
    probes: [],       // {group, data}
    taskPoint: null,  // {x,z,type}
    markers: [],
    started: false,
    _dayT: 0,
    _stormT: 0,
    _stormOn: false,
    _lastZoneId: null,
    _pendingQuiz: []
  };

  /* ================= 啓動 ================= */
  Game.boot = function () {
    const canvas = document.getElementById('scene');

    // 先檢測 WebGL 可用性，缺失時給出明確提示而非靜默卡死
    let webglOK = false;
    try {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      webglOK = !!gl;
    } catch (e) { webglOK = false; }
    if (!webglOK) {
      const t = document.getElementById('ld-tip');
      if (t) t.textContent = '當前瀏覽器/環境未啓用 WebGL，無法渲染 3D 畫面。請使用支持 WebGL 的現代瀏覽器，並確認未禁用「硬件加速」。';
      console.error('[Game] WebGL 不可用，無法啓動 3D 渲染。');
      return;
    }

    World.init(canvas);
    S.Models.init();
    if (S.Settings) S.Settings.load();        // 讀取本地偏好
    Player.create(World.scene);
    Player.bindInput(canvas);
    UI.init(this);
    if (S.Settings) S.Settings.applyAll();     // 應用音量/畫質等即時項
    this.bindKeys();

    const ld = document.getElementById('ld-progress');
    const tip = document.getElementById('ld-tip');

    // 1) 預加載 GLB 模型（玩家農夫 + 牲畜 + 村民角色 + 樹/屋）
    const MODEL_LIST = [
      'vendor/models/farmer.glb',
      'vendor/models/cow.glb', 'vendor/models/bull.glb', 'vendor/models/goat.glb',
      'vendor/models/sheep.glb', 'vendor/models/camel.glb', 'vendor/models/chicken.glb',
      'vendor/models/woman.glb', 'vendor/models/adventurer.glb',
      'vendor/models/tree.glb', 'vendor/models/hut.glb',
      'vendor/models/mosque.glb', 'vendor/models/tent.glb', 'vendor/models/baobab.glb',
      'vendor/models/school.glb', 'vendor/models/stall.glb', 'vendor/models/well.glb',
      // 開放授權場景變體：薩赫勒樹、草叢、泥屋與不同外觀的牛。
      'vendor/models/acacia.glb', 'vendor/models/savanna_tree.glb', 'vendor/models/tall_grass.glb',
      'vendor/models/hut_variant_b.glb',
      'vendor/models/cow_quaternius.glb', 'vendor/models/cow_madtroll.glb'
    ];
    S.Models.preloadAll(MODEL_LIST, (done, total) => {
      tip.textContent = '正在裝載牲畜、村民與場景模型… ' + done + '/' + total;
      if (ld) ld.style.width = Math.round((done / total) * 50) + '%';
    }).then(() => {
      // 通過公開接口取模型；loader 內部使用帶版本號的緩存鍵，
      // 不能直接訪問 _gltfs 的未版本化路徑，否則會誤保留藍色佔位體。
      Player.setupModel(S.Models.get('vendor/models/farmer.glb'));
      if (ld) ld.style.width = '55%';

      // 2) 構建世界（含散佈的牲畜與地形）；地形/障礙就緒後再生成村民，
      //    這樣村民既能避開建築，又能用向下射線貼合“可見地形表面”消除懸浮。
      World.build((label, p) => {
        tip.textContent = label;
        if (ld) ld.style.width = Math.round(55 + p * 40) + '%';
      }).then(() => {
        if (S.NPCs && S.NPCs.create) S.NPCs.create(World.scene);
        if (ld) ld.style.width = '100%';
        tip.textContent = '準備好了。';
        setTimeout(() => {
          document.getElementById('loading').classList.add('out');
          this.startLoop();
          UI.title(() => this.startStory());
        }, 350);
      });
    });
  };

  Game.startStory = function () {
    this.started = true;
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('minimap-wrap').classList.remove('hidden');
    document.getElementById('objective').classList.remove('hidden');
    const touchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (touchCapable) document.getElementById('touch-ui').classList.remove('hidden');
    this.actIndex = 0; this.stepIndex = 0;
    World.setSeason('dry');
    this.syncHUD();
    this.enterAct(0);
  };

  Game.enterAct = function (i) {
    this.actIndex = i;
    this.stepIndex = 0;
    const act = ACTS[i];
    if (!act) return;
    UI.chapterCard(act, () => { this.beginStep(); });
  };

  /* ================= 任務步驟 ================= */
  Game.currentStep = function () {
    const act = ACTS[this.actIndex];
    return act ? act.steps[this.stepIndex] : null;
  };

  Game.beginStep = function () {
    const act = ACTS[this.actIndex];
    if (!act) return;
    if (this.stepIndex >= act.steps.length) { this.finishAct(); return; }
    const st = act.steps[this.stepIndex];
    this.clearMarkers();

    if (st.k === 'probe') {
      // 在自家田生成調查點
      const f = siteById('farm');
      const rng = S.makeRng(4242);
      const n = Math.min(st.n, PROBES.length);
      this.probes = [];
      for (let i = 0; i < n; i++) {
        const ang = rng() * 6.283, rad = 9 + rng() * 18;
        const x = f.x + Math.cos(ang) * rad, z = f.z + Math.sin(ang) * rad;
        const m = World.addMarker(x, z, 0xffd477, 'probe');
        this.probes.push({ x, z, marker: m, data: PROBES[i], done: false });
        this.markers.push(m);
      }
    } else if (st.k === 'mini') {
      const owner = st.type === 'tree' ? siteById('farm') : siteById('farm');
      const x = owner.x + (st.type === 'stone' ? 16 : -6), z = owner.z + (st.type === 'stone' ? -10 : 12);
      const m = World.addMarker(x, z, 0xe8871e, 'generic');
      this.taskPoint = { x, z, type: st.type, need: st.n, marker: m };
      this.markers.push(m);
    } else if (st.k === 'goto') {
      const s = siteById(st.site);
      if (s) {
        const m = World.addMarker(s.x, s.z, 0x8fd07a, 'generic');
        this.taskPoint = { x: s.x, z: s.z, type: 'goto', marker: m };
        this.markers.push(m);
      }
    } else if (st.k === 'quiz') {
      setTimeout(() => {
        const arg = st.ids ? st.ids.join(',') : (st.group || 'desertification');
        const n = st.n || (st.ids ? st.ids.length : 1);
        this.runQuiz({ arg, n }, () => { setTimeout(() => this.completeStep(), 200); });
      }, 520);
    } else if (st.k === 'season') {
      // 自動完成
      setTimeout(() => {
        World.setSeason(st.v);
        this.state.season = st.v;
        UI.toast(st.v === 'rain' ? '🌧 雨季來了 —— 第一場雨落在你挖好的坑裏' : '☀ 旱季開始', 'good');
        UI.SFX.plant();
        if (st.v === 'rain') {
          this.state.fertility = clamp(this.state.fertility + 14, 0, 100);
          this.state.food += 120;
          this.state.water = clamp(this.state.water + 80, 0, 260);
        }
        this.syncHUD();
        this.completeStep();
      }, 900);
    }
    this.refreshObjective();
  };

  Game.completeStep = function () {
    const act = ACTS[this.actIndex];
    if (!act) return;
    if (this._completing) return;          // 防重入
    this._completing = true;
    setTimeout(() => { this._completing = false; }, 500);
    this.stepIndex++;
    this.clearMarkers();
    this.refreshObjective();
    if (this.stepIndex >= act.steps.length) this.finishAct();
    else setTimeout(() => this.beginStep(), 120);
  };

  Game.finishAct = function () {
    this.actState[ACTS[this.actIndex].id] = { done: true, step: this.stepIndex };
    const next = this.actIndex + 1;
    if (next >= ACTS.length) return;
    if (next === 5) { // 終章：起風
      World.setSeason('dry');
      this.state.season = 'dry';
      this.triggerStorm(26);
    }
    setTimeout(() => this.enterAct(next), 700);
  };

  Game.clearMarkers = function () {
    this.markers.forEach(m => World.removeMarker(m));
    this.markers = [];
    this.probes = [];
    this.taskPoint = null;
  };

  Game.refreshObjective = function () {
    const act = ACTS[this.actIndex];
    if (!act) return;
    const steps = act.steps.map((s, i) => ({
      text: (s.desc || s.k),
      done: i < this.stepIndex
    }));
    UI.objective(act.chapter + ' · ' + (this.actIndex + 1) + '/' + ACTS.length, act.title, steps);
  };

  /* ================= 指令解析 ================= */
  Game.runAct = function (actStr, ctx) {
    if (!actStr) return null;
    let quizReq = null, miniReq = null, endReq = null, openNotes = false;
    String(actStr).split(';').forEach(raw => {
      const p = raw.trim();
      if (!p) return;
      const a = p.split(':');
      const cmd = a[0];
      if (cmd === 'next') { this._pendingNext = true; }
      else if (cmd === 'add') {
        const v = parseFloat(a[2]);
        if (this.state[a[1]] !== undefined) this.state[a[1]] = this.state[a[1]] + v;
        else this.state[a[1]] = v;
        const label = { water: '水', food: '糧食', cash: '現金', fertility: '肥力' }[a[1]] || a[1];
        UI.toast((v > 0 ? '＋' : '') + v + ' ' + label, v > 0 ? 'good' : 'bad');
      }
      else if (cmd === 'flag') { this.flags[a[1]] = true; }
      else if (cmd === 'unflag') { this.flags[a[1]] = false; }
      else if (cmd === 'choice') {
        // choice:<key>:<土地分>:<生計分>:<描述> —— 記錄劇情抉擇，供終章結局判定
        this.choices = this.choices || {};
        this.choices[a[1]] = true;
        this.state.landScore = (this.state.landScore || 0) + (parseFloat(a[2]) || 0);
        this.state.livelihood = (this.state.livelihood || 0) + (parseFloat(a[3]) || 0);
        if (a[4]) UI.toast(a[4], 'note');
      }
      else if (cmd === 'note') { this.unlockNote(a[1]); }
      else if (cmd === 'sus') { this.state.sustain = clamp(this.state.sustain + parseFloat(a[1]), 0, 100); }
      else if (cmd === 'season') { this.state.season = a[1]; World.setSeason(a[1]); }
      else if (cmd === 'quiz') { quizReq = { arg: a[1], n: a[2] ? parseInt(a[2]) : 1 }; }
      else if (cmd === 'mini') { miniReq = { type: a[1], n: a[2] ? parseInt(a[2]) : undefined }; }
      else if (cmd === 'end') { endReq = a[1]; }
      else if (cmd === 'act' && a[1] === 'notes') { openNotes = true; }
    });
    this.syncHUD();

    if (quizReq) return { kind: 'quiz', req: quizReq };
    if (miniReq) return { kind: 'mini', req: miniReq };
    if (endReq) return { kind: 'end', id: endReq };
    if (openNotes) return { kind: 'notes' };
    return null;
  };

  Game.unlockNote = function (id) {
    if (!id) return;
    if (!this.state.notes.has(id)) {
      this.state.notes.add(id);
      const n = S.NOTES.find(x => x.id === id);
      if (n) UI.toast('📘 解鎖知識點：' + n.t, 'note');
    }
  };

  /* ================= 對話 ================= */
  Game.talkTo = function (npcId, nodeId, isTaskStep) {
    const spec = npcById(npcId);
    const tree = DIALOGUE[npcId];
    if (!spec || !tree) return;
    let node = tree[nodeId] || tree.start;
    if (!node) { UI.toast('（他只是對你點了點頭）'); return; }
    // 只有「當前任務要求的那次對話」才允許推進任務；普通閒聊裏的 next 不應改變進度
    this._talkGuard = isTaskStep ? { act: this.actIndex, step: this.stepIndex, used: false } : null;
    this._talkCompletesStep = !!isTaskStep;
    this._talkCtx = { npcId, nodeId: nodeId || 'start' };
    this.showNode(npcId, nodeId || 'start');
  };

  Game.showNode = function (npcId, nodeId) {
    const tree = DIALOGUE[npcId];
    const node = tree && tree[nodeId];
    if (!node) { this.endTalk(); return; }
    try {
      UI.showDialogue(npcById(npcId), node, opt => this.onDialogueChoice(npcId, node, opt));
    } catch (err) {
      // 任何渲染異常都必須釋放模態，否則 UI.mode 卡在 dialogue，整局無法再交互
      console.error('[Game] 對話渲染失敗：', err);
      UI.hideDialogue();
      this._pendingNext = false;
      this._talkCompletesStep = false;
      this._talkGuard = null;
      UI.toast('對話暫時無法顯示，請走近再按一次 F。', 'bad');
    }
  };

  Game.onDialogueChoice = function (npcId, node, opt) {
    const actStr = opt.isContinue ? (node.act || null) : (opt.act || null);
    const to = opt.isContinue ? node.to : opt.to;
    const res = this.runAct(actStr, { npcId });
    // 任務推進統一放到 endTalk：對話樹中常有多個 next，若在選項裏立刻
    // completeStep，一次對話會連跳好幾個任務步驟。
    if (res && res.kind === 'quiz') {
      UI.hideDialogue();
      this.runQuiz(res.req, () => {
        if (to) this.showNode(npcId, to); else this.endTalk();
      });
      return;
    }
    if (res && res.kind === 'mini') {
      UI.hideDialogue();
      this.runMini(res.req.type, res.req.n, () => {
        if (to) this.showNode(npcId, to); else this.endTalk();
      });
      return;
    }
    if (res && res.kind === 'end') {
      UI.hideDialogue();
      this.showEnding(res.id);
      return;
    }
    if (res && res.kind === 'notes') {
      UI.hideDialogue();
      UI.notes();
      this._talkGuard = null;
      this._pendingNext = false;
      this._talkCompletesStep = false;
      return;
    }
    if (to) this.showNode(npcId, to); else this.endTalk();
  };

  Game.endTalk = function () {
    UI.hideDialogue();
    const needAdvance = this._pendingNext || this._talkCompletesStep;
    this._pendingNext = false;
    this._talkCompletesStep = false;
    if (needAdvance) this._advanceFromTalk();
    this._talkGuard = null;
  };

  // 一次任務對話最多推進一個步驟，且只在對話結束後推進；
  // guard 為空説明是閒聊，即便對話裏有 next 也不動任務進度。
  Game._advanceFromTalk = function () {
    const g = this._talkGuard;
    if (!g || g.used) return;
    if (g.act !== this.actIndex || g.step !== this.stepIndex) return;
    g.used = true;
    this.completeStep();
  };

  /* ================= 問答流程 ================= */
  Game.runQuiz = function (req, onDone) {
    let items = [];
    if (req.arg && req.arg.indexOf(',') >= 0) {
      items = req.arg.split(',').map(id => S.QUIZ_ALL.find(q => q.id === id)).filter(Boolean);
    } else if (req.arg && /^[A-H]\d+$/.test(req.arg)) {
      const one = S.QUIZ_ALL.find(q => q.id === req.arg);
      if (one) items = [one];
    } else {
      // 從分組隨機抽 n 題（優先未答過的）
      const pool = (S.QUIZ[req.arg] || S.QUIZ.desertification).items;
      const unseen = pool.filter(q => !this._asked.has(q.id));
      const src = unseen.length ? unseen : pool;
      const n = Math.min(req.n || 1, src.length);
      const copy = src.slice();
      for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
      items = copy.slice(0, n);
    }
    if (!items.length) { onDone && onDone(); return; }
    const next = () => {
      const it = items.shift();
      if (!it) { onDone && onDone(); return; }
      this._asked.add(it.id);
      this.state.quizTotal++;
      UI._currentQuiz = it;
      UI.showQuiz(it, (ok, item) => {
        // 解鎖知識點（答對額外加分）
        this.unlockNote(item.id);
        if (ok) {
          this.state.quizCorrect++;
          this.state.sustain = clamp(this.state.sustain + 2, 0, 100);
          this.state.cash += 250;
        } else {
          this.state.sustain = clamp(this.state.sustain - 0.5, 0, 100);
        }
        this.syncHUD();
        next();
      });
    };
    next();
  };

  /* ================= 小遊戲 ================= */
  Game.runMini = function (type, need, onDone, isTask) {
    const cfg = { zai: 8, stone: 4, tree: 5, water: 6, graze: 8 };
    const n = need || cfg[type] || 6;
    UI.minigame(type, n, (count, aborted) => {
      if (count > 0) {
        if (type === 'zai') {
          this.state.zai += count;
          this.state.water = clamp(this.state.water - count * 3, 0, 260);
          this.state.fertility = clamp(this.state.fertility + count * 3.2, 0, 100);
          this.state.sustain = clamp(this.state.sustain + count * 1.4, 0, 100);
          UI.toast('🕳 挖了 ' + count + ' 個 zaï 坑　肥力 +' + (count * 3.2).toFixed(0), 'good');
        } else if (type === 'stone') {
          this.state.stones += count;
          this.state.fertility = clamp(this.state.fertility + count * 4.0, 0, 100);
          this.state.sustain = clamp(this.state.sustain + count * 1.8, 0, 100);
          UI.toast('🪨 擺了 ' + count + ' 道石線　徑流減慢，入滲增加', 'good');
        } else if (type === 'tree') {
          this.state.trees += count;
          this.state.water = clamp(this.state.water - count * 12, 0, 260);
          this.state.fertility = clamp(this.state.fertility + count * 2.6, 0, 100);
          this.state.sustain = clamp(this.state.sustain + count * 2.4, 0, 100);
          UI.toast('🌳 種下 ' + count + ' 棵白相思　旱季有飼料，雨季有肥', 'good');
        } else if (type === 'graze') {
          this.state.fertility = clamp(this.state.fertility + count * 1.1, 0, 100);
          this.state.sustain = clamp(this.state.sustain + count * 1.0, 0, 100);
          UI.toast('🌿 輪牧練習：吃 ' + count + ' 塊草場，給草留了口氣', 'good');
        } else {
          this.state.water = clamp(this.state.water + count * 12, 0, 260);
          UI.toast('💧 打了 ' + count + ' 桶水', 'good');
        }
        this.syncHUD();
      }
      if (!aborted && count >= n && isTask) this._pendingNext = true;
      onDone && onDone(count);
      if (this._pendingNext && !aborted) {
        this._pendingNext = false;
        setTimeout(() => this.completeStep(), 200);
      }
    });
  };

  /* ================= 調查點 ================= */
  Game.investigate = function (p) {
    p.done = true;
    World.removeMarker(p.marker);
    const i = this.markers.indexOf(p.marker);
    if (i >= 0) this.markers.splice(i, 1);
    UI.SFX.open();
    const html = '<div class="sub">土地退化現場調查</div><h1>' + p.data.title + '</h1>' +
      '<div class="lead" style="margin-top:14px">' + p.data.text.replace(/\n/g, '<br>') + '</div>';
    UI.overlay(html, [{
      label: '回答相關問題 ▸', onClick: () => {
        UI.closeOverlay();
        this.runQuiz({ arg: p.data.quiz, n: 1 }, () => {
          const need = (ACTS[this.actIndex].steps[this.stepIndex] || {}).n || 3;
          // 統計「已完成」的調查點；之前誤寫成未完成數量，導致永遠達不到 need
          const doneCount = this.probes.filter(x => x.done).length;
          if (doneCount >= need) { setTimeout(() => this.completeStep(), 260); }
          else UI.toast('還需調查 ' + (need - doneCount) + ' 處跡象', 'note');
        });
      }
    }]);
  };

  /* ================= 交互 ================= */
  Game.tryInteract = function () {
    if (!this.started || UI.mode) return;
    const pos = Player.pos;

    // 1) 任務相關：探針
    for (const p of this.probes) {
      if (p.done) continue;
      if (dist2(pos.x, pos.z, p.x, p.z) < 16) { this.investigate(p); return; }
    }
    // 2) 任務要求的對話（優先於世界設施，確保劇情步驟能完成）
    const step = this.currentStep();
    const near = NPCs.nearest(pos, INTERACTION_RADIUS);
    if (step && step.k === 'talk') {
      const target = NPCs.get(step.npc);
      // 目標村民在交互半徑內時直接選它，避免被旁邊更近的人擠掉導致任務對話打不開
      const nt = (target && dist2(pos.x, pos.z, target.x, target.z) < INTERACTION_RADIUS * INTERACTION_RADIUS)
        ? target : near;
      if (nt && nt.spec.id === step.npc) {
        this.talkTo(step.npc, step.node || 'start', true);   // 此對話即為當前任務步驟
        return;
      }
    }
    // 3) 普通 NPC 閒聊：必須排在世界設施之前，否則老井、水塘、苗圃、集市
    //    區域裏的村民會被打水/賣糧攔住，按 F 永遠開不了口
    if (near) { this.talkTo(near.spec.id, 'start'); return; }
    // 4) 世界設施（附近沒有村民時才生效）
    const zone = S.zoneAt(pos.x, pos.z);
    if (zone && zone.id === 'well') { this.drawWater(90); return; }
    if (zone && zone.id === 'mare') { this.drawWater(70); return; }
    if (zone && zone.id === 'market') { this.sellGrain(); return; }
    if (zone && zone.id === 'nursery') { this.getSeedlings(); return; }
    // 5) 任務點（小遊戲 / 到達點）
    if (this.taskPoint) {
      const tp = this.taskPoint;
      if (dist2(pos.x, pos.z, tp.x, tp.z) < 72) {
        if (tp.type === 'goto') return;    // 到達點無需交互
        this.runMini(tp.type, tp.need, () => { }, true);
        return;
      }
    }
    UI.toast('這裏沒有可做的事。附近有人的話，走近一點按 F。');
  };

  Game.drawWater = function (amount) {
    if (this._waterCD && Date.now() - this._waterCD < 6000) {
      UI.toast('桶還在沉澱。等一會兒再打。', 'bad'); return;
    }
    this._waterCD = Date.now();
    this.runMini('water', 4, () => { }, false);
  };

  Game.sellGrain = function () {
    if (this.state.food < 30) { UI.toast('糧食太少，賣了家裏就沒得吃了。', 'bad'); return; }
    const kg = Math.min(60, Math.floor(this.state.food - 20));
    this.state.food -= kg;
    this.state.cash += kg * 62;
    this.state.sustain = clamp(this.state.sustain - 0.4, 0, 100);
    UI.toast('賣出 ' + kg + ' kg 小米　＋' + (kg * 62).toLocaleString('en-US') + ' F', 'good');
    this.syncHUD();
  };

  Game.getSeedlings = function () {
    if (this._seedCD && Date.now() - this._seedCD < 25000) { UI.toast('苗圃今天已經給你了。樹木要慢慢長。', 'bad'); return; }
    if (this.state.cash < 500) { UI.toast('一株苗要錢。你先去集市賣點糧食。', 'bad'); return; }
    this._seedCD = Date.now();
    this.state.cash -= 500;
    this.syncHUD();
    UI.toast('領取 3 株白相思苗（－500 F）。現在就把它們種下。', 'good');
    setTimeout(() => this.runMini('tree', 3, () => { }, false), 320);
  };

  /* ================= 季節與事件 ================= */
  Game.triggerStorm = function (sec) {
    this._stormOn = true;
    this._stormT = sec || 20;
    World.setStorm(true);
    UI.flash(true);
    UI.toast('🌪 哈馬丹風來了 —— 空氣中全是撒哈拉的沙', 'bad');
    setTimeout(() => UI.flash(false), 900);
  };

  Game.updateWorld = function (dt) {
    // 區域橫幅
    const z = S.zoneAt(Player.pos.x, Player.pos.z);
    if (z) {
      const id = z.id || z.name;
      if (id !== this._lastZoneId) { this._lastZoneId = id; this._lastZoneCool = 0; }
      UI.zoneBanner(z.name);
    }

    // 到達檢查
    const step = this.currentStep();
    if (step && step.k === 'goto' && step.site) {
      const s = siteById(step.site);
      if (s && dist2(Player.pos.x, Player.pos.z, s.x, s.z) < s.r * s.r * 0.85) {
        this.completeStep();
      }
    }

    // 天數
    this._dayT += dt;
    if (this._dayT > 17) {
      this._dayT = 0;
      this.state.day++;
      this.state.water = clamp(this.state.water - 3, 0, 260);
      this.state.food = clamp(this.state.food - 1.8, 0, 999);
      if (this.state.water <= 5) { UI.toast('水快沒了 —— 去旱谷或水塘打水', 'bad'); this.state.sustain = clamp(this.state.sustain - 0.6, 0, 100); }
      if (this.state.food <= 10) { UI.toast('糧倉見底了', 'bad'); this.state.sustain = clamp(this.state.sustain - 0.8, 0, 100); }
      // 雨季肥力緩慢恢復
      if (this.state.season === 'rain') this.state.fertility = clamp(this.state.fertility + 0.25, 0, 100);
      this.syncHUD();
    }

    // 沙塵暴計時
    if (this._stormOn) {
      this._stormT -= dt;
      if (this._stormT <= 0) {
        this._stormOn = false;
        World.setStorm(false);
        UI.toast('風停了。沙落在田裏，也落在你的坑裏。');
      }
    } else if (this.state.season === 'dry' && this.started && Math.random() < dt * 0.0035) {
      this.triggerStorm(16);
    }

    // 靠近提示
    let prompt = null;
    const n = NPCs.nearest(Player.pos, INTERACTION_RADIUS);
    if (n) prompt = '與 ' + n.spec.name + ' 交談';
    else {
      for (const p of this.probes) {
        if (!p.done && dist2(Player.pos.x, Player.pos.z, p.x, p.z) < 9) { prompt = '調查：' + p.data.title.slice(2); break; }
      }
      if (!prompt && this.taskPoint && this.taskPoint.type !== 'goto' &&
        dist2(Player.pos.x, Player.pos.z, this.taskPoint.x, this.taskPoint.z) < 42) {
        const t = { zai: '開始挖 zaï 坑', stone: '開始擺石線', tree: '開始種樹', water: '打水' }[this.taskPoint.type];
        prompt = t;
      }
      if (!prompt) {
        const st = this.currentStep();
        if (st && st.k === 'talk') {
          const nn = NPCs.nearest(Player.pos, INTERACTION_RADIUS);
          if (nn && nn.spec.id === st.npc) prompt = '交談';
        }
      }
      if (!prompt) {
        const zn = S.zoneAt(Player.pos.x, Player.pos.z);
        if (zn && zn.id === 'well') prompt = '在老井打水';
        else if (zn && zn.id === 'mare') prompt = '在水塘打水';
        else if (zn && zn.id === 'market') prompt = '賣糧';
        else if (zn && zn.id === 'nursery') prompt = '領取樹苗';
      }
    }
    UI.prompt(UI.mode ? null : prompt);
  };

  Game.syncHUD = function () {
    UI.setHUD(this.state);
  };

  /* ================= 結局 ================= */
  // end:auto 與未知 id 按累計抉擇判定；終章三個選項各對應一種結局。
  // 舊版 ENDINGS.stay 並不存在，導致終章一選完就拋 TypeError。
  Game.pickEnding = function () {
    const c = this.choices || {};
    if (c.final_migrate) return 'south';
    if (c.final_diverse) return 'diverse';
    if (c.final_stay) return 'resilient';
    const score = (this.state.landScore || 0) + (this.state.livelihood || 0);
    if (score <= 0) return 'displaced';
    return score >= 4 ? 'resilient' : 'diverse';
  };

  Game.showEnding = function (id) {
    const key = (id && id !== 'auto' && ENDINGS[id]) ? id : this.pickEnding();
    const e = ENDINGS[key] || ENDINGS.resilient;
    const st = this.state;
    const rate = st.quizTotal ? Math.round(st.quizCorrect / st.quizTotal * 100) : 0;
    const stats = {
      correct: st.quizCorrect, total: st.quizTotal, rate,
      notes: st.notes.size, notesTotal: S.NOTES.length,
      fertility: st.fertility, sustain: st.sustain,
      food: st.food, cash: st.cash
    };
    World.setStorm(false);
    UI.ending(e, stats, () => location.reload());
  };

  /* ================= 輸入 ================= */
  Game.handleInteractInput = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.repeat) return;
    if (!this.started || UI.mode) return;
    this.tryInteract();
  };

  Game.bindKeys = function () {
    this._asked = new Set();
    window.addEventListener('keydown', e => {
      const code = e.code;
      if (code === 'KeyF' || code === 'KeyE') {
        this.handleInteractInput(e);
      } else if (code === 'Tab' || code === 'KeyJ') {
        e.preventDefault();
        if (UI.mode) { if (UI.mode === 'overlay') UI.closeOverlay(); } else UI.journal();
      } else if (code === 'KeyN') {
        if (UI.mode) { if (UI.mode === 'overlay') UI.closeOverlay(); } else UI.notes();
      } else if (code === 'KeyH') {
        if (UI.mode) { if (UI.mode === 'overlay') UI.closeOverlay(); } else UI.help();
      } else if (code === 'KeyV') {
        if (!UI.mode) this.toggleView();
      } else if (code === 'KeyG') {
        if (!UI.mode && this.started) this.toggleHerd();
      } else if (code === 'Escape') {
        if (UI.mode === 'overlay') UI.closeOverlay();
        else if (UI.mode === 'dialogue') { UI.hideDialogue(); this._pendingNext = false; this._talkCompletesStep = false; this._talkGuard = null; }
        else if (UI.mode === 'quiz') { /* 必須作答 */ }
      } else if (code === 'Space' || code === 'Enter') {
        if (UI.mode === 'dialogue') { UI._continue(); }
        else if (UI.mode === 'quiz') {
          const fb = document.getElementById('quiz-feedback');
          if (!fb.classList.contains('hidden')) UI._closeQuiz();
        } else if (UI.mode === 'overlay') {
          const b = document.querySelector('#ov-panel .ov-btn:not(.ghost)');
          if (b) b.click();
        }
      }
    });
      const ba = document.getElementById('btn-act');
      if (ba) {
        ba.addEventListener('pointerup', e => this.handleInteractInput(e));
        // 兼容沒有 Pointer Events 的舊 WebView，避免與 pointerup 重複觸發。
        if (!window.PointerEvent) ba.addEventListener('click', e => this.handleInteractInput(e));
      }
      const bh = document.getElementById('btn-herd');
      if (bh) bh.addEventListener('click', () => {
        if (this.started && !UI.mode) this.toggleHerd();
      });
    };

  /* ================= 趕牛玩法 ================= */
  Game.toggleHerd = function () {
    const st = World.toggleHerd();
    UI.toast(st.active
      ? '🐄 吹哨趕牛！附近的牛會跟着你，把牠們帶到牧民營地的畜欄。'
      : '🐄 停止趕牛，牛羣恢復自由吃草。', 'good');
    UI.SFX.talk();
    this.updateHerdHUD();
  };

  Game.updateHerdHUD = function () {
    if (!World.herdStatus) return;
    const st = World.herdStatus();
    const sig = [st.active, st.following, st.penned, st.done].join('|');
    if (sig !== this._herdSig) { this._herdSig = sig; UI.setHerd(st); }
    if (st.penned >= st.goal && !st.done) {
      World.herdDone = true;
      this.state.cash += 2000;
      this.state.food += 80;
      this.state.sustain = clamp(this.state.sustain + 3, 0, 100);
      this.syncHUD();
      UI.toast('🎉 牛羣歸欄！家計與可持續發展指數提升。', 'good');
      UI.SFX.good();
      this.updateHerdHUD();
    }
  };

  Game.toggleView = function () {
    Player.toggleView();
    UI.toast(Player.firstPerson ? '已切換到第一人稱' : '已切換到第三人稱', 'good');
    const btn = document.getElementById('btn-view');
    if (btn) btn.textContent = Player.firstPerson ? '👤 第一人稱' : '👁 視角';
  };

  /* ================= 主循環 ================= */
  Game.startLoop = function () {
    const clock = new THREE.Clock();
    const canvas = document.getElementById('scene');
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      Player.enabled = (UI.mode === null);
      Player.update(dt, World.camera);
      NPCs.update(dt, Player.pos, !UI.mode);
      World.update(dt, Player.pos);
      if (this.started) { this.updateWorld(dt); this.updateHerdHUD(); }
      if (this.started) {
        const targets = [];
        this.probes.forEach(p => { if (!p.done) targets.push(p); });
        if (this.taskPoint) targets.push(this.taskPoint);
        // 趕牛時把畜欄標上小地圖與導航箭頭，讓玩家知道往哪裏趕
        if (World.herdMode && !World.herdDone && World.herdStatus) {
          const hs = World.herdStatus();
          if (hs) targets.push({ x: hs.penX, z: hs.penZ });
        }
        const step = this.currentStep();
        if (step && step.k === 'talk') {
          const spec = NPCS.find(n => n.id === step.npc);
          if (spec) targets.push({ x: spec.x, z: spec.z });
        }
        UI.drawMinimap(Player.pos, Player.yaw, targets);

        // 任務導航箭頭：把當前優先目標投影到屏幕，始終指向任務方向
        if (UI.mode) {
          UI.hideNavArrow();
        } else if (targets.length) {
          // 選取離玩家最近的目標作為導航方向
          let t = targets[0], bd = Infinity;
          for (const tt of targets) {
            const d = dist2(Player.pos.x, Player.pos.z, tt.x, tt.z);
            if (d < bd) { bd = d; t = tt; }
          }
          const dist = Math.sqrt(bd);
          if (dist < 14) { UI.hideNavArrow(); }   // 已抵達：隱藏
          else {
            const ty = heightAt(t.x, t.z) + 1.4;
            const wp = new THREE.Vector3(t.x, ty, t.z).project(World.camera);
            const behind = wp.z > 1;               // 目標在相機身後
            let nx = wp.x, ny = wp.y;
            if (behind) { nx = -nx; ny = -ny; }     // 翻轉屏幕方向，指向正確側
            const sx = (nx * 0.5 + 0.5) * window.innerWidth;
            const sy = (-ny * 0.5 + 0.5) * window.innerHeight;
            const onScreen = !behind && Math.abs(wp.x) <= 1 && Math.abs(wp.y) <= 1;
            UI.navArrow(sx, sy, onScreen, Math.round(dist) + ' 米');
          }
        } else {
          UI.hideNavArrow();
        }
      }
      World.renderer.render(World.scene, World.camera);
    };
    loop();
  };

  global.SOS.Game = Game;

  /* 啓動（經典腳本由 ESM 動態注入，此時 DOMContentLoaded 可能已觸發，故需按 readyState 兜底） */
  let _booted = false;
  function bootOnce() {
    if (_booted) return;
    _booted = true;
    try { Game.boot(); }
    catch (err) {
      console.error(err);
      const t = document.getElementById('ld-tip');
      if (t) t.textContent = '啓動失敗：' + err.message;
    }
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootOnce);
  } else {
    bootOnce();
  }
})(window);
