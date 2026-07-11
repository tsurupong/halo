// CLI 側の fs シーム (D3 §0 のテスト容易性)。core の各 Fs シームと同型の最小集合を
// まとめ、コマンドはこれを注入して実 I/O を切り離す。既定は node:fs/promises 実装。
import { mkdir, readFile, writeFile, readdir, rm, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface CliFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  /** パスの存在。ENOENT を false に写像する。 */
  exists(path: string): Promise<boolean>;
  /** ディレクトリか。存在しなければ false。 */
  isDirectory(path: string): Promise<boolean>;
}

export function createNodeCliFs(): CliFs {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, data) => {
      await writeFile(path, data, 'utf8');
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readdir: (path) => readdir(path),
    rm: async (path) => {
      await rm(path, { force: true });
    },
    exists: async (path) => {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
