// 渲染：分块缓存渲染（静态地形/建筑预渲染成 chunk，动态层单独画）
//
// 性能设计：
//   - 地面 + 建筑 + 水格静态外观 → 16×16 格的 chunk 画布，只渲染一次，按需缓存
//   - 水格形状（蒙版用）同样按 chunk 缓存
//   - 每帧动态的只有：云影/涟漪（特效层）、水珠溅落、人物、雨丝、HUD
//   - 缓存有上限，走远后自动淘汰重建

const Render = {
  canvas: null, ctx: null,
  camX: 0, camY: 0,
  miniCanvas: null,
  sprites: {},                 // 贴图缓存 name -> Image
  chunkCache: new Map(),       // 地形 chunk 缓存 "cx,cy" -> canvas
  maskCache: new Map(),        // 水格形状缓存 "cx,cy" -> canvas

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
    [TILE_TYPE.PATH]: '#c2a575',
  },

  SPRITE_LIST: [
    'player-down-0', 'player-down-1', 'player-down-2', 'player-down-3',
    'player-up-0', 'player-up-1', 'player-up-2', 'player-up-3',
    'player-left-0', 'player-left-1', 'player-left-2', 'player-left-3',
    'player-right-0', 'player-right-1', 'player-right-2', 'player-right-3',
    'player-swim-0', 'player-swim-1', 'player-swim-2', 'player-swim-3',
    'player-swim-up-0', 'player-swim-up-1', 'player-swim-up-2', 'player-swim-up-3',
    'player-swim-down-0', 'player-swim-down-1', 'player-swim-down-2', 'player-swim-down-3',
    'house-2', 'pagoda-2', 'fountain', 'tree-2',
    'tile-grass-1', 'tile-grass-2', 'tile-grass-3', 'tile-flower',
    'tile-road', 'tile-plaza', 'tile-sand', 'tile-water', 'tile-forest',
    'tile-wall-top',
  ],

  TILE_IMG: {
    [TILE_TYPE.WATER]: ['tile-water'],
    [TILE_TYPE.SAND]: ['tile-sand'],
    [TILE_TYPE.GRASS]: ['tile-grass-2', 'tile-grass-2', 'tile-grass-2', 'tile-grass-1', 'tile-flower'],
    [TILE_TYPE.FOREST]: ['tile-forest'],
    [TILE_TYPE.ROAD]: ['tile-road'],
    [TILE_TYPE.PATH]: ['tile-dirt', 'tile-dirt', 'tile-gravel'],
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
    this.buildBridgeTile();
    this.bakeMinimap();
    this.snapCamera();
  },

  // 程序化木桥贴图：棕色木板 + 板缝 + 木纹高光
  buildBridgeTile() {
    const c = document.createElement('canvas');
    c.width = c.height = CONFIG.TILE;
    const g = c.getContext('2d');
    g.fillStyle = '#8a5a33';
    g.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = '#7a4c2a';
      g.fillRect(0, i * 8, 32, 6);
      g.fillStyle = 'rgba(255,220,160,.16)';
      g.fillRect(0, i * 8, 32, 2);
    }
    g.fillStyle = '#6b3f22';
    for (let i = 0; i < 5; i++) g.fillRect(i * 7 + 2, 0, 2, 32);
    this.sprites['tile-bridge'] = c;   // canvas 可直接用于 drawImage
  },

  loadSprites() {
    for (const name of this.SPRITE_LIST) {
      const img = new Image();
      img.src = `assets/sprites/${name}.png`;
      this.sprites[name] = img;
    }
  },

  // 所有贴图就绪后才允许渲染（否则会把残缺画面烤进 chunk 缓存）
  spritesReady() {
    return this.SPRITE_LIST.every(n => {
      const img = this.sprites[n];
      return img && img.complete && img.naturalWidth > 0;
    });
  },

  resize() {
    this.canvas.width = innerWidth;
    this.canvas.height = innerHeight;
  },

  // 小地图：抽样渲染整个世界（每 2 格采 1 像素 → 400×400，只画一次）
  bakeMinimap() {
    const STEP = 1;
    const c = document.createElement('canvas');
    c.width = Math.ceil(CONFIG.WORLD_W / STEP);
    c.height = Math.ceil(CONFIG.WORLD_H / STEP);
    const mc = c.getContext('2d');
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        mc.fillStyle = this.COLORS[World.tileAt(x * STEP, y * STEP)];
        mc.fillRect(x, y, 1, 1);
      }
    }
    this.miniCanvas = c;
  },

  // 小地图的迷雾缓存（未探索区域不显示）——实际内容在 WorldMap.fogMini
  foggedMini() {
    return (typeof WorldMap !== 'undefined' && WorldMap.fogMini) ? WorldMap.fogMini : this.miniCanvas;
  },

  snapCamera() {
    this.camX = Player.x - this.canvas.width / 2;
    this.camY = Player.y - this.canvas.height / 2;
    this.clampCamera();
  },

  clampCamera() {
    const maxX = CONFIG.WORLD_W * CONFIG.TILE - this.canvas.width;
    const maxY = CONFIG.WORLD_H * CONFIG.TILE - this.canvas.height;
    this.camX = Math.max(0, Math.min(maxX, this.camX));
    this.camY = Math.max(0, Math.min(maxY, this.camY));
  },

  updateCamera(dt) {
    const targetX = Player.x - this.canvas.width / 2;
    const targetY = Player.y - this.canvas.height / 2;
    const k = 1 - Math.pow(0.001, dt);
    this.camX += (targetX - this.camX) * k;
    this.camY += (targetY - this.camY) * k;
    this.clampCamera();
  },

  // ---------- chunk 缓存 ----------

  key(cx, cy) { return cx + ',' + cy; },

  // 淘汰离当前镜头太远的缓存，控制内存
  evictFar(map, ccx, ccy, keep = 5) {
    if (map.size <= 60) return;
    for (const k of map.keys()) {
      const [cx, cy] = k.split(',').map(Number);
      if (Math.abs(cx - ccx) > keep || Math.abs(cy - ccy) > keep) map.delete(k);
    }
  },

  // 取（或渲染）一个 16×16 格的静态地形 chunk
  getChunk(cx, cy) {
    const k = this.key(cx, cy);
    let c = this.chunkCache.get(k);
    if (c) return c;
    c = document.createElement('canvas');
    const S = CONFIG.CHUNK_PX;
    c.width = c.height = S;
    const g = c.getContext('2d');
    for (let y = 0; y < CONFIG.CHUNK_TILES; y++) {
      for (let x = 0; x < CONFIG.CHUNK_TILES; x++) {
        const wx = cx * CONFIG.CHUNK_TILES + x, wy = cy * CONFIG.CHUNK_TILES + y;
        if (!World.inBounds(wx, wy)) continue;
        const sx = x * CONFIG.TILE, sy = y * CONFIG.TILE;
        this.drawGroundInto(g, wx, wy, sx, sy);
        this.drawPropsInto(g, wx, wy, sx, sy);
      }
    }
    this.evictFar(this.chunkCache, cx, cy);
    this.chunkCache.set(k, c);
    return c;
  },

  // 取（或渲染）一个 chunk 的水格形状（白色 = 水），供特效层裁剪
  getWaterMask(cx, cy) {
    const k = this.key(cx, cy);
    let c = this.maskCache.get(k);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = CONFIG.CHUNK_PX;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    for (let y = 0; y < CONFIG.CHUNK_TILES; y++) {
      for (let x = 0; x < CONFIG.CHUNK_TILES; x++) {
        const wx = cx * CONFIG.CHUNK_TILES + x, wy = cy * CONFIG.CHUNK_TILES + y;
        if (World.inBounds(wx, wy) && World.tileAt(wx, wy) === TILE_TYPE.WATER) {
          g.fillRect(x * CONFIG.TILE, y * CONFIG.TILE, CONFIG.TILE, CONFIG.TILE);
        }
      }
    }
    this.evictFar(this.maskCache, cx, cy);
    this.maskCache.set(k, c);
    return c;
  },

  // ---------- 每帧绘制 ----------

  draw(time) {
    const { ctx, canvas } = this;

    // 贴图没加载完时只显示加载提示（避免残缺画面烤进缓存）
    if (!this.spritesReady()) {
      ctx.fillStyle = '#0a1a2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#9ab';
      ctx.font = '16px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('素材加载中…', canvas.width / 2, canvas.height / 2);
      return;
    }

    ctx.fillStyle = '#0a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 可见范围覆盖到的 chunk
    const S = CONFIG.CHUNK_PX;
    const cx0 = Math.max(0, Math.floor(this.camX / S));
    const cy0 = Math.max(0, Math.floor(this.camY / S));
    const cx1 = Math.floor((this.camX + canvas.width) / S);
    const cy1 = Math.floor((this.camY + canvas.height) / S);

    // 一遍贴上所有静态 chunk（地形 + 树 + 建筑）
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx * CONFIG.CHUNK_TILES >= CONFIG.WORLD_W || cy * CONFIG.CHUNK_TILES >= CONFIG.WORLD_H) continue;
        ctx.drawImage(this.getChunk(cx, cy), cx * S - this.camX, cy * S - this.camY);
      }
    }

    // 动态层：水面特效（云影 + 水面涟漪）、雨珠溅落、摇曳的树
    Effects.drawWaterFX(cx0, cy0, cx1, cy1, time);
    Effects.drawSplashes();
    this.drawTrees(time);

    // 人物
    this.drawPlayer(time);

    // 雨丝
    Effects.drawRain();

    // 昼夜循环：落叶/鸟/萤火虫（Ambience）→ 夜幕压暗 → 窗户亮灯
    const night = Ambience.nightLevel(time);
    Ambience.draw(time);
    if (night > 0.02) {
      ctx.fillStyle = `rgba(10,15,40,${night * 0.5})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // 窗户亮灯（夜晚才开灯，窗口位置固定在房屋上部）
      if (night > 0.15) {
        const tx0 = Math.max(0, Math.floor(this.camX / CONFIG.TILE));
        const ty0 = Math.max(0, Math.floor(this.camY / CONFIG.TILE));
        const tx1 = Math.min(CONFIG.WORLD_W - 1, Math.ceil((this.camX + canvas.width) / CONFIG.TILE));
        const ty1 = Math.min(CONFIG.WORLD_H - 1, Math.ceil((this.camY + canvas.height) / CONFIG.TILE));
        for (let wy = ty0; wy <= ty1; wy++) {
          for (let wx = tx0; wx <= tx1; wx++) {
            if (World.tileAt(wx, wy) !== TILE_TYPE.HOUSE) continue;
            const hv = this.hash(wx, wy);
            if (hv < 0.2) continue;   // 少数黑灯的屋子
            const sx = wx * CONFIG.TILE - this.camX;
            const sy = wy * CONFIG.TILE - this.camY - 2;
            ctx.fillStyle = `rgba(255,214,120,${Math.min(1, (night - 0.05) * 1.6)})`;
            ctx.fillRect(sx + 7, sy + 6, 5, 6);
            ctx.fillRect(sx + 20, sy + 6, 5, 6);
            ctx.fillStyle = `rgba(255,200,110,${night * 0.18})`;   // 窗灯暖光晕
            ctx.fillRect(sx + 1, sy, 30, 16);
          }
        }
      }
    }

    this.drawMinimap();
    this.drawHUD(time);

    // 世界地图覆盖层（M 键开关，最顶层）
    WorldMap.drawOverlay(time);
  },

  // 坐标哈希：同一个格子永远得到同一个随机数
  hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177 | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  },

  // 静态地面：画进 chunk（world 坐标 wx,wy → chunk 内像素 sx,sy）
  drawGroundInto(g, wx, wy, sx, sy) {
    const t = World.tileAt(wx, wy);
    const jitter = ((wx * 7 + wy * 13) % 5) * 2 - 4;
    g.fillStyle = this.shade(this.COLORS[t], jitter);
    g.fillRect(sx, sy, CONFIG.TILE, CONFIG.TILE);

    const imgs = this.TILE_IMG[t];
    if (t === TILE_TYPE.PATH && World.bridgeTiles && World.bridgeTiles.has(wx + ',' + wy)) {
      // 水上的路 = 木桥
      const b = this.sprites['tile-bridge'];
      if (b) g.drawImage(b, sx, sy, CONFIG.TILE, CONFIG.TILE);
    }
    else if (imgs) {
      const name = imgs[Math.floor(this.hash(wx, wy) * imgs.length)];
      const img = this.sprites[name];
      if (img && img.complete && img.naturalWidth) {
        g.drawImage(img, sx, sy, CONFIG.TILE, CONFIG.TILE);
      }
    }

    if (t === TILE_TYPE.WATER) {
      // 岸线泡沫：挨着陆地的边（静态，烤进 chunk）
      g.fillStyle = 'rgba(220,240,255,.45)';
      if (World.tileAt(wx, wy - 1) !== TILE_TYPE.WATER) g.fillRect(sx, sy, CONFIG.TILE, 3);
      if (World.tileAt(wx, wy + 1) !== TILE_TYPE.WATER) g.fillRect(sx, sy + CONFIG.TILE - 3, CONFIG.TILE, 3);
      if (World.tileAt(wx - 1, wy) !== TILE_TYPE.WATER) g.fillRect(sx, sy, 3, CONFIG.TILE);
      if (World.tileAt(wx + 1, wy) !== TILE_TYPE.WATER) g.fillRect(sx + CONFIG.TILE - 3, sy, 3, CONFIG.TILE);
    }
    else if (t === TILE_TYPE.SAND) {
      if (this.hash(wx, wy) < 0.4) {
        g.fillStyle = 'rgba(0,0,0,.08)';
        g.fillRect(sx + 8 + this.hash(wx + 3, wy) * 16, sy + 8 + this.hash(wx, wy + 3) * 16, 2, 2);
      }
    }
    else if (t === TILE_TYPE.MOUNTAIN) {
      g.fillStyle = 'rgba(0,0,0,.18)';
      g.beginPath();
      g.moveTo(sx + 4, sy + CONFIG.TILE - 4);
      g.lineTo(sx + CONFIG.TILE / 2 + jitter, sy + 6);
      g.lineTo(sx + CONFIG.TILE - 4, sy + CONFIG.TILE - 4);
      g.closePath();
      g.fill();
    }
  },

  // 静态建筑与树木：画进 chunk
  drawPropsInto(g, wx, wy, sx, sy) {
    const t = World.tileAt(wx, wy);
    const cx = sx + CONFIG.TILE / 2;
    const by = sy + CONFIG.TILE;

    // 树改为动态绘制（见 drawTrees）：风吹摆动 + 人物经过弯腰
    if (t === TILE_TYPE.HOUSE) {
      const isPagoda = this.hash(wx, wy) > 0.86;
      this.shadowOn(g, cx, by - 2, 14);
      if (isPagoda) this.blitOn(g, 'pagoda-2', cx, by - 2, 42, 46);
      else this.blitOn(g, 'house-2', cx, by - 2, 42, 42);
    }
    // 墙砖由地面层 TILE_IMG[WALL] 绘制（此前道具层错位重复绘制，已删）
    else if (t === TILE_TYPE.FOUNTAIN) {
      this.blitOn(g, 'fountain', cx, by - 2, 40, 40);
    }
  },

  // 摇曳的树（动态绘制）：风让树轻轻摆动，人物靠近时树会弯腰让路
  drawTrees(time) {
    const { ctx } = this;
    const T = CONFIG.TILE;
    const x0 = Math.max(0, Math.floor(this.camX / T) - 1);
    const y0 = Math.max(0, Math.floor(this.camY / T) - 1);
    const x1 = Math.min(CONFIG.WORLD_W, Math.ceil((this.camX + innerWidth) / T) + 1);
    const y1 = Math.min(CONFIG.WORLD_H, Math.ceil((this.camY + innerHeight) / T) + 2);

    for (let wy = y0; wy < y1; wy++) {
      for (let wx = x0; wx < x1; wx++) {
        if (World.tileAt(wx, wy) !== TILE_TYPE.FOREST) continue;
        const size = 30 + this.hash(wx, wy) * 12;
        const cxp = wx * T + T / 2 - this.camX;
        const byp = wy * T + T - this.camY;

        // 风：缓慢的全局摆动（每棵树相位不同）
        const wind = Math.sin(time / 750 + wx * 0.04 + wy * 0.02) * 1.6;
        // 人物推移：越近弯得越厉害，方向 = 远离人物
        const pdx = wx * T + T / 2 - Player.x;
        const pdy = wy * T + T - Player.y;
        const d = Math.hypot(pdx, pdy);
        const R = 88;
        let bend = wind;
        if (d < R) bend += -(pdx / (d || 1)) * (1 - d / R) * 8;
        // 靠得太近：惊飞一群鸟（模块内部有冷却）
        if (d < 34) Ambience.tryScare(wx, wy, pdx, time);

        const shear = bend / size;   // 顶部弯曲像素 → 剪切系数
        this.shadowOn(ctx, cxp, byp - 3, size * 0.3);
        ctx.save();
        ctx.translate(cxp, byp - 2);
        ctx.transform(1, 0, shear, 1, 0, 0);
        const img = this.sprites['tree-2'];
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, -size * 0.4, -size, size * 0.8, size);
        }
        ctx.restore();
      }
    }

    // 草丛：稀疏点缀在草原上，随风摆动 + 人物拨动
    for (let wy = y0; wy < y1; wy++) {
      for (let wx = x0; wx < x1; wx++) {
        if (World.tileAt(wx, wy) !== TILE_TYPE.GRASS) continue;
        const hv = this.hash(wx, wy);
        if (hv < 0.80) continue;
        const bx = wx * T + 4 + hv * 18 - this.camX;
        const by = wy * T + 26 - this.camY;
        // 风摆（草更轻，摆得更快）+ 人物拨动
        const wind = Math.sin(time / 420 + wx * 0.09 + wy * 0.05) * 3.2;
        const pdx = wx * T + T / 2 - Player.x, pdy = wy * T + T - Player.y;
        const d = Math.hypot(pdx, pdy);
        let bend = wind;
        if (d < 56) bend += -(pdx / (d || 1)) * (1 - d / 56) * 5;
        ctx.strokeStyle = 'rgba(36,100,44,.9)';
        ctx.lineWidth = 1.6;
        for (const b of [-3, 0, 3]) {
          ctx.beginPath();
          ctx.moveTo(bx + b, by);
          ctx.quadraticCurveTo(bx + b + bend * 0.5, by - 7, bx + b + bend, by - 13);
          ctx.stroke();
        }
      }
    }
  },

  drawPlayer(time) {
    const { ctx } = this;
    const swimming = Player.inWater;
    let name;
    let flip = false;
    if (swimming) {
      // 游泳贴图：水线已画进角色里，四方向齐全；移动循环划水帧，静止用漂浮帧
      const frame = Player.moving ? 1 + (Math.floor(time / 140) % 3) : 0;
      const dir = Player.facing;
      if (dir === 'up') name = `player-swim-up-${frame}`;
      else if (dir === 'down') name = `player-swim-down-${frame}`;
      else {
        name = `player-swim-${frame}`;   // 侧向条带默认朝右
        flip = dir === 'left';
      }
    } else if (!Player.moving) {
      name = `player-${Player.facing}-0`;
    } else {
      const frame = 1 + (Math.floor(time / 130) % 3);
      name = `player-${Player.facing}-${frame}`;
    }
    const img = this.sprites[name];

    if (!img || !img.complete || !img.naturalWidth) return;

    if (swimming) {
      // 只画水线以上的部分（约 55%）：头和肩膀露出水面，下半身不可见。
      // 裁剪边正好是贴图自带的白色水线环，看起来像整个人浸在水中。
      const CROP = 0.6;                  // 显示顶部 60%（头 + 肩膀露在水面上）
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const w = 40 * iw / ih;
      const hCrop = 40 * CROP;
      const bob = !Player.moving ? Math.sin(time / 320) * 1.6 : 0; // 静止漂浮起伏
      ctx.save();
      ctx.translate(Player.x - this.camX, Player.y - this.camY + 4 + bob);
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, iw, ih * CROP, -w / 2, -hCrop, w, hCrop);
      ctx.restore();
      return;
    }

    this.shadow(Player.x - this.camX, Player.y - this.camY + 12, 9);

    const h = 40;
    const w = img.naturalWidth ? h * img.naturalWidth / img.naturalHeight : 24;
    const bob = !Player.moving ? Math.sin(time / 320) * 1.6 : Math.sin(time / 90) * 2;

    ctx.save();
    ctx.translate(Player.x - this.camX, Player.y - this.camY + 20 - h / 2 + bob);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  },

  // 影子 / 贴图 的双版本：主画布用，chunk 画布也用
  shadow(cx, cy, r) {
    this.shadowOn(this.ctx, cx, cy, r);
  },
  shadowOn(g, cx, cy, r) {
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.beginPath();
    g.ellipse(cx, cy, r, r * 0.4, 0, 0, Math.PI * 2);
    g.fill();
  },
  blitOn(g, name, cx, bottom, w, h) {
    const img = this.sprites[name];
    if (img && img.complete && img.naturalWidth) {
      g.drawImage(img, cx - w / 2, bottom - h, w, h);
    }
  },

  // 雷达式小地图：以人物为中心的局部地图，随移动滚动；
  // 显示范围与迷雾揭露范围一致；未探索区域涂黑；范围内的城市显示名字
  drawMinimap() {
    const size = 160;
    const pad = 10;
    const VIEW = 64;                    // 小地图视野：64×64 格
    const { ctx } = this;
    const cx = Player.x / CONFIG.TILE, cy = Player.y / CONFIG.TILE;
    const x0 = cx - VIEW / 2, y0 = cy - VIEW / 2;
    const px2s = size / VIEW;           // 格 → 屏幕像素

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, pad, size, size);
    ctx.clip();
    // 底色（未探索=深色）
    ctx.fillStyle = '#0d1526';
    ctx.fillRect(pad, pad, size, size);
    // 局部地形（1px/格 的世界图采样，越界自动钳制）
    const hi = this.miniCanvas;
    const sx = Math.max(0, Math.min(hi.width - VIEW, Math.round(x0)));
    const sy = Math.max(0, Math.min(hi.height - VIEW, Math.round(y0)));
    ctx.drawImage(hi, sx, sy, VIEW, VIEW, pad, pad, size, size);

    // 迷雾：未探索的迷雾格涂黑
    if (typeof WorldMap !== 'undefined' && WorldMap.fog) {
      ctx.fillStyle = '#0d1526';
      const fw = WorldMap.FW;
      for (let fy = 0; fy < WorldMap.FH; fy++) {
        for (let fx = 0; fx < fw; fx++) {
          if (WorldMap.exploredAt(fx, fy)) continue;
          const wx0 = fx * WorldMap.CELL, wy0 = fy * WorldMap.CELL;
          ctx.fillRect(
            pad + (wx0 - x0) * px2s, pad + (wy0 - y0) * px2s,
            WorldMap.CELL * px2s + 0.5, WorldMap.CELL * px2s + 0.5
          );
        }
      }
    }

    // 范围内的城市标注
    ctx.font = '10px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    for (const c of World.cities) {
      const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
      if (Math.abs(ccx - cx) > VIEW / 2 || Math.abs(ccy - cy) > VIEW / 2) continue;
      const fx = Math.floor(ccx / WorldMap.CELL), fy = Math.floor(ccy / WorldMap.CELL);
      if (typeof WorldMap !== 'undefined' && !WorldMap.exploredAt(fx, fy)) continue;
      const px = pad + (ccx - x0) * px2s;
      const py = pad + (ccy - y0) * px2s;
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText(c.name, px, py - 8);
    }
    ctx.restore();

    // 边框 + 人物中心红点
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, pad + 0.5, size, size);
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.arc(pad + size / 2, pad + size / 2, 3, 0, Math.PI * 2);
    ctx.fill();
  },

  drawHUD(time) {
    const { ctx } = this;
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    // 游戏时间：240 秒 = 1 天（与昼夜循环同步）
    const day = Math.floor(time / 1000 / 240) + 1;
    const t1 = (time / 1000) % 240;
    let phase, icon;
    if (t1 < 25) { phase = '黎明'; icon = '🌅'; }
    else if (t1 < 95) { phase = '夜晚'; icon = '🌙'; }
    else if (t1 < 120) { phase = '黎明'; icon = '🌅'; }
    else if (t1 < 210) { phase = '白天'; icon = '☀️'; }
    else { phase = '黄昏'; icon = '🌆'; }
    const city = World.cityAt(Player.tileX(), Player.tileY());
    const move = Player.inWater ? '🏊 游泳中'
      : (Input.running() ? '🏃 奔跑中' : '🚶 步行');
    ctx.fillText(
      `🗓️ 第${day}天 ${icon}${phase}  ` +
      `位置 (${Player.tileX()}, ${Player.tileY()})  ` +
      (city ? `🏘️ ${city}  ` : '') +
      `${move}  M 世界地图`,
      180, 24
    );
  },

  shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
    const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
    return `rgb(${r},${g},${b})`;
  },
};
