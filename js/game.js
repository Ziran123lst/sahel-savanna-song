/* ================================================================
 *  game.js —— 主状态机：任务链 · 交互 · 资源 · 季节 · 结局
 * ================================================================ */
(function (global) {
  'use strict';
  const S = global.SOS;
  const UI = S.UI, Player = S.Player, World = S.World, NPCs = S.NPCs;
  const { SITES, NPCS, DIALOGUE, ACTS, PROBES, ENDINGS, INTERACTION_RADIUS, clamp, dist2, heightAt } = S;

  const siteById = id => SITES.find(s => s.id === id);
  // NPCS 是 story.js 导出的纯规格数组；NPCs（模块）才有 .list（运行时实例）。
  // 按 id 查运行时实例，再取回 spec。之前误用 NPCS.list 导致 TypeError，对话一按 F 就崩。
  const npcById = id => {
    const it = NPCs.list.find(n => n.spec.id === id);
    return it ? it.spec : null;
  };
