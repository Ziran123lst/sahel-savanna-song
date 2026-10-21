/* ================================================================
 *  game.js —— 主状态机：任务链 · 交互 · 资源 · 季节 · 结局
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const UI = S.UI, Player = S.Player, World = S.World, NPCs = S.NPCs;
  const { SITES, NPCS, DIALOGUE, ACTS, PROBES, ENDINGS, clamp, dist2, heightAt } = S;

  const siteById = id => SITES.find(s => s.id === id);
  const npcById = id => NPCS.find(n => n.id === id);

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

  /* ================= 启动 ================= */
  Game.boot = function () {
    const canvas = document.getElementById('scene');
    World.init(canvas);
    Player.create(World.scene);
    Player.bindInput(canvas);
    NPCs.create(World.scene);
    UI.init(this);
    this.bindKeys();

    const ld = document.getElementById('ld-progress');
    const tip = document.getElementById('ld-tip');
    World.build((label, p) => {
      tip.textContent = label;
      if (ld) ld.style.width = Math.round(p * 100) + '%';
    }).then(() => {
      if (ld) ld.style.width = '100%';
      tip.textContent = '准备好了。';
      setTimeout(() => {
        document.getElementById('loading').classList.add('out');
        this.startLoop();
        UI.title(() => this.startStory());
      }, 350);
    });
  };

  Game.startStory = function () {
    this.started = true;
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('minimap-wrap').classList.remove('hidden');
    document.getElementById('objective').classList.remove('hidden');
    if ('ontouchstart' in window) document.getElementById('touch-ui').classList.remove('hidden');
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

  /* ================= 任务步骤 ================= */
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
      // 在自家田生成调查点
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
      // 自动完成
      setTimeout(() => {
        World.setSeason(st.v);
        this.state.season = st.v;
        UI.toast(st.v === 'rain' ? '🌧 雨季来了 —— 第一场雨落在你挖好的坑里' : '☀ 旱季开始', 'good');
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
    if (next === 5) { // 终章：起风
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
        const label = { water: '水', food: '粮食', cash: '现金', fertility: '肥力' }[a[1]] || a[1];
        UI.toast((v > 0 ? '＋' : '') + v + ' ' + label, v > 0 ? 'good' : 'bad');
      }
      else if (cmd === 'flag') { this.flags[a[1]] = true; }
      else if (cmd === 'unflag') { this.flags[a[1]] = false; }
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
      if (n) UI.toast('📘 解锁知识点：' + n.t, 'note');
    }
  };

  /* ================= 对话 ================= */
  Game.talkTo = function (npcId, nodeId) {
    const spec = npcById(npcId);
    const tree = DIALOGUE[npcId];
    if (!spec || !tree) return;
    let node = tree[nodeId] || tree.start;
    if (!node) { UI.toast('（他只是对你点了点头）'); return; }
    this._talkCtx = { npcId, nodeId: nodeId || 'start' };
    this.showNode(npcId, nodeId || 'start');
  };

  Game.showNode = function (npcId, nodeId) {
    const spec = npcById(npcId);
    const tree = DIALOGUE[npcId];
    const node = tree[nodeId];
    if (!node) { this.endTalk(); return; }
    UI.showDialogue(spec, node, opt => this.onDialogueChoice(npcId, node, opt));
  };

  Game.onDialogueChoice = function (npcId, node, opt) {
    const actStr = opt.isContinue ? (node.act || null) : (opt.act || null);
    const to = opt.isContinue ? node.to : opt.to;
    const res = this.runAct(actStr, { npcId });
    const finish = () => {
      if (this._pendingNext) {
        this._pendingNext = false;
        this.completeStep();
      }
    };

    if (res && res.kind === 'quiz') {
      UI.hideDialogue();
      this.runQuiz(res.req, () => {
        finish();
        if (to) this.showNode(npcId, to); else this.endTalk();
      });
      return;
    }
    if (res && res.kind === 'mini') {
      UI.hideDialogue();
      this.runMini(res.req.type, res.req.n, () => {
        finish();
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
      return;
    }
    finish();
    if (to) this.showNode(npcId, to); else this.endTalk();
  };

  Game.endTalk = function () {
    UI.hideDialogue();
    if (this._pendingNext) { this._pendingNext = false; this._talkCompletesStep = false; this.completeStep(); return; }
    if (this._talkCompletesStep) { this._talkCompletesStep = false; this.completeStep(); }
  };

  /* ================= 问答流程 ================= */
  Game.runQuiz = function (req, onDone) {
    let items = [];
    if (req.arg && req.arg.indexOf(',') >= 0) {
      items = req.arg.split(',').map(id => S.QUIZ_ALL.find(q => q.id === id)).filter(Boolean);
    } else if (req.arg && /^[A-H]\d+$/.test(req.arg)) {
      const one = S.QUIZ_ALL.find(q => q.id === req.arg);
      if (one) items = [one];
    } else {
      // 从分组随机抽 n 题（优先未答过的）
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
        // 解锁知识点（答对额外加分）
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

  /* ================= 小游戏 ================= */
  Game.runMini = function (type, need, onDone, isTask) {
    const cfg = { zai: 8, stone: 4, tree: 5, water: 6 };
    const n = need || cfg[type] || 6;
    UI.minigame(type, n, (count, aborted) => {
      if (count > 0) {
        if (type === 'zai') {
          this.state.zai += count;
          this.state.water = clamp(this.state.water - count * 3, 0, 260);
          this.state.fertility = clamp(this.state.fertility + count * 3.2, 0, 100);
          this.state.sustain = clamp(this.state.sustain + count * 1.4, 0, 100);
          UI.toast('🕳 挖了 ' + count + ' 个 zaï 坑　肥力 +' + (count * 3.2).toFixed(0), 'good');
        } else if (type === 'stone') {
          this.state.stones += count;
          this.state.fertility = clamp(this.state.fertility + count * 4.0, 0, 100);
          this.state.sustain = clamp(this.state.sustain + count * 1.8, 0, 100);
          UI.toast('🪨 摆了 ' + count + ' 道石线　径流减慢，入渗增加', 'good');
        } else if (type === 'tree') {
          this.state.trees += count;
          this.state.water = clamp(this.state.water - count * 12, 0, 260);
          this.state.fertility = clamp(this.state.fertility + count * 2.6, 0, 100);
          this.state.sustain = clamp(this.state.sustain + count * 2.4, 0, 100);
          UI.toast('🌳 种下 ' + count + ' 棵白相思　旱季有饲料，雨季有肥', 'good');
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

  /* ================= 调查点 ================= */
  Game.investigate = function (p) {
    p.done = true;
    World.removeMarker(p.marker);
    const i = this.markers.indexOf(p.marker);
    if (i >= 0) this.markers.splice(i, 1);
    UI.SFX.open();
    const html = '<div class="sub">土地退化现场调查</div><h1>' + p.data.title + '</h1>' +
      '<div class="lead" style="margin-top:14px">' + p.data.text.replace(/\n/g, '<br>') + '</div>';
    UI.overlay(html, [{
      label: '回答相关问题 ▸', onClick: () => {
        UI.closeOverlay();
        this.runQuiz({ arg: p.data.quiz, n: 1 }, () => {
          const remain = this.probes.filter(x => !x.done).length;
          const need = (ACTS[this.actIndex].steps[this.stepIndex] || {}).n || 3;
          const doneCount = this.probes.filter(x => x.done).length;
          if (doneCount >= need) { setTimeout(() => this.completeStep(), 260); }
          else UI.toast('还需调查 ' + (need - doneCount) + ' 处迹象', 'note');
        });
      }
    }]);
  };

  /* ================= 交互 ================= */
  Game.tryInteract = function () {
    if (UI.mode) return;
    const pos = Player.pos;

    // 1) 任务相关：探针
    for (const p of this.probes) {
      if (p.done) continue;
      if (dist2(pos.x, pos.z, p.x, p.z) < 9) { this.investigate(p); return; }
    }
    // 2) NPC
    const n = NPCs.nearest(pos, 3.4);
    if (n) {
      const step = this.currentStep();
      let nodeId = null;
      if (step && step.k === 'talk' && step.npc === n.spec.id) {
        nodeId = step.node || 'start';
        this._talkCompletesStep = true;    // 此对话即为当前任务步骤
      }
      this.talkTo(n.spec.id, nodeId || 'start');
      return;
    }
    // 3) 任务点（小游戏 / 到达点）
    if (this.taskPoint) {
      const tp = this.taskPoint;
      if (dist2(pos.x, pos.z, tp.x, tp.z) < 42) {
        if (tp.type === 'goto') return;    // 到达点无需交互
        this.runMini(tp.type, tp.need, () => { }, true);
        return;
      }
    }
    // 4) 世界设施
    const zone = S.zoneAt(pos.x, pos.z);
    if (zone && zone.id === 'well') { this.drawWater(90); return; }
    if (zone && zone.id === 'mare') { this.drawWater(70); return; }
    if (zone && zone.id === 'market') { this.sellGrain(); return; }
    if (zone && zone.id === 'nursery') { this.getSeedlings(); return; }
    UI.toast('这里没有可做的事。附近有人的话，走近一点按 F。');
  };

  Game.drawWater = function (amount) {
    if (this._waterCD && Date.now() - this._waterCD < 6000) {
      UI.toast('桶还在沉淀。等一会儿再打。', 'bad'); return;
    }
    this._waterCD = Date.now();
    this.runMini('water', 4, () => { }, false);
  };

  Game.sellGrain = function () {
    if (this.state.food < 30) { UI.toast('粮食太少，卖了家里就没得吃了。', 'bad'); return; }
    const kg = Math.min(60, Math.floor(this.state.food - 20));
    this.state.food -= kg;
    this.state.cash += kg * 62;
    this.state.sustain = clamp(this.state.sustain - 0.4, 0, 100);
    UI.toast('卖出 ' + kg + ' kg 小米　＋' + (kg * 62).toLocaleString('en-US') + ' F', 'good');
    this.syncHUD();
  };

  Game.getSeedlings = function () {
    if (this._seedCD && Date.now() - this._seedCD < 25000) { UI.toast('苗圃今天已经给你了。树木要慢慢长。', 'bad'); return; }
    if (this.state.cash < 500) { UI.toast('一株苗要钱。你先去集市卖点粮食。', 'bad'); return; }
    this._seedCD = Date.now();
    this.state.cash -= 500;
    this.syncHUD();
    UI.toast('领取 3 株白相思苗（－500 F）。现在就把它们种下。', 'good');
    setTimeout(() => this.runMini('tree', 3, () => { }, false), 320);
  };

  /* ================= 季节与事件 ================= */
  Game.triggerStorm = function (sec) {
    this._stormOn = true;
    this._stormT = sec || 20;
    World.setStorm(true);
    UI.flash(true);
    UI.toast('🌪 哈马丹风来了 —— 空气中全是撒哈拉的沙', 'bad');
    setTimeout(() => UI.flash(false), 900);
  };

  Game.updateWorld = function (dt) {
    // 区域横幅
    const z = S.zoneAt(Player.pos.x, Player.pos.z);
    if (z) {
      const id = z.id || z.name;
      if (id !== this._lastZoneId) { this._lastZoneId = id; this._lastZoneCool = 0; }
      UI.zoneBanner(z.name);
    }

    // 到达检查
    const step = this.currentStep();
    if (step && step.k === 'goto' && step.site) {
      const s = siteById(step.site);
      if (s && dist2(Player.pos.x, Player.pos.z, s.x, s.z) < s.r * s.r * 0.85) {
        this.completeStep();
      }
    }

    // 天数
    this._dayT += dt;
    if (this._dayT > 17) {
      this._dayT = 0;
      this.state.day++;
      this.state.water = clamp(this.state.water - 3, 0, 260);
      this.state.food = clamp(this.state.food - 1.8, 0, 999);
      if (this.state.water <= 5) { UI.toast('水快没了 —— 去旱谷或水塘打水', 'bad'); this.state.sustain = clamp(this.state.sustain - 0.6, 0, 100); }
      if (this.state.food <= 10) { UI.toast('粮仓见底了', 'bad'); this.state.sustain = clamp(this.state.sustain - 0.8, 0, 100); }
      // 雨季肥力缓慢恢复
      if (this.state.season === 'rain') this.state.fertility = clamp(this.state.fertility + 0.25, 0, 100);
      this.syncHUD();
    }

    // 沙尘暴计时
    if (this._stormOn) {
      this._stormT -= dt;
      if (this._stormT <= 0) {
        this._stormOn = false;
        World.setStorm(false);
        UI.toast('风停了。沙落在田里，也落在你的坑里。');
      }
    } else if (this.state.season === 'dry' && this.started && Math.random() < dt * 0.0035) {
      this.triggerStorm(16);
    }

    // 靠近提示
    let prompt = null;
    const n = NPCs.nearest(Player.pos, 3.4);
    if (n) prompt = '与 ' + n.spec.name + ' 交谈';
    else {
      for (const p of this.probes) {
        if (!p.done && dist2(Player.pos.x, Player.pos.z, p.x, p.z) < 9) { prompt = '调查：' + p.data.title.slice(2); break; }
      }
      if (!prompt && this.taskPoint && this.taskPoint.type !== 'goto' &&
        dist2(Player.pos.x, Player.pos.z, this.taskPoint.x, this.taskPoint.z) < 42) {
        const t = { zai: '开始挖 zaï 坑', stone: '开始摆石线', tree: '开始种树', water: '打水' }[this.taskPoint.type];
        prompt = t;
      }
      if (!prompt) {
        const zn = S.zoneAt(Player.pos.x, Player.pos.z);
        if (zn && zn.id === 'well') prompt = '在老井打水';
        else if (zn && zn.id === 'mare') prompt = '在水塘打水';
        else if (zn && zn.id === 'market') prompt = '卖粮';
        else if (zn && zn.id === 'nursery') prompt = '领取树苗';
      }
    }
    UI.prompt(UI.mode ? null : prompt);
  };

  Game.syncHUD = function () {
    UI.setHUD(this.state);
  };

  /* ================= 结局 ================= */
  Game.showEnding = function (id) {
    const base = ENDINGS[id] || ENDINGS.stay;
    let e = base;
    // 根据表现微调标题后缀
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

  /* ================= 输入 ================= */
  Game.bindKeys = function () {
    this._asked = new Set();
    window.addEventListener('keydown', e => {
      const code = e.code;
      if (code === 'KeyF' || code === 'KeyE') {
        if (!UI.mode) this.tryInteract();
      } else if (code === 'Tab' || code === 'KeyJ') {
        e.preventDefault();
        if (UI.mode === 'overlay') UI.closeOverlay(); else UI.journal();
      } else if (code === 'KeyN') {
        if (UI.mode === 'overlay') UI.closeOverlay(); else UI.notes();
      } else if (code === 'KeyH') {
        if (UI.mode === 'overlay') UI.closeOverlay(); else UI.help();
      } else if (code === 'Escape') {
        if (UI.mode === 'overlay') UI.closeOverlay();
        else if (UI.mode === 'dialogue') { UI.hideDialogue(); this._pendingNext = false; this._talkCompletesStep = false; }
        else if (UI.mode === 'quiz') { /* 必须作答 */ }
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
    if (ba) ba.addEventListener('click', () => { if (!UI.mode) this.tryInteract(); });
  };

  /* ================= 主循环 ================= */
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
      if (this.started) this.updateWorld(dt);
      if (this.started) {
        const targets = [];
        this.probes.forEach(p => { if (!p.done) targets.push(p); });
        if (this.taskPoint) targets.push(this.taskPoint);
        const step = this.currentStep();
        if (step && step.k === 'talk') {
          const spec = NPCS.find(n => n.id === step.npc);
          if (spec) targets.push({ x: spec.x, z: spec.z });
        }
        UI.drawMinimap(Player.pos, Player.yaw, targets);
      }
      World.renderer.render(World.scene, World.camera);
    };
    loop();
  };

  global.SOS.Game = Game;

  /* 启动 */
  window.addEventListener('DOMContentLoaded', () => {
    try { Game.boot(); }
    catch (err) {
      console.error(err);
      const t = document.getElementById('ld-tip');
      if (t) t.textContent = '启动失败：' + err.message;
    }
  });
})(window);
