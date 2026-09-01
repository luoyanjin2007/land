// 世界生成：用「值噪声」算法生成一片大陆
// 地形分布：低处是水，往上是沙滩、草地、森林、高山

// 可复现的随机数生成器（同一个种子 = 同一个世界）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成一层噪声：在粗糙网格上撒随机数，再双线性插值放大成平滑起伏
function makeNoiseLayer(w, h, cell, rng) {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = [];
  for (let y = 0; y < gh; y++) {
    grid[y] = [];
    for (let x = 0; x < gw; x++) grid[y][x] = rng();
  }
  // 采样函数：把世界坐标映射到网格上做平滑插值
  return function (x, y) {
    const fx = x / cell, fy = y / cell;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx); // smoothstep，让过渡更自然
    const sy = ty * ty * (3 - 2 * ty);
    const v00 = grid[y0][x0],     v10 = grid[y0][x0 + 1];
    const v01 = grid[y0 + 1][x0], v11 = grid[y0 + 1][x0 + 1];
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy) +
           (v01 * (1 - sx) + v11 * sx) * sy;
  };
}

const World = {
  tiles: null,   // 二维数组 tiles[y][x] = 地形编号
  spawn: null,   // 出生点 {x, y}（格子坐标）
  cities: [],    // 城市列表 {x, y, w, h, name}

  // 生成世界
  generate(seed) {
    const rng = mulberry32(seed);
    const { MAP_W: w, MAP_H: h } = CONFIG;
    // 三层噪声叠加：大轮廓 + 中等起伏 + 细节
    const n1 = makeNoiseLayer(w, h, 64, rng);
    const n2 = makeNoiseLayer(w, h, 24, rng);
    const n3 = makeNoiseLayer(w, h, 9, rng);

    this.tiles = [];
    for (let y = 0; y < h; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < w; x++) {
        // 用到地图中心的距离做「岛屿化」：越靠边越低（变海）
        const dx = (x - w / 2) / (w / 2);
        const dy = (y - h / 2) / (h / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const e = n1(x, y) * 0.55 + n2(x, y) * 0.3 + n3(x, y) * 0.15
                - dist * dist * 0.55;
        this.tiles[y][x] = this.classify(e);
      }
    }
    this.buildCities(rng);
    this.findSpawn();
  },

  // 在大陆上盖城市：城墙一圈 + 十字大街 + 中央广场喷泉 + 民居
  buildCities(rng) {
    // 城市位置：出生区域东侧不远处（保证玩家出门就能走到）
    const cx = (CONFIG.MAP_W >> 1) + 14;
    const cy = (CONFIG.MAP_H >> 1) - 8;
    this.stampCity(cx, cy, 26, 20, '圣魂村', rng);
  },

  stampCity(ox, oy, w, h, name, rng) {
    // 记录城市范围（HUD 显示用）
    this.cities.push({ x: ox, y: oy, w, h, name });

    const set = (x, y, t) => {
      if (this.inBounds(x, y)) this.tiles[y][x] = t;
    };
    const get = (x, y) => this.inBounds(x, y) ? this.tiles[y][x] : -1;

    // 1. 平整地基：整个区域先铺草地（覆盖原来的森林山地等）
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) set(x, y, TILE_TYPE.GRASS);
    }

    // 2. 城墙一圈（四角留塔楼位），每边正中开城门
    const gx = ox + (w >> 1), gy = oy + (h >> 1);
    for (let x = ox; x < ox + w; x++) {
      set(x, oy, TILE_TYPE.WALL);              // 北墙
      set(x, oy + h - 1, TILE_TYPE.WALL);      // 南墙
    }
    for (let y = oy; y < oy + h; y++) {
      set(ox, y, TILE_TYPE.WALL);              // 西墙
      set(ox + w - 1, y, TILE_TYPE.WALL);      // 东墙
    }
    set(gx, oy, TILE_TYPE.ROAD);               // 北城门
    set(gx, oy + h - 1, TILE_TYPE.ROAD);       // 南城门
    set(ox, gy, TILE_TYPE.ROAD);               // 西城门
    set(ox + w - 1, gy, TILE_TYPE.ROAD);       // 东城门

    // 3. 十字大街 + 环城内街
    for (let x = ox + 1; x < ox + w - 1; x++) set(x, gy, TILE_TYPE.ROAD);
    for (let y = oy + 1; y < oy + h - 1; y++) set(gx, y, TILE_TYPE.ROAD);
    for (let x = ox + 3; x < ox + w - 3; x++) {
      set(x, oy + 3, TILE_TYPE.ROAD);
      set(x, oy + h - 4, TILE_TYPE.ROAD);
    }
    for (let y = oy + 3; y < oy + h - 3; y++) {
      set(ox + 3, y, TILE_TYPE.ROAD);
      set(ox + w - 4, y, TILE_TYPE.ROAD);
    }

    // 4. 中央广场 + 喷泉
    const px = gx - 2, py = gy - 2;
    for (let y = py; y < py + 5; y++) {
      for (let x = px; x < px + 5; x++) set(x, y, TILE_TYPE.PLAZA);
    }
    set(gx, gy, TILE_TYPE.FOUNTAIN);

    // 5. 民居：沿街两侧、隔一格放一间（留出门口空隙），带确定性随机
    for (let y = oy + 1; y < oy + h - 1; y++) {
      for (let x = ox + 1; x < ox + w - 1; x++) {
        const t = get(x, y);
        if (t !== TILE_TYPE.GRASS) continue;
        // 紧邻道路的草地才有资格盖房（临街而建）
        const nearRoad =
          get(x + 1, y) === TILE_TYPE.ROAD || get(x - 1, y) === TILE_TYPE.ROAD ||
          get(x, y + 1) === TILE_TYPE.ROAD || get(x, y - 1) === TILE_TYPE.ROAD;
        if (nearRoad && rng() < 0.55) set(x, y, TILE_TYPE.HOUSE);
      }
    }

    // 6. 城里没盖房的空地撒几棵树点缀
    for (let y = oy + 1; y < oy + h - 1; y++) {
      for (let x = ox + 1; x < ox + w - 1; x++) {
        if (get(x, y) === TILE_TYPE.GRASS && rng() < 0.12) set(x, y, TILE_TYPE.FOREST);
      }
    }
  },

  // 按高度值划分地形
  classify(e) {
    if (e < 0.28) return TILE_TYPE.WATER;
    if (e < 0.33) return TILE_TYPE.SAND;
    if (e < 0.55) return TILE_TYPE.GRASS;
    if (e < 0.72) return TILE_TYPE.FOREST;
    return TILE_TYPE.MOUNTAIN;
  },

  // 找一个安全出生点：从地图中心螺旋往外找第一块可行走的草地
  findSpawn() {
    const cx = CONFIG.MAP_W >> 1, cy = CONFIG.MAP_H >> 1;
    for (let r = 0; r < 50; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (this.walkable(x, y) &&
              this.tiles[y][x] === TILE_TYPE.GRASS) {
            this.spawn = { x, y };
            return;
          }
        }
      }
    }
    this.spawn = { x: cx, y: cy }; // 兜底
  },

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < CONFIG.MAP_W && y < CONFIG.MAP_H;
  },

  // 是否可通行：水、山、房屋、城墙、喷泉不能走
  walkable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const t = this.tiles[y][x];
    return t !== TILE_TYPE.WATER && t !== TILE_TYPE.MOUNTAIN &&
           t !== TILE_TYPE.HOUSE && t !== TILE_TYPE.WALL &&
           t !== TILE_TYPE.FOUNTAIN;
  },

  // 人物当前是否在城市里（返回城市名，不在则返回 null）
  cityAt(x, y) {
    for (const c of this.cities) {
      if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c.name;
    }
    return null;
  },

  tileAt(x, y) {
    return this.inBounds(x, y) ? this.tiles[y][x] : TILE_TYPE.WATER;
  },
};
