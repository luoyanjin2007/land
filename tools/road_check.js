// 道路连通性诊断：node tools/road_check.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const cfg = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
const world = fs.readFileSync(path.join(ROOT, 'src/world.js'), 'utf8');
eval(cfg + '\n' + world + `
World.generate(20260901);
const links = [[0,1],[1,2],[1,3],[3,4],[4,5]];
const K = (x,y) => x + ',' + y;
links.forEach(([a,b], i) => {
  const A = World.cities[a], B = World.cities[b];
  const s = World.gateToward(A, B), g = World.gateToward(B, A);
  const q = [[s.x, s.y]];
  const seen = new Set([K(s.x, s.y)]);
  let ok = false, cnt = 0;
  while (q.length) {
    const [x, y] = q.pop(); cnt++;
    if (K(x, y) === K(g.x, g.y)) { ok = true; break; }
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const k = K(x+dx, y+dy);
      if (!seen.has(k) && World.roadTiles.has(k)) { seen.add(k); q.push([x+dx, y+dy]); }
    }
  }
  const sIn = World.roadTiles.has(K(s.x, s.y));
  const gIn = World.roadTiles.has(K(g.x, g.y));
  console.log('路' + i + ': ' + A.name + '→' + B.name +
    ' 门(' + s.x + ',' + s.y + ')→(' + g.x + ',' + g.y + ')' +
    ' 起点' + (sIn ? '在' : '不在') + '路中 终点' + (gIn ? '在' : '不在') + '路中' +
    ' 连通:' + (ok ? '✓' : '✗') + ' 覆盖' + cnt + '格');
});
`);
