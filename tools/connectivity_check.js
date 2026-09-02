// 可走性连通诊断：城门之间不借道路、只走自然地形，能否互通？
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
  // BFS：只走自然可走地形（不含 roadTiles；水可游泳）
  const q = [[s.x, s.y]];
  const seen = new Set([K(s.x, s.y)]);
  let ok = false, cnt = 0;
  while (q.length) {
    const [x, y] = q.pop(); cnt++;
    if (K(x, y) === K(g.x, g.y)) { ok = true; break; }
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      const k = K(nx, ny);
      if (!seen.has(k) && World.walkable(nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  console.log('路' + i + ': ' + A.name + '→' + B.name +
    ' 自然地形连通:' + (ok ? '✓' : '✗（被山隔断，需要山道隘口）'));
});
`);
