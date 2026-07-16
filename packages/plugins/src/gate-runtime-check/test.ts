// gate 30-test: 採用 runtime の test.sh へ委譲する薄いラッパー(D5 §2.4)。
import { delegate } from './delegate.js';

await delegate('30-test', 'test.sh');
