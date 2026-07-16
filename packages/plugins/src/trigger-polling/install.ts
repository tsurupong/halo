// trigger polling: 高頻度起動をスケジューラバックエンドへ登録する(設計 D10 §3, ADR-0015)。
// 発火間隔(分)は環境変数で上書き可(既定 15 分)。
import { join } from 'node:path';
import { diag } from '../lib/io.js';
import { install, requireProfile } from '../trigger/common.js';

const profile = requireProfile('polling');
const launcherDir = process.env['HALO_LAUNCHER_DIR'] ?? '.';
const interval = process.env['HALO_POLL_INTERVAL_MIN'] ?? '15';
diag(`trigger-polling: 登録します profile=${profile} interval=${interval}min`);
install('polling', profile, `interval:${interval}`, join(launcherDir, 'fire'));
