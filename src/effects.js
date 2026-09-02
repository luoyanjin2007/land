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

    // ---- 雨天随机涟漪：落在镜头附近的随机点上（水面的大圈，地面的溅落）----
    this.rainTimer -= dt;
    if (level > 0.05 && this.rainTimer <= 0) {
      this.rainTimer = 0.05;
      const n = Math.ceil(level * 4);
      for (let i = 0; i < n; i++) {
        const wx = Render.camX + Math.random() * innerWidth;
        const wy = Render.camY + Math.random() * innerHeight;
        const tx = Math.floor(wx / CONFIG.TILE), ty = Math.floor(wy / CONFIG.TILE);
        const isWater = World.tileAt(tx, ty) === TILE_TYPE.WATER;
        if (isWater) this.spawnRipple(wx, wy, 14, 1.1, false);
        else this.spawnRipple(wx, wy, 7, 0.45, true); // 陆地：只有水珠溅起
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

  // 把天空贴图四边做渐隐处理（预渲染一次）：边缘 alpha 降到 0，平铺无缝
  buildFeatheredSky() {
    const T = 1024, F = 150; // F = 渐隐带宽度
    const c = document.createElement('canvas');
    c.width = c.height = T;
    const g = c.getContext('2d');
    g.drawImage(this.skyImg, 0, 0, T, T);
    g.globalCompositeOperation = 'destination-in';
    // 横向渐隐
    let grad = g.createLinearGradient(0, 0, T, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(F / T, 'rgba(0,0,0,1)');
    grad.addColorStop(1 - F / T, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, T, T);
    // 纵向渐隐
    grad = g.createLinearGradient(0, 0, 0, T);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(F / T, 'rgba(0,0,0,1)');
    grad.addColorStop(1 - F / T, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, T, T);
    g.globalCompositeOperation = 'source-over';
    this.skyFeather = c;
  },

  // 把羽化天空贴图预拼成 3×3 大图（每帧只需一次源矩形绘制，性能优化）
  buildSkyTiled() {
    if (!this.skyFeather) this.buildFeatheredSky();
    const T = 1024;
    const c = document.createElement('canvas');
    c.width = T * 3; c.height = T * 3;
    const g = c.getContext('2d');
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        g.drawImage(this.skyFeather, i * T, j * T);
      }
    }
    this.skyTiled = c;
  },

  // opts: noDrop=不画水珠弹起（纯涟漪圈），noRing=不画涟漪圈（纯水珠）
  spawnRipple(wx, wy, max, life, land, alpha = 0.55, opts = {}) {    // 池上限防爆
    if (this.ripples.length > 320) this.ripples.shift();
    this.ripples.push({ x: wx, y: wy, t: 0, life, max, land: !!land, a: alpha,
                        noDrop: !!opts.noDrop, noRing: !!opts.noRing });
  },

  // 雨滴溅起的水珠：直接画在主画布上（不经过水面裁剪层），陆地上也可见
  // 只画弹起的水珠；涟漪圈是水面专属，在 fx 裁剪层里画
  drawSplashes() {
    const { ctx } = Render;
    ctx.save();
    for (const r of this.ripples) {
      if (r.noDrop) continue; // 纯尾流圈不产生水花
      const p = r.t / r.life;
      if (p >= 0.35) continue; // 后段交给涟漪圈
      const q = p / 0.35;
      const sx = r.x - Render.camX, sy = r.y - Render.camY;
      ctx.fillStyle = `rgba(235,248,255,${0.9 * (1 - q)})`;
      ctx.beginPath();
      ctx.arc(sx, sy - 5 * Math.sin(q * Math.PI), 2.4 * (1 - q * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  },

  // 水面特效层：云朵倒影 + 涟漪，都裁剪在水格内
  // 参数是可见的 chunk 范围（蒙版由 chunk 缓存拼装，性能优化）
  drawWaterFX(cx0, cy0, cx1, cy1, time) {
    const { ctx, canvas } = Render;
    const S = CONFIG.CHUNK_PX;

    // 1. 蒙版层：可见 chunk 的水格形状拼贴（每帧十几次 blit，替代上千次 fillRect）
    const mask = this.maskCanvas.getContext('2d');
    mask.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        mask.drawImage(Render.getWaterMask(cx, cy), cx * S - Render.camX, cy * S - Render.camY);
      }
    }

    // 2. 特效层：漂移的天空倒影（AI 天空贴图优先，程序云朵兜底）
    //    倒影锚定世界坐标：屏幕点 S 看到的纹理坐标 = 世界坐标 W + 时间漂移
    //    → 源矩形偏移 = +(camX + t)（mod 平铺尺寸），人走过去云影留在原地
    const fx = this.fxCanvas.getContext('2d');
    fx.clearRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
    const T = 1024; // 贴图平铺尺寸
    const sx = (((Render.camX + time * 0.02) % T) + T) % T;
    const sy = (((Render.camY + time * 0.013) % T) + T) % T;
    const sky = this.skyImg;
    if (sky && sky.complete && sky.naturalWidth) {
      // AI 天空贴图：四边羽化 + 预拼成大图，单次源矩形绘制（性能优）
      if (!this.skyTiled) this.buildSkyTiled();
      fx.globalAlpha = 0.68;
      fx.drawImage(
        this.skyTiled,
        sx, sy, Math.min(canvas.width, this.skyTiled.width - sx), Math.min(canvas.height, this.skyTiled.height - sy),
        0, 0, Math.min(canvas.width, this.skyTiled.width - sx), Math.min(canvas.height, this.skyTiled.height - sy)
      );
      fx.globalAlpha = 1;
    } else {
      // 程序云朵兜底：3×3 平铺
      const bx = -sx, by = -sy;
      for (let ox = 0; ox <= 2; ox++) {
        for (let oy = 0; oy <= 2; oy++) {
          fx.drawImage(this.cloudCanvas, bx + ox * T, by + oy * T);
        }
      }
      fx.fillStyle = 'rgba(150,205,255,.28)';
      fx.fillRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
    }

    // 3. 涟漪圈画进特效层：水面专属（陆地只有水珠，没有波纹）
    //    前段 0~0.35 是水珠弹起（直绘层负责），这里只画落地后的圈
    //    扩散用 ease-out（先猛扩散再减速）——符合真实水波：
    //    人游远了，身后的波纹也已经大幅扩散开，不会僵在原地
    fx.strokeStyle = 'rgba(235,245,255,1)';
    for (const r of this.ripples) {
      if (r.land) continue;
      const p = r.t / r.life;
      if (p < 0.35) continue;
      const q = (p - 0.35) / 0.65;
      const ease = 1 - (1 - q) * (1 - q); // 先快后慢
      const rad = r.max * (0.35 + 0.65 * ease) + 1;
      const px = r.x - Render.camX, py = r.y - Render.camY;
      fx.globalAlpha = (1 - q) * (r.a || 0.55);
      fx.beginPath();
      fx.ellipse(px, py, rad, rad * 0.55, 0, 0, Math.PI * 2);
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
