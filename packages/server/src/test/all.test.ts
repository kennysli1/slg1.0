/**
 * 测试入口（跨平台）：汇总导入所有 *.test.ts。
 * 因为 Node 20 的 `--test` 自动发现只认 .js，且 Windows cmd 不展开 glob，
 * 故用一个 barrel 显式导入；node:test 在 import 时即注册用例。
 * 新增测试文件时在此加一行 import 即可。
 */
import './full-loop.test.js';
import './multiplayer-pvp.test.js';
import './persistence.test.js';
import './config.test.js';
import './meta.test.js';
import './manifest.test.js';
