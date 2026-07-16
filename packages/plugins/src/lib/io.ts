// プラグイン共通 I/O(D1 §3 契約): stdin から JSON 1 個を読み、stdout へ JSON 1 個を書く。
// stderr は診断専用。exit 0 = pass / 2 = fail / その他 = error。

/** stdin を EOF まで読み、JSON としてパースして返す。 */
export async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

/** stdout へ JSON 1 個を書く(末尾改行つき)。 */
export function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** 診断メッセージを stderr へ出す(stdout チャネルを汚さない)。 */
export function diag(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** オブジェクトから文字列フィールドを取り出す(欠落・型違いは undefined)。 */
export function str(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}
