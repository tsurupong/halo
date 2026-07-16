// trigger schedule: nightly 定時起動をスケジューラバックエンドへ登録する(設計 D10 §3, ADR-0015)。
// 起動時刻は環境変数で上書き可(既定 03:00 の nightly 起動)。
import { join } from 'node:path';
import { diag } from '../lib/io.js';
import { install, requireProfile } from '../trigger/common.js';

const profile = requireProfile('schedule');
const launcherDir = process.env['HALO_LAUNCHER_DIR'] ?? '.';
const time = process.env['HALO_SCHEDULE_TIME'] ?? '03:00';
diag(`trigger-schedule: 登録します profile=${profile} ST=${time}`);
install('schedule', profile, `daily:${time}`, join(launcherDir, 'fire'));
