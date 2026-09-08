// 主循环：组装一切，启动游戏

(function boot() {
  // 1. 生成世界（种子固定则世界固定；想换世界就改这个数字）
  World.generate(20260901);

  // 2. 初始化各模块
  Input.init();
  Player.init();
  Render.init(document.getElementById('game'));
  Effects.init();
  WorldMap.init();
  Ambience.init();
  Entities.init();
  Combat.init();

  // 3. 开场画面：点击「开始探索」→ 武魂觉醒选择 → 选定后才接管操作
  let started = false;
  document.getElementById('start-btn').addEventListener('click', () => {
    document.getElementById('title').classList.add('hidden');
    document.getElementById('awaken').classList.add('show');
  });
  document.querySelectorAll('.soul-card').forEach(card => {
    card.addEventListener('click', () => {
      Player.awaken(card.dataset.soul);
      document.getElementById('awaken').classList.remove('show');
      started = true;
    });
  });

  // 4. 游戏循环：requestAnimationFrame 驱动，dt 控制帧率无关的速度
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); // 上限 50ms 防止切标签页后暴走
    last = now;
    if (started) {
      Player.update(dt);
      Entities.update(dt, now);
      Combat.update(dt, now);
    }
    WorldMap.reveal(Player.x, Player.y);
    Effects.update(dt, now);
    Ambience.update(dt, now);
    Render.updateCamera(dt);
    Render.draw(now);
    Input.endFrame();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
