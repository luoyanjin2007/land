// 渲染：把世界和人物画到画布上（含镜头跟随、小地图、贴图、波光、阴影）

const Render = {
  canvas: null, ctx: null,
  camX: 0, camY: 0,            // 镜头左上角的像素坐标
  miniCanvas: null,            // 全地图小地图（预渲染一次）
  sprites: {},                 // 贴图缓存 name -> Image

  // 各地形的基础色
  COLORS: {
    [TILE_TYPE.WATER]: '#1e5588',
    [TILE_TYPE.SAND]: '#d9c47a',
    [TILE_TYPE.GRASS]: '#5d9e4a',
    [TILE_TYPE.FOREST]: '#4a8a3d',
    [TILE_TYPE.MOUNTAIN]: '#8a8578',
    [TILE_TYPE.ROAD]: '#b8a888',
    [TILE_TYPE.HOUSE]: '#c2743f',
    [TILE_TYPE.WALL]: '#6e6659',
    [TILE_TYPE.PLAZA]: '#c9c2b0',
    [TILE_TYPE.FOUNTAIN]: '#9fc4d8',
  },

  // 需要预加载的贴图（tools/slice.js 切出来的）
  SPRITE_LIST: [
    'player-down-0', 'player-down-1', 'player-down-2', 'player-down-3',
    'player-up-0', 'player-up-1', 'player-up-2', 'player-up-3',
    'player-left-0', 'player-left-1', 'player-left-2', 'player-left-3',
    'player-right-0', 'player-right-1', 'player-right-2', 'player-right-3',
    'house-2', 'pagoda-2', 'fountain', 'tree-2',
    'tile-grass-1', 'tile-grass-2', 'tile-grass-3', 'tile-flower',
    'tile-road', 'tile-plaza', 'tile-sand', 'tile-water', 'tile-forest',
    'tile-wall-top',
  ],

  // 地形 → 地面瓷砖（数组表示随机变体，按坐标哈希选取）
  TILE_IMG: {
    [TILE_TYPE.WATER]: ['tile-water'],
    [TILE_TYPE.SAND]: ['tile-sand'],
    [TILE_TYPE.GRASS]: ['tile-grass-2', 'tile-grass-2', 'tile-grass-2', 'tile-grass-1', 'tile-flower'],
    [TILE_TYPE.FOREST]: ['tile-forest'],
    [TILE_TYPE.ROAD]: ['tile-road'],
    [TILE_TYPE.PLAZA]: ['tile-plaza'],
    [TILE_TYPE.FOUNTAIN]: ['tile-plaza'],
    [TILE_TYPE.HOUSE]: ['tile-grass-2'],
    [TILE_TYPE.WALL]: ['tile-wall-top'],
  },

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    addEventListener('resize', () => this.resize());
    this.loadSprites();
    this.bakeMinimap();
    this.snapCamera();
  },

  // 异步预加载贴图；没加载完时先用色块/emoji 兜底
  loadSprites() {
    for (const name of this.SPRITE_LIST) {
      const img = new Image();
      img.src = `assets/sprites/${name}.png`;
      this.sprites[name] = img;
    }
  },

  resize() {
    this.canvas.width = innerWidth;
    this.canvas.height = innerHeight;
  },

  // 小地图：把 200x200 的世界压成一张小图，只画一次
  bakeMinimap() {
    const c = document.createElement('canvas');
    c.width = CONFIG.MAP_W; c.height = CONFIG.MAP_H;
    const mc = c.getContext('2d');
    for (let y = 0; y < CONFIG.MAP_H; y++) {
      for (let x = 0; x < CONFIG.MAP_W; x++) {
        mc.fillStyle = this.COLORS[World.tiles[y][x]];
        mc.fillRect(x, y, 1, 1);
      }
    }
    this.miniCanvas = c;
  },

  // 开局镜头直接对准人物（不做平滑飞行）
  snapCamera() {
    this.camX = Player.x - this.canvas.width / 2;
    this.camY = Player.y - this.canvas.height / 2;
    this.clampCamera();
  },

  clampCamera() {
    const maxX = CONFIG.MAP_W * CONFIG.TILE - this.canvas.width;
    const maxY = CONFIG.MAP_H * CONFIG.TILE - this.canvas.height;
    this.camX = Math.max(0, Math.min(maxX, this.camX));
    this.camY = Math.max(0, Math.min(maxY, this.camY));
  },

  // 每帧：镜头平滑跟随人物
  updateCamera(dt) {
    const targetX = Player.x - this.canvas.width / 2;
    const targetY = Player.y - this.canvas.height / 2;
    const k = 1 - Math.pow(0.001, dt);
    this.camX += (targetX - this.camX) * k;
    this.camY += (targetY - this.camY) * k;
    this.clampCamera();
  },

  draw(time) {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#0a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 只画镜头可见范围内的格子
    const x0 = Math.max(0, Math.floor(this.camX / CONFIG.TILE));
    const y0 = Math.max(0, Math.floor(this.camY / CONFIG.TILE));
    const x1 = Math.min(CONFIG.MAP_W, Math.ceil((this.camX + canvas.width) / CONFIG.TILE));
    const y1 = Math.min(CONFIG.MAP_H, Math.ceil((this.camY + canvas.height) / CONFIG.TILE));

    // 第一遍：画地面（草/沙/路/水/广场等平面元素）
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        this.drawGround(x, y, time);
      }
    }
    // 1.5 遍：水面特效层（云朵倒影 + 水面涟漪，裁剪在水格内）+ 雨滴溅起的水珠
    Effects.drawWaterFX(x0, y0, x1, y1, time);
    Effects.drawSplashes();
    // 第二遍：画立起来的建筑/树（保证树冠能盖住上一行的地面）
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        this.drawProps(x, y);
      }
    }
    // 第三遍：人物（最上层）
    this.drawPlayer(time);

    // 雨丝（屏幕空间，盖在最上面）
    Effects.drawRain();

    this.drawMinimap();
    this.drawHUD();
  },

  // 坐标哈希：同一个格子永远得到同一个随机数（确定性随机）
  hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177 | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  },

  drawGround(x, y, time) {
    const { ctx } = this;
    const t = World.tiles[y][x];
    const sx = x * CONFIG.TILE - this.camX;
    const sy = y * CONFIG.TILE - this.camY;
    const jitter = ((x * 7 + y * 13) % 5) * 2 - 4;
    // 底色先铺（贴图未加载时的兜底）
    ctx.fillStyle = this.shade(this.COLORS[t], jitter);
    ctx.fillRect(sx, sy, CONFIG.TILE, CONFIG.TILE);

    // 铺 AI 瓷砖：同一格永远用同一张变体
    const imgs = this.TILE_IMG[t];
    if (imgs) {
      const name = imgs[Math.floor(this.hash(x, y) * imgs.length)];
      this.blitTile(name, sx, sy);
    }

    if (t === TILE_TYPE.WATER) {
      // 波光：亮度随时间正弦流动
      const wave = Math.sin(time / 600 + x * 0.8 + y * 1.3) * 6;
      ctx.fillStyle = `rgba(255,255,255,${0.05 + Math.max(0, wave) * 0.012})`;
      ctx.fillRect(sx, sy, CONFIG.TILE, CONFIG.TILE);
      // 岸线：挨着陆地的边画一道浅色泡沫
      ctx.fillStyle = 'rgba(220,240,255,.45)';
      if (World.tileAt(x, y - 1) !== TILE_TYPE.WATER) ctx.fillRect(sx, sy, CONFIG.TILE, 3);
      if (World.tileAt(x, y + 1) !== TILE_TYPE.WATER) ctx.fillRect(sx, sy + CONFIG.TILE - 3, CONFIG.TILE, 3);
      if (World.tileAt(x - 1, y) !== TILE_TYPE.WATER) ctx.fillRect(sx, sy, 3, CONFIG.TILE);
      if (World.tileAt(x + 1, y) !== TILE_TYPE.WATER) ctx.fillRect(sx + CONFIG.TILE - 3, sy, 3, CONFIG.TILE);
    }
    else if (t === TILE_TYPE.MOUNTAIN) {
      // 山体：深色棱线营造起伏
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath();
      ctx.moveTo(sx + 4, sy + CONFIG.TILE - 4);
      ctx.lineTo(sx + CONFIG.TILE / 2 + jitter, sy + 6);
      ctx.lineTo(sx + CONFIG.TILE - 4, sy + CONFIG.TILE - 4);
      ctx.closePath();
      ctx.fill();
    }
  },

  // 满格铺瓷砖贴图（加载失败时静默跳过，露出底色）
  blitTile(name, sx, sy) {
    const img = this.sprites[name];
    if (img && img.complete && img.naturalWidth) {
      this.ctx.drawImage(img, sx, sy, CONFIG.TILE, CONFIG.TILE);
    }
  },

  // 建筑与树木：贴图锚定在格子底部中央，比格子略大，制造高度感
  drawProps(x, y) {
    const { ctx } = this;
    const t = World.tiles[y][x];
    const sx = x * CONFIG.TILE - this.camX;
    const sy = y * CONFIG.TILE - this.camY;
    const cx = sx + CONFIG.TILE / 2;
    const by = sy + CONFIG.TILE; // 格子底边

    if (t === TILE_TYPE.FOREST) {
      // 树的大小带确定性抖动，森林更自然
      const size = 30 + this.hash(x, y) * 12;
      this.shadow(cx, by - 3, size * 0.3);
      this.blit('tree-2', cx, by - 2, size * 0.8, size);
    }
    else if (t === TILE_TYPE.HOUSE) {
      // 少数房子画成中式木楼，其余是白墙红瓦小屋
      const isPagoda = this.hash(x, y) > 0.86;
      this.shadow(cx, by - 2, 14);
      if (isPagoda) this.blit('pagoda-2', cx, by - 2, 42, 46);
      else this.blit('house-2', cx, by - 2, 42, 42);
    }
    else if (t === TILE_TYPE.FOUNTAIN) {
      this.blit('fountain', cx, by - 2, 40, 40);
    }
  },

  drawPlayer(time) {
    const { ctx } = this;
    // 四方向贴图：朝向-帧号；静止用 0 号站立帧，行走循环 1~3 帧
    let name;
    if (!Player.moving) {
      name = `player-${Player.facing}-0`;
    } else {
      const frame = 1 + (Math.floor(time / 130) % 3);
      name = `player-${Player.facing}-${frame}`;
    }
    const img = this.sprites[name];

    // 影子
    this.shadow(Player.x - this.camX, Player.y - this.camY + 12, 9);

    const h = 40, w = img && img.naturalWidth ? h * img.naturalWidth / img.naturalHeight : 24;
    ctx.save();
    ctx.translate(Player.x - this.camX, Player.y - this.camY + 20 - h / 2);
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // 贴图未就绪的兜底
      ctx.font = '26px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🧍', 0, 0);
    }
    ctx.restore();
  },

  // 画椭圆影子
  shadow(cx, cy, r) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  },

  // 按名字画贴图：以 (cx, bottom) 为锚点，缩放到指定大小
  blit(name, cx, bottom, w, h) {
    const img = this.sprites[name];
    if (img && img.complete && img.naturalWidth) {
      this.ctx.drawImage(img, cx - w / 2, bottom - h, w, h);
    }
  },

  // 左上角小地图：全貌 + 人物位置红点
  drawMinimap() {
    const size = 160;
    const pad = 10;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.miniCanvas, pad, pad, size, size);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, pad + 0.5, size, size);
    const mx = pad + (Player.x / (CONFIG.MAP_W * CONFIG.TILE)) * size;
    const my = pad + (Player.y / (CONFIG.MAP_H * CONFIG.TILE)) * size;
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.arc(mx, my, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  drawHUD() {
    const { ctx } = this;
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    const city = World.cityAt(Player.tileX(), Player.tileY());
    ctx.fillText(
      `位置 (${Player.tileX()}, ${Player.tileY()})  ` +
      (city ? `🏘️ ${city}  ` : '') +
      `${Input.running() ? '🏃奔跑中' : '🚶步行'}  Shift 加速`,
      180, 24
    );
  },

  // 颜色明暗调整
  shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
    const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
    return `rgb(${r},${g},${b})`;
  },
};
