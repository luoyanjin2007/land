// 从 AI 生成的素材图集中切图，白底转透明，输出到 assets/sprites/
// 用法: node tools/slice.js
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'sprites');
fs.mkdirSync(OUT, { recursive: true });

// 把接近白色的像素变透明（边缘半透明化，避免白边）
function whitenessToAlpha(img) {
  const w = img.bitmap.width, h = img.bitmap.height;
  img.scan(0, 0, w, h, function (x, y, idx) {
    const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
    const min = Math.min(r, g, b), max = Math.max(r, g, b);
    const whiteness = (min / 255) * (1 - (max - min) / 255);
    if (whiteness > 0.92) {
      this.bitmap.data[idx + 3] = 0;
    } else if (whiteness > 0.78) {
      this.bitmap.data[idx + 3] = Math.round(255 * (0.92 - whiteness) / 0.14);
    }
  });
}

async function main() {
  // ---------- 角色贴图 ----------
  // 找所有有意义大小的连通色块（人物本体 + 被水面隔开的头部等），
  // 返回它们的联合包围盒——只有孤立小噪点被忽略
  function significantBBox(img, alphaMin = 128) {
    const { width: w, height: h, data } = img.bitmap;
    const visited = new Uint8Array(w * h);
    const comps = [];
    const at = (x, y) => data[(y * w + x) * 4 + 3];
    for (let y0 = 0; y0 < h; y0++) {
      for (let x0 = 0; x0 < w; x0++) {
        const i0 = y0 * w + x0;
        if (visited[i0] || at(x0, y0) < alphaMin) { visited[i0] = 1; continue; }
        // 从这个像素做泛洪，统计连通块
        const stack = [x0, y0];
        visited[i0] = 1;
        let minX = x0, maxX = x0, minY = y0, maxY = y0, count = 0;
        while (stack.length) {
          const cy = stack.pop(), cx = stack.pop();
          count++;
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (visited[ni]) continue;
            visited[ni] = 1;
            if (at(nx, ny) < alphaMin) continue;
            stack.push(nx, ny);
          }
        }
        comps.push({ minX, minY, maxX, maxY, count });
      }
    }
    if (!comps.length) return null;
    // 只保留 >= 最大块 5% 的色块（游泳帧的头部与身体被水面隔开，都要保留）
    const largest = Math.max(...comps.map(c => c.count));
    const keep = comps.filter(c => c.count >= largest * 0.05);
    return {
      minX: Math.min(...keep.map(c => c.minX)),
      minY: Math.min(...keep.map(c => c.minY)),
      maxX: Math.max(...keep.map(c => c.maxX)),
      maxY: Math.max(...keep.map(c => c.maxY)),
    };
  }

  // 从一张图里切一帧：去白底 -> 保留有意义的色块 -> 裁到联合包围盒
  async function cutFrame(src, x, y, w, h) {
    const cell = src.clone().crop({ x, y, w, h });
    whitenessToAlpha(cell);
    const box = significantBBox(cell);
    if (!box) throw new Error('没找到人物色块');
    const pad = 2;
    return cell.crop({
      x: Math.max(0, box.minX - pad), y: Math.max(0, box.minY - pad),
      w: box.maxX - box.minX + 1 + pad * 2, h: box.maxY - box.minY + 1 + pad * 2,
    });
  }

  // 每个朝向 4 帧，切完统一垫到相同画布（脚底对齐、水平居中）再缩放
  async function sliceFrames(file, prefix, gridRow, rowCount = 4) {
    const src = await Jimp.read(path.join(ROOT, 'assets', file));
    const n = 4;
    const cw = Math.floor(src.bitmap.width / n);
    const cells = [];
    for (let c = 0; c < n; c++) {
      let cell;
      if (gridRow === undefined) {
        // 横向条带：一列一格，占满整个高度
        cell = await cutFrame(src, c * cw, 0, cw, src.bitmap.height);
      } else {
        // 4×4 网格图集：取指定行的 4 格
        const ch = Math.floor(src.bitmap.height / rowCount);
        cell = await cutFrame(src, c * cw, gridRow * ch, cw, ch);
      }
      cells.push(cell);
    }
    const maxW = Math.max(...cells.map(c => c.bitmap.width));
    const maxH = Math.max(...cells.map(c => c.bitmap.height));
    for (let c = 0; c < n; c++) {
      const canvas = new Jimp({ width: maxW, height: maxH, color: 0x00000000 });
      canvas.composite(cells[c], Math.floor((maxW - cells[c].bitmap.width) / 2), maxH - cells[c].bitmap.height);
      canvas.resize({ w: 72, h: Jimp.AUTO });
      await canvas.write(path.join(OUT, `${prefix}-${c}.png`));
    }
  }

  {
    // 四方向图集是 4×4 网格，第一行 = 朝下（正面）
    await sliceFrames('角色四方向图集.jpeg', 'player-down', 0);
    await sliceFrames('角色背面图集.jpeg', 'player-up');       // 横向条带
    await sliceFrames('角色右向图集.jpeg', 'player-right');    // 横向条带
    await sliceFrames('角色游泳图集.jpeg', 'player-swim');     // 游泳（朝右）：横向条带
    await sliceFrames('角色游泳上下图集.jpeg', 'player-swim-up', 0, 2);   // 游泳（朝上）：2 行图集第一行
    await sliceFrames('角色游泳上下图集.jpeg', 'player-swim-down', 1, 2); // 游泳（朝下）：2 行图集第二行
    // 朝左 = 朝右镜像
    for (let c = 0; c < 4; c++) {
      const cell = await Jimp.read(path.join(OUT, `player-right-${c}.png`));
      cell.flip({ horizontal: true, vertical: false });
      await cell.write(path.join(OUT, `player-left-${c}.png`));
    }
  }

  // 边缘修复：把四周 n 像素的环带替换成向内 n 像素处的像素
  // （AI 图集的白色网格线会渗进格子边缘，裁切+复制双保险去白边）
  function clampEdges(img, n = 3) {
    const w = img.bitmap.width, h = img.bitmap.height, d = img.bitmap.data;
    const get = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    const set = (x, y, p) => { const i = (y * w + x) * 4; d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = p[3]; };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < n || y < n || x >= w - n || y >= h - n) {
          const sx = Math.min(w - 1 - n, Math.max(n, x));
          const sy = Math.min(h - 1 - n, Math.max(n, y));
          set(x, y, get(sx, sy));
        }
      }
    }
  }

  // ---------- 地面瓷砖图集：4 列 × 4 行，整格无缝裁切 ----------
  // 瓷砖是满格贴图，不需要去白底，直接按格切
  const tSrc = await Jimp.read(path.join(ROOT, 'assets', '地面瓷砖图集.jpeg'));
  const TC = 4, TR = 4;
  const tw = Math.floor(tSrc.bitmap.width / TC);
  const th = Math.floor(tSrc.bitmap.height / TR);
  const tNames = [
    ['tile-grass-1', 'tile-grass-2', 'tile-grass-3', 'tile-grass-4'],
    ['tile-road', 'tile-plaza', 'tile-sand', 'tile-water'],
    ['tile-forest', 'tile-shore', 'tile-wall-top', 'tile-wall-side'],
    ['tile-dirt', 'tile-gravel', 'tile-flower', null], // 右下角有水印，跳过
  ];
  for (let r = 0; r < TR; r++) {
    for (let c = 0; c < TC; c++) {
      const name = tNames[r][c];
      if (!name) continue;
      // 收缩 7% 再裁，避开图集白色网格线
      const inset = Math.floor(tw * 0.07);
      const cell = tSrc.clone().crop({
        x: c * tw + inset, y: r * th + inset,
        w: tw - inset * 2, h: th - inset * 2,
      });
      cell.resize({ w: 128, h: 128 });
      clampEdges(cell, 3); // 残留白边用内侧纹理覆盖
      await cell.write(path.join(OUT, `${name}.png`));
    }
  }

  // ---------- 建筑图集 v2：3 列 × 3 行，白底 ----------
  const bSrc = await Jimp.read(path.join(ROOT, 'assets', '建筑素材图集v2.jpeg'));
  whitenessToAlpha(bSrc);
  const BC = 3, BR = 3;
  const bw = Math.floor(bSrc.bitmap.width / BC);
  const bh = Math.floor(bSrc.bitmap.height / BR);
  const bNames = [
    ['house-2', 'pagoda-2', 'wall-crenel'],
    ['well-2', 'fountain', 'gate-arch'],
    ['tree-2', 'bush-2', 'sign'],
  ];
  for (let r = 0; r < BR; r++) {
    for (let c = 0; c < BC; c++) {
      const name = bNames[r][c];
      if (!name) continue;
      const cell = bSrc.clone().crop({ x: c * bw, y: r * bh, w: bw, h: bh });
      cell.autocrop({ tolerance: 0.02 });
      cell.resize({ h: 96, w: Jimp.AUTO });
      await cell.write(path.join(OUT, `${name}.png`));
    }
  }


  // ---------- 地形瓷砖图集 v2：丘陵/森林变体/沙地变体 ----------
  const t2 = await Jimp.read(path.join(ROOT, 'assets', '地形瓷砖图集v2.jpeg'));
  const t2Names = [
    ['tile-hill-1', 'tile-hill-2', 'tile-hill-3', 'tile-rock'],
    ['tile-forest-dark', 'tile-bamboo', 'tile-leaf', 'tile-mushroom'],
    [null, null, null, 'tile-cracked'],   // 第三行山峰/雪山带天空背景，跳过
    ['tile-pebble', 'tile-wood', 'tile-thick-grass', 'tile-dry-grass'],
  ];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const name = t2Names[r][c];
      if (!name) continue;
      const inset = Math.floor(tw * 0.07);
      const cell = t2.clone().crop({
        x: c * tw + inset, y: r * th + inset,
        w: tw - inset * 2, h: th - inset * 2,
      });
      cell.resize({ w: 128, h: 128 });
      clampEdges(cell, 3);
      await cell.write(path.join(OUT, name + '.png'));
    }
  }

  // ---------- 悬崖侧面图集：4 个垂直面板（高处地形的侧立面） ----------
  const cSrc = await Jimp.read(path.join(ROOT, 'assets', '悬崖侧面图集.jpeg'));
  const cliffDefs = [
    ['tile-cliff-grass', 16, 240],    // 草皮+泥土断层
    ['tile-cliff-rock', 510, 610],    // 纯岩石峭壁（避开顶部草皮）
    ['tile-cliff-hill', 1040, 240],   // 丘陵土坡
    ['tile-cliff-sand', 1565, 240],   // 沙层
  ];
  for (const [name, px, py] of cliffDefs) {
    const cell = cSrc.clone().crop({ x: px, y: py, w: 440, h: 512 });
    cell.resize({ w: 110, h: 128 });
    await cell.write(path.join(OUT, name + '.png'));
  }

  console.log('完成，输出文件：');

  for (const f of fs.readdirSync(OUT).sort()) {
    const s = fs.statSync(path.join(OUT, f));
    console.log(`  ${f}  (${Math.round(s.size / 1024)}KB)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
