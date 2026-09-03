// 从 tile-flower.png 生成透明背景的花覆盖层 tile-flower-overlay.png
//
// 原图是整格贴图、自带绿底，直接当地面贴图用会让那一格底色变浅
// （平均 rgb(88,189,108) vs 基准草地 rgb(50,162,80)），看起来像花自带
// 一块异色地面。抠掉绿底后叠在基准草地上，花就成了纯点缀。
//
// 用法: node tools/make_flower_overlay.js

const { Jimp } = require('jimp');

const SRC = 'assets/sprites/tile-flower.png';
const OUT = 'assets/sprites/tile-flower-overlay.png';
const SOFT = 18;   // 绿色主导度阈值：>=SOFT 全透明，<=0 全保留，中间线性过渡

(async () => {
  const im = await Jimp.read(SRC);
  const { width: w, height: h, data: d } = im.bitmap;
  let kept = 0, soft = 0;

  for (let i = 0; i < w * h * 4; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // 绿色主导程度：g 比 r/b 中较大者高出多少。花瓣是白色和粉紫，此值 <=0
    const greenness = g - Math.max(r, b);
    let a;
    if (greenness >= SOFT) a = 0;
    else if (greenness <= 0) a = 255;
    else { a = Math.round(255 * (1 - greenness / SOFT)); soft++; }   // 保住抗锯齿边缘
    if (a > 0) kept++;
    d[i + 3] = a;
  }

  await im.write(OUT);
  console.log(`${OUT}: 保留 ${kept} px (${(kept / (w * h) * 100).toFixed(1)}%)，软边缘 ${soft} px`);
})();
