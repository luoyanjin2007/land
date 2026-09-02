// 桥与地形分布检查：node tools/bridge_check.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const cfg = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
const world = fs.readFileSync(path.join(ROOT, 'src/world.js'), 'utf8');
eval(cfg + '\n' + world + `
World.generate(20260901);
console.log('道路格数:', World.roadTiles.size);
console.log('桥格数:', World.bridgeTiles.size);
let spot = null;
for (const k of World.bridgeTiles) {
  const [x, y] = k.split(',').map(Number);
  if (!spot || y < spot.y) spot = { x, y };
}
console.log('桥位置:', JSON.stringify(spot));
if (spot) {
  const NAME = (x, y) => Object.keys(TILE_TYPE).find(k => TILE_TYPE[k] === World.tileAt(x, y));
  console.log('桥面类型:', NAME(spot.x, spot.y), '| 桥头西:', NAME(spot.x - 1, spot.y), '| 桥头东:', NAME(spot.x + 1, spot.y));
}
`);
