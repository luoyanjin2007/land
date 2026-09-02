// 世界地图界面（M 键开关）：迷雾探索 + 城市标注 + 人物位置
// 迷雾网格：每格覆盖 8×8 世界格，玩家走过的地方揭露半径内的格子

const WorldMap = {
  visible: false,
  fog: null,           // Uint8Array：1 = 已探索
  FW: 0, FH: 0,        // 迷雾网格尺寸
  CELL: 8,             // 每迷雾格覆盖的世界格数
  REVEAL_R: 7,         // 揭露半径（迷雾格）

  init() {
    this.FW = Math.ceil(CONFIG.WORLD_W / this.CELL);
    this.FH = Math.ceil(CONFIG.WORLD_H / this.CELL);
    this.fog = new Uint8Array(this.FW * this.FH);
    // 小地图迷雾缓存：只点亮已探索区域（与角落小地图共用）
    if (Render.miniCanvas) {
      this.fogMini = document.createElement('canvas');
      this.fogMini.width = Render.miniCanvas.width;
      this.fogMini.height = Render.miniCanvas.height;
    }
    this.reveal(Player.x, Player.y);
    // M 键开关
    addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'm') this.toggle();
    });
  },

  // 揭露人物周围的迷雾（圆形）；新点亮的格子同步到小地图缓存
  reveal(px, py) {
    const cx = Math.floor(px / CONFIG.TILE / this.CELL);
    const cy = Math.floor(py / CONFIG.TILE / this.CELL);
    const R = this.REVEAL_R;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        const fx = cx + dx, fy = cy + dy;
        if (fx < 0 || fy < 0 || fx >= this.FW || fy >= this.FH) continue;
        const idx = fy * this.FW + fx;
        if (this.fog[idx] === 1) continue;
        this.fog[idx] = 1;
        // 增量点亮小地图缓存（每迷雾格 = 小地图上 8×8 像素，1px/格）
        if (this.fogMini && Render.miniCanvas) {
          this.fogMini.getContext('2d').drawImage(
            Render.miniCanvas,
            fx * 8, fy * 8, 8, 8,
            fx * 8, fy * 8, 8, 8
          );
        }
      }
    }
  },

  exploredAt(fx, fy) {
    return fx >= 0 && fy >= 0 && fx < this.FW && fy < this.FH &&
           this.fog[fy * this.FW + fx] === 1;
  },

  toggle() { this.visible = !this.visible; },

  // 全屏地图覆盖层（在 HUD 之后绘制 = 最顶层）
  drawOverlay(time) {
    if (!this.visible) return;
    const { ctx, canvas } = Render;

    ctx.fillStyle = 'rgba(4,8,18,.94)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 地图区域：正方形居中
    const size = Math.min(canvas.width, canvas.height) * 0.8;
    const ox = (canvas.width - size) / 2;
    const oy = (canvas.height - size) / 2 + 10;
    const cell = size / this.FW;

    // 底色（未探索 = 深色）
    ctx.fillStyle = '#0d1526';
    ctx.fillRect(ox, oy, size, size);

    // 已探索区域：从烘焙小地图采样对应区域
    for (let fy = 0; fy < this.FH; fy++) {
      for (let fx = 0; fx < this.FW; fx++) {
        if (!this.exploredAt(fx, fy)) continue;
        const sw = this.CELL, sh = this.CELL;
        ctx.drawImage(
          Render.miniCanvas,
          fx * sw, fy * sh, sw, sh,
          ox + fx * cell, oy + fy * cell, cell + 0.6, cell + 0.6
        );
      }
    }
    // 边框
    ctx.strokeStyle = '#ffe9a8';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, size, size);

    // 城市标注（探索到才显示）
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const c of World.cities) {
      const ccx = Math.floor((c.x + c.w / 2) / this.CELL);
      const ccy = Math.floor((c.y + c.h / 2) / this.CELL);
      if (!this.exploredAt(ccx, ccy)) continue;
      const px = ox + ((c.x + c.w / 2) / CONFIG.WORLD_W) * size;
      const py = oy + ((c.y + c.h / 2) / CONFIG.WORLD_H) * size;
      ctx.fillStyle = 'rgba(10,14,24,.6)';
      const tw2 = ctx.measureText('🏘️ ' + c.name).width;
      ctx.fillRect(px - tw2 / 2 - 5, py - 26, tw2 + 10, 18);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText('🏘️ ' + c.name, px, py - 13);
    }

    // 人物位置（闪烁红点 + 「你在这里」）
    const px = ox + (Player.x / CONFIG.TILE / CONFIG.WORLD_W) * size;
    const py = oy + (Player.y / CONFIG.TILE / CONFIG.WORLD_H) * size;
    if (Math.floor(time / 400) % 2 === 0) {
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 标题 / 提示
    ctx.font = '20px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText('斗 罗 大 陆 · 世 界 地 图', canvas.width / 2, oy - 24);
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillText('红点 = 你的位置 · 走过的地方会点亮 · M 键关闭', canvas.width / 2, oy + size + 26);
  },
};
