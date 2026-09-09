// 世界：斗罗大陆 1200×1200，按需生成（tileAt 随时计算任意格子，不存整张地图）
//
// 三层结构：
//   1. 大陆骨架（正史地理）：西海、北境天山、南境沙漠、南海、海神岛
//   2. 群系：星斗大森林（圈层结构，从边缘百年到核心万年）、基础地形
//   3. 地标城市：6 座城市按正史相对位置落位，每座城独立生成函数，内部布局懒加载
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

// ---- 六座城市的独立生成函数 ---------------------------------------------
// 约定：每个函数接收 (c, g, set, get, rng)，在 g[y][x] 上写入 TILE_TYPE 枚举。
// c 是城市对象 {x,y,w,h,name,seed,tier}。
// 最后调用 finalizeCity 统一收尾（草坪化剩余草地、边界检查）。

// 通用：填充矩形
function fillRect(g, x0, y0, x1, y1, t) {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = t;
}

// 通用：画直线道路（水平或垂直，自动判断）
function roadLine(g, x0, y0, x1, y1) {
  if (x0 === x1) {
    const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0];
    for (let y = a; y <= b; y++)
      if (y >= 0 && y < g.length && x0 >= 0 && x0 < g[0].length) g[y][x0] = TILE_TYPE.ROAD;
  } else {
    const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
    for (let x = a; x <= b; x++)
      if (y0 >= 0 && y0 < g.length && x >= 0 && x < g[0].length) g[y0][x] = TILE_TYPE.ROAD;
  }
}

// 通用：城墙（带四个城门洞）
function cityWalls(g, w, h, gates) {
  for (let x = 0; x < w; x++) { g[0][x] = TILE_TYPE.WALL; g[h - 1][x] = TILE_TYPE.WALL; }
  for (let y = 0; y < h; y++) { g[y][0] = TILE_TYPE.WALL; g[y][w - 1] = TILE_TYPE.WALL; }
  for (const gx of gates.x) { g[0][gx] = TILE_TYPE.ROAD; g[h - 1][gx] = TILE_TYPE.ROAD; }
  for (const gy of gates.y) { g[gy][0] = TILE_TYPE.ROAD; g[gy][w - 1] = TILE_TYPE.ROAD; }
}

// 通用：沿街两侧放房子，指定路段和密度
function lineHouses(g, x0, y0, x1, y1, rng, density = 0.55, w = 1, sides = 2) {
  if (x0 === x1) {
    const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0];
    for (let y = a + 1; y < b; y++) {
      if (sides !== 2 && sides !== 0) {}
      if (sides & 1) { // 左侧
        const nx = x0 - 1;
        if (nx >= 0 && g[y][nx] === TILE_TYPE.LAWN && rng() < density) g[y][nx] = TILE_TYPE.HOUSE;
      }
      if (sides & 2) { // 右侧
        const nx = x0 + 1;
        if (nx < g[0].length && g[y][nx] === TILE_TYPE.LAWN && rng() < density) g[y][nx] = TILE_TYPE.HOUSE;
      }
    }
  } else {
    const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
    for (let x = a + 1; x < b; x++) {
      if (sides & 1) { // 上方
        const ny = y0 - 1;
        if (ny >= 0 && g[ny][x] === TILE_TYPE.LAWN && rng() < density) g[ny][x] = TILE_TYPE.HOUSE;
      }
      if (sides & 2) { // 下方
        const ny = y0 + 1;
        if (ny < g.length && g[ny][x] === TILE_TYPE.LAWN && rng() < density) g[ny][x] = TILE_TYPE.HOUSE;
      }
    }
  }
}

// 1. 圣魂村：最小的村，一条主街、武魂殿小殿、几户人家、村头大槐树
function genShenghunVillage(c, g, set, get, rng) {
  const w = c.w, h = c.h;
  // 一条东西主街（偏南）
  const mainY = h - 6;
  for (let x = 1; x < w - 1; x++) g[mainY][x] = TILE_TYPE.ROAD;
  // 南北短巷连到村北
  const midX = Math.floor(w / 2);
  for (let y = 2; y < mainY; y++) g[y][midX] = TILE_TYPE.ROAD;

  // 村北中央：武魂殿小殿（2×2 神庙，前有小广场）
  fillRect(g, midX - 1, 2, midX, 4, TILE_TYPE.TEMPLE);
  fillRect(g, midX - 2, 5, midX + 1, 5, TILE_TYPE.PLAZA);

  // 村头老槐树（西南角，大树 = 3 格 FOREST）
  g[mainY - 1][1] = TILE_TYPE.FOREST;
  g[mainY - 2][1] = TILE_TYPE.FOREST;
  g[mainY - 1][2] = TILE_TYPE.FOREST;

  // 主街北侧：几户人家
  for (let x = 2; x < w - 2; x++) {
    if (x === midX || x === midX - 1 || x === midX + 1) continue;
    if (rng() < 0.5) g[mainY - 1][x] = TILE_TYPE.HOUSE;
    if (rng() < 0.3) g[mainY - 2][x] = TILE_TYPE.HOUSE;
  }
  // 主街南侧：两户
  for (let x = 3; x < w - 3; x += 2) {
    if (rng() < 0.5) g[mainY + 1][x] = TILE_TYPE.HOUSE;
  }

  // 村外围墙（简化：没有正式城墙，一圈篱笆=草地视觉区分就行，省一个地形类型）
  // 没有城墙——村子是开放的

  // 剩下的空地 = 草坪（finalizeCity 里统一做）
}

