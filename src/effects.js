// 天气与水面特效：云朵倒影、雨天、涟漪
// 思路（来自用户描述的雨天水洼倒影效果）：
//   1. 水面基色加深（render.js 的 COLORS）
//   2. 生成一张天空云朵图，低透明度、缓慢漂移地叠在水面上（= 天空的倒影）
//   3. 雨天：屏幕空间雨丝 + 水面随机涟漪圈
//   4. 玩家走近水边：水面荡开涟漪圈

const Effects = {
  cloudCanvas: null,     // 程序生成的备用云朵图（可平铺）
  skyImg: null,          // AI 生成的天空云层贴图（优先使用）
  maskCanvas: null,      // 离屏画布：先把水面区域抠出来，再把云"印"进去
  ripples: [],           // 涟漪池 {x, y, t, life, max}（世界像素坐标）
  streaks: [],           // 雨丝（屏幕坐标）
  rainTimer: 0,          // 涟漪生成计时器
  walkTimer: 0,          // 玩家脚步涟漪计时器

  init() {
    // ---- 云朵图：画一堆柔边白色椭圆，九宫格偏移绘制实现无缝平铺 ----
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    for (let i = 0; i < 55; i++) {
      const bx = Math.random() * S, by = Math.random() * S;
      const rx = 40 + Math.random() * 110;
      const ry = rx * (0.35 + Math.random() * 0.4);
      const rot = Math.random() * Math.PI;
      const a = 0.16 + Math.random() * 0.2;
      g.fillStyle = `rgba(235,245,255,${a})`;
      // 每朵云 2~3 层嵌套椭圆，做出柔边层次
      for (const scale of [1, 0.6, 0.3]) {
        for (const dx of [-S, 0, S]) {
          for (const dy of [-S, 0, S]) {
            g.beginPath();
            g.ellipse(bx + dx, by + dy, rx * scale, ry * scale, rot, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
    }
    this.cloudCanvas = c;

    // ---- AI 天空贴图：加载成功后替代程序云朵 ----
    const sky = new Image();
    sky.src = 'assets/天空云影-裁剪.jpeg';
    this.skyImg = sky;

    // ---- 水面蒙版画布（屏幕大小）----
    const m = document.createElement('canvas');
    m.width = innerWidth; m.height = innerHeight;
    this.maskCanvas = m;
    const f = document.createElement('canvas');
    f.width = innerWidth; f.height = innerHeight;
    this.fxCanvas = f;   // 特效层：云影/天空色调/涟漪画在这，最后用蒙版裁剪
    addEventListener('resize', () => {
      this.maskCanvas.width = innerWidth;
      this.maskCanvas.height = innerHeight;
      this.fxCanvas.width = innerWidth;
      this.fxCanvas.height = innerHeight;
    });
  },

  // 天气：用慢正弦模拟 晴 → 雨 → 晴 的循环（约 100 秒一轮）
  rainLevel(time) {
    const v = Math.sin((time / 1000 / 100) * Math.PI * 2);
    return Math.max(0, v - 0.3) / 0.7; // 0=完全无雨，1=大雨
  },

  // 每帧更新：涟漪池、雨丝池
  update(dt, time) {
    const level = this.rainLevel(time);

    // ---- 雨天随机涟漪：落在镜头附近的随机点上（水面的大圈，地面的小圈）----
    this.rainTimer -= dt;
    if (level > 0.05 && this.rainTimer <= 0) {
      this.rainTimer = 0.05;
      const n = Math.ceil(level * 3);
      for (let i = 0; i < n; i++) {
        const wx = Render.camX + Math.random() * innerWidth;
        const wy = Render.camY + Math.random() * innerHeight;
        const tx = Math.floor(wx / CONFIG.TILE), ty = Math.floor(wy / CONFIG.TILE);
        const isWater = World.tileAt(tx, ty) === TILE_TYPE.WATER;
        // 地面涟漪小而稀，水面涟漪大而密
        if (isWater) this.spawnRipple(wx, wy, 14, 1.1);
        else if (Math.random() < level * 0.25) this.spawnRipple(wx, wy, 5, 0.5);
      }
    }

    // ---- 玩家脚步涟漪：贴着水边走动时，旁边的水面荡开 ----
    if (Player.moving) {
      this.walkTimer -= dt;
      if (this.walkTimer <= 0) {
        this.walkTimer = 0.22;
        const pt = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const wet = [];
        for (const [dx, dy] of pt) {
          const tx = Player.tileX() + dx, ty = Player.tileY() + dy;
          if (World.tileAt(tx, ty) === TILE_TYPE.WATER) {
            wet.push([(tx + 0.5) * CONFIG.TILE, (ty + 0.5) * CONFIG.TILE]);
          }
        }
        if (wet.length) {
          const [rx, ry] = wet[Math.floor(Math.random() * wet.length)];
          this.spawnRipple(rx, ry, 10, 0.9);
        }
      }
    }

    // ---- 涟漪池推进与回收 ----
    for (const r of this.ripples) r.t += dt;
    this.ripples = this.ripples.filter(r => r.t < r.life);

    // ---- 雨丝池：数量随雨量增减 ----
    const want = Math.floor(level * 130);
    while (this.streaks.length < want) {
      this.streaks.push({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        len: 10 + Math.random() * 14,
        speed: 620 + Math.random() * 260,
        drift: 60 + Math.random() * 40, // 斜着落
      });
    }
    if (this.streaks.length > want) this.streaks.length = want;
    for (const s of this.streaks) {
      s.y += s.speed * dt;
      s.x += s.drift * dt;
      if (s.y > innerHeight + 20) { s.y = -20; s.x = Math.random() * innerWidth; }
      if (s.x > innerWidth + 20) s.x = -20;
    }
  },

  spawnRipple(wx, wy, max, life) {
    // 池上限防爆
    if (this.ripples.length > 260) this.ripples.shift();
    this.ripples.push({ x: wx, y: wy, t: 0, life, max });
  },

  // 水面特效层：云朵倒影 + 涟漪，都裁剪在水格内
  // 在地面层之后、建筑层之前调用
  drawWaterFX(x0, y0, x1, y1, time) {
    const { ctx } = Render;

    // 1. 蒙版层：把可见的水格填成不透明形状（只当裁剪用）
    const mask = this.maskCanvas.getContext('2d');
    mask.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    mask.fillStyle = '#fff';
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (World.tiles[y][x] !== TILE_TYPE.WATER) continue;
        mask.fillRect(
          x * CONFIG.TILE - Render.camX,
          y * CONFIG.TILE - Render.camY,
          CONFIG.TILE, CONFIG.TILE
        );
      }
    }

    // 2. 特效层：漂移的天空倒影（AI 天空贴图优先，程序云朵兜底）
    //    倒影锚定世界坐标：屏幕点 S 看到的纹理坐标 = 世界坐标 W + 时间漂移
    //    → 绘制偏移 = -(camX + t)，人走过去云影留在原地
    const fx = this.fxCanvas.getContext('2d');
    fx.clearRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
    const T = 1024; // 贴图平铺尺寸
    const bx = -((((Render.camX + time * 0.02) % T) + T) % T) ;           // ∈ (-T, 0]
    const by = -((((Render.camY + time * 0.013) % T) + T) % T);           // ∈ (-T, 0]
    const sky = this.skyImg;
    if (sky && sky.complete && sky.naturalWidth) {
      // AI 天空贴图：半透明铺在水面 = 天空倒影，水面纹理隐约透出
      fx.globalAlpha = 0.68;
      for (let ox = 0; ox <= 2; ox++) {
        for (let oy = 0; oy <= 2; oy++) {
          fx.drawImage(sky, bx + ox * T, by + oy * T);
        }
      }
      fx.globalAlpha = 1;
    } else {
      for (let ox = 0; ox <= 2; ox++) {
        for (let oy = 0; oy <= 2; oy++) {
          fx.drawImage(this.cloudCanvas, bx + ox * T, by + oy * T);
        }
      }
      fx.fillStyle = 'rgba(150,205,255,.28)';
      fx.fillRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
    }

    // 3. 涟漪圈画进特效层
    fx.strokeStyle = 'rgba(235,245,255,1)';
    for (const r of this.ripples) {
      const p = r.t / r.life;
      const sx = r.x - Render.camX, sy = r.y - Render.camY;
      fx.globalAlpha = (1 - p) * 0.55;
      fx.beginPath();
      fx.ellipse(sx, sy, r.max * p + 1, (r.max * p + 1) * 0.55, 0, 0, Math.PI * 2);
      fx.stroke();
    }
    fx.globalAlpha = 1;

    // 4. 用蒙版裁剪特效层：特效只留在水格范围内
    fx.globalCompositeOperation = 'destination-in';
    fx.drawImage(this.maskCanvas, 0, 0);
    fx.globalCompositeOperation = 'source-over';

    // 5. 特效层贴回主画布
    ctx.drawImage(this.fxCanvas, 0, 0);
  },

  // 雨丝层：屏幕空间，最后画（在人物之上，营造"雨在眼前落"）
  drawRain() {
    if (!this.streaks.length) return;
    const { ctx } = Render;
    ctx.save();
    ctx.strokeStyle = 'rgba(200,225,255,.38)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const s of this.streaks) {
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.drift * (s.len / s.speed), s.y - s.len);
    }
    ctx.stroke();
    ctx.restore();
  },
};
