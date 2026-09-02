// 山峰阈值参数扫描：node tools/threshold_test.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const cfg = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
const worldSrc = fs.readFileSync(path.join(ROOT, 'src/world.js'), 'utf8');

for (const th of [0.55, 0.60, 0.65, 0.68, 0.72]) {
  const src = cfg + '\n' +
    worldSrc.replace('if (e < 0.60) {', 'if (e < ' + th + ') {') +
    `
World.generate(20260901);
const NAME = (x, y) => Object.keys(TILE_TYPE).find(k => TILE_TYPE[k] === World.tileAt(x, y));
let m = 0, g = 0, f = 0, w = 0, s = 0, total = 0;
for (let y = 0; y < 800; y += 4) for (let x = 0; x < 800; x += 4) {
  const n = NAME(x, y); total++;
  if (n === 'MOUNTAIN') m++; else if (n === 'GRASS') g++; else if (n === 'FOREST') f++;
  else if (n === 'WATER') w++; else if (n === 'SAND') s++;
}
console.log('山峰阈值', th, '→ 山', (m / total * 100).toFixed(1) + '%',
  '草', (g / total * 100).toFixed(1) + '%', '林', (f / total * 100).toFixed(1) + '%',
  '水', (w / total * 100).toFixed(1) + '%', '沙', (s / total * 100).toFixed(1) + '%',
  '(262,181)=' + NAME(262, 181));
`;
  eval(src);
}
