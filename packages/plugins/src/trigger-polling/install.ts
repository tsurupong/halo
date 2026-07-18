// trigger polling: 高頻度起動をスケジューラバックエンドへ登録する(設計 D10 §3, ADR-0015)。
// 発火間隔(分)は環境変数で上書き可(既定 15 分)。
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { diag } from '../lib/io.js';
import { install, requireProfile } from '../trigger/common.js';

const profile = requireProfile('polling');
const pluginDir = process.env['HALO_PLUGIN_DIR'] ?? '.';
const interval = process.env['HALO_POLL_INTERVAL_MIN'] ?? '15';

const manifestPath = join(pluginDir, 'plugin.json');
if (!existsSync(manifestPath)) {
  diag(`trigger-polling: plugin.json not found: ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { aux?: Record<string, string> };
const rel = manifest.aux?.['fire'];
if (rel === undefined) {
  diag(`trigger-polling: fire entry not declared: ${manifestPath}`);
  process.exit(1);
}
const firePath = isAbsolute(rel) ? rel : join(pluginDir, rel);

diag(`trigger-polling: 登録します profile=${profile} interval=${interval}min`);
install('polling', profile, `interval:${interval}`, [process.execPath, firePath]);
