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

    if (CONFIG.LAB) {
      // 【高度实验室】手工设计的高度场：中央大山，无城市
      this.cities = [];
      this.spawn = { x: 24, y: 34 };
      return;
    }

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
  },

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; },

  // 确定性哈希（世界坐标 → 0~1）：给植被和地形做自然抖动
  hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  },

  // 所在城市（含 10 格城郊缓冲）：保证城市坐落在开阔平地
  cityCovering(x, y) {
    for (const c of this.cities) {
      if (x >= c.x - 10 && x < c.x + c.w + 10 && y >= c.y - 10 && y < c.y + c.h + 10) return c;
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
    if (CONFIG.LAB) return this.labTileAt(x, y);

    // 地标城市 + 城郊缓冲（优先级最高，保证城市不受海洋/群系侵蚀）
    const c = this.cityCovering(x, y);
    if (c) {
      const lx = x - c.x, ly = y - c.y;
      if (lx >= 0 && ly >= 0 && lx < c.w && ly < c.h) {
        return this.getCityLayout(c)[ly][lx];
      }
      return TILE_TYPE.GRASS; // 城郊空地
    }

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

    // 北境天山：山脊不可走，丘陵山脚可走（层次分明的山）
    if (y < 34 + this.n2(x, y) * 12) return TILE_TYPE.MOUNTAIN;
    if (y < 58 + this.n2(x, y) * 18) return TILE_TYPE.HILL;

    // 南海
    const sEdge = 762 + (this.coast(x, y) - 0.5) * 40;
    if (y > sEdge) return TILE_TYPE.WATER;

    // 南境沙漠（夹在星罗城南与南海之间）
    if (y > 566 + (this.coast(x, y) - 0.5) * 30) return TILE_TYPE.SAND;

    // 星斗大森林：密林 / 疏林 / 林间空地交错，边缘带抖动不规则
    if (x >= this.forest.x0 && x <= this.forest.x1 &&
        y >= this.forest.y0 && y <= this.forest.y1) {
      const n = this.forestN(x, y) + (this.hash(x, y) - 0.5) * 0.18;
      if (n > 0.55) return TILE_TYPE.FOREST;                        // 密林
      if (n > 0.40) return this.hash(x * 3 + 1, y * 3 + 7) < 0.45
        ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;                       // 疏林与空地
      return TILE_TYPE.GRASS;                                       // 林间空地
    }

    // 基础地形：起伏决定层次 草原/碎林/湖泊/丘陵/山峰
    const e = this.n1(x, y) * 0.55 + this.n2(x, y) * 0.3 + this.n3(x, y) * 0.15;
    if (e < 0.30) return TILE_TYPE.WATER;   // 内陆湖
    if (e < 0.33) return TILE_TYPE.SAND;    // 湖岸
    if (e < 0.55) {
      const n = this.forestN(x, y) + (this.hash(x + 7, y + 3) - 0.5) * 0.12;
      return n > 0.68 ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;  // 碎林
    }
    if (e < 0.68) return TILE_TYPE.HILL;    // 丘陵：可行走的山脚
    return TILE_TYPE.MOUNTAIN;              // 山峰：不可行走
  },

  // 【高度实验室】手工设计的高度场：
  //   中央一座大山（主峰+山脊），向外依次丘陵 → 草原 → 沙滩 → 环湖
  labTileAt(x, y) {
    const cx = 24, cy = 17;                    // 山体中心
    const d = Math.hypot(x - cx, y - cy);
    if (d > 21) return TILE_TYPE.WATER;        // 外围环湖
    let e = Math.max(0, 1 - d / 15);           // 0~1 高度
    e = e * e * 1.15;                          // 陡峭化（平方）
    e += (this.n2(x, y) - 0.5) * 0.2;          // 噪声细节让山脊不呆板
    if (e > 0.60) return TILE_TYPE.MOUNTAIN;   // 主峰区
    if (e > 0.32) return TILE_TYPE.HILL;       // 丘陵带
    if (e > 0.08) return TILE_TYPE.GRASS;      // 草原
    return TILE_TYPE.SAND;                     // 湖滩
  },

  // 可通行：山峰、树、建筑、城墙、喷泉阻挡；水可游泳通过，丘陵可走
  walkable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const t = this.tileAt(x, y);
    return t !== TILE_TYPE.MOUNTAIN && t !== TILE_TYPE.FOREST &&
           t !== TILE_TYPE.HOUSE && t !== TILE_TYPE.WALL &&
           t !== TILE_TYPE.FOUNTAIN;
  },
};
