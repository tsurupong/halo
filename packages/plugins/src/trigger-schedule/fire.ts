// trigger schedule: 発火時の実処理。スケジューラ経由で呼ばれる。
// 引数: argv[2] = プロファイル名(例 nightly)。stdin JSON は持たない(D1 §1.9)。
import { fire, requireProfile } from '../trigger/common.js';

fire('schedule', requireProfile('schedule'));
