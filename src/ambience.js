// 环境小生命：惊飞的鸟、飘落的叶、夜晚的萤火虫、昼夜循环
const Ambience = {
  birds: [],            // {x, y, vx, vy, t, life, phase}（世界坐标）
  leaves: [],           // {x, y, vy, t, life, sway, size, col}
  flies: [],            // 萤火虫 {x, y, phase}
  leafTimer: 0,
  flyTimer: 0,
  scareCd: new Map(),   // 每棵树的惊鸟冷却

  // 目前所有状态都是懒加载，无需初始化；保留方法以统一各模块的启动协议
  init() {},

  // 昼夜循环（约 4 分钟一轮）：0 = 白天正午，1 = 深夜
  nightLevel(time) {
    const s = Math.sin((time / 1000 / 240) * Math.PI * 2);
    return Math.max(0, s);
  },

  update(dt, time) {
    const night = this.nightLevel(time);

    // ---- 落叶：视野内随机森林格飘落叶子 ----
    this.leafTimer -= dt;
    if (this.leafTimer <= 0) {
      this.leafTimer = 0.22;
      const wx = Render.camX + Math.random() * innerWidth;
      const wy = Render.camY + Math.random() * innerHeight;
      const tx = Math.floor(wx / CONFIG.TILE), ty = Math.floor(wy / CONFIG.TILE);
      if (World.tileAt(tx, ty) === TILE_TYPE.FOREST) {
        this.leaves.push({
          x: wx, y: wy - 26 - Math.random() * 34,
          vy: 24 + Math.random() * 20, t: 0, life: 2.4,
          sway: Math.random() * 6.28,
          size: 3 + Math.random() * 2,
          col: Math.random() < 0.35 ? '215,145,55' : '150,200,90',
        });
      }
    }
    for (const l of this.leaves) {
      l.t += dt;
      l.y += l.vy * dt;
      l.x += Math.sin(time / 420 + l.sway) * 22 * dt;
    }
    this.leaves = this.leaves.filter(l => l.t < l.life);
    if (this.leaves.length > 46) this.leaves.splice(0, this.leaves.length - 46);

    // ---- 鸟群运动 ----
    for (const b of this.birds) {
      b.t += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vy += 8 * dt;   // 渐渐趋于平飞
    }
    this.birds = this.birds.filter(b => b.t < b.life);

    // ---- 萤火虫：夜晚维持一小群，白天淡出 ----
    const want = Math.floor(night * 22);
    this.flyTimer -= dt;
    if (this.flies.length < want && this.flyTimer <= 0) {
      this.flyTimer = 0.25;
      const wx = Render.camX + Math.random() * innerWidth;
      const wy = Render.camY + Math.random() * innerHeight;
      const tx = Math.floor(wx / CONFIG.TILE), ty = Math.floor(wy / CONFIG.TILE);
      const t = World.tileAt(tx, ty);
      if (t !== TILE_TYPE.WATER && t !== TILE_TYPE.MOUNTAIN) {
        this.flies.push({ x: wx, y: wy, phase: Math.random() * 6.28 });
      }
    }
    for (const f of this.flies) {
      f.x += Math.sin(time / 800 + f.phase) * 11 * dt;
      f.y += Math.cos(time / 650 + f.phase * 1.7) * 8 * dt;
    }
    // 漂出镜头视野的萤火虫移除 → 让生成器持续在玩家附近补充（整夜可见）
    const ccx = Render.camX + innerWidth / 2, ccy = Render.camY + innerHeight / 2;
    this.flies = this.flies.filter(f =>
      Math.abs(f.x - ccx) < innerWidth * 0.75 &&
      Math.abs(f.y - ccy) < innerHeight * 0.75);
    if (night < 0.15 && this.flies.length) this.flies.length = Math.max(0, this.flies.length - 2);
  },

  // 人物靠近树时惊飞一群鸟（drawTrees 里调用，带每树冷却）
  tryScare(wx, wy, pdx, time) {
    const key = wx + ',' + wy;
    const last = this.scareCd.get(key) || -99999;
    if (time - last < 9000) return;
    this.scareCd.set(key, time);
    const dir = pdx > 0 ? -1 : 1;   // 朝远离人物的方向飞
    const n = 2 + Math.floor(Math.random() * 2);
    const bx = wx * CONFIG.TILE + CONFIG.TILE / 2;
    const by = wy * CONFIG.TILE + 6;
    for (let i = 0; i < n; i++) {
      this.birds.push({
        x: bx + (i - 1) * 6, y: by + Math.random() * 5,
        vx: dir * (58 + Math.random() * 46) + (Math.random() - 0.5) * 26,
        vy: -44 - Math.random() * 30,
        t: 0, life: 2.4, phase: Math.random() * 6.28,
      });
    }
    if (this.birds.length > 60) this.birds.splice(0, this.birds.length - 60);
  },

  // 绘制（在树之后、人物之前调用）
  draw(time) {
    const { ctx } = Render;

    // 落叶（小方块带旋转）
    for (const l of this.leaves) {
      const a = Math.min(1, (1 - l.t / l.life) * 2);
      ctx.save();
      ctx.translate(l.x - Render.camX, l.y - Render.camY);
      ctx.rotate(l.t * 3 + l.sway);
      ctx.fillStyle = `rgba(${l.col},${a})`;
      ctx.fillRect(-l.size / 2, -l.size / 2, l.size, l.size * 0.6);
      ctx.restore();
    }

    // 鸟（两笔翅膀，扑扇）
    for (const b of this.birds) {
      const p = b.t / b.life;
      const a = p < 0.12 ? p / 0.12 : 1 - ((p - 0.12) / 0.88) * 0.7;
      const flap = Math.sin(b.t * 24 + b.phase) * 2.6;
      ctx.strokeStyle = `rgba(42,42,54,${a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(b.x - Render.camX - 3.2, b.y - Render.camY + flap * 0.4);
      ctx.quadraticCurveTo(b.x - Render.camX, b.y - Render.camY - 2.5 - flap * 0.4,
                           b.x - Render.camX + 3.2, b.y - Render.camY + flap * 0.4);
      ctx.stroke();
    }

    // 萤火虫（夜晚，脉动的光点）
    const night = this.nightLevel(time);
    for (const f of this.flies) {
      const a = night * (0.35 + 0.65 * Math.abs(Math.sin(time / 640 + f.phase)));
      const sx = f.x - Render.camX, sy = f.y - Render.camY;
      ctx.fillStyle = `rgba(190,255,130,${a * 0.4})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(220,255,150,${a})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};
