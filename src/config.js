// 全局配置：改这里即可调整世界的基本参数
const CONFIG = {
  MAP_W: 200,        // 地图宽度（格）
  MAP_H: 200,        // 地图高度（格）
  TILE: 32,          // 每格像素
  PLAYER_SPEED: 170, // 步行速度（像素/秒）
  RUN_SPEED: 280,    // 按住 Shift 的奔跑速度
  PLAYER_SIZE: 20,   // 人物碰撞箱（像素，正方形）
};

// 地形类型编号
const TILE_TYPE = {
  WATER: 0,
  SAND: 1,
  GRASS: 2,
  FOREST: 3,
  MOUNTAIN: 4,
  ROAD: 5,      // 城内道路
  HOUSE: 6,     // 房屋（不可通行）
  WALL: 7,      // 城墙（不可通行）
  PLAZA: 8,     // 广场石板
  FOUNTAIN: 9,  // 中央喷泉（不可通行）
};