// 2. 诺丁城：镇级，十字大街、武魂分殿、学院区、市集、平民区
function genNuodingCity(c, g, set, get, rng) {
  const w = c.w, h = c.h;
  const mx = Math.floor(w / 2), my = Math.floor(h / 2);

  cityWalls(g, w, h, { x: [mx], y: [my] });

  // 十字大街
  for (let x = 1; x < w - 1; x++) g[my][x] = TILE_TYPE.ROAD;
  for (let y = 1; y < h - 1; y++) g[y][mx] = TILE_TYPE.ROAD;
  // 中心小广场
  fillRect(g, mx - 1, my - 1, mx + 1, my + 1, TILE_TYPE.PLAZA);

  // 东城：武魂分殿（东西主街东段北侧，3×3 殿+前广场）
  const tX = mx + 5, tY = my - 5;
  fillRect(g, tX, tY, tX + 3, tY + 3, TILE_TYPE.TEMPLE);
  fillRect(g, tX - 1, tY + 4, tX + 4, tY + 4, TILE_TYPE.PLAZA);
  // 殿前连到主街的路
  for (let y = my - 1; y > tY + 4; y--) g[y][tX + 2] = TILE_TYPE.ROAD;

  // 北城：学院区（诺丁学院，3×4 学院建筑群 + 操场）
  const acX = mx - 8, acY = 2;
  fillRect(g, acX, acY + 1, acX + 4, acY + 4, TILE_TYPE.COLLEGE);
  fillRect(g, acX + 5, acY + 2, acX + 8, acY + 5, TILE_TYPE.LAWN); // 操场/草地
  // 学院路（南北向支路）
  for (let y = 1; y < my; y++) g[y][acX - 2] = TILE_TYPE.ROAD;
  // 东西横向支路
  for (let x = acX - 2; x <= acX + 9; x++) g[acY][x] = TILE_TYPE.ROAD;

  // 南城：市集（主街南侧一大片 MARKET 格）
  fillRect(g, mx - 4, my + 2, mx + 4, my + 6, TILE_TYPE.MARKET);

  // 西城 + 其他零散民宅
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      // 路旁边的草地有几率变民宅
      const nearRoad =
        (x > 0 && g[y][x - 1] === TILE_TYPE.ROAD) ||
        (x < w - 1 && g[y][x + 1] === TILE_TYPE.ROAD) ||
        (y > 0 && g[y - 1][x] === TILE_TYPE.ROAD) ||
        (y < h - 1 && g[y + 1][x] === TILE_TYPE.ROAD);
      if (nearRoad && rng() < 0.45) g[y][x] = TILE_TYPE.HOUSE;
    }
  }

  // 几处花圃点缀
  for (let i = 0; i < 6; i++) {
    const fx = 2 + Math.floor(rng() * (w - 4));
    const fy = 2 + Math.floor(rng() * (h - 4));
    if (g[fy][fx] === TILE_TYPE.LAWN) g[fy][fx] = TILE_TYPE.FLOWER;
  }
}

