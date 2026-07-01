import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { createGameApp } from './app.js';

/**
 * 运维 CLI（一次性进程，非常驻）：刷档 / 删档。
 *
 * 与 main.ts 的区别：不起 HTTP/WS、**不调 resume()**（不激活任何定时任务），
 * 只是「载入存档 → 备份 → 改数据 → 刷盘 → 退出」，因此没有内存/落盘不同步的风险。
 *
 * 三种模式（对应 package.json 脚本）：
 *   --mode=season   保留账号 + 地图位置，进度归零（新赛季重开）
 *   --mode=respawn  保留登录凭据，重新分配地图位置（地图布局也变了时用）
 *   --mode=wipe     连账号一起清空（= 干净删档）
 *
 * 每次执行前自动把当前存档备份到 data/backups/<原名>.<时间戳>.json，选错也能回滚。
 * 数据文件路径同 main.ts：环境变量 DATA_PATH，默认 data/game.json。
 */

type Mode = 'season' | 'respawn' | 'wipe';

const MODE_DESC: Record<Mode, string> = {
  season: '保留账号 + 地图位置，进度归零（新赛季重开）',
  respawn: '保留登录凭据，重新分配地图位置',
  wipe: '连账号一起清空（删档）',
};

function parseMode(argv: string[]): Mode {
  const arg = argv.find((a) => a.startsWith('--mode='));
  const m = arg?.split('=')[1];
  if (m === 'season' || m === 'respawn' || m === 'wipe') return m;
  console.error(
    `用法：需指定 --mode=season|respawn|wipe\n` +
      Object.entries(MODE_DESC)
        .map(([k, v]) => `  --mode=${k.padEnd(8)} ${v}`)
        .join('\n'),
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function backup(dataPath: string): string | null {
  if (!existsSync(dataPath)) return null; // 无存档，无需备份
  const dir = join(dirname(dataPath), 'backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // 时间戳用 ISO 去掉非法字符；一次性进程，Date 可用。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = basename(dataPath).replace(/\.json$/i, '');
  const dest = join(dir, `${name}.${stamp}.json`);
  copyFileSync(dataPath, dest);
  return dest;
}

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  const dataPath = process.env.DATA_PATH ?? join(__dirname, '../../../data/game.json');

  console.log(`[admin] 模式：${mode}（${MODE_DESC[mode]}）`);
  console.log(`[admin] 存档：${dataPath}`);

  // 1. 备份（安全网）
  const bak = backup(dataPath);
  console.log(bak ? `[admin] 已备份到：${bak}` : '[admin] 无现有存档，跳过备份');

  // 2. 载入存档（不 resume，不激活定时任务）
  const app = createGameApp({ storePath: dataPath });
  const before = app.store.all('player').length;

  // 3. 刷档
  const opts =
    mode === 'wipe'
      ? { keepAccounts: false }
      : { keepAccounts: true, reassignSpots: mode === 'respawn' };
  const { accounts } = app.resetWorld(opts);

  // 4. 落盘
  (app.store as { flush?: () => void }).flush?.();

  if (mode === 'wipe') {
    console.log(`[admin] 完成：已清空 ${before} 个账号及全部进度，存档回到全新状态。`);
  } else {
    console.log(`[admin] 完成：保留 ${accounts} 个账号，进度已归零、世界已重建。`);
  }
  process.exit(0);
}

main();
