// trigger schedule: nightly 定時起動をスケジューラバックエンドへ登録する(設計 D10 §3, ADR-0015)。
// 起動時刻は環境変数で上書き可(既定 03:00 の nightly 起動)。
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { diag } from '../lib/io.js';
import { install, requireProfile } from '../trigger/common.js';

const profile = requireProfile('schedule');
const pluginDir = process.env['HALO_PLUGIN_DIR'] ?? '.';
const time = process.env['HALO_SCHEDULE_TIME'] ?? '03:00';

const manifestPath = join(pluginDir, 'plugin.json');
if (!existsSync(manifestPath)) {
  diag(`trigger-schedule: plugin.json not found: ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { aux?: Record<string, string> };
const rel = manifest.aux?.['fire'];
if (rel === undefined) {
  diag(`trigger-schedule: fire entry not declared: ${manifestPath}`);
  process.exit(1);
}
const firePath = isAbsolute(rel) ? rel : join(pluginDir, rel);

diag(`trigger-schedule: 登録します profile=${profile} ST=${time}`);
install('schedule', profile, `daily:${time}`, [process.execPath, firePath]);
