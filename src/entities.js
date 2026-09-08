// 实体系统：魂兽（怪物）与以后的 NPC 共用 update/draw/邻近查询。
//
// 本版只有魂兽：
//   - 在玩家周围的野外（草原/森林格）按需生成，走太远自动剔除，总数有上限
//   - 仇恨圈模型：进入 aggro 才追，追击距离过远脱战；普攻/挨打都走射程圈
//   - 状态计时（root 定身 / slow 减速 / hitFlash 受击闪白 / atkTimer 攻击间隔）
//     全部挂在怪物对象上，由 Combat 施加、在这里推进

const MONSTER_TYPES = {
  // 草原上的百年魂兽·野猪：慢、厚、贴脸啃
  boar: {
    name: '百年魂兽·野猪', hp: 42, dmg: 7, speed: 58, r: 13,
    color: '#b07142', aggro: 120, atkRange: 34, atkCd: 1.4,
    exp: 8, mp: 6,
  },
  // 森林里的百年魂兽·风狼：快、脆、仇恨远
  wolf: {
    name: '百年魂兽·风狼', hp: 30, dmg: 9, speed: 96, r: 11,
    color: '#9aa0ad', aggro: 165, atkRange: 30, atkCd: 1.0,
    exp: 12, mp: 8,
  },
};

