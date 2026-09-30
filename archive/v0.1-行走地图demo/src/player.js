// 人物：位置（像素坐标）、移动、与地形的碰撞

const Player = {
  x: 0, y: 0,      // 像素坐标（世界坐标系）
  moving: false,   // 是否在移动（渲染动画用）
  facing: 'down',  // 朝向：up / down / left / right

  init() {
    // 出生点格子 → 像素坐标（格子中心）
    this.x = (World.spawn.x + 0.5) * CONFIG.TILE;
    this.y = (World.spawn.y + 0.5) * CONFIG.TILE;
  },

  // 每帧更新：dt 是距上帧的秒数
  update(dt) {
    const ax = Input.axisX();
    const ay = Input.axisY();
    this.moving = ax !== 0 || ay !== 0;

    // 静止漂浮在水中：缓慢荡开小而淡的涟漪（呼吸感）
    if (this.inWater && !this.moving) {
      this.idleTimer = (this.idleTimer || 0) - dt;
      if (this.idleTimer <= 0) {
        this.idleTimer = 0.8;
        Effects.spawnRipple(this.x, this.y, 10, 0.9, false, 0.35);
      }
    }

    if (!this.moving) return;
    // 朝向 = 本帧的主移动方向（松开按键后保持最后朝向）
    if (Math.abs(ax) >= Math.abs(ay)) {
      if (ax > 0) this.facing = 'right';
      else if (ax < 0) this.facing = 'left';
    }
    if (Math.abs(ay) > Math.abs(ax)) {
      this.facing = ay > 0 ? 'down' : 'up';
    }

    // 水里游泳：速度减半（阻力），并持续荡开涟漪
    const wasInWater = this.inWater;
    const speed = (Input.running() ? CONFIG.RUN_SPEED : CONFIG.PLAYER_SPEED)
                * (this.inWater ? 0.55 : 1);
    const len = Math.hypot(ax, ay);
    const dx = (ax / len) * speed * dt;
    const dy = (ay / len) * speed * dt;

    // X、Y 轴分开处理碰撞：贴墙滑动而不是卡死
    this.tryMove(dx, 0);
    this.tryMove(0, dy);

    // 入水瞬间：一个大圈；游泳中：从人物正中心（水线处）持续荡开扩散波纹
    // 涟漪画在人物之下：人物自然遮挡圈的上半段，下半段在身前水面可见
    if (this.inWater && !wasInWater) {
      Effects.spawnRipple(this.x, this.y, 24, 0.8, false, 0.85);
      this.swimTimer = 0.1;
      this.swimSide = false;
    } else if (this.inWater) {
      this.swimTimer -= dt;
      if (this.swimTimer <= 0) {
        this.swimTimer = 0.13;
        // 正中心的大扩散圈（实时在脚下）
        Effects.spawnRipple(this.x, this.y + 4, 26, 0.6, false, 0.85, { noDrop: true });
        // 溅起的水花（身上）
        Effects.spawnRipple(this.x, this.y, 8, 0.4, false, 0.8, { noRing: true });
        // 身后侧向的小圈，交替偏移形成 V 字尾迹
        this.swimSide = !this.swimSide;
        const side = this.swimSide ? 9 : -9;
        const backX = this.facing === 'left' ? 18 : this.facing === 'right' ? -18 : 0;
        const backY = this.facing === 'up' ? 18 : this.facing === 'down' ? -18 : 0;
        const perpX = (this.facing === 'up' || this.facing === 'down') ? side : 0;
        const perpY = (this.facing === 'left' || this.facing === 'right') ? side : 0;
        Effects.spawnRipple(this.x + backX + perpX, this.y + backY + perpY, 16, 0.5, false, 0.6, { noDrop: true });
      }
    }
  },

  // 当前是否在水里（游泳状态）
  get inWater() {
    return World.tileAt(this.tileX(), this.tileY()) === TILE_TYPE.WATER;
  },

  // 尝试沿某一轴移动，撞到不可行走地形就停下
  tryMove(dx, dy) {
    const nx = this.x + dx, ny = this.y + dy;
    if (!this.collides(nx, ny)) {
      this.x = nx; this.y = ny;
    }
  },

  // 碰撞检测：人物碰撞箱的四个角是否踩进不可行走格子
  collides(px, py) {
    const half = CONFIG.PLAYER_SIZE / 2;
    const corners = [
      [px - half, py - half], [px + half, py - half],
      [px - half, py + half], [px + half, py + half],
    ];
    for (const [cx, cy] of corners) {
      if (!World.walkable(Math.floor(cx / CONFIG.TILE), Math.floor(cy / CONFIG.TILE))) {
        return true;
      }
    }
    return false;
  },

  // 当前所在格子
  tileX() { return Math.floor(this.x / CONFIG.TILE); },
  tileY() { return Math.floor(this.y / CONFIG.TILE); },
};