// 3. 史莱克学院：纯学院风，没有城墙，教学楼围绕中央大操场
function genShrekAcademy(c, g, set, get, rng) {
  const w = c.w, h = c.h;
  const mx = Math.floor(w / 2), my = Math.floor(h / 2);

  // 外围不设城墙，一圈树篱（FOREST 当绿化带）
  for (let x = 2; x < w - 2; x++) {
    if (x === mx) continue; // 正门
    g[1][x] = TILE_TYPE.FOREST;
    g[h - 2][x] = TILE_TYPE.FOREST;
  }
  for (let y = 2; y < h - 2; y++) {
    g[y][1] = TILE_TYPE.FOREST;
    g[y][w - 2] = TILE_TYPE.FOREST;
  }

  // 正门（南门）进去的中央大道
  for (let y = h - 3; y > 5; y--) g[y][mx] = TILE_TYPE.ROAD;

  // 中央大操场（PLAZA 大片空地）
  fillRect(g, mx - 8, my - 4, mx + 8, my + 6, TILE_TYPE.PLAZA);

  // 北侧主教学楼（5×3，学院建筑）
  fillRect(g, mx - 5, 3, mx + 5, 7, TILE_TYPE.COLLEGE);
  fillRect(g, mx - 2, 7, mx + 2, 8, TILE_TYPE.PLAZA); // 楼前台阶广场

  // 东西两侧教学楼
  fillRect(g, mx - 16, my - 6, mx - 10, my - 1, TILE_TYPE.COLLEGE);
  fillRect(g, mx + 10, my - 6, mx + 16, my - 1, TILE_TYPE.COLLEGE);

  // 武魂测试馆（东侧独立建筑）
  fillRect(g, mx + 12, my + 2, mx + 18, my + 5, TILE_TYPE.TEMPLE);

  // 食堂（西南角）
  fillRect(g, mx - 18, my + 4, mx - 12, my + 7, TILE_TYPE.HOUSE);

  // 宿舍区（西北角，几排小房子）
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 5; dx++) {
      if (rng() < 0.75) g[14 + dy * 3][mx - 22 + dx * 4] = TILE_TYPE.HOUSE;
    }
  }
  // 宿舍区路
  for (let y = 14; y < 24; y++) g[y][mx - 20] = TILE_TYPE.ROAD;
  for (let x = mx - 24; x <= mx - 4; x++) g[my + 8][x] = TILE_TYPE.ROAD;

  // 环操场小路
  for (let x = mx - 9; x <= mx + 9; x++) {
    g[my - 5][x] = TILE_TYPE.ROAD;
    g[my + 7][x] = TILE_TYPE.ROAD;
  }
  for (let y = my - 5; y <= my + 7; y++) {
    g[y][mx - 9] = TILE_TYPE.ROAD;
    g[y][mx + 9] = TILE_TYPE.ROAD;
  }

  // 零散绿化：花圃和树
  for (let i = 0; i < 15; i++) {
    const fx = 3 + Math.floor(rng() * (w - 6));
    const fy = 3 + Math.floor(rng() * (h - 6));
    if (g[fy][fx] === TILE_TYPE.LAWN) g[fy][fx] = rng() < 0.5 ? TILE_TYPE.FOREST : TILE_TYPE.FLOWER;
  }

  // 主入口标牌（南门外，用广场格代替）
  fillRect(g, mx - 1, h - 2, mx + 1, h - 1, TILE_TYPE.PLAZA);
}

// 4. 索托城：商业大城，中轴线 + 大斗魂场 + 密集店铺
function genSuotoCity(c, g, set, get, rng) {
  const w = c.w, h = c.h;
  const mx = Math.floor(w / 2), my = Math.floor(h / 2);

  cityWalls(g, w, h, { x: [mx], y: [my, my - 12, my + 12] });

  // 中央南北大街 + 东西主街
  for (let x = 2; x < w - 2; x++) g[my][x] = TILE_TYPE.ROAD;
  for (let y = 2; y < h - 2; y++) g[y][mx] = TILE_TYPE.ROAD;
  // 两条辅助东西街
  for (let x = 2; x < w - 2; x++) {
    g[my - 15][x] = TILE_TYPE.ROAD;
    g[my + 15][x] = TILE_TYPE.ROAD;
  }
  // 两条辅助南北街
  for (let y = 2; y < h - 2; y++) {
    g[y][mx - 18] = TILE_TYPE.ROAD;
    g[y][mx + 18] = TILE_TYPE.ROAD;
  }

  // 中心广场 + 喷泉
  fillRect(g, mx - 3, my - 3, mx + 3, my + 3, TILE_TYPE.PLAZA);
  g[my][mx] = TILE_TYPE.FOUNTAIN;

  // 大斗魂场（城北中心，4×5 大型建筑）
  const arenaX = mx - 4, arenaY = 4;
  fillRect(g, arenaX, arenaY, arenaX + 8, arenaY + 6, TILE_TYPE.PALACE);
  // 门前广场
  fillRect(g, arenaX - 2, arenaY + 6, arenaX + 10, arenaY + 8, TILE_TYPE.PLAZA);
  // 连到中心
  for (let y = arenaY + 8; y < my; y++) g[y][mx] = TILE_TYPE.ROAD;

  // 东西两大市集（密集店铺区）
  fillRect(g, 3, my - 12, mx - 20, my - 3, TILE_TYPE.MARKET);
  fillRect(g, mx + 20, my - 12, w - 4, my - 3, TILE_TYPE.MARKET);

  // 南部民宅区 + 旅店
  for (let y = my + 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      const near =
        (x > 0 && g[y][x - 1] === TILE_TYPE.ROAD) ||
        (x < w - 1 && g[y][x + 1] === TILE_TYPE.ROAD) ||
        (y > 0 && g[y - 1][x] === TILE_TYPE.ROAD) ||
        (y < h - 1 && g[y + 1][x] === TILE_TYPE.ROAD);
      if (near && rng() < 0.65) g[y][x] = TILE_TYPE.HOUSE;
    }
  }

  // 几处花圃点缀
  for (let i = 0; i < 12; i++) {
    const fx = 3 + Math.floor(rng() * (w - 6));
    const fy = 3 + Math.floor(rng() * (h - 6));
    if (g[fy][fx] === TILE_TYPE.LAWN) g[fy][fx] = TILE_TYPE.FLOWER;
  }
}

