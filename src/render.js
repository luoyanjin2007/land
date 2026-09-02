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
  },

  SPRITE_LIST: [
    'player-down-0', 'player-down-1', 'player-down-2', 'player-down-3',
    'player-up-0', 'player-up-1', 'player-up-2', 'player-up-3',
    'player-left-0', 'player-left-1', 'player-left-2', 'player-left-3',
    'player-right-0', 'player-right-1', 'player-right-2', 'player-right-3',
    'player-swim-0', 'player-swim-1', 'player-swim-2', 'player-swim-3',
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

  // 小地图：把整个世界压成一张小图，只画一次
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
        if (World.inBounds(wx, wy) && World.tiles[wy][wx] === TILE_TYPE.WATER) {
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
        if (cx * CONFIG.CHUNK_TILES >= CONFIG.MAP_W || cy * CONFIG.CHUNK_TILES >= CONFIG.MAP_H) continue;
        ctx.drawImage(this.getChunk(cx, cy), cx * S - this.camX, cy * S - this.camY);
      }
    }

    // 动态层：水面特效（云影 + 水面涟漪）、雨珠溅落
    Effects.drawWaterFX(cx0, cy0, cx1, cy1, time);
    Effects.drawSplashes();

    // 人物
    this.drawPlayer(time);

    // 雨丝
    Effects.drawRain();

    this.drawMinimap();
    this.drawHUD();
  },

  // 坐标哈希：同一个格子永远得到同一个随机数
  hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177 | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  },

  // 静态地面：画进 chunk（world 坐标 wx,wy → chunk 内像素 sx,sy）
  drawGroundInto(g, wx, wy, sx, sy) {
    const t = World.tiles[wy][wx];
    const jitter = ((wx * 7 + wy * 13) % 5) * 2 - 4;
    g.fillStyle = this.shade(this.COLORS[t], jitter);
    g.fillRect(sx, sy, CONFIG.TILE, CONFIG.TILE);

    const imgs = this.TILE_IMG[t];
    if (imgs) {
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
    const t = World.tiles[wy][wx];
    const cx = sx + CONFIG.TILE / 2;
    const by = sy + CONFIG.TILE;

    if (t === TILE_TYPE.FOREST) {
      const size = 30 + this.hash(wx, wy) * 12;
      this.shadowOn(g, cx, by - 3, size * 0.3);
      this.blitOn(g, 'tree-2', cx, by - 2, size * 0.8, size);
    }
    else if (t === TILE_TYPE.HOUSE) {
      const isPagoda = this.hash(wx, wy) > 0.86;
      this.shadowOn(g, cx, by - 2, 14);
      if (isPagoda) this.blitOn(g, 'pagoda-2', cx, by - 2, 42, 46);
      else this.blitOn(g, 'house-2', cx, by - 2, 42, 42);
    }
    else if (t === TILE_TYPE.WALL) {
      this.blitOn(g, 'tile-wall-top', sx, sy, CONFIG.TILE, CONFIG.TILE);
    }
    else if (t === TILE_TYPE.FOUNTAIN) {
      this.blitOn(g, 'fountain', cx, by - 2, 40, 40);
    }
  },

  drawPlayer(time) {
    const { ctx } = this;
    const swimming = Player.inWater;
    let name;
    if (swimming) {
      // 游泳贴图：水线已画进角色里，移动时循环划水帧，静止用漂浮帧
      const frame = Player.moving ? 1 + (Math.floor(time / 140) % 3) : 0;
      name = `player-swim-${frame}`;
    } else if (!Player.moving) {
      name = `player-${Player.facing}-0`;
    } else {
      const frame = 1 + (Math.floor(time / 130) % 3);
      name = `player-${Player.facing}-${frame}`;
    }
    const img = this.sprites[name];

    // 陆上有影子；水里没有影子（贴图自带浸水感）
    if (!swimming) this.shadow(Player.x - this.camX, Player.y - this.camY + 12, 9);

    const h = swimming ? 42 : 40;
    const w = img && img.naturalWidth ? h * img.naturalWidth / img.naturalHeight : 24;
    const bob = swimming
      ? Math.sin(time / 320) * 1.6
      : (Player.moving ? Math.sin(time / 90) * 2 : 0);
    const sink = swimming ? 5 : 0;

    ctx.save();
    ctx.translate(Player.x - this.camX, Player.y - this.camY + 20 - h / 2 + sink + bob);
    // 游泳贴图默认朝右：朝左走时镜像
    if (swimming && Player.facing === 'left') ctx.scale(-1, 1);
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.font = '26px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🧍', 0, 0);
    }
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
      (Player.inWater ? '🏊 游泳中  ' : '') +
      `${Input.running() ? '🏃奔跑中' : '🚶步行'}  Shift 加速`,
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
