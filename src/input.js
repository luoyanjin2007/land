// 键盘输入：维护一个「当前按着哪些键」的表

const Input = {
  keys: {},
  edge: new Set(),   // 本帧「刚按下」的键：魂技等边沿触发动作

  init() {
    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      this.keys[k] = true;
      // 按住不放时浏览器会连发 keydown，e.repeat 把它们滤掉，否则魂技会连放
      if (!e.repeat) this.edge.add(k);
      // 防止方向键滚动页面
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) {
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
    });
    // 窗口失焦时清空，防止按键卡住
    addEventListener('blur', () => { this.keys = {}; this.edge.clear(); });
  },

  // 本帧是否按下过某键；读走即删，下帧不会重复触发
  took(k) {
    const v = this.edge.has(k);
    this.edge.delete(k);
    return v;
  },

  // 每帧末清空未消费的边沿（防止觉醒界面里按的数字键攒到开局放技能）
  endFrame() { this.edge.clear(); },

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
