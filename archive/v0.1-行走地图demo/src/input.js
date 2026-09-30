// 键盘输入：维护一个「当前按着哪些键」的表

const Input = {
  keys: {},

  init() {
    addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      // 防止方向键滚动页面
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
    });
    // 窗口失焦时清空，防止按键卡住
    addEventListener('blur', () => { this.keys = {}; });
  },

  // 是否按着某个方向（WASD / 方向键）
  axisX() {
    let x = 0;
    if (this.keys['a'] || this.keys['arrowleft']) x -= 1;
    if (this.keys['d'] || this.keys['arrowright']) x += 1;
    return x;
  },
  axisY() {
    let y = 0;
    if (this.keys['w'] || this.keys['arrowup']) y -= 1;
    if (this.keys['s'] || this.keys['arrowdown']) y += 1;
    return y;
  },
  running() {
    return !!(this.keys['shift']);
  },
};