// 5. 星罗城：帝都，三道城墙（宫城/皇城/外城），棋盘街格局
function genXingluoCity(c, g, set, get, rng) {
  const w = c.w, h = c.h;
  const mx = Math.floor(w / 2), my = Math.floor(h / 2);

  // 外城墙
  cityWalls(g, w, h, { x: [mx, mx - 25, mx + 25], y: [my, my - 20, my + 20] });

  // 皇城城墙（居中，约占中心 25%）
  const pw = Math.floor(w * 0.38), ph = Math.floor(h * 0.42);
  const px0 = mx - Math.floor(pw / 2), py0 = my - Math.floor(ph / 2);
  const px1 = px0 + pw, py1 = py0 + ph;
  for (let x = px0; x <= px1; x++) { g[py0][x] = TILE_TYPE.WALL; g[py1][x] = TILE_TYPE.WALL; }
  for (let y = py0; y <= py1; y++) { g[y][px0] = TILE_TYPE.WALL; g[y][px1] = TILE_TYPE.WALL; }
  // 皇城南门（正门）+ 北门
  g[py0][mx] = TILE_TYPE.ROAD;
  g[py1][mx] = TILE_TYPE.ROAD;
  g[py0 + Math.floor(ph / 2)][px0] = TILE_TYPE.ROAD;
  g[py0 + Math.floor(ph / 2)][px1] = TILE_TYPE.ROAD;

  // 宫城（皇城内圈，PALACE）
  const cw = Math.floor(pw * 0.55), ch_ = Math.floor(ph * 0.55);
  const cx0 = mx - Math.floor(cw / 2), cy0 = my - Math.floor(ch_ / 2);
  const cx1 = cx0 + cw, cy1 = cy0 + ch_;
  fillRect(g, cx0, cy0, cx1, cy1, TILE_TYPE.PALACE);
  // 宫内花园（草坪点缀）
  for (let i = 0; i < 8; i++) {
    const fx = cx0 + 2 + Math.floor(rng() * (cw - 4));
    const fy = cy0 + 2 + Math.floor(rng() * (ch_ - 4));
    if (g[fy][fx] === TILE_TYPE.PALACE) g[fy][fx] = TILE_TYPE.FLOWER;
  }
  // 宫城前广场
  fillRect(g, cx0 - 3, cy1 + 1, cx1 + 3, cy1 + 3, TILE_TYPE.PLAZA);

  // 皇城内部：官署区 + 官邸
  for (let y = py0 + 1; y < py1; y++) {
    for (let x = px0 + 1; x < px1; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      if (rng() < 0.35) g[y][x] = TILE_TYPE.HOUSE;
    }
  }
  // 皇城内十字大街
  for (let x = px0 + 1; x < px1; x++) g[my][x] = TILE_TYPE.ROAD;
  for (let y = py0 + 1; y < py1; y++) g[y][mx] = TILE_TYPE.ROAD;

  // 外城棋盘街：约每 10 格一条横/竖街
  for (let x = 5; x < w - 5; x += 10)
    for (let y = 2; y < h - 2; y++)
      if (g[y][x] === TILE_TYPE.LAWN) g[y][x] = TILE_TYPE.ROAD;
  for (let y = 5; y < h - 5; y += 10)
    for (let x = 2; x < w - 2; x++)
      if (g[y][x] === TILE_TYPE.LAWN) g[y][x] = TILE_TYPE.ROAD;

  // 外城：贵族区（东北）、市集（西南）、平民区（东南、西）
  // 东北贵族区 = 稀疏大宅
  for (let y = 2; y < py0 - 2; y++) {
    for (let x = mx + 1; x < w - 2; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      const near =
        (x > 0 && g[y][x - 1] === TILE_TYPE.ROAD) ||
        (y > 0 && g[y - 1][x] === TILE_TYPE.ROAD);
      if (near && rng() < 0.2) g[y][x] = TILE_TYPE.HOUSE;
    }
  }
  // 西南市集
  fillRect(g, 3, my + 12, mx - 12, h - 5, TILE_TYPE.MARKET);
  // 其余外城民宅（中等密度）
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      // 已在皇城/宫城里的跳过（已经生成过）
      if (x >= px0 && x <= px1 && y >= py0 && y <= py1) continue;
      const near =
        (x > 0 && g[y][x - 1] === TILE_TYPE.ROAD) ||
        (x < w - 1 && g[y][x + 1] === TILE_TYPE.ROAD) ||
        (y > 0 && g[y - 1][x] === TILE_TYPE.ROAD) ||
        (y < h - 1 && g[y + 1][x] === TILE_TYPE.ROAD);
      if (near && rng() < 0.5) g[y][x] = TILE_TYPE.HOUSE;
    }
  }

  // 寺庙点缀
  g[3][mx - 35] = TILE_TYPE.TEMPLE;
  g[h - 4][mx + 30] = TILE_TYPE.TEMPLE;

  // 中心大花园
  fillRect(g, mx - 4, py1 + 4, mx + 4, py1 + 10, TILE_TYPE.LAWN);
  for (let i = 0; i < 12; i++) {
    const fx = mx - 3 + Math.floor(rng() * 7);
    const fy = py1 + 5 + Math.floor(rng() * 5);
    g[fy][fx] = rng() < 0.6 ? TILE_TYPE.FLOWER : TILE_TYPE.FOREST;
  }
}

