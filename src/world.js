// 世界：斗罗大陆 800×800，按需生成（tileAt 随时计算任意格子，不存整张地图）
//
// 三层结构：
//   1. 大陆骨架（正史地理）：西海、北境天山、南境沙漠、南海、东海、海神岛
//   2. 群系噪声：星斗大森林、基础地形（草原/碎林/湖泊/丘陵）
//   3. 地标城市：6 座城市按正史相对位置落位，内部布局懒加载生成
//
// 同一个 (x,y) 永远算出同一个结果——世界是确定的，内存占用与地图尺寸无关

// 可复现随机数（同一种子 = 同一个世界）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 值噪声层：粗糙网格撒随机数 + 双线性插值 + smoothstep
function makeNoiseLayer(w, h, cell, rng) {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = [];
  for (let y = 0; y < gh; y++) {
    grid[y] = [];
    for (let x = 0; x < gw; x++) grid[y][x] = rng();
  }
  return function (x, y) {
    const fx = x / cell, fy = y / cell;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sxx = tx * tx * (3 - 2 * tx);
    const syy = ty * ty * (3 - 2 * ty);
    const v00 = grid[y0][x0], v10 = grid[y0][x0 + 1];
    const v01 = grid[y0 + 1][x0], v11 = grid[y0 + 1][x0 + 1];
    return (v00 * (1 - sxx) + v10 * sxx) * (1 - syy) +
           (v01 * (1 - sxx) + v11 * sxx) * syy;
  };
}

