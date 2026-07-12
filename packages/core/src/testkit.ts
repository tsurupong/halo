// テスト専用の in-memory CliFs。実 I/O を排し写像テストに徹する。
import type { CliFs } from './fs.js';

export interface MemFs extends CliFs {
  files: Map<string, string>;
  dirs: Set<string>;
}

function norm(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/** 単純な in-memory fs。ディレクトリは明示集合で管理し、書き込み時に親を自動生成する。 */
export function memFs(seed: { files?: Record<string, string>; dirs?: string[] } = {}): MemFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);

  const addDirs = (path: string): void => {
    const parts = norm(path).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      dirs.add(cur);
    }
  };

  for (const [p, c] of Object.entries(seed.files ?? {})) {
    const np = norm(p);
    files.set(np, c);
    addDirs(np.slice(0, np.lastIndexOf('/')) || '/');
  }
  for (const d of seed.dirs ?? []) addDirs(d);

  return {
    files,
    dirs,
    async readFile(path) {
      const v = files.get(norm(path));
      if (v === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async writeFile(path, data) {
      const np = norm(path);
      files.set(np, data);
      addDirs(np.slice(0, np.lastIndexOf('/')) || '/');
    },
    async mkdir(path) {
      addDirs(path);
    },
    async readdir(path) {
      const np = norm(path);
      if (!dirs.has(np)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const prefix = np === '/' ? '/' : `${np}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (key === np) continue;
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length).split('/')[0];
          if (rest) names.add(rest);
        }
      }
      return [...names];
    },
    async rm(path) {
      files.delete(norm(path));
    },
    async exists(path) {
      const np = norm(path);
      return files.has(np) || dirs.has(np);
    },
    async isDirectory(path) {
      return dirs.has(norm(path));
    },
  };
}
