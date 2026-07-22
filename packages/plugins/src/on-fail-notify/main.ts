// min-autonomy: L1
// on-fail-notify / 30-notify (D1 §1.6): エスカレーション通知 on-fail プラグイン。
// stdin の on-fail.in JSON {task_id, reason, retry_count, gate?, workdir?} を受け取り、
// retry_count がしきい値 (HALO_NOTIFY_THRESHOLD 既定 3、task-source の needs-human 判定と
// 同じ >= 比較) に達した場合のみ HALO_NOTIFY_URL へ JSON を HTTP POST する (汎用 Webhook:
// ntfy / Slack Incoming Webhook 等)。loop は on-fail を毎失敗で呼ぶため、閾値判定は本体で行う。
// HALO_NOTIFY_URL 未設定・閾値未満は何もせず exit 0。送信失敗もベストエフォート (exit 0)。
// 出力は無し、stdout は空に保つ。
import { readStdinJson, diag, str } from '../lib/io.js';

const input = await readStdinJson().catch(() => undefined);
const taskId = str(input, 'task_id');
const reason = str(input, 'reason') ?? '';
const gate = str(input, 'gate');
const rcRaw =
  typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)['retry_count']
    : undefined;
const retryCount = typeof rcRaw === 'number' ? rcRaw : 0;

const url = process.env['HALO_NOTIFY_URL'];
const thresholdRaw = Number(process.env['HALO_NOTIFY_THRESHOLD'] ?? '3');
const threshold = Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? thresholdRaw : 3;

if (taskId === undefined || url === undefined || url === '' || retryCount < threshold) {
  process.exit(0);
}

const timeoutRaw = Number(process.env['HALO_NOTIFY_TIMEOUT_MS'] ?? '10000');
const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 10000;

const payload = {
  task_id: taskId,
  reason,
  retry_count: retryCount,
  ...(gate !== undefined ? { gate } : {}),
  ts: new Date().toISOString(),
};

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) diag(`on-fail-notify: 通知先が HTTP ${res.status} を返却`);
} catch (err) {
  diag(`on-fail-notify: 送信失敗: ${(err as Error).message}`);
}
process.exit(0);
