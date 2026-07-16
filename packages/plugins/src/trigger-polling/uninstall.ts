// trigger polling: install が登録したスケジュールを解除する(設計 D10 §3, ADR-0015)。
import { diag } from '../lib/io.js';
import { requireProfile, uninstall } from '../trigger/common.js';

const profile = requireProfile('polling');
diag(`trigger-polling: 解除します profile=${profile}`);
uninstall('polling', profile);
