// 武魂与魂技数据。首版两个武魂，各 4 个魂技、各一条成长线。
//
// 设计约定（见战斗系统选型）：
//   - 普攻自动进行，attack 描述自动攻击的射程/伤害/攻速/出手形态
//   - 魂技手动释放（1~4 键）：花魂力 + 各自冷却
//   - kind 是 Combat.cast 里的分派键；新增魂技只需在这里加数据
//   - 数值全是试玩占位，平衡在玩法跑通后再调

const SOULS = {
  // 昊天锤：爆发·近战。血厚、手短，靠贴脸一套带走
  hammer: {
    id: 'hammer',
    name: '昊天锤',
    tag: '爆发 · 近战',
    color: '255,179,71',          // fx 颜色统一存 RGB 三元组，绘制时拼 rgba()
    baseHp: 120, baseMp: 80,
    growHp: 14, growMp: 5,        // 每级上限增长
    attack: { range: 46, damage: 14, interval: 0.75, kind: 'melee' },
    skills: [
      { name: '崩地锤', cost: 8,  cd: 3.5,  kind: 'cone',  range: 74, arc: 2.0, dmg: 34, knock: 24 },
      { name: '铁血护体', cost: 15, cd: 12,  kind: 'shield', dur: 4, cut: 0.6 },
      { name: '昊天震', cost: 30, cd: 9,    kind: 'nova',  range: 92, dmg: 26, knock: 80 },
      { name: '霸绝', cost: 60, cd: 25,   kind: 'smite', range: 60, dmg: 120 },
    ],
  },

  // 蓝银草：控制·远程。血薄蓝长，射程圈外白打人（风筝）
  grass: {
    id: 'grass',
    name: '蓝银草',
    tag: '控制 · 远程',
    color: '126,200,80',
    baseHp: 90, baseMp: 120,
    growHp: 9, growMp: 9,
    attack: { range: 170, damage: 8, interval: 0.85, kind: 'bolt' },
    skills: [
      { name: '缠绕', cost: 8,  cd: 5,  kind: 'root', range: 180, dmg: 6, dur: 1.5 },
      { name: '蓝银牢', cost: 15, cd: 10, kind: 'zone', range: 150, radius: 70, dur: 3, slow: 0.45, dps: 10 },
      { name: '藤鞭', cost: 15, cd: 4,  kind: 'line', range: 200, width: 20, dmg: 22 },
      { name: '蓝银皇域', cost: 60, cd: 30, kind: 'nova', range: 130, dmg: 30, root: 1.2, knock: 20 },
    ],
  },
};