// 6. 武魂城：圣地，三圈同心结构 + 中央武魂殿圣殿
function genWuhunCity(c, g, set, get, rng) {
  const w = c.w, h = c.h;
  const mx = Math.floor(w / 2), my = Math.floor(h / 2);

  // 外城墙 + 六道城门（东西南北+东南+西北？就四道主门吧）
  cityWalls(g, w, h, { x: [mx, mx - 30, mx + 30], y: [my, my - 25, my + 25] });

  // 三圈同心结构：中心圣殿 → 内圈（分殿+贵族） → 中圈（神职人员） → 外圈（平民商旅）
  const rInner = 22;   // 内圈半径（格）
  const rMid = 45;     // 中圈半径
  const rOuter = Math.min(w, h) / 2 - 4;

  // 环形的墙（近似八角形，用直线段拼）— 简化成方形墙 + 拱门
  // 内圈墙（方形）
  const ix0 = mx - rInner, ix1 = mx + rInner;
  const iy0 = my - rInner, iy1 = my + rInner;
  for (let x = ix0; x <= ix1; x++) { g[iy0][x] = TILE_TYPE.WALL; g[iy1][x] = TILE_TYPE.WALL; }
  for (let y = iy0; y <= iy1; y++) { g[y][ix0] = TILE_TYPE.WALL; g[y][ix1] = TILE_TYPE.WALL; }
  g[iy0][mx] = TILE_TYPE.ROAD; g[iy1][mx] = TILE_TYPE.ROAD;
  g[my][ix0] = TILE_TYPE.ROAD; g[my][ix1] = TILE_TYPE.ROAD;

  // 中圈墙（方形）
  const mx0 = mx - rMid, mx1 = mx + rMid;
  const my0 = my - rMid, my1 = my + rMid;
  for (let x = mx0; x <= mx1; x++) { g[my0][x] = TILE_TYPE.WALL; g[my1][x] = TILE_TYPE.WALL; }
  for (let y = my0; y <= my1; y++) { g[y][mx0] = TILE_TYPE.WALL; g[y][mx1] = TILE_TYPE.WALL; }
  g[my0][mx] = TILE_TYPE.ROAD; g[my1][mx] = TILE_TYPE.ROAD;
  g[my][mx0] = TILE_TYPE.ROAD; g[my][mx1] = TILE_TYPE.ROAD;

  // 中央圣殿（8×8 巨型 TEMPLE + 前广场）
  const tx0 = mx - 5, tx1 = mx + 5;
  const ty0 = my - 7, ty1 = my + 3;
  fillRect(g, tx0, ty0, tx1, ty1, TILE_TYPE.TEMPLE);
  // 殿前大台阶广场
  fillRect(g, tx0 - 3, ty1 + 1, tx1 + 3, ty1 + 4, TILE_TYPE.PLAZA);
  // 圣殿前大道（南向）
  for (let y = ty1 + 5; y < h - 3; y++) g[y][mx] = TILE_TYPE.ROAD;
  // 东西横贯大道
  for (let x = 3; x < w - 3; x++) g[my][x] = TILE_TYPE.ROAD;
  // 南北纵贯大道
  for (let y = 3; y < h - 3; y++) g[y][mx] = TILE_TYPE.ROAD;

  // 内圈（内圈墙内，圣殿外）：武魂分殿 + 长老殿 + 草坪
  for (let y = iy0 + 1; y < iy1; y++) {
    for (let x = ix0 + 1; x < ix1; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      if (rng() < 0.15) g[y][x] = TILE_TYPE.TEMPLE; // 小型分殿
      else if (rng() < 0.25) g[y][x] = TILE_TYPE.FLOWER;
    }
  }
  // 内圈环路
  for (let x = ix0 + 2; x < ix1 - 1; x++) { g[iy0 + 2][x] = TILE_TYPE.ROAD; g[iy1 - 2][x] = TILE_TYPE.ROAD; }
  for (let y = iy0 + 2; y < iy1 - 1; y++) { g[y][ix0 + 2] = TILE_TYPE.ROAD; g[y][ix1 - 2] = TILE_TYPE.ROAD; }

  // 中圈：神职人员居住区 + 学院（武魂学院）
  fillRect(g, mx0 + 3, my0 + 4, mx0 + 12, my0 + 12, TILE_TYPE.COLLEGE); // 武魂学院（西北）
  for (let y = my0 + 1; y < my1; y++) {
    for (let x = mx0 + 1; x < mx1; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      // 不在内圈里
      if (x > ix0 && x < ix1 && y > iy0 && y < iy1) continue;
      const near =
        (x > 0 && g[y][x - 1] === TILE_TYPE.ROAD) ||
        (y > 0 && g[y - 1][x] === TILE_TYPE.ROAD);
      if (near && rng() < 0.3) g[y][x] = TILE_TYPE.HOUSE;
    }
  }
  // 中圈环路
  for (let x = mx0 + 3; x < mx1 - 2; x++) { g[my0 + 3][x] = TILE_TYPE.ROAD; g[my1 - 3][x] = TILE_TYPE.ROAD; }
  for (let y = my0 + 3; y < my1 - 2; y++) { g[y][mx0 + 3] = TILE_TYPE.ROAD; g[y][mx1 - 3] = TILE_TYPE.ROAD; }

  // 外圈：密集民居 + 市集 + 旅店
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (g[y][x] !== TILE_TYPE.LAWN) continue;
      // 跳过中圈以里
      if (x >= mx0 && x <= mx1 && y >= my0 && y <= my1) continue;
      const near =
        (x > 0 && g[y][x - 1] === TILE_TYPE.ROAD) ||
        (x < w - 1 && g[y][x + 1] === TILE_TYPE.ROAD) ||
        (y > 0 && g[y - 1][x] === TILE_TYPE.ROAD) ||
        (y < h - 1 && g[y + 1][x] === TILE_TYPE.ROAD);
      if (near && rng() < 0.6) g[y][x] = TILE_TYPE.HOUSE;
    }
  }

  // 东西两市集
  fillRect(g, 4, my - 8, mx0 - 3, my + 6, TILE_TYPE.MARKET);
  fillRect(g, mx1 + 3, my - 8, w - 5, my + 6, TILE_TYPE.MARKET);

  // 天使像（城南入口大广场中央，用 fountain 占位+周围花圃）
  fillRect(g, mx - 3, h - 10, mx + 3, h - 5, TILE_TYPE.PLAZA);
  g[h - 8][mx] = TILE_TYPE.FOUNTAIN;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (Math.abs(dx) + Math.abs(dy) === 4) {
      const fx = mx + dx, fy = h - 8 + dy;
      if (fx > 2 && fx < w - 3 && fy > 2 && fy < h - 3 && g[fy][fx] === TILE_TYPE.LAWN)
        g[fy][fx] = TILE_TYPE.FLOWER;
    }
  }
}