const Entities = {
  monsters: [],
  spawnTimer: 0,
  MAX: 20,               // 世界内魂兽上限

  // NPC 以后加在这里；目前只有怪物
  init() {},

  active() { return !!Player.soul; },

  update(dt, time) {
    if (!this.active()) return;

    // ---- 补充魂兽：每 0.8s 尝试一次，在玩家 380~760px 的环上找点 ----
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.8;
      if (this.monsters.length < this.MAX) this.trySpawn();
    }

    for (const m of this.monsters) this.updateMonster(m, dt);

    // 同类互相挤开，避免叠成一个点（n ≤ 20，O(n²) 无所谓）
    const ms = this.monsters;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i], b = ms[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const min = a.r + b.r - 4;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.01 && d2 < min * min) {
          const d = Math.sqrt(d2), push = (min - d) / 2;
          dx /= d; dy /= d;
          this.slide(a, -dx * push, -dy * push);
          this.slide(b, dx * push, dy * push);
        }
      }
    }

    // 剔除距离随屏幕尺寸：视口半对角 + 500px，保证大屏边缘刷出的怪不会被秒删
    const cull = Math.hypot(innerWidth, innerHeight) / 2 + 500;
    this.monsters = this.monsters.filter(m =>
      !m.dead && Math.hypot(m.x - Player.x, m.y - Player.y) < cull);
    // y 排序一次，渲染时与玩家做插入式遮挡
    this.monsters.sort((a, b) => a.y - b.y);
  },

  updateMonster(m, dt) {
    const T = MONSTER_TYPES[m.type];
    m.root = Math.max(0, m.root - dt);
    m.slowT = Math.max(0, m.slowT - dt);
    m.hitFlash = Math.max(0, m.hitFlash - dt);
    m.atkTimer -= dt;
    m.moving = false;

    const dx = Player.x - m.x, dy = Player.y - m.y;
    const d = Math.hypot(dx, dy);
    if (!m.aggroed && d < T.aggro) m.aggroed = true;
    if (m.aggroed && d > 480) m.aggroed = false;    // 跑远脱战

    if (m.aggroed && Player.hp > 0) {
      if (d > T.atkRange * 0.85) {
        // 追击（定身时站桩）
        if (m.root <= 0) {
          const slow = m.slowT > 0 ? m.slowF : 1;
          const sp = T.speed * slow * dt / (d || 1);
          this.slide(m, dx * sp, dy * sp);
          if (Math.abs(dx) > 1) m.face = dx > 0 ? 1 : -1;
          m.moving = true;
        }
      } else if (m.atkTimer <= 0 && m.root <= 0) {
        // 贴到射程内：自动咬一口
        m.atkTimer = T.atkCd;
        Combat.hurtPlayer(T.dmg);
        const mx = (m.x + Player.x) / 2, my = (m.y + Player.y) / 2 - 4;
        Combat.fxPush({ k: 'arc', x: mx, y: my, r: 24,
          a: Math.atan2(Player.y - m.y, Player.x - m.x), w: 0.7,
          t: 0, life: 0.18, col: '230,92,64' });
      }
    } else {
      // 闲置游荡：挑一个近处点慢慢走
      m.wanderT -= dt;
      if (m.wanderT <= 0) {
        m.wanderT = 1.5 + Math.random() * 2.5;
        const ang = Math.random() * Math.PI * 2, dist = 30 + Math.random() * 60;
        m.wx = m.x + Math.cos(ang) * dist;
        m.wy = m.y + Math.sin(ang) * dist;
      }
      if (m.wx != null) {
        const wx = m.wx - m.x, wy = m.wy - m.y, wd = Math.hypot(wx, wy);
        if (wd < 6) m.wx = null;
        else {
          const sp = T.speed * 0.35 * dt / wd;
          if (this.slide(m, wx * sp, wy * sp) && Math.abs(wx) > 1) m.face = wx > 0 ? 1 : -1;
          m.moving = true;
        }
      }
    }
  },

  // 带地形碰撞的移动（X/Y 轴分开，贴墙滑动）。返回是否实际移动了。
  slide(m, dx, dy) {
    let moved = false;
    if (this.landAt(m.x + dx, m.y, m.r * 0.7)) { m.x += dx; moved = true; }
    if (this.landAt(m.x, m.y + dy, m.r * 0.7)) { m.y += dy; moved = true; }
    return moved;
  },

  // 魂兽只走陆地：水、山、建筑、墙、喷泉都挡
  landAt(x, y, r) {
    const T = CONFIG.TILE;
    const pts = [[x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]];
    for (const [px, py] of pts) {
      const t = World.tileAt(Math.floor(px / T), Math.floor(py / T));
      if (t === TILE_TYPE.WATER || t === TILE_TYPE.MOUNTAIN ||
          t === TILE_TYPE.HOUSE || t === TILE_TYPE.WALL || t === TILE_TYPE.FOUNTAIN) return false;
    }
    return true;
  },

  trySpawn() {
    // 落点环贴着视口椭圆外缘：怪在屏幕外刷出，走过来才入画，不会凭空冒出来
    const hw = innerWidth / 2, hh = innerHeight / 2;
    for (let i = 0; i < 16; i++) {
      const ang = Math.random() * Math.PI * 2;
      const edge = 1 / Math.hypot(Math.cos(ang) / hw, Math.sin(ang) / hh);
      const dist = Math.max(360, edge + 40) + Math.random() * 160;
      const x = Player.x + Math.cos(ang) * dist;
      const y = Player.y + Math.sin(ang) * dist;
      const tx = Math.floor(x / CONFIG.TILE), ty = Math.floor(y / CONFIG.TILE);
      if (!World.inBounds(tx, ty)) continue;
      const t = World.tileAt(tx, ty);
      if (t !== TILE_TYPE.GRASS && t !== TILE_TYPE.FOREST) continue;
      if (World.cityAt(tx, ty)) continue;                    // 城里安全
      if (!this.landAt(x, y, 10)) continue;
      let crowded = false;
      for (const m of this.monsters) {
        if (Math.hypot(m.x - x, m.y - y) < 70) { crowded = true; break; }
      }
      if (crowded) continue;
      // 森林多出狼，草原全是猪
      const type = t === TILE_TYPE.FOREST && Math.random() < 0.65 ? 'wolf' : 'boar';
      this.spawn(type, x, y);
      return;
    }
  },

  spawn(type, x, y) {
    const T = MONSTER_TYPES[type];
    this.monsters.push({
      type, x, y,
      hp: T.hp, maxHp: T.hp,
      face: Math.random() < 0.5 ? 1 : -1,
      aggroed: false, moving: false,
      atkTimer: 0.5 + Math.random() * 0.5,
      root: 0, slowT: 0, slowF: 1, hitFlash: 0,
      wanderT: Math.random() * 2, wx: null, wy: null,
      phase: Math.random() * Math.PI * 2,
      dead: false,
    });
  },

  // ---- 查询 ----

  nearestAlive(x, y, r) {
    let best = null, bd = r;
    for (const m of this.monsters) {
      if (m.dead) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  },

  inRadius(x, y, r) {
    const out = [];
    for (const m of this.monsters) {
      if (!m.dead && Math.hypot(m.x - x, m.y - y) <= r) out.push(m);
    }
    return out;
  },

  knock(m, dx, dy) {
    this.slide(m, dx, dy);
  },

  // ---- 绘制：按 y 与玩家分前后两层（update 里已排好序）----

  drawLayer(time, front) {
    if (!this.active()) return;
    for (const m of this.monsters) {
      if (m.dead) continue;
      if ((m.y > Player.y) !== front) continue;
      this.drawMonster(m, time);
    }
  },

  drawMonster(m, time) {
    const { ctx } = Render;
    const T = MONSTER_TYPES[m.type];
    const sx = m.x - Render.camX, sy = m.y - Render.camY;
    const r = T.r;
    Render.shadow(sx, sy + 8, r * 0.95);

    const bob = m.moving ? Math.sin(time / 90 + m.phase) * 1.6 : 0;
    ctx.save();
    ctx.translate(sx, sy + bob);
    if (m.face < 0) ctx.scale(-1, 1);

    // 身体
    ctx.fillStyle = T.color;
    ctx.beginPath();
    ctx.ellipse(0, -6, r, r * 0.78, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 头（朝向移动方向）
    const hx = r * 0.72, hy = -8;
    ctx.fillStyle = T.color;
    ctx.beginPath();
    ctx.ellipse(hx, hy, r * 0.52, r * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (m.type === 'wolf') {
      // 三角耳 + 尾巴
      ctx.fillStyle = T.color;
      ctx.beginPath();
      ctx.moveTo(hx - 6, hy - r * 0.4); ctx.lineTo(hx - 2, hy - r * 0.95); ctx.lineTo(hx + 2, hy - r * 0.4);
      ctx.moveTo(hx + 3, hy - r * 0.42); ctx.lineTo(hx + 8, hy - r * 0.9); ctx.lineTo(hx + 9, hy - r * 0.3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, -8); ctx.lineTo(-r * 1.25, -13);
      ctx.lineWidth = 2.5; ctx.stroke();
    } else {
      // 猪拱嘴 + 小獠牙
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath();
      ctx.ellipse(hx + r * 0.42, hy + 1, 4, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(hx + 5, hy + 4); ctx.lineTo(hx + 8, hy + 7);
      ctx.moveTo(hx + 1, hy + 4); ctx.lineTo(hx - 1, hy + 7);
      ctx.stroke();
    }

    // 眼睛
    ctx.fillStyle = '#1a1a22';
    ctx.beginPath();
    ctx.arc(hx + 2, hy - 2, 1.6, 0, Math.PI * 2);
    ctx.fill();

    // 受击闪白
    if (m.hitFlash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.8, m.hitFlash * 7)})`;
      ctx.beginPath();
      ctx.ellipse(0, -6, r, r * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 定身：脚下缠一圈蓝银草（三个绿色弧）
    if (m.root > 0) {
      ctx.strokeStyle = 'rgba(126,200,80,.9)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const a0 = time / 300 + i * (Math.PI * 2 / 3);
        ctx.beginPath();
        ctx.arc(sx, sy + 3, r + 2, a0, a0 + 1.5);
        ctx.stroke();
      }
    }
    // 减速：青色脚圈
    if (m.slowT > 0) {
      ctx.strokeStyle = 'rgba(120,200,235,.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(sx, sy + 7, r * 0.9, r * 0.34, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 血条（受伤后才显示）
    if (m.hp < m.maxHp) {
      const w = 28, frac = Math.max(0, m.hp / m.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(sx - w / 2, sy - r - 15, w, 4);
      ctx.fillStyle = `hsl(${100 * frac},62%,46%)`;
      ctx.fillRect(sx - w / 2, sy - r - 15, w * frac, 4);
    }
  },
};
