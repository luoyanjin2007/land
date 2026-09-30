# 斗罗大陆 · 2D 大世界原型

瓦片制 2D 俯视角 RPG（斗罗大陆同人），原生 HTML5 Canvas + 纯 JS，**无构建框架、无外部运行时依赖**——双击 `index.html` 即可玩。

## 运行

- **本地游玩**：直接双击 `index.html`（需联网拉取一次贴图；file:// 下一切功能正常）
- **正式线上版**：https://land-8aq.pages.dev （master 分支，Cloudflare Pages 自动部署）
- **预览版**：https://preview.land-8aq.pages.dev （preview 分支，新改动上线前先在此试玩验收）

## 玩法现状

1200×1200 格无缝程序化大陆；六座正史城市（圣魂村→诺丁城→史莱克学院→索托城→武魂城→星罗城）；城际道路/木桥/风景湖；M 键世界地图 + 战争迷雾 + 雷达小地图；昼夜与天气、动态草木鸟虫；武魂觉醒二选一（昊天锤 / 蓝银草），半自动战斗 + 魂技 + 魂兽 + 升级魂环。

## 工作区结构

```
index.html            入口：开场/觉醒界面 + 按依赖顺序加载 12 个脚本
src/                  游戏全部源码（12 个文件，见 docs/01-代码地图.md）
assets/sprites/       运行时贴图（人物/地形/建筑/魂兽）
assets/*.jpeg         开场图 + AI 切图原料（除两张外运行时不下载）
docs/                 设计文档 + 进度/计划/AI行为手册（从 00 开始按编号读）
tools/verify/         世界生成验收脚本（道路/桥/连通性）
tools/asset-pipeline/ 切图、抠白底、花覆盖层等美术管线
tools/screenshots/    CDP 自动截图脚本（产物 gitignore）
archive/              历史存档（v0.1 行走 demo）
.github/workflows/    push master/preview 自动部署 Cloudflare Pages
```

## 给 AI 助手 / 后续维护者

**先读 [`docs/00-文档导航.md`](docs/00-文档导航.md)**；需要快速搞清"现在做到哪、接下来做什么、改完怎么验"时，直接看 **[`docs/04-AI行为手册.md`](docs/04-AI行为手册.md)**。
