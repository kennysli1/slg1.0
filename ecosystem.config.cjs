// pm2 进程守护配置：开机自启、崩溃自动重启、日志留存。
// 用法见 docs/部署手册_腾讯云轻量服务器.md。
module.exports = {
  apps: [
    {
      name: 'kow',
      // 生产统一运行构建产物，与根 package.json 的 npm start 保持一致。
      script: 'packages/server/dist/main.js',
      node_args: '--enable-source-maps',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        // 数据落盘路径（相对 cwd）
        DATA_PATH: './data/game.json',
      },
      autorestart: true,
      max_restarts: 10,
      // 优雅停机：给进程时间 flush 存档
      kill_timeout: 5000,
      out_file: './logs/out.log',
      error_file: './logs/err.log',
    },
    {
      // AI 测试服 01：与主服使用相同代码，但世界存档、日志和端口完全隔离。
      name: 'kow-test-01',
      script: 'packages/server/dist/main.js',
      node_args: '--enable-source-maps',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '8081',
        HOST: '0.0.0.0',
        DATA_PATH: './data/test-01/game.json',
        LOG_DIR: './logs/test-01',
      },
      autorestart: true,
      max_restarts: 10,
      kill_timeout: 5000,
      out_file: './logs/test-01/out.log',
      error_file: './logs/test-01/err.log',
    },
    {
      // 筛色子实验场：独立进程、端口和内存会话，不加载 KOW 存档。
      name: 'kow-dice-lab',
      script: 'packages/dice-lab/dist/server/main.js',
      node_args: '--enable-source-maps',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        DICE_LAB_ENABLED: 'on',
        DICE_LAB_PORT: '8091',
        DICE_LAB_HOST: '127.0.0.1',
        DICE_LAB_TOKEN: process.env.DICE_LAB_TOKEN ?? '',
      },
      autorestart: true,
      max_restarts: 10,
      kill_timeout: 5000,
      out_file: './logs/dice-lab/out.log',
      error_file: './logs/dice-lab/err.log',
    },
  ],
};