// ---- 生成器映射 -----------------------------------------------------------

const CITY_GENERATORS = {
  '圣魂村': genShenghunVillage,
  '诺丁城': genNuodingCity,
  '史莱克学院': genShrekAcademy,
  '索托城': genSuotoCity,
  '星罗城': genXingluoCity,
  '武魂城': genWuhunCity,
};

// =============================================================================

const World = {
  W: CONFIG.WORLD_W, H: CONFIG.WORLD_H,
  cities: [],              // {x, y, w, h, name, seed, tier}
  godIsland: { x: 120, y: 450, rx: 40, ry: 34 },   // 海神岛（西侧大海）
  // 星斗大森林：圈层结构（中心点 + 半径 + 噪声软边），从边缘百年到核心万年
  forest: { cx: 640, cy: 520, rOuter: 160, rMid: 100, rCore: 45 }, // 半径单位：格
  spawn: null,
  _layouts: new Map(),     // 城市内部布局缓存 name -> 二维数组

  // 初始化：只建噪声层和城市定义，不生成任何格子
  generate(seed) {
    this.seed = seed;
    const rng = mulberry32(seed);
    this.n1 = makeNoiseLayer(this.W, this.H, 90, rng);   // 大起伏
    this.n2 = makeNoiseLayer(this.W, this.H, 32, rng);   // 中起伏
    this.n3 = makeNoiseLayer(this.W, this.H, 12, rng);   // 细节
    this.coast = makeNoiseLayer(this.W, this.H, 50, rng); // 海岸线扰动
    this.forestN = makeNoiseLayer(this.W, this.H, 24, rng); // 森林疏密纹理

    // 六大地标（正史相对位置：圣魂村→诺丁城→史莱克在北，索托城中，
    // 武魂城靠西南方，星罗城在最南）。规模按 5 级拉开。
    this.cities = [
      { x: 260, y: 140, w: 20,  h: 16, name: '圣魂村',     tier: 'village' },
      { x: 380, y: 210, w: 40,  h: 32, name: '诺丁城',     tier: 'town'    },
      { x: 540, y: 280, w: 70,  h: 55, name: '史莱克学院', tier: 'city'    },
      { x: 470, y: 420, w: 70,  h: 55, name: '索托城',     tier: 'city'    },
      { x: 740, y: 780, w: 110, h: 90, name: '星罗城',     tier: 'capital' },
      { x: 700, y: 560, w: 160, h: 140, name: '武魂城',     tier: 'holy'    },
    ].map((c, i) => ({ ...c, seed: seed + 1000 + i * 77 }));

    // 出生点：圣魂村主街中段
    const v = this.cities[0];
    this.spawn = { x: v.x + (v.w >> 1), y: v.y + v.h - 6 };

    // 城际道路
    this.generateRoads(seed);
    // 风景湖（道路穿湖 → 湖中段成为木桥）
    this.placeScenicLakes(rng);

    // 地形缓存：生成全部完成后才启用。tileAt 此后是 (x,y) 的纯函数，
    // 每格只算一次（存 t+1，0 = 未计算）。生成期间必须为 null——
    // carveRoad 会边查 tileAt 边往 roadTiles 加，那时缓存会存下没铺路的旧值。
    this._tc = new Uint8Array(this.W * this.H);
  },

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; },

  // 确定性哈希（世界坐标 → 0~1）：植被和道路的自然抖动
  hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  },

  // 城门选择：朝目标城市方向的那座门（取最近的门）
  gateToward(city, target) {
    const cx = city.x + (city.w >> 1), cy = city.y + (city.h >> 1);
    const tx = target.x + (target.w >> 1), ty = target.y + (target.h >> 1);
    const dx = tx - cx, dy = ty - cy;
    // 水平距离更大 → 从东西门出；否则南北门
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
              t === TILE_TYPE.WALL || t === TILE_TYPE.FOUNTAIN ||
              t === TILE_TYPE.TEMPLE || t === TILE_TYPE.PALACE ||
              t === TILE_TYPE.COLLEGE) continue;
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
            t2 !== TILE_TYPE.HOUSE && t2 !== TILE_TYPE.WALL &&
            t2 !== TILE_TYPE.FOUNTAIN && t2 !== TILE_TYPE.TEMPLE &&
            t2 !== TILE_TYPE.PALACE && t2 !== TILE_TYPE.COLLEGE) {
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
        if (Math.abs(x - (c.x + c.w / 2)) < Math.max(c.w, 50) &&
            Math.abs(y - (c.y + c.h / 2)) < Math.max(c.h, 50)) { okDist = false; break; }
      }
      const tHere = this.tileAt(x, y);
      if (okDist && this.inBounds(x, y) &&
          tHere !== TILE_TYPE.WATER && tHere !== TILE_TYPE.MOUNTAIN) far.push({ x, y });
    }
    // 打乱（确定性），取相距足够远的 3 处放湖
    far.sort((a, b) => this.hash(a.x, a.y) - this.hash(b.x, b.y));
    const chosen = [];
    for (const s of far) {
      if (chosen.every(c => Math.hypot(c.x - s.x, c.y - s.y) > 180)) {
        chosen.push(s);
        if (chosen.length >= 3) break;
      }
    }
    for (const s of chosen) {
      this.lakes.push({ x: s.x, y: s.y, rx: 9 + Math.floor(rng() * 5), ry: 7 + Math.floor(rng() * 4) });
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

  // 生成全部城际道路
  generateRoads(seed) {
    this.roadTiles = new Set();
    this.bridgeTiles = new Set();
    const rng = mulberry32(seed + 999);
    // 主线：圣魂村 → 诺丁 → 史莱克 → 索托 → 武魂城 → 星罗
    const links = [
      [0, 1], [1, 2], [2, 3], [3, 5], [5, 4],
      [1, 3],  // 诺丁 → 索托 支线
    ];
    for (const [a, b] of links) this.carveRoad(this.cities[a], this.cities[b], rng);
  },

  // 城市覆盖（城郊缓冲 = 城市尺寸的 1/3 再加 8 格，大城缓冲更大）
  cityCovering(x, y) {
    for (const c of this.cities) {
      const padX = Math.max(12, Math.floor(c.w / 3));
      const padY = Math.max(12, Math.floor(c.h / 3));
      if (x >= c.x - padX && x < c.x + c.w + padX &&
          y >= c.y - padY && y < c.y + c.h + padY) return c;
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
    for (let y = 0; y < c.h; y++) g[y] = new Array(c.h).fill(TILE_TYPE.GRASS);
    // 注意：上面错写成 c.h 了（w 列），下面修正
    for (let y = 0; y < c.h; y++) g[y] = new Array(c.w).fill(TILE_TYPE.GRASS);

    const set = (x, y, t) => { if (x >= 0 && y >= 0 && x < c.w && y < c.h) g[y][x] = t; };
    const get = (x, y) => (x >= 0 && y >= 0 && x < c.w && y < c.h) ? g[y][x] : -1;

    const gen = CITY_GENERATORS[c.name];
    if (gen) gen(c, g, set, get, rng);

    // 收尾：未使用的 GRASS 改成城内草坪（不长野草、没有野花，干净）
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        if (g[y][x] === TILE_TYPE.GRASS) g[y][x] = TILE_TYPE.LAWN;
      }
    }

    this._layouts.set(c.name, g);
    return g;
  },

  // 核心：任意格子的地形类型（按需计算）
  // 地形查询（带缓存）：每帧有多个全屏遍历在调它，未缓存时噪声计算会吃掉
  // 近 30% 的帧预算。缓存在 generate() 末尾启用，之前直接透传。
  tileAt(x, y) {
    const tc = this._tc;
    if (!tc) return this.computeTile(x, y);
    if (!this.inBounds(x, y)) return TILE_TYPE.WATER;
    const i = y * this.W + x;
    const c = tc[i];
    if (c) return c - 1;
    const t = this.computeTile(x, y);
    tc[i] = t + 1;
    return t;
  },

  // 星斗大森林圈层查询：0 = 外部，1 = 边缘（百年），2 = 中层（千年），3 = 核心（万年）
  forestZone(x, y) {
    const f = this.forest;
    const dx = x - f.cx, dy = y - f.cy;
    const d = Math.hypot(dx, dy);
    const noise = (this.coast(x, y) - 0.5) * 18; // 软边 ±9 格
    if (d > f.rOuter + noise) return 0;
    if (d > f.rMid + noise * 0.7) return 1;
    if (d > f.rCore + noise * 0.3) return 2;
    return 3;
  },

  computeTile(x, y) {
    if (!this.inBounds(x, y)) return TILE_TYPE.WATER;

    // 城市内部布局优先
    const cIn = this.cityAt(x, y);
    if (cIn) {
      const c = this.cities.find(cc => cc.name === cIn);
      return this.getCityLayout(c)[y - c.y][x - c.x];
    }

    // 城际道路（穿过城郊缓冲和野外，连接各城城门）
    if (this.roadTiles.has(x + ',' + y)) return TILE_TYPE.PATH;

    // 风景湖（湖面渲染成水；路上的湖格已被上面 road 分支接管 = 木桥）
    if (this.inLakeRaw(x, y)) return TILE_TYPE.WATER;

    // 城郊缓冲（城越大缓冲越宽，保证坐落在平原上）
    const c = this.cityCovering(x, y);
    if (c) return TILE_TYPE.GRASS;

    // 海神岛（西侧大海中的仙岛）
    const gi = this.godIsland;
    const ddx = (x - gi.x) / gi.rx, ddy = (y - gi.y) / gi.ry;
    const dIsland = ddx * ddx + ddy * ddy;
    if (dIsland < 1.2) {
      const edge = dIsland > 0.75 || this.forestN(x, y) > 0.6;
      return edge ? TILE_TYPE.SAND : TILE_TYPE.GRASS;
    }

    // 大陆骨架：西海 / 东海海岸线（噪声扰动）
    const wEdge = 180 + (this.coast(x, y) - 0.5) * 90;
    const eEdge = 1080 + (this.coast(x, y) - 0.5) * 80;
    if (x < wEdge || x > eEdge) return TILE_TYPE.WATER;

    // 北境天山
    if (y < 50 + this.n2(x, y) * 30) return TILE_TYPE.MOUNTAIN;

    // 南海
    const sEdge = 1140 + (this.coast(x, y) - 0.5) * 50;
    if (y > sEdge) return TILE_TYPE.WATER;

    // 南境沙漠（夹在星罗城南与南海之间）
    if (y > 900 + (this.coast(x, y) - 0.5) * 40) return TILE_TYPE.SAND;

    // 星斗大森林：圈层结构
    const fz = this.forestZone(x, y);
    if (fz > 0) {
      const n = this.forestN(x, y) + (this.hash(x, y) - 0.5) * 0.12;
      // 核心区（万年）：几乎全是密林
      if (fz === 3) return n > 0.25 ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;
      // 中层（千年）：密林为主，夹杂空地
      if (fz === 2) return n > 0.45 ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;
      // 边缘（百年）：疏林
      return n > 0.6 ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;
    }

    // 基础地形：起伏决定草原/碎林/湖泊/山
    const e = this.n1(x, y) * 0.55 + this.n2(x, y) * 0.3 + this.n3(x, y) * 0.15;
    if (e < 0.28) return TILE_TYPE.WATER;   // 内陆湖
    if (e < 0.31) return TILE_TYPE.SAND;    // 湖岸
    if (e < 0.7) {
      const n = this.forestN(x, y) + (this.hash(x + 7, y + 3) - 0.5) * 0.12;
      return n > 0.72 ? TILE_TYPE.FOREST : TILE_TYPE.GRASS;   // 碎林
    }
    return TILE_TYPE.MOUNTAIN;
  },

  // 可通行：山、建筑、城墙、喷泉、神庙、宫殿、学院、花圃阻挡；水可游泳
  walkable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const t = this.tileAt(x, y);
    return t !== TILE_TYPE.MOUNTAIN &&
           t !== TILE_TYPE.HOUSE && t !== TILE_TYPE.WALL &&
           t !== TILE_TYPE.FOUNTAIN && t !== TILE_TYPE.TEMPLE &&
           t !== TILE_TYPE.PALACE && t !== TILE_TYPE.COLLEGE &&
           t !== TILE_TYPE.FLOWER;
  },
};