const World = {
  W: CONFIG.WORLD_W, H: CONFIG.WORLD_H,
  cities: [],              // {x, y, w, h, name, seed}
  godIsland: { x: 80, y: 300, rx: 32, ry: 26 },   // 海神岛（西侧大海）
  forest: { x0: 260, y0: 260, x1: 430, y1: 400 }, // 星斗大森林（两帝国交界）
  spawn: null,
  _layouts: new Map(),     // 城市内部布局缓存 name -> 二维数组

  // 初始化：只建噪声层和城市定义，不生成任何格子
  generate(seed) {
    this.seed = seed;
    const rng = mulberry32(seed);
    this.n1 = makeNoiseLayer(this.W, this.H, 64, rng);   // 大起伏
    this.n2 = makeNoiseLayer(this.W, this.H, 24, rng);   // 中起伏
    this.n3 = makeNoiseLayer(this.W, this.H, 9, rng);    // 细节
    this.coast = makeNoiseLayer(this.W, this.H, 40, rng);// 海岸线扰动
    this.forestN = makeNoiseLayer(this.W, this.H, 18, rng); // 森林分布

    // 六大地标（正史相对位置：圣魂村→诺丁城→史莱克在北，索托城中，
    // 武魂城在两帝国交界，星罗城在南）
    this.cities = [
      { x: 187, y: 130, w: 26, h: 20, name: '圣魂村' },
      { x: 287, y: 168, w: 34, h: 26, name: '诺丁城' },
      { x: 405, y: 218, w: 30, h: 24, name: '史莱克学院' },
      { x: 343, y: 287, w: 34, h: 26, name: '索托城' },
      { x: 382, y: 456, w: 36, h: 28, name: '武魂城' },
      { x: 463, y: 527, w: 34, h: 26, name: '星罗城' },
    ].map((c, i) => ({ ...c, seed: seed + 1000 + i * 77 }));

    // 出生点：圣魂村中央广场（喷泉旁两格，保证可行走）
    const v = this.cities[0];
    this.spawn = { x: v.x + (v.w >> 1), y: v.y + (v.h >> 1) + 2 };

    // 城际道路
    this.generateRoads(seed);
    // 风景湖（道路穿湖 → 湖中段成为木桥）
    this.placeScenicLakes(rng);
  },

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; },

  // 确定性哈希（世界坐标 → 0~1）：植被和道路的自然抖动
  hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  },

  // 城门选择：朝目标城市方向的那座门
  gateToward(city, target) {
    const cx = city.x + (city.w >> 1), cy = city.y + (city.h >> 1);
    const dx = target.x + (target.w >> 1) - cx;
    const dy = target.y + (target.h >> 1) - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: dx > 0 ? city.x + city.w - 1 : city.x, y: cy };
    }
    return { x: cx, y: dy > 0 ? city.y + city.h - 1 : city.y };
  },

  // 城际道路：BFS 双模式——优先纯陆地；不通时允许涉水（水上铺木桥）
  carveRoad(A, B, rng) {
    const start = this.gateToward(A, B);
    const goal = this.gateToward(B, A);
    const K = (x, y) => x + ',' + y;
    const T = CONFIG.TILE;

    // BFS：allowWater=false 只走陆地；true 时可涉水（水格标为桥）
    const bfs = (allowWater) => {
      const came = new Map();
      const q = [[start.x, start.y]];
      const seen = new Set([K(start.x, start.y)]);
      while (q.length) {
        const [x, y] = q.shift();
        if (x === goal.x && y === goal.y) {
          // 回溯路径
          const path = [];
          let k = K(x, y);
          while (k !== K(start.x, start.y)) { path.push(k); k = came.get(k); }
          path.push(K(start.x, start.y));
          return path;
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          const nk = K(nx, ny);
          if (seen.has(nk) || !this.inBounds(nx, ny)) continue;
          const t = this.tileAt(nx, ny);
          if (t === TILE_TYPE.WATER && !allowWater) continue;
          if (t === TILE_TYPE.MOUNTAIN || t === TILE_TYPE.HOUSE ||
              t === TILE_TYPE.WALL || t === TILE_TYPE.FOUNTAIN) continue;
          seen.add(nk);
          came.set(nk, K(x, y));
          q.push([nx, ny]);
        }
      }
      return null;
    };

    let path = bfs(false);              // 先尝试纯陆地
    let bridge = false;
    if (!path) { path = bfs(true); bridge = true; }   // 不通：木桥模式

    if (!path) {
      // 极端兜底：直线（几乎不会发生）
      const dx = Math.sign(goal.x - start.x), dy = Math.sign(goal.y - start.y);
      let x = start.x, y = start.y;
      path = [K(x, y)];
      while (x !== goal.x || y !== goal.y) {
        if (x !== goal.x) x += dx;
        else if (y !== goal.y) y += dy;
        path.push(K(x, y));
      }
    }

    // 铺路：水上格记为桥（渲染用木栈道贴图）
    for (const kk of path) {
      this.roadTiles.add(kk);
      if (bridge) {
        const [px, py] = kk.split(',').map(Number);
        if (this.tileAt(px, py) === TILE_TYPE.WATER) this.bridgeTiles.add(kk);
      }
      const [px, py] = kk.split(',').map(Number);
      // 路宽自然变化（加宽格不可是建筑/山/水）
      if (rng() < 0.4) {
        const t2 = this.tileAt(px, py + 1);
        if (t2 !== TILE_TYPE.WATER && t2 !== TILE_TYPE.MOUNTAIN &&
            t2 !== TILE_TYPE.HOUSE && t2 !== TILE_TYPE.WALL && t2 !== TILE_TYPE.FOUNTAIN) {
          this.roadTiles.add(px + ',' + (py + 1));
        }
      }
    }
  },

  // 风景湖：在远离城市的野外道路上放置小湖，道路从湖上穿过 → 湖中段自动成为木桥
  placeScenicLakes(rng) {
    this.lakes = [];
    const far = [];
    for (const k of this.roadTiles) {
      const [x, y] = k.split(',').map(Number);
      let okDist = true;
      for (const c of this.cities) {
        if (Math.abs(x - (c.x + c.w / 2)) < 46 && Math.abs(y - (c.y + c.h / 2)) < 46) { okDist = false; break; }
      }
      const tHere = this.tileAt(x, y);
      if (okDist && this.inBounds(x, y) &&
          tHere !== TILE_TYPE.WATER && tHere !== TILE_TYPE.MOUNTAIN) far.push({ x, y });
    }
    // 打乱（确定性），取相距足够远的两处放湖
    far.sort((a, b) => this.hash(a.x, a.y) - this.hash(b.x, b.y));
    const chosen = [];
    for (const s of far) {
      if (chosen.every(c => Math.hypot(c.x - s.x, c.y - s.y) > 120)) {
        chosen.push(s);
        if (chosen.length >= 2) break;
      }
    }
    for (const s of chosen) {
      this.lakes.push({ x: s.x, y: s.y, rx: 7 + Math.floor(rng() * 4), ry: 5 + Math.floor(rng() * 3) });
    }
    // 道路穿湖的格子 = 桥面
    for (const k of this.roadTiles) {
      if (this.inLakeRaw(k.split(',')[0] * 1, k.split(',')[1] * 1)) this.bridgeTiles.add(k);
    }
  },

  // 是否在风景湖范围内（含噪声边缘）
  inLakeRaw(x, y) {
    if (!this.lakes) return false;
    for (const l of this.lakes) {
      const ddx = (x - l.x) / l.rx, ddy = (y - l.y) / l.ry;
      if (ddx * ddx + ddy * ddy < 1 + (this.coast(x, y) - 0.5) * 0.25) return true;
    }
    return false;
  },

  // 生成全部城际道路（正史路线：圣魂村→诺丁城→史莱克/索托→武魂城→星罗城）
  generateRoads(seed) {
    this.roadTiles = new Set();
    this.bridgeTiles = new Set();
    const rng = mulberry32(seed + 999);
    const links = [
      [0, 1], [1, 2], [1, 3], [3, 4], [4, 5],
    ];
    for (const [a, b] of links) this.carveRoad(this.cities[a], this.cities[b], rng);
  },

  // 所在城市（含 6 格城郊缓冲）：保证城边一定是陆地
  cityCovering(x, y) {
    for (const c of this.cities) {
      if (x >= c.x - 12 && x < c.x + c.w + 12 && y >= c.y - 12 && y < c.y + c.h + 12) return c;
    }
    return null;
  },

  cityAt(x, y) {
    for (const c of this.cities) {
      if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c.name;
    }
    return null;
  },

  // 城市内部布局（懒加载生成一次，缓存）
  getCityLayout(c) {
    let g = this._layouts.get(c.name);
    if (g) return g;
    const rng = mulberry32(c.seed);
    g = [];
    for (let y = 0; y < c.h; y++) g[y] = new Array(c.w).fill(TILE_TYPE.GRASS);
    const set = (x, y, t) => { if (x >= 0 && y >= 0 && x < c.w && y < c.h) g[y][x] = t; };
    const get = (x, y) => (x >= 0 && y >= 0 && x < c.w && y < c.h) ? g[y][x] : -1;
    const gx = c.w >> 1, gy = c.h >> 1;
    // 城墙一圈，四边正中开城门
    for (let x = 0; x < c.w; x++) { set(x, 0, TILE_TYPE.WALL); set(x, c.h - 1, TILE_TYPE.WALL); }
    for (let y = 0; y < c.h; y++) { set(0, y, TILE_TYPE.WALL); set(c.w - 1, y, TILE_TYPE.WALL); }
    set(gx, 0, TILE_TYPE.ROAD); set(gx, c.h - 1, TILE_TYPE.ROAD);
    set(0, gy, TILE_TYPE.ROAD); set(c.w - 1, gy, TILE_TYPE.ROAD);
    // 十字大街 + 内环街
    for (let x = 1; x < c.w - 1; x++) set(x, gy, TILE_TYPE.ROAD);
    for (let y = 1; y < c.h - 1; y++) set(gx, y, TILE_TYPE.ROAD);
    for (let x = 3; x < c.w - 3; x++) { set(x, 3, TILE_TYPE.ROAD); set(x, c.h - 4, TILE_TYPE.ROAD); }
    for (let y = 3; y < c.h - 3; y++) { set(3, y, TILE_TYPE.ROAD); set(c.w - 4, y, TILE_TYPE.ROAD); }
    // 中央广场 + 喷泉
    for (let y = gy - 2; y <= gy + 2; y++) {
      for (let x = gx - 2; x <= gx + 2; x++) set(x, y, TILE_TYPE.PLAZA);
    }
    set(gx, gy, TILE_TYPE.FOUNTAIN);
    // 沿街民居
    for (let y = 1; y < c.h - 1; y++) {
      for (let x = 1; x < c.w - 1; x++) {
        if (get(x, y) !== TILE_TYPE.GRASS) continue;
        const near = get(x + 1, y) === TILE_TYPE.ROAD || get(x - 1, y) === TILE_TYPE.ROAD ||
                     get(x, y + 1) === TILE_TYPE.ROAD || get(x, y - 1) === TILE_TYPE.ROAD;
        if (near && rng() < 0.55) set(x, y, TILE_TYPE.HOUSE);
      }
    }
    // 空地种树
    for (let y = 1; y < c.h - 1; y++) {
      for (let x = 1; x < c.w - 1; x++) {
        if (get(x, y) === TILE_TYPE.GRASS && rng() < 0.12) set(x, y, TILE_TYPE.FOREST);
      }
    }
    this._layouts.set(c.name, g);
    return g;
  },

  // 核心：任意格子的地形类型（按需计算）
  tileAt(x, y) {
    if (!this.inBounds(x, y)) return TILE_TYPE.WATER;
    const rkey = x + ',' + y;

    // 城市内部布局优先
    const cIn = this.cityAt(x, y);
    if (cIn) {
      const c = this.cities.find(cc => cc.name === cIn);
      return this.getCityLayout(c)[y - c.y][x - c.x];
    }

    // 城际道路（穿过城郊缓冲和野外，连接各城城门）
    if (this.roadTiles.has(rkey)) return TILE_TYPE.PATH;

    // 城郊缓冲（12 格开阔平地，让城市坐落在平原上）
    const c = this.cityCovering(x, y);
    if (c) return TILE_TYPE.GRASS;

    // 海神岛（西侧大海中的仙岛）
    const gi = this.godIsland;
    const ddx = (x - gi.x) / gi.rx, ddy = (y - gi.y) / gi.ry;
    const dIsland = ddx * ddx + ddy * ddy;
    if (dIsland < 1.15) {
      const edge = dIsland > 0.72 || this.forestN(x, y) > 0.62;
      return edge ? TILE_TYPE.SAND : TILE_TYPE.GRASS;
    }

    // 大陆骨架：西海 / 东海海岸线（噪声扰动）
    const wEdge = 130 + (this.coast(x, y) - 0.5) * 70;
    const eEdge = 735 + (this.coast(x, y) - 0.5) * 60;
    if (x < wEdge || x > eEdge) return TILE_TYPE.WATER;

    // 北境天山
    if (y < 42 + this.n2(x, y) * 24) return TILE_TYPE.MOUNTAIN;

    // 南海
    const sEdge = 762 + (this.coast(x, y) - 0.5) * 40;
    if (y > sEdge) return TILE_TYPE.WATER;

    // 南境沙漠（夹在星罗城南与南海之间）
    if (y > 566 + (this.coast(x, y) - 0.5) * 30) return TILE_TYPE.SAND;

    // 星斗大森林：边缘柔化（噪声波浪边界）+ 内部疏密交错
    const f = this.forest;
    if (x >= f.x0 - 14 && x <= f.x1 + 14 && y >= f.y0 - 14 && y <= f.y1 + 14) {
      const dEdge = Math.min(x - f.x0, f.x1 - x, y - f.y0, f.y1 - y);
      const wave = (this.coast(x, y) - 0.5) * 30;           // 边缘波浪 ±15
      const eff = dEdge + wave;
      const n = this.forestN(x, y) + (this.hash(x, y) - 0.5) * 0.14;
      if (eff > 10) {
        // 深入内部：密林 / 疏林 / 空地 交错
        if (n > 0.52) return TILE_TYPE.FOREST;
        if (n > 0.38) return this.hash(x * 3 + 1, y * 3 + 7) < 0.45
          ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;
        return TILE_TYPE.GRASS;
      }
      if (eff > -6 && n > 0.62) return TILE_TYPE.FOREST;    // 边缘外溢的树
      // 边缘之外落到底部基础地形
    }

    // 基础地形：起伏决定草原/碎林/湖泊/山（山峰只在最高的地方出现）
    const e = this.n1(x, y) * 0.55 + this.n2(x, y) * 0.3 + this.n3(x, y) * 0.15;
    if (e < 0.30) return TILE_TYPE.WATER;   // 内陆湖
    if (e < 0.33) return TILE_TYPE.SAND;    // 湖岸
    if (e < 0.68) {
      return this.forestN(x, y) > 0.68 ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;
    }
    return TILE_TYPE.MOUNTAIN;
  },

  // 可通行：山、建筑、城墙、喷泉阻挡；水可游泳通过
  walkable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const t = this.tileAt(x, y);
    return t !== TILE_TYPE.MOUNTAIN &&
           t !== TILE_TYPE.HOUSE && t !== TILE_TYPE.WALL &&
           t !== TILE_TYPE.FOUNTAIN;
  },
};
