// trigger polling: 高頻度発火時の実処理。schedule と同一の fire 契約に従う。
// 引数: argv[2] = プロファイル名(例 continuous)。stdin JSON は持たない(D1 §1.9)。
import { fire, requireProfile } from '../trigger/common.js';

fire('polling', requireProfile('polling'));
