/**
 * Barrel 守卫测试：确保 test/ 目录下每个 *.test.ts（排除 all.test.ts 和自身）
 * 都已被 all.test.ts import，防止新增测试文件漏登记。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('所有 *.test.ts 都已在 all.test.ts 中 import', () => {
  const testDir = __dirname;
  const allBarrel = readFileSync(join(testDir, 'all.test.ts'), 'utf-8');

  const allFiles = readdirSync(testDir).filter(
    (f) =>
      f.endsWith('.test.ts') &&
      f !== 'all.test.ts' &&
      f !== 'barrel.test.ts',
  );

  const missing: string[] = [];
  for (const file of allFiles) {
    const jsName = file.replace(/\.ts$/, '.js');
    // all.test.ts 以 import './<name>.js' 形式登记
    if (!allBarrel.includes(`'./${jsName}'`) && !allBarrel.includes(`"./${jsName}"`)) {
      missing.push(file);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `以下测试文件未在 all.test.ts 中 import，请添加：\n  ${missing.join('\n  ')}`,
  );
});
