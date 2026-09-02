// 桥诊断：为什么没有桥
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const cfg = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
const world = fs.readFileSync(path.join(ROOT, 'src/world.js'), 'utf8');
eval(cfg + '\n' + world + `
World.generate(20260901);
let candidates = 0;
const lengths = [];
for (const k of World.roadTiles) {
  const [x, y] = k.split(',').map(Number);
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    if (World.tileAt(x + dx, y + dy) === TILE_TYPE.WATER) {
      candidates++;
      let len = 0, wx = x + dx, wy = y + dy;
      while (len < 20 && World.tileAt(wx, wy) === TILE_TYPE.WATER) { len++; wx += dx; wy += dy; }
      lengths.push(len);
      break;
    }
  }
}
console.log('贴水道路格（候选）:', candidates);
console.log('对应水面长度分布:', JSON.stringify(lengths.slice(0, 30)));
const NAME = (x, y) => Object.keys(TILE_TYPE).find(k => TILE_TYPE[k] === World.tileAt(x, y));
console.log('取样候选的落点:', NAME(400, 300), NAME(300, 250));
`);
