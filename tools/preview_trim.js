// 离线复刻 render.js 的 trimWhiteSprite：边缘泛洪抠白 + 包围盒裁切，
// 再合成到深绿背景上导出 PNG，供肉眼检查白背景是否抠净、内部白墙是否被误抠。
// 用法: node tools/preview_trim.js [name...]
const path = require('path');
const { Jimp } = require('jimp');

const S = 1024;
const names = require('process').argv.slice(2);

async function process(name) {
  const img = await Jimp.read(path.join(__dirname, '..', 'assets', 'sprites', 'buildings', name + '.jpg'));
  img.resize({ w: S, h: S });
  const { data: px } = img.bitmap;

  const N = S * S;
  const light = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
    const mn = Math.min(r, gg, b), mx = Math.max(r, gg, b);
    if (mn > 232 && mx - mn < 22) light[i] = 1;
  }
  const ext = new Uint8Array(N);
  const stack = [];
  const seed = (x, y) => { const i = y * S + x; if (light[i] && !ext[i]) { ext[i] = 1; stack.push(i); } };
  for (let x = 0; x < S; x++) { seed(x, 0); seed(x, S - 1); }
  for (let y = 1; y < S - 1; y++) { seed(0, y); seed(S - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % S, y = (i / S) | 0;
    const nb = [[i - 1, x > 0], [i + 1, x < S - 1], [i - S, y > 0], [i + S, y < S - 1]];
    for (const [j, ok] of nb) if (ok && light[j] && !ext[j]) { ext[j] = 1; stack.push(j); }
  }
  let minX = S, minY = S, maxX = 0, maxY = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    let a = 255;
    if (ext[i]) a = 0;
    else if (light[i]) {
      const touch = (x > 0 && ext[i - 1]) || (x < S - 1 && ext[i + 1]) ||
                    (y > 0 && ext[i - S]) || (y < S - 1 && ext[i + S]);
      if (touch) a = 130;
    }
    px[i * 4 + 3] = a;
    if (a > 20) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(S - 1, maxX + pad); maxY = Math.min(S - 1, maxY + pad);

  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const crop = new Jimp({ width: cw, height: ch, color: 0x2d4a2dff });
  // 直接逐像素合成（Jimp alpha 合成版本间 API 不稳，手动来）
  const cd = crop.bitmap.data;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const si = ((y + minY) * S + (x + minX)) * 4;
    const di = (y * cw + x) * 4;
    const a = px[si + 3] / 255;
    cd[di]     = px[si]     * a + cd[di]     * (1 - a);
    cd[di + 1] = px[si + 1] * a + cd[di + 1] * (1 - a);
    cd[di + 2] = px[si + 2] * a + cd[di + 2] * (1 - a);
  }
  const out = path.join(__dirname, name + '-trim-preview.png');
  await crop.write(out);
  console.log(name, 'crop=', cw + 'x' + ch, '->', out);
}

(async () => {
  for (const n of names) await process(n);
})();
