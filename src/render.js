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
  CHUNK_HEAD: 56,               // 正常世界
  LAB_HEAD: 120,               // 实验室模式（山峰可达 2 格高）              // chunk 画布顶部预留区：高处地形向上生长的空间
  TIER: { 0: 0, 1: 1, 2: 1, 3: 1, 4: 3, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 2 }, // 地形海拔层级：WATER0 沙草林路1 丘陵2 山峰3
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
    [TILE_TYPE.HILL]: '#8d9b7a',
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
    'tile-wall-top', 'tile-hill-1', 'tile-hill-2', 'tile-hill-3', 'tile-rock',
    'tile-forest-dark', 'tile-bamboo', 'tile-leaf', 'tile-mushroom',
    'tile-pebble', 'tile-cracked', 'tile-thick-grass', 'tile-dry-grass',
    'tile-cliff-grass', 'tile-cliff-rock', 'tile-cliff-hill', 'tile-cliff-sand',
  ],

  TILE_IMG: {
    [TILE_TYPE.HILL]: ['tile-hill-1', 'tile-hill-1', 'tile-hill-2', 'tile-hill-3'],
    [TILE_TYPE.WATER]: ['tile-water'],
    [TILE_TYPE.SAND]: ['tile-sand', 'tile-sand', 'tile-pebble', 'tile-cracked'],
    [TILE_TYPE.GRASS]: ['tile-grass-2', 'tile-grass-2', 'tile-grass-2', 'tile-grass-1', 'tile-flower'],
    [TILE_TYPE.FOREST]: ['tile-forest'], // 星斗大森林内的变体在 drawGroundInto 里按区域启用
    [TILE_TYPE.MOUNTAIN]: ['tile-rock'],
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

  // 小地图：抽样渲染整个世界（每 2 格采 1 像素 → 400×400，只画一次）
  bakeMinimap() {
    const STEP = 2;
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
    c.width = S; c.height = S + (CONFIG.LAB ? 120 : 56);   // 顶部预留：高处地形向上生长
    const g = c.getContext('2d');
    for (let y = 0; y < CONFIG.CHUNK_TILES; y++) {
      for (let x = 0; x < CONFIG.CHUNK_TILES; x++) {
        const wx = cx * CONFIG.CHUNK_TILES + x, wy = cy * CONFIG.CHUNK_TILES + y;
        if (!World.inBounds(wx, wy)) continue;
        const sx = x * CONFIG.TILE, sy = y * CONFIG.TILE + (CONFIG.LAB ? 120 : 56);
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
    c.width = CONFIG.CHUNK_PX; c.height = CONFIG.CHUNK_PX + (CONFIG.LAB ? 120 : 56);
    const g = c.getContext('2d');
    g.translate(0, (CONFIG.LAB ? 120 : 56));
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

  // ---------- 【高度实验室】伪 3D 烘焙 ----------
  // 原理：整张世界是一张连续高度场 e(x,y)。
  //   顶面：每格地面画在 屏幕Y = 格子Y − e×缩放（高处整体上移）
  //   侧壁：相邻格子的高度差自动产生断崖（悬崖纹理填充）
  //   顺序：地面(全体) → 侧壁(全体) → 道具(按行排序) —— 画家算法
  // 一次烘焙成整张大画布，之后每帧只需贴可见区域（48×48 实验室专用）

  headPx() { return CONFIG.LAB ? 140 : 56; },
  // 斜视角参数：顶面压扁比例（≈cos30°），立面因此大面积可见
  KY() { return CONFIG.LAB ? 0.62 : 1; },
  PITCH() { return CONFIG.TILE * this.KY(); },   // 行间距（压扁后的顶面高度）

  labBake() {
    if (this._labBaked) return;
    const T = CONFIG.TILE, W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
    const HEAD = this.headPx();
    const P = this.PITCH();   // 压扁后的行间距
    const HS = 56;   // 高度缩放：每单位高度上移的像素

    // 1. 原始高度场 + 两轮箱式平滑（让侧壁高度渐变，山坡圆润）
    const raw = [];
    for (let y = 0; y < H; y++) {
      raw[y] = [];
      for (let x = 0; x < W; x++) raw[y][x] = World.labElev(x, y);
    }
    let sm = raw;
    for (let pass = 0; pass < 2; pass++) {
      const out = [];
      for (let y = 0; y < H; y++) {
        out[y] = [];
        for (let x = 0; x < W; x++) {
          let s = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < W && ny < H) { s += sm[ny][nx]; n++; }
            }
          }
          out[y][x] = s / n;
        }
      }
      sm = out;
    }
    this._labElevSm = sm;   // 人物绘制也要按高度位移

    // 2. 画布
    const c = document.createElement('canvas');
    c.width = W * T; c.height = H * P + HEAD;
    const g = c.getContext('2d');
    g.fillStyle = '#0a1a2e';
    g.fillRect(0, 0, c.width, c.height);

    // 顶面 Y 表
    const topY = [];
    for (let y = 0; y < H; y++) {
      topY[y] = [];
      for (let x = 0; x < W; x++) topY[y][x] = y * P + HEAD - sm[y][x] * HS;
    }

    // 3. 斜投影柱体：每格画 顶面 + 南立面 + 东立面
    //    相机从东南方向 30° 俯视：高度让顶面向左上偏移 (OX,OY)
    //    相邻格子的顶面互相覆盖 → 只有朝向相机的立面露出来
    const OX = 10, OY = 22;   // 每单位高度的屏幕偏移（水平/垂直）
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = World.tileAt(x, y);
        const e = sm[y][x];
        const vx = -OX * e, vy = -OY * e;
        const bx = x * T, by = y * P + HEAD;
        if (e < 0.02) {
          // 平地：只画顶面
          const imgs = this.TILE_IMG[t];
          const name = imgs[Math.floor(this.hash(x, y) * imgs.length)];
          const img = this.sprites[name];
          if (img && img.complete && img.naturalWidth) {
            g.drawImage(img, bx, by, T, P);
          }
          continue;
        }
        const cimg = this.sprites[t === TILE_TYPE.MOUNTAIN ? 'tile-cliff-rock'
          : t === TILE_TYPE.HILL ? 'tile-cliff-hill'
          : t === TILE_TYPE.SAND ? 'tile-cliff-sand' : 'tile-cliff-grass'];
        const pat = (cimg && cimg.complete && cimg.naturalWidth)
          ? g.createPattern(cimg, 'repeat') : this.COLORS[t];

        // 南立面（先画，被顶面和东邻覆盖多余部分）
        g.beginPath();
        g.moveTo(bx + vx, by + vy + P);
        g.lineTo(bx + T + vx, by + vy + P);
        g.lineTo(bx + T, by + P);
        g.lineTo(bx, by + P);
        g.closePath();
        g.fillStyle = pat;
        g.fill();
        g.fillStyle = 'rgba(10,14,24,.3)';
        g.fill();

        // 东立面（更暗，背光面）
        g.beginPath();
        g.moveTo(bx + T, by);
        g.lineTo(bx + T + vx, by + vy);
        g.lineTo(bx + T + vx, by + vy + P);
        g.lineTo(bx + T, by + P);
        g.closePath();
        g.fillStyle = pat;
        g.fill();
        g.fillStyle = 'rgba(10,14,24,.45)';
        g.fill();

        // 顶面（最后画，盖住立面的上边缘）
        const imgs = this.TILE_IMG[t];
        const name = imgs[Math.floor(this.hash(x, y) * imgs.length)];
        const img = this.sprites[name];
        if (img && img.complete && img.naturalWidth) {
          g.drawImage(img, bx + vx, by + vy, T, P);
        } else {
          g.fillStyle = this.COLORS[t];
          g.fillRect(bx + vx, by + vy, T, P);
        }
        // 高峰雪顶（带抖动，避免等值线图案）
        if (t === TILE_TYPE.MOUNTAIN && e + (this.hash(x, y) - 0.5) * 0.08 > 0.93) {
          g.fillStyle = 'rgba(240,246,255,.55)';
          g.fillRect(bx + vx, by + vy, T, P);
        }
      }
    }

    // 5. 道具（按行排序，树等；实验室里种几棵树当参照物）
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (World.tileAt(x, y) === TILE_TYPE.FOREST ||
            (World.tileAt(x, y) === TILE_TYPE.GRASS && this.hash(x, y) > 0.93)) {
          const size = 30 + this.hash(x, y) * 12;
          const img = this.sprites['tree-2'];
          if (img && img.complete && img.naturalWidth) {
            g.drawImage(img, x * T + T / 2 - size * 0.4, topY[y][x] + P - size, size * 0.8, size);
          }
        }
      }
    }

    // 6. 水面蒙版（一次性，供云影/涟漪裁剪）
    const m = document.createElement('canvas');
    m.width = c.width; m.height = c.height;
    const mg = m.getContext('2d');
    mg.fillStyle = '#fff';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (World.tileAt(x, y) === TILE_TYPE.WATER) {
          mg.fillRect(x * T, topY[y][x], T, P);
        }
      }
    }
    this.labMask = m;

    // 7. 让 drawWaterFX 用整张蒙版（实验室模式跳过 chunk 拼装）
    this._labMaskMode = true;

    this.labCanvas = c;
    this._labBaked = true;
  },

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

    // 【高度实验室】整张世界一次性烘焙（伪 3D 位移渲染 + 画家算法）
    if (CONFIG.LAB) {
      this.labBake();
      ctx.fillStyle = '#0a1a2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.labCanvas, -this.camX, Render.headPx() - this.camY);
      const lc0 = 0, lr0 = 0;
      const lc1 = Math.ceil(CONFIG.WORLD_W / CONFIG.CHUNK_TILES) - 1;
      const lr1 = Math.ceil(CONFIG.WORLD_H / CONFIG.CHUNK_TILES) - 1;
      Effects.drawWaterFX(lc0, lr0, lc1, lr1, time);
      Effects.drawSplashes();
      this.drawPlayer(time);
      Effects.drawRain();
      this.drawMinimap();
      this.drawHUD();
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
        ctx.drawImage(this.getChunk(cx, cy), cx * S - this.camX, cy * S - this.camY - Render.CHUNK_HEAD);
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
    const t = World.tileAt(wx, wy);
    const jitter = ((wx * 7 + wy * 13) % 5) * 2 - 4;
    g.fillStyle = this.shade(this.COLORS[t], jitter);
    g.fillRect(sx, sy, CONFIG.TILE, CONFIG.TILE);

    const imgs = this.TILE_IMG[t];
    if (t === TILE_TYPE.FOREST) {
      // 星斗大森林内启用地面变体（密林/落叶/蘑菇），村内外围用统一地面
      const inZone = wx >= World.forest.x0 && wx <= World.forest.x1 &&
                     wy >= World.forest.y0 && wy <= World.forest.y1;
      const pool = inZone
        ? ['tile-forest', 'tile-forest-dark', 'tile-leaf', 'tile-mushroom']
        : imgs;
      const name = pool[Math.floor(this.hash(wx, wy) * pool.length)];
      const img = this.sprites[name];
      if (img && img.complete && img.naturalWidth) {
        g.drawImage(img, sx, sy, CONFIG.TILE, CONFIG.TILE);
      }
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
    // 墙砖由地面层 TILE_IMG[WALL] 绘制（此前道具层错位重复绘制，已删）
    else if (t === TILE_TYPE.MOUNTAIN) {
      // 高耸山峰：向上生长的岩峰（悬崖岩壁纹理填充），高度由平滑噪声决定 → 连绵山脉
      const n = World.n2 ? World.n2(wx, wy) : 0.5;
      const hgt = (CONFIG.LAB ? 30 : 22) + n * (CONFIG.LAB ? 56 : 40);
      const jx = (this.hash(wx, wy) - 0.5) * 10;
      const cimg = this.sprites['tile-cliff-rock'];
      if (cimg && cimg.complete && cimg.naturalWidth) {
        const pat = g.createPattern(cimg, 'repeat');
        g.beginPath();
        g.moveTo(sx - 2, sy + CONFIG.TILE);
        g.lineTo(sx + CONFIG.TILE / 2 + jx, sy + CONFIG.TILE - hgt);
        g.lineTo(sx + CONFIG.TILE + 2, sy + CONFIG.TILE);
        g.closePath();
        g.fillStyle = pat;
        g.fill();
        // 明暗光照：左上受光、右下投影，让山峰从地面上立起来
        const lg = g.createLinearGradient(sx, sy + CONFIG.TILE - hgt, sx + CONFIG.TILE, sy + CONFIG.TILE);
        lg.addColorStop(0, 'rgba(255,250,240,.3)');
        lg.addColorStop(0.55, 'rgba(0,0,0,0)');
        lg.addColorStop(1, 'rgba(8,12,22,.5)');
        g.fillStyle = lg;
        g.fill();
        g.strokeStyle = 'rgba(8,12,22,.6)';
        g.lineWidth = 2;
        g.stroke();
        if (hgt > 52) {   // 高峰带雪顶
          const ax = sx + CONFIG.TILE / 2 + jx;
          g.beginPath();
          g.moveTo(ax - 10, sy + CONFIG.TILE - hgt + 14);
          g.lineTo(ax, sy + CONFIG.TILE - hgt);
          g.lineTo(ax + 10, sy + CONFIG.TILE - hgt + 14);
          g.closePath();
          g.fillStyle = 'rgba(240,246,255,.95)';
          g.fill();
        }
      }
    }
    else if (t === TILE_TYPE.HILL) {
      // 丘陵：轻微隆起的缓坡包（可行走）
      const hgt = 6 + (World.n3 ? World.n3(wx, wy) : 0.5) * 10;
      const cimg = this.sprites['tile-cliff-hill'];
      if (cimg && cimg.complete && cimg.naturalWidth) {
        const pat = g.createPattern(cimg, 'repeat');
        g.beginPath();
        g.moveTo(sx - 1, sy + CONFIG.TILE);
        g.quadraticCurveTo(sx + CONFIG.TILE / 2, sy + CONFIG.TILE - hgt * 2, sx + CONFIG.TILE + 1, sy + CONFIG.TILE);
        g.closePath();
        g.fillStyle = pat;
        g.fill();
      }
    }
    else if (t === TILE_TYPE.FOUNTAIN) {
      this.blitOn(g, 'fountain', cx, by - 2, 40, 40);
    }
  },

  drawPlayer(time) {
    const { ctx } = this;
    const swimming = Player.inWater;
    // 实验室模式：人物也按所在格子的高度位移（站得高画得高）
    let elevOff = 0;
    if (CONFIG.LAB && this._labElevSm) {
      const tx = Math.max(0, Math.min(CONFIG.WORLD_W - 1, Player.tileX()));
      const ty = Math.max(0, Math.min(CONFIG.WORLD_H - 1, Player.tileY()));
      elevOff = -(this._labElevSm[ty][tx] || 0) * 56;
    }
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
      ctx.translate(Player.x - this.camX, Player.y - this.camY + 4 + bob + (elevOff || 0));
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, iw, ih * CROP, -w / 2, -hCrop, w, hCrop);
      ctx.restore();
      return;
    }

    this.shadow(Player.x - this.camX, Player.y - this.camY + 12 + (elevOff || 0), 9);

    const h = 40;
    const w = img.naturalWidth ? h * img.naturalWidth / img.naturalHeight : 24;
    const bob = !Player.moving ? Math.sin(time / 320) * 1.6 : Math.sin(time / 90) * 2;

    ctx.save();
    ctx.translate(Player.x - this.camX, Player.y - this.camY + 20 - h / 2 + bob + (elevOff || 0));
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
    const mx = pad + (Player.x / (CONFIG.WORLD_W * CONFIG.TILE)) * size;
    const my = pad + (Player.y / (CONFIG.WORLD_H * CONFIG.TILE)) * size;
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
