// 渲染：分块缓存渲染（静态地形/建筑预渲染成 chunk，动态层单独画）
//
// 性能设计：
//   - 地面 + 建筑 + 水格静态外观 → 16×16 格的 chunk 画布，只渲染一次，按需缓存
//   - 水格形状（蒙版用）同样按 chunk 缓存
//   - 每帧动态的只有：云影/涟漪（特效层）、水珠溅落、人物、雨丝、HUD
//   - 缓存有上限，走远后自动淘汰重建

const Render = {
  canvas: null, ctx: null,
  camX: 0, camY: 0, camFX: 0, camFY: 0,
  miniCanvas: null,
  sprites: {},                 // 贴图缓存 name -> Image
  chunkCache: new Map(),       // 地形 chunk 缓存 "cx,cy" -> canvas
  tuftCache: new Map(),        // 草丛层缓存 "cx,cy" -> canvas | null（该块无草）
  maskCache: new Map(),        // 水格形状缓存 "cx,cy" -> canvas

  // 人物周围「洞」的半径（格）。洞内的草不贴静态层，改为逐帧重画以实现摆动。
  // 必须大于互动半径 56px：人物贴着格子边缘时距洞口 2×32=64px > 56px，
  // 保证弯曲量在洞口已衰减到 0，洞里洞外接得上。
  TUFT_HOLE_T: 2,

  // chunk 四周留白：烤进 chunk 的东西会探出所属格子——树冠最高 41px 且锚点上移
  // 2px，探出格顶 11px；宝塔 42×46 探出格顶 16px、左右各 5px。不留白就会被 chunk
  // 边界切平，每 16 格一条缝。上方 20px 覆盖最高的宝塔，左右 8px。
  // 下方不需要：树影在格内，冠底也不过格底。
  CHUNK_PAD_T: 20,
  CHUNK_PAD_X: 8,

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
    [TILE_TYPE.LAWN]: '#5d9e4a',   // 与草地同色：城内草坪只是不长野草，观感应一致
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
    'tile-grass-2', 'tile-flower-overlay',
    'tile-road', 'tile-dirt', 'tile-gravel', 'tile-plaza', 'tile-sand', 'tile-water', 'tile-forest',
    'tile-wall-top', 'grass-0', 'grass-1', 'grass-2', 'grass-3',
  ],

  TILE_IMG: {
    [TILE_TYPE.WATER]: ['tile-water'],
    [TILE_TYPE.SAND]: ['tile-sand'],
    [TILE_TYPE.GRASS]: ['tile-grass-2'],
    [TILE_TYPE.LAWN]: ['tile-grass-2'],
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
    // alpha: false —— 背景每帧整屏填满，画布下面什么都看不到。带 alpha 的画布
    // 浏览器要多做一次与页面的合成，关掉直接省掉这一遍整屏的读改写。
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'p') {
        this.perf.on = !this.perf.on;
        this.perf.last = 0;   // 否则关掉再打开时，中间那段空档会被当成一帧的间隔
      }
      if (e.key.toLowerCase() === 'b') {
        this.perf.bare = !this.perf.bare;
        this.perf.last = 0;
      }
      // 1~5 分层开关：关掉某层看帧间隔怎么动，比猜哪层贵可靠
      if (e.key >= '1' && e.key <= '5') {
        this.perf.off[e.key] = !this.perf.off[e.key];
        this.perf.last = 0;
      }
    });
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

  // 镜头有两套坐标：camFX/camFY 是平滑跟随用的浮点真值，camX/camY 是取整后
  // 给渲染用的。小数坐标的 drawImage 会强制浏览器对整张源图做双线性重采样——
  // 满屏 16 个 chunk 每帧就是 400 多万像素的无谓重算，取整后走整数快速拷贝。
  // 代价是镜头以整像素步进，但一帧移动好几像素，看不出来。
  snapCamera() {
    this.camFX = Player.x - this.canvas.width / 2;
    this.camFY = Player.y - this.canvas.height / 2;
    this.clampCamera();
  },

  clampCamera() {
    const maxX = CONFIG.WORLD_W * CONFIG.TILE - this.canvas.width;
    const maxY = CONFIG.WORLD_H * CONFIG.TILE - this.canvas.height;
    this.camFX = Math.max(0, Math.min(maxX, this.camFX));
    this.camFY = Math.max(0, Math.min(maxY, this.camFY));
    this.camX = Math.round(this.camFX);
    this.camY = Math.round(this.camFY);
  },

  updateCamera(dt) {
    const targetX = Player.x - this.canvas.width / 2;
    const targetY = Player.y - this.canvas.height / 2;
    const k = 1 - Math.pow(0.001, dt);
    this.camFX += (targetX - this.camFX) * k;
    this.camFY += (targetY - this.camFY) * k;
    this.clampCamera();
  },

  // ---------- chunk 缓存 ----------

  key(cx, cy) { return cx + ',' + cy; },

  // 淘汰离镜头太远的缓存。基准是镜头中心所在的 chunk，而不是刚创建的那一块——
  // 后者在屏幕边缘创建时会把另一侧仍在屏内的 chunk 判为「远」，删掉又立刻重建，
  // 每次重建都是一整块 16×16 格的重新绘制，走路时就会一顿一顿。
  // keep=3 留 7×7=49 块，满屏最多用到 4×5，余量够。
  evictFar(ccx, ccy, keep = 3) {
    for (const map of [this.chunkCache, this.tuftCache, this.maskCache]) {
      if (map.size <= 30) continue;
      for (const k of map.keys()) {
        const [cx, cy] = k.split(',').map(Number);
        if (Math.abs(cx - ccx) > keep || Math.abs(cy - ccy) > keep) map.delete(k);
      }
    }
  },

  // 取（或渲染）一个 16×16 格的静态地形 chunk
  getChunk(cx, cy) {
    const k = this.key(cx, cy);
    let c = this.chunkCache.get(k);
    if (c) return c;
    c = document.createElement('canvas');
    const S = CONFIG.CHUNK_PX;
    const PT = this.CHUNK_PAD_T, PXX = this.CHUNK_PAD_X;
    c.width = S + PXX * 2; c.height = S + PT;
    const g = c.getContext('2d');
    for (let y = 0; y < CONFIG.CHUNK_TILES; y++) {
      for (let x = 0; x < CONFIG.CHUNK_TILES; x++) {
        const wx = cx * CONFIG.CHUNK_TILES + x, wy = cy * CONFIG.CHUNK_TILES + y;
        if (!World.inBounds(wx, wy)) continue;
        const sx = x * CONFIG.TILE + PXX, sy = y * CONFIG.TILE + PT;
        this.drawGroundInto(g, wx, wy, sx, sy);
        this.drawPropsInto(g, wx, wy, sx, sy);
      }
    }
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
    this.maskCache.set(k, c);
    return c;
  },

  // ---------- 每帧绘制 ----------

  // 性能面板（P 键开关）：各图层耗时用指数滑动平均，否则数字跳得看不清。
  // 存在的意义是别再靠"调用次数推算"猜瓶颈——线上读数字才算证据。
  BUILD: 29,
  perf: {
    on: false, bare: false, off: {},
    frame: 0, chunk: 0, water: 0, tuft: 0, trees: 0, other: 0,
    nChunk: 0, nTuft: 0, last: 0, gap: 0,
  },

  // a 是上一帧均值，b 是本帧实测；0.1 的权重约等于看最近 10 帧
  ema(a, b) { return a * 0.9 + b * 0.1; },

  draw(time) {
    const { ctx, canvas } = this;
    const P = this.perf;
    const t0 = P.on ? performance.now() : 0;
    if (P.on && P.last) P.gap = this.ema(P.gap, t0 - P.last);
    P.last = t0;

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

    // 空跑模式（B 键）：除了背景填充什么都不画。用来量帧率的「地板」——
    // 如果空屏的帧间隔和满屏一样，瓶颈就不在我们画的内容上，继续优化渲染是白费。
    if (P.bare) {
      if (P.on) {
        P.frame = this.ema(P.frame, performance.now() - t0);
        P.chunk = P.tuft = P.water = P.trees = P.other = 0;
        P.nChunk = P.nTuft = 0;
        this.drawPerf();
      }
      return;
    }

    // 可见范围覆盖到的 chunk
    const S = CONFIG.CHUNK_PX;
    const cx0 = Math.max(0, Math.floor(this.camX / S));
    const cy0 = Math.max(0, Math.floor(this.camY / S));
    const cx1 = Math.floor((this.camX + canvas.width) / S);
    const cy1 = Math.floor((this.camY + canvas.height) / S);

    // 一遍贴上所有静态 chunk（地形 + 树 + 建筑）。
    // 循环自上而下，配合 chunk 顶部留白正好给出对的层次：下方 chunk 后贴，
    // 它留白里探出的树冠会盖住上方 chunk 的地面——下方物体本就更靠近镜头。
    const tChunk = P.on ? performance.now() : 0;
    const PT = this.CHUNK_PAD_T, PXX = this.CHUNK_PAD_X;
    // 多贴一行下方的 chunk：林内树冠已烤进各自 chunk，视口下边界外那一行树的
    // 冠顶会探进屏幕约 11px。左右不用多贴——
    // 树冠只溢出格子 0.5px，落不到屏内。
    let nc = 0;
    if (!P.off[1]) for (let cy = cy0; cy <= cy1 + 1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx * CONFIG.CHUNK_TILES >= CONFIG.WORLD_W || cy * CONFIG.CHUNK_TILES >= CONFIG.WORLD_H) continue;
        ctx.drawImage(this.getChunk(cx, cy), cx * S - this.camX - PXX, cy * S - this.camY - PT);
        nc++;
      }
    }
    P.nChunk = nc;
    this.evictFar(Math.floor((this.camX + canvas.width / 2) / S),
                  Math.floor((this.camY + canvas.height / 2) / S));

    // 草丛：静态层整块贴，但在人物周围按格挖一个洞，洞内的草改为逐帧重画，
    // 于是只有人物身边的草会摆动、会被拨开。洞口与格线重合、草丛横向偏移
    // 又被夹在格内，所以挖得干净，不会切到邻格静态草的边。
    // 每帧调用数：约 16 次整块贴图 + 洞内十来丛，而不是满屏 570 丛。
    const tTuft = P.on ? performance.now() : 0;
    if (!P.off[3]) {
      const T0 = CONFIG.TILE, HR = this.TUFT_HOLE_T;
      const ptx = Math.floor(Player.x / T0), pty = Math.floor(Player.y / T0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect((ptx - HR) * T0 - this.camX, (pty - HR) * T0 - this.camY,
               (HR * 2 + 1) * T0, (HR * 2 + 1) * T0);
      ctx.clip('evenodd');
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          if (cx * CONFIG.CHUNK_TILES >= CONFIG.WORLD_W || cy * CONFIG.CHUNK_TILES >= CONFIG.WORLD_H) continue;
          const tl = this.getTuftLayer(cx, cy);
          if (tl) ctx.drawImage(tl, cx * S - this.camX, cy * S - this.camY);
        }
      }
      ctx.restore();
      this.drawNearTufts(time);
    }

    // 动态层：水面特效（云影 + 水面涟漪）、雨珠溅落
    const tWater = P.on ? performance.now() : 0;
    if (!P.off[2]) {
      Effects.drawWaterFX(cx0, cy0, cx1, cy1, time);
      Effects.drawSplashes();
    }

    const night = Ambience.nightLevel(time);
    const T = CONFIG.TILE;
    const tx0 = Math.max(0, Math.floor(this.camX / T));
    const ty0 = Math.max(0, Math.floor(this.camY / T));
    const tx1 = Math.min(CONFIG.WORLD_W - 1, Math.ceil((this.camX + canvas.width) / T));
    const ty1 = Math.min(CONFIG.WORLD_H - 1, Math.ceil((this.camY + canvas.height) / T));

    // 水面额外压暗：现实里夜间水体几乎不漫反射，只镜面映天，所以比岸上暗得多。
    // 画在人物之前——游泳的人是水面之上的物体，只该吃全局夜色，不该被水的
    // 那一层一起压黑（原先放在夜幕里，等于盖在人物身上）。
    // 按行合并连续水格再一次性 fill：分次 fill 会在格子交界留下半透明叠加的
    // 淡色网格线，合成同一条路径则由扫描线统一算覆盖率，接缝消失。
    if (night > 0.02 && !P.off[5]) {
      ctx.fillStyle = `rgba(3,8,24,${night * 0.42})`;
      ctx.beginPath();
      for (let wy = ty0; wy <= ty1; wy++) {
        let run = -1;
        for (let wx = tx0; wx <= tx1 + 1; wx++) {
          const isWater = wx <= tx1 && World.tileAt(wx, wy) === TILE_TYPE.WATER;
          if (isWater) { if (run < 0) run = wx; }
          else if (run >= 0) {
            ctx.rect(run * T - this.camX, wy * T - this.camY, (wx - run) * T, T);
            run = -1;
          }
        }
      }
      ctx.fill();
    }

    // 草丛在上面画完了（静态层 + 人物周围的动态那一小圈），这里只剩惊鸟判定
    const tTrees = P.on ? performance.now() : 0;
    this.scareBirds(time);
    const tRest = P.on ? performance.now() : 0;

    // 人物
    this.drawPlayer(time);

    // 雨丝
    if (!P.off[4]) Effects.drawRain();

    // 昼夜循环：落叶/鸟/萤火虫（Ambience）→ 夜幕压暗 → 窗户亮灯
    if (!P.off[4]) Ambience.draw(time);
    if (night > 0.02 && !P.off[5]) {
      ctx.fillStyle = `rgba(10,15,40,${night * 0.5})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 窗户亮灯（夜晚才开灯，窗口位置固定在房屋上部）
      if (night > 0.15) {
        for (let wy = ty0; wy <= ty1; wy++) {
          for (let wx = tx0; wx <= tx1; wx++) {
            if (World.tileAt(wx, wy) !== TILE_TYPE.HOUSE) continue;
            const hv = this.hash(wx, wy);
            if (hv < 0.2) continue;   // 少数黑灯的屋子
            const sx = wx * T - this.camX;
            const sy = wy * T - this.camY - 2;
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

    if (P.on) {
      const end = performance.now();
      P.chunk = this.ema(P.chunk, tTuft - tChunk);
      P.tuft = this.ema(P.tuft, tWater - tTuft);
      P.water = this.ema(P.water, tTrees - tWater);
      P.trees = this.ema(P.trees, tRest - tTrees);
      P.other = this.ema(P.other, (end - t0) - (tRest - tChunk));
      P.frame = this.ema(P.frame, end - t0);
      this.drawPerf();
    }

    // 世界地图覆盖层（M 键开关，最顶层）
    WorldMap.drawOverlay(time);
  },

  // 性能读数：右上角。gap 是相邻两帧 draw 起点的间隔，也就是真实帧时间
  // （含浏览器合成和我们之外的开销）；frame 只是 draw() 自己的耗时。
  drawPerf() {
    const { ctx, canvas } = this;
    const P = this.perf;
    const f = (v) => v.toFixed(2) + 'ms';
    const sw = (n) => P.off[n] ? '关' : '开';
    const lines = [
      `v${this.BUILD}  画布 ${canvas.width}×${canvas.height}${P.bare ? '  [空跑]' : ''}`,
      `帧间隔 ${f(P.gap)}  ≈ ${(1000 / Math.max(0.01, P.gap)).toFixed(0)} fps`,
      `draw 合计 ${f(P.frame)}`,
      `─────────────`,
      `1 chunk ${sw(1)} ${f(P.chunk)} ×${P.nChunk}`,
      `2 水面   ${sw(2)} ${f(P.water)}`,
      `3 草丛   ${sw(3)} ${f(P.tuft)} ×${P.nTuft}`,
      `4 氛围雨 ${sw(4)}`,
      `5 夜色   ${sw(5)}`,
      `惊鸟 ${f(P.trees)}   其余 ${f(P.other)}`,
    ];
    ctx.font = '12px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const w = 215, h = lines.length * 16 + 12;
    const x = canvas.width - w - 12, y = 12;
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#8fe38f';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + 10, y + 20 + i * 16);
    }
  },

  // 坐标哈希：同一个格子永远得到同一个随机数
  hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
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
      const name = imgs.length === 1
        ? imgs[0]
        : imgs[Math.floor(this.hash(wx, wy) * imgs.length)];
      const img = this.sprites[name];
      if (img && img.complete && img.naturalWidth) {
        g.drawImage(img, sx, sy, CONFIG.TILE, CONFIG.TILE);
      }
    }

    // 花：叠在基准草地之上，而不是换掉整格贴图。原先用 tile-flower 替换地面，
    // 那张图自带的绿底比 tile-grass-2 亮 53%，看着像每丛花自带一块异色地面。
    // tile-flower-overlay 是抠掉绿底的透明贴图（见 tools/ 生成脚本）。
    if (t === TILE_TYPE.GRASS) {
      const fh = this.hash(wx * 11 + 3, wy * 11 + 17);
      if (fh < 0.2) {   // 20% 的草原格开花
        const fo = this.sprites['tile-flower-overlay'];
        if (fo && fo.complete && fo.naturalWidth) {
          // 4 种翻转朝向，避免同一张花图在 20% 的格子上重复出花纹
          const f = Math.floor(fh * 20) & 3;
          const T = CONFIG.TILE, h = T / 2;
          g.save();
          g.translate(sx + h, sy + h);
          g.scale((f & 1) ? -1 : 1, (f & 2) ? -1 : 1);
          g.drawImage(fo, -h, -h, T, T);
          g.restore();
        }
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

    // 树和树影全部烤进 chunk：不再有任何逐树的每帧绘制。
    // 实测树林 43fps 时 JS 只占 3.3ms，20ms 全在 GPU 啃七百多次带斜切的
    // drawImage——瓶颈是绘制调用数，摆动效果换不来这个代价，所以整个砍掉。
    if (t === TILE_TYPE.FOREST) {
      const size = (30 + this.hash(wx, wy) * 12) | 0;
      this.shadowOn(g, cx, by - 5, size * 0.3);
      this.blitOn(g, 'tree-2', cx, by - 2, Math.round(size * 0.8), size);
    }
    else if (t === TILE_TYPE.HOUSE) {
      const isPagoda = this.hash(wx, wy) > 0.86;
      this.shadowOn(g, cx, by - 2, 14);
      if (isPagoda) this.blitOn(g, 'pagoda-2', cx, by - 2, 42, 46);
      else this.blitOn(g, 'house-2', cx, by - 2, 42, 42);
    }
    // 墙砖由地面层 TILE_IMG[WALL] 绘制（此前道具层错位重复绘制，已删）
    else if (t === TILE_TYPE.FOUNTAIN) {
      this.blitOn(g, 'fountain', cx, by - 2, 40, 40);
    }
    // 紧贴森林北侧的草丛例外，烤进 chunk：草丛层整层贴在所有 chunk 之后，
    // 而南边的树冠会探进这格 11px——放在草丛层里会压在树冠上面。烤进 chunk
    // 则由逐行绘制顺序保证树后画。代价是这一圈草不摆、也不被人物拨开。
    else if (t === TILE_TYPE.GRASS && World.tileAt(wx, wy + 1) === TILE_TYPE.FOREST) {
      this.tuftInto(g, wx, wy, sx, sy);
    }
  },

  // 草丛的确定性摆放：给定格子返回预缩放贴图和格内偏移，这格没草则返回 null。
  // 静态草丛层和人物周围逐帧重画的草共用这一个函数，保证两者摆放逐像素一致——
  // 否则草进出「洞」的时候会跳位。
  tuftAt(wx, wy) {
    const gv = this._grassVariants || (this._grassVariants = []);
    if (!gv.length) for (let i = 0; i < 4; i++) gv.push(this.sprites['grass-' + i]);
    for (let i = 0; i < 4; i++) {
      if (!gv[i] || !gv[i].complete || !gv[i].naturalWidth) return null;
    }
    // 独立 hash：若沿用 hash(wx, wy) 会与地面贴图变体 floor(hash*5) 完全相关，
    // 草丛就只长在变体格上，看着像草丛自带一块异色地面
    const hv = this.hash(wx * 7 + 13, wy * 7 + 31);
    if (hv < 0.55) return null;           // 45% 的草格长草
    const t01 = (hv - 0.55) / 0.45;       // 归一到 0~1：hv 被门控截断在高段，直接用会偏大
    const vi = Math.floor(this.hash(wx * 3 + 5, wy * 3 + 9) * 4);
    const gh = (15 + t01 * 9) | 0;        // 15~24px，约半格到 3/4 格；取整 = 预缩放桶号
    const tufts = this._tufts || (this._tufts = []);
    const s = tufts[vi * 32 + gh] || this.tuftSprite(vi, gh);
    // 横向偏移夹在格子内。草丛原本可以横跨格线，但人物周围那个洞是按格挖的，
    // 跨线的草会被洞口切掉一条边；夹住之后洞口与格线重合，挖得干净。
    // 竖向天然在格内（顶 = 格顶 + 28 - gh，gh 最大 24）。
    const T = CONFIG.TILE;
    const ox = Math.max(0, Math.min(T - s.width, Math.round(6 + t01 * 20 - s.width / 2)));
    return { s, ox, gh };
  },

  tuftInto(g, wx, wy, sx, sy) {
    const t = this.tuftAt(wx, wy);
    if (t) g.drawImage(t.s, sx + t.ox, sy + 28 - t.gh);
  },

  // 草丛层：整个 chunk 的草预渲染成一张透明画布，每帧只需一次 drawImage。
  // 和地形分开是为了能在人物周围「挖洞」——洞内的草改为逐帧重画，才能摆动。
  // 这一格若紧贴森林北侧则跳过（已烤进 chunk，见 drawPropsInto 的注释）。
  // 整块没草就存 null，省一张 1MB 的空画布。
  getTuftLayer(cx, cy) {
    const k = this.key(cx, cy);
    if (this.tuftCache.has(k)) return this.tuftCache.get(k);
    const T = CONFIG.TILE;
    let c = null, g = null;
    for (let y = 0; y < CONFIG.CHUNK_TILES; y++) {
      for (let x = 0; x < CONFIG.CHUNK_TILES; x++) {
        const wx = cx * CONFIG.CHUNK_TILES + x, wy = cy * CONFIG.CHUNK_TILES + y;
        if (!World.inBounds(wx, wy)) continue;
        if (World.tileAt(wx, wy) !== TILE_TYPE.GRASS) continue;
        if (World.tileAt(wx, wy + 1) === TILE_TYPE.FOREST) continue;
        const t = this.tuftAt(wx, wy);
        if (!t) continue;
        if (!c) {
          c = document.createElement('canvas');
          c.width = c.height = CONFIG.CHUNK_PX;
          g = c.getContext('2d');
        }
        g.drawImage(t.s, x * T + t.ox, y * T + 28 - t.gh);
      }
    }
    this.tuftCache.set(k, c);
    return c;
  },

  // 人物周围那个洞里的草：逐帧重画，带风摆和被人物拨开的弯曲。
  // 弯曲量在互动半径边缘衰减到 0，而洞比互动半径大——所以洞口那一圈草画出来
  // 与静态版逐像素相同，草进出洞口不会突然抖一下。
  drawNearTufts(time) {
    const { ctx } = this;
    const T = CONFIG.TILE, R = this.TUFT_HOLE_T, PR = 56;
    const ptx = Math.floor(Player.x / T), pty = Math.floor(Player.y / T);
    let n = 0;
    for (let wy = pty - R; wy <= pty + R; wy++) {
      for (let wx = ptx - R; wx <= ptx + R; wx++) {
        if (!World.inBounds(wx, wy)) continue;
        if (World.tileAt(wx, wy) !== TILE_TYPE.GRASS) continue;
        if (World.tileAt(wx, wy + 1) === TILE_TYPE.FOREST) continue;
        const t = this.tuftAt(wx, wy);
        if (!t) continue;
        const pdx = wx * T + T / 2 - Player.x, pdy = wy * T + T - Player.y;
        const d = Math.sqrt(pdx * pdx + pdy * pdy);
        const fade = d >= PR ? 0 : 1 - d / PR;
        const wind = Math.sin(time / 420 + wx * 0.09 + wy * 0.05) * 3;
        const bend = (wind - (pdx / (d || 1)) * 5) * fade;
        ctx.setTransform(1, 0, bend / t.gh, 1, wx * T + t.ox - this.camX, wy * T + 28 - this.camY);
        ctx.drawImage(t.s, 0, -t.gh);
        n++;
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.perf.nTuft = n;
  },

  // 惊鸟：人物贴近树时惊飞一群鸟。树已全部烤进 chunk，不用再扫视口，
  // 只扫人物周围 ±2 格就够了。
  scareBirds(time) {
    const T = CONFIG.TILE;
    const ptx = Math.floor(Player.x / T), pty = Math.floor(Player.y / T);
    for (let wy = pty - 2; wy <= pty + 2; wy++) {
      for (let wx = ptx - 2; wx <= ptx + 2; wx++) {
        if (!World.inBounds(wx, wy) || World.tileAt(wx, wy) !== TILE_TYPE.FOREST) continue;
        const pdx = wx * T + T / 2 - Player.x, pdy = wy * T + T - Player.y;
        if (pdx * pdx + pdy * pdy < 34 * 34) Ambience.tryScare(wx, wy, pdx, time);
      }
    }
  },

  // 草丛预缩放，同 treeCrown 的道理：源图 26~42×40，实际只画到 ~20×20，
  // 一屏最多千余丛，每丛每帧都降采样一次太浪费。4 变体 × 高度 15~24 = 40 张小图。
  tuftSprite(vi, h) {
    const img = this._grassVariants[vi];
    const c = document.createElement('canvas');
    const w = Math.max(1, Math.round(h * img.naturalWidth / img.naturalHeight));
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    this._tufts[vi * 32 + h] = c;
    return c;
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
