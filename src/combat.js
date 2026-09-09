// 战斗系统：半即时自动战斗。
//
// 玩家在世界里只做两件事：
//   1. 拉位置——进/退自己和魂兽的射程圈（远程风筝、近战贴脸）
//   2. 放魂技——1~4 键，花共享魂力池里的魂力，每个魂技各自转冷却
// 普攻全自动：射程内存活魂兽按攻速出手，无需按键。
//
// 视觉特效（fx）是短寿命的屏幕对象：arc 扇形 / bolt 连线 / ring 扩散环 /
// smite 落击光柱；zone 是长寿命地面区域（蓝银牢）；nums 是飘字。

const Combat = {
  cds: [0, 0, 0, 0],       // 四个魂技的剩余冷却
  atkTimer: 0,             // 普攻间隔
  shieldT: 0, shieldCut: 0,
  hurtFlash: 0,
  toasts: [],              // {text, t}
  fx: [],
  zones: [],
  nums: [],

  // 魂技解锁等级（= 魂环数）。正式版改为剧情/猎杀获得，试玩版先按等级自动给，
  // 否则从开局到第一个魂环要打几十只猪，测不到后面的技能。
  SKILL_UNLOCK: [1, 3, 5, 8],

  init() {},

  reset() {
    this.cds = [0, 0, 0, 0];
    this.atkTimer = 0;
    this.shieldT = this.shieldCut = this.hurtFlash = 0;
    this.toasts = []; this.fx = []; this.zones = []; this.nums = [];
  },

  expNeed(lv) { return 8 + lv * 4; },

  update(dt) {
    if (!Player.soul) return;
    const soul = SOULS[Player.soul];

    // 魂力回复 / 计时推进
    Player.mp = Math.min(Player.maxMp, Player.mp + Player.mpRegen * dt);
    Player.invuln = Math.max(0, Player.invuln - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.8);
    for (let i = 0; i < 4; i++) this.cds[i] = Math.max(0, this.cds[i] - dt);

    // 魂技（按键边沿，按住不连发）
    for (let i = 0; i < 4; i++) {
      if (Input.took(String(i + 1))) this.cast(i);
    }

    // 普攻：射程内最近的魂兽
    this.atkTimer -= dt;
    const a = soul.attack;
    const target = Entities.nearestAlive(Player.x, Player.y, a.range);
    if (target && this.atkTimer <= 0) {
      this.atkTimer = a.interval;
      this.basicAttack(target, a, soul);
    }

    this.updateZones(dt);
    this.updateFx(dt);
  },

  // ---------- 普攻 ----------

  basicAttack(m, a, soul) {
    const ang = Math.atan2(m.y - Player.y, m.x - Player.x);
    if (a.kind === 'melee') {
      // 近身挥击弧 + 微击退
      this.fxPush({ k: 'arc', x: Player.x, y: Player.y - 4, r: a.range + 6,
        a: ang, w: 1.6, t: 0, life: 0.22, col: soul.color });
      this.hurt(m, a.damage);
      Entities.knock(m, Math.cos(ang) * 8, Math.sin(ang) * 8);
    } else {
      // 远程藤条/锤影连线
      this.fxPush({ k: 'bolt', x1: Player.x, y1: Player.y - 8, x2: m.x, y2: m.y - 6,
        t: 0, life: 0.14, w: 2.5, col: soul.color });
      this.hurt(m, a.damage);
    }
  },

  // ---------- 魂技 ----------

  cast(i) {
    const needLv = this.SKILL_UNLOCK[i];
    if (Player.level < needLv) return this.toast(`需要等级 ${needLv}`);
    if (this.cds[i] > 0) return;
    const soul = SOULS[Player.soul];
    const sk = soul.skills[i];
    if (Player.mp < sk.cost) return this.toast('魂力不足');

    const px = Player.x, py = Player.y;

    switch (sk.kind) {
      case 'cone': {
        // 朝最近目标（没有就朝面朝方向）扇形一击
        const t = Entities.nearestAlive(px, py, sk.range);
        const ang = t ? Math.atan2(t.y - py, t.x - px) : this.facingAngle();
        this.spend(i, sk);
        this.fxPush({ k: 'arc', x: px, y: py - 4, r: sk.range, a: ang, w: sk.arc,
          t: 0, life: 0.3, col: soul.color });
        for (const m of Entities.inRadius(px, py, sk.range)) {
          const d = Math.atan2(m.y - py, m.x - px);
          if (Math.abs(this.angDiff(d, ang)) <= sk.arc / 2) {
            this.hurt(m, sk.dmg);
            Entities.knock(m, Math.cos(d) * sk.knock, Math.sin(d) * sk.knock);
          }
        }
        break;
      }
      case 'shield': {
        this.spend(i, sk);
        this.shieldT = sk.dur;
        this.shieldCut = sk.cut;
        this.fxPush({ k: 'ring', x: px, y: py, r0: 10, r1: 34, t: 0, life: 0.4, col: '255,220,140' });
        this.toast(`铁血护体 · ${sk.dur}s 减伤 ${Math.round(sk.cut * 100)}%`);
        break;
      }
      case 'nova': {
        this.spend(i, sk);
        this.fxPush({ k: 'ring', x: px, y: py, r0: 16, r1: sk.range, t: 0, life: 0.45, col: soul.color });
        for (const m of Entities.inRadius(px, py, sk.range)) {
          const d = Math.atan2(m.y - py, m.x - px) || Math.random() * 6.28;
          this.hurt(m, sk.dmg);
          if (sk.root) m.root = Math.max(m.root, sk.root);
          if (sk.knock) Entities.knock(m, Math.cos(d) * sk.knock, Math.sin(d) * sk.knock);
        }
        break;
      }
      case 'smite': {
        // 单体巨锤，必须射程内有目标
        const t = Entities.nearestAlive(px, py, sk.range);
        if (!t) return;
        this.spend(i, sk);
        this.fxPush({ k: 'smite', x: t.x, y: t.y, r: 30, t: 0, life: 0.35, col: soul.color });
        this.hurt(t, sk.dmg);
        Entities.knock(t, (t.x - px) * 0.12, (t.y - py) * 0.12);
        break;
      }
      case 'root': {
        const t = Entities.nearestAlive(px, py, sk.range);
        if (!t) return;
        this.spend(i, sk);
        this.fxPush({ k: 'bolt', x1: px, y1: py - 8, x2: t.x, y2: t.y - 4,
          t: 0, life: 0.2, w: 4, col: soul.color });
        this.fxPush({ k: 'ring', x: t.x, y: t.y, r0: 6, r1: 22, t: 0, life: 0.35, col: soul.color });
        this.hurt(t, sk.dmg);
        t.root = Math.max(t.root, sk.dur);
        break;
      }
      case 'zone': {
        // 落点：射程内最近的魂兽；没有就落在面前 100px
        const t = Entities.nearestAlive(px, py, sk.range);
        const zx = t ? t.x : px + Math.cos(this.facingAngle()) * 100;
        const zy = t ? t.y : py + Math.sin(this.facingAngle()) * 100;
        this.spend(i, sk);
        this.zones.push({ x: zx, y: zy, r: sk.radius, dur: sk.dur, t: 0,
          slow: sk.slow, dps: sk.dps, tick: 0, col: soul.color });
        this.fxPush({ k: 'ring', x: zx, y: zy, r0: 10, r1: sk.radius, t: 0, life: 0.4, col: soul.color });
        break;
      }
      case 'line': {
        // 瞄准只在鞭子够得到的范围内锁怪——否则会朝 200 格外的怪空抽
        const t = Entities.nearestAlive(px, py, sk.range);
        const ang = t ? Math.atan2(t.y - py, t.x - px) : this.facingAngle();
        const ex = px + Math.cos(ang) * sk.range, ey = py + Math.sin(ang) * sk.range;
        this.spend(i, sk);
        this.fxPush({ k: 'whip', x1: px, y1: py - 8, x2: ex, y2: ey,
          t: 0, life: 0.28, col: soul.color });
        // 垂直距离 ≤ half width 且投影在线段内 = 被藤鞭扫中
        for (const m of Entities.monsters) {
          if (m.dead) continue;
          const dx = m.x - px, dy = m.y - py;
          const along = dx * Math.cos(ang) + dy * Math.sin(ang);
          if (along < 0 || along > sk.range) continue;
          const perp = Math.abs(-dx * Math.sin(ang) + dy * Math.cos(ang));
          if (perp <= sk.width / 2 + m.r) {
            this.hurt(m, sk.dmg);
            Entities.knock(m, Math.cos(ang) * 10, Math.sin(ang) * 10);
            // 命中点爆一个小绿环，让「抽中了」读得出来（旧版特效和普攻完全一样）
            this.fxPush({ k: 'ring', x: m.x, y: m.y, r0: 6, r1: 20, t: 0, life: 0.28, col: soul.color });
          }
        }
        break;
      }
    }
  },

  spend(i, sk) {
    Player.mp -= sk.cost;
    this.cds[i] = sk.cd;
  },

  facingAngle() {
    return { up: -Math.PI / 2, down: Math.PI / 2, left: Math.PI, right: 0 }[Player.facing] ?? 0;
  },

  angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  },

  // ---------- 伤害 / 击杀 / 升级 ----------

  hurt(m, dmg) {
    if (m.dead) return;
    m.hp -= dmg;
    m.hitFlash = 0.12;
    this.numPush(m.x, m.y - 22, String(Math.round(dmg)), '255,255,255');
    if (m.hp <= 0) {
      m.dead = true;
      const T = MONSTER_TYPES[m.type];
      Player.mp = Math.min(Player.maxMp, Player.mp + T.mp);
      this.fxPush({ k: 'ring', x: m.x, y: m.y, r0: 8, r1: 30, t: 0, life: 0.4, col: '230,230,180' });
      this.numPush(m.x, m.y - 8, `+${T.exp} 魂力`, '255,224,130');
      this.addExp(T.exp);
    }
  },

  hurtPlayer(raw) {
    if (Player.invuln > 0) return;
    let dmg = raw;
    if (this.shieldT > 0) dmg *= 1 - this.shieldCut;
    Player.hp -= dmg;
    this.hurtFlash = 1;
    this.numPush(Player.x, Player.y - 30, `-${Math.round(dmg)}`, '255,110,90');
    if (Player.hp <= 0) {
      Player.hp = 0;
      this.toast('你被击倒了……在圣魂村醒来');
      Player.respawn();
    }
  },

  addExp(n) {
    const soul = SOULS[Player.soul];
    Player.exp += n;
    let need = this.expNeed(Player.level);
    while (Player.exp >= need) {
      Player.exp -= need;
      Player.level++;
      Player.maxHp += soul.growHp;
      Player.maxMp += soul.growMp;
      Player.hp = Player.maxHp;
      Player.mp = Player.maxMp;
      Player.rings = this.SKILL_UNLOCK.filter(lv => Player.level >= lv).length;
      this.toast(`等级提升 · Lv.${Player.level}`);
      const idx = this.SKILL_UNLOCK.indexOf(Player.level);
      if (idx >= 0) this.toast(`获得魂环 · 习得「${soul.skills[idx].name}」（${idx + 1} 键）`);
      this.fxPush({ k: 'ring', x: Player.x, y: Player.y, r0: 10, r1: 60, t: 0, life: 0.7, col: '255,230,150' });
      need = this.expNeed(Player.level);
    }
  },

  // ---------- 区域效果（蓝银牢） ----------

  updateZones(dt) {
    for (const z of this.zones) {
      z.t += dt;
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.5;
        for (const m of Entities.inRadius(z.x, z.y, z.r)) {
          m.slowT = 0.6;
          m.slowF = 1 - z.slow;
          this.hurt(m, z.dps * 0.5);
        }
      }
    }
    this.zones = this.zones.filter(z => z.t < z.dur);
  },

  // ---------- 特效 / 飘字 / 提示 ----------

  fxPush(o) {
    if (this.fx.length > 90) this.fx.shift();
    this.fx.push(o);
  },

  numPush(x, y, text, col) {
    if (this.nums.length > 40) this.nums.shift();
    this.nums.push({ x, y, text, col, t: 0, life: 0.9, vy: -26 });
  },

  toast(text) {
    this.toasts.push({ text, t: 0 });
    if (this.toasts.length > 4) this.toasts.shift();
  },

  updateFx(dt) {
    for (const f of this.fx) f.t += dt;
    this.fx = this.fx.filter(f => f.t < f.life);
    for (const n of this.nums) { n.t += dt; n.y += n.vy * dt; }
    this.nums = this.nums.filter(n => n.t < n.life);
    for (const t of this.toasts) t.t += dt;
    this.toasts = this.toasts.filter(t => t.t < 2.4);
  },

  // 地面区域：画在魂兽之下
  drawGround() {
    if (!Player.soul) return;
    const { ctx } = Render;
    for (const z of this.zones) {
      const fade = z.t > z.dur - 0.3 ? (z.dur - z.t) / 0.3 : 1;
      const sx = z.x - Render.camX, sy = z.y - Render.camY;
      const pulse = 1 + Math.sin(performance.now() / 200) * 0.03;
      ctx.fillStyle = `rgba(${z.col},${0.1 * fade})`;
      ctx.beginPath();
      ctx.arc(sx, sy, z.r * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${z.col},${0.55 * fade})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      // 边缘绕动的小藤尖
      const now = performance.now() / 500;
      ctx.strokeStyle = `rgba(${z.col},${0.8 * fade})`;
      for (let i = 0; i < 6; i++) {
        const a = now + i * Math.PI / 3;
        ctx.beginPath();
        ctx.arc(sx + Math.cos(a) * z.r, sy + Math.sin(a) * z.r, 3, a, a + 2);
        ctx.stroke();
      }
    }
  },

  // 魂技特效、飘字、护体环、受击红边、提示：画在人物之上
  drawFx() {
    if (!Player.soul) return;
    const { ctx, canvas } = Render;

    for (const f of this.fx) {
      const p = f.t / f.life, a = 1 - p;
      const sx0 = f.x !== undefined ? f.x - Render.camX : 0;
      const sy0 = f.y !== undefined ? f.y - Render.camY : 0;
      if (f.k === 'arc') {
        ctx.fillStyle = `rgba(${f.col},${0.32 * a})`;
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.arc(sx0, sy0, f.r, f.a - f.w / 2, f.a + f.w / 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = `rgba(${f.col},${0.7 * a})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (f.k === 'ring') {
        const ease = 1 - (1 - p) * (1 - p);
        const rr = f.r0 + (f.r1 - f.r0) * ease;
        ctx.strokeStyle = `rgba(${f.col},${a})`;
        ctx.lineWidth = 1 + 3 * a;
        ctx.beginPath();
        ctx.ellipse(sx0, sy0, rr, rr * 0.55, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (f.k === 'bolt') {
        const x1 = f.x1 - Render.camX, y1 = f.y1 - Render.camY;
        const x2 = f.x2 - Render.camX, y2 = f.y2 - Render.camY;
        ctx.strokeStyle = `rgba(${f.col},${0.35 * a})`;
        ctx.lineWidth = f.w + 3;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.lineWidth = f.w;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      } else if (f.k === 'whip') {
        // 藤鞭：抽出时先沿垂直方向甩出弧度再绷直，三层描边（深藤/亮藤/白芯）
        const x1 = f.x1 - Render.camX, y1 = f.y1 - Render.camY;
        let dx = f.x2 - f.x1, dy = f.y2 - f.y1;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const grow = Math.min(1, p / 0.35);          // 前 35% 时间抽出去
        const gx = x1 + dx * len * grow, gy = y1 + dy * len * grow;
        const swag = Math.sin(Math.min(1, p / 0.5) * Math.PI) * 16;
        const cx = (x1 + gx) / 2 - dy * swag, cy = (y1 + gy) / 2 + dx * swag;
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(${f.col},${0.3 * a})`;
        ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cx, cy, gx, gy); ctx.stroke();
        ctx.strokeStyle = `rgba(${f.col},${0.85 * a})`;
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cx, cy, gx, gy); ctx.stroke();
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cx, cy, gx, gy); ctx.stroke();
      } else if (f.k === 'smite') {
        // 落地光柱 + 爆环
        const grad = ctx.createLinearGradient(sx0, sy0 - f.r * 2.4, sx0, sy0);
        grad.addColorStop(0, `rgba(${f.col},0)`);
        grad.addColorStop(1, `rgba(${f.col},${0.7 * a})`);
        ctx.fillStyle = grad;
        ctx.fillRect(sx0 - 7, sy0 - f.r * 2.4, 14, f.r * 2.4);
        const rr = f.r * (0.4 + p * 0.8);
        ctx.strokeStyle = `rgba(255,240,200,${a})`;
        ctx.lineWidth = 2 + 4 * a;
        ctx.beginPath();
        ctx.ellipse(sx0, sy0, rr, rr * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 铁血护体：人物周身金环
    if (this.shieldT > 0) {
      const sx = Player.x - Render.camX, sy = Player.y - Render.camY;
      const blink = this.shieldT < 1 && Math.floor(performance.now() / 120) % 2 === 0;
      ctx.strokeStyle = `rgba(255,220,140,${blink ? 0.35 : 0.8})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(sx, sy - 4, 20, 24, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 飘字
    ctx.font = 'bold 13px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    for (const n of this.nums) {
      const a = 1 - n.t / n.life;
      const sx = n.x - Render.camX, sy = n.y - Render.camY;
      ctx.strokeStyle = `rgba(0,0,0,${a})`;
      ctx.lineWidth = 3;
      ctx.strokeText(n.text, sx, sy);
      ctx.fillStyle = `rgba(${n.col},${a})`;
      ctx.fillText(n.text, sx, sy);
    }

    // 受击红边
    if (this.hurtFlash > 0) {
      const g = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * 0.32,
        canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.72);
      g.addColorStop(0, 'rgba(180,20,20,0)');
      g.addColorStop(1, `rgba(180,20,20,${0.4 * this.hurtFlash})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 居中提示（升级、习得、倒地等）
    ctx.font = 'bold 19px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    this.toasts.forEach((t, i) => {
      const a = t.t < 0.25 ? t.t / 0.25 : t.t > 2 ? (2.4 - t.t) / 0.4 : 1;
      ctx.fillStyle = `rgba(0,0,0,${0.5 * a})`;
      const w = ctx.measureText(t.text).width;
      ctx.fillRect(canvas.width / 2 - w / 2 - 12, 116 + i * 28 - 19, w + 24, 26);
      ctx.fillStyle = `rgba(255,233,168,${a})`;
      ctx.fillText(t.text, canvas.width / 2, 100 + i * 28);
    });
  },
};
