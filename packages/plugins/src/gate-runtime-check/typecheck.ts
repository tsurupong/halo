// gate 10-typecheck: 採用 runtime の check エントリへ委譲する薄いラッパー(D5 §2.4)。
import { delegate } from './delegate.js';

await delegate('10-typecheck', 'check');
