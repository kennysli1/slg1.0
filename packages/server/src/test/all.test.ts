/**
 * 测试入口（跨平台）：汇总导入所有 *.test.ts。
 * 因为 Node 20 的 `--test` 自动发现只认 .js，且 Windows cmd 不展开 glob，
 * 故用一个 barrel 显式导入；node:test 在 import 时即注册用例。
 * 新增测试文件时在此加一行 import 即可。
 */
import './full-loop.test.js';
import './building.test.js';
import './multiplayer-pvp.test.js';
import './combat.test.js';
import './hex.test.js';
import './movement-path.test.js';
import './movement-index.test.js';
import './movement-recall.test.js';
import './movement-push-increment.test.js';
import './combat-field.test.js';
import './persistence.test.js';
import './reset.test.js';
import './config.test.js';
import './meta.test.js';
import './manifest.test.js';
import './architecture.test.js';
import './notifications.test.js';
import './population.test.js';
// ---- 新增回归测试（阶段 1-3）----
import './scheduler.test.js';
import './lock-concurrency.test.js';
import './concurrency.test.js';
import './reset-concurrency.test.js';
import './population-regression.test.js';
import './population-v2.test.js';
import './gateway-scheduler-serial.test.js';
// ---- 网络安全阶段（wire-boundary / rate-limit / validate）----
import './rate-limit.test.js';
import './validate.test.js';
import './wire-boundary.test.js';
import './store.test.js';
import './smoke-wire.test.js';
import './economy-overflow.test.js';
import './multi-village.test.js';
import './found-village.test.js';
import './transport-abandon.test.js';
import './balance-roundtrip.test.js';
import './balance-override.test.js';
import './treasure.test.js';
import './pvp-treasure.test.js';
import './research.test.js';
// ---- 新增测试 ----
import './barrel.test.js';
import './push-contract.test.js';
import './gm-routes.test.js';
import './trade.test.js';
import './mercenary.test.js';

import './task.test.js';
import './modifier-coverage.test.js';
import './movement-foreign-visibility.test.js';
import './caravan-return.test.js';
import './caravan-npc-faithful.test.js';
import './task-flows.test.js';
import './register-spot.test.js';
import './diplomacy-movement.test.js';
import './reputation.test.js';
import './alchemy.test.js';
import './vision-multivillage.test.js';
import './incoming-warning.test.js';
import './world-generation.test.js';
import './kingdom.test.js';
import './kingdom-overview.test.js';
import './dialogue.test.js';
import './task-m12-m13.test.js';
