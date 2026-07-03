// pm2 进程守护配置：开机自启、崩溃自动重启、日志留存。
// 用法见 docs/部署手册_腾讯云轻量服务器.md。
module.exports = {
  apps: [
    {
      name: 'kow',
      // 用 tsx 直接跑 TS 源码（无需单独编译后端）
      script: 'node',
      args: '--import tsx packages/server/src/main.ts',
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
  ],
};
