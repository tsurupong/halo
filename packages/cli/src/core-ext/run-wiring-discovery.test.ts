// H2 / N7: discoverPort が弾いたプラグインを呼び出し元へ伝える。以前は issues を捨てて
// いたため、gate-loop-audit の manifest が壊れた/ dist が無いだけで安全網が 1 枚黙って
// 外れ、残ったゲートで pass 判定が続いた。ADR-0004 は「検知のみ・警告して継続」を
// 明示的に却下しているので、起動を止められるだけの情報を返せていることを検証する。
import { describe, expect, it } from 'vitest';
import type { DirEntry, DiscoveryFs } from '@tsurupong/halo-core';
import { discoverLoopPorts } from './run-wiring.js';

/** ports 配下だけを持つ最小の DiscoveryFs。キーは絶対パス。 */
function discoveryFs(files: Record<string, string>): DiscoveryFs {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    async readDir(path): Promise<DirEntry[]> {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of [...Object.keys(files), ...dirs]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).split('/')[0];
        if (rest !== undefined && rest !== '') names.add(rest);
      }
      return [...names].map((name) => ({
        name,
        isDirectory: dirs.has(`${path}/${name}`),
        isFile: files[`${path}/${name}`] !== undefined,
      }));
    },
    async readFile(path) {
      const v = files[path];
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async exists(path) {
      return files[path] !== undefined || dirs.has(path);
    },
  };
}

const HALO = '/repo/.halo';

function manifest(port: string, name: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ name, version: '1.0.0', port, entry: 'main.js', ...extra });
}

/** task-source と executor を満たす最小構成 (これだけなら issues は空になる)。 */
function minimalPorts(): Record<string, string> {
  return {
    [`${HALO}/ports/task-source.d/ts/plugin.json`]: manifest('task-source', 'ts'),
    [`${HALO}/ports/task-source.d/ts/main.js`]: '',
    [`${HALO}/ports/executor.d/ex/plugin.json`]: manifest('executor', 'ex'),
    [`${HALO}/ports/executor.d/ex/main.js`]: '',
  };
}

describe('discoverLoopPorts', () => {
  it('reports no issues for a well-formed port set', async () => {
    const { ports, issues } = await discoverLoopPorts(HALO, discoveryFs(minimalPorts()));
    expect(issues).toEqual([]);
    expect(ports.taskSource).toHaveLength(1);
    expect(ports.executor).toHaveLength(1);
  });

  it('surfaces a gate whose manifest is invalid instead of silently dropping it', async () => {
    const files = {
      ...minimalPorts(),
      [`${HALO}/ports/gate.d/50-loop-audit/plugin.json`]: '{ not json',
      [`${HALO}/ports/gate.d/50-loop-audit/main.js`]: '',
    };
    const { ports, issues } = await discoverLoopPorts(HALO, discoveryFs(files));
    expect(ports.gate).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.port).toBe('gate');
    expect(issues[0]!.dir).toContain('50-loop-audit');
  });

  it('surfaces a gate whose entry is missing (unbuilt dist, moved repo)', async () => {
    const files = {
      ...minimalPorts(),
      // plugin.json はあるが main.js が無い = requireEntry で弾かれる経路。
      [`${HALO}/ports/gate.d/50-loop-audit/plugin.json`]: manifest('gate', 'audit'),
    };
    const { ports, issues } = await discoverLoopPorts(HALO, discoveryFs(files));
    expect(ports.gate).toHaveLength(0);
    expect(issues.some((i) => i.port === 'gate' && i.message.includes('entry not found'))).toBe(
      true,
    );
  });

  it('reports an empty single port through the same channel (N7)', async () => {
    const files = { ...minimalPorts() };
    delete files[`${HALO}/ports/executor.d/ex/plugin.json`];
    delete files[`${HALO}/ports/executor.d/ex/main.js`];
    const { issues } = await discoverLoopPorts(HALO, discoveryFs(files));
    expect(
      issues.some((i) => i.port === 'executor' && i.message.includes('no enabled plugin')),
    ).toBe(true);
  });

  it('does not treat an empty multi-plugin port as a problem', async () => {
    // gate / sink / on-fail / context は 0 件でも構成として正当 (D2 §2.7)。
    const { issues } = await discoverLoopPorts(HALO, discoveryFs(minimalPorts()));
    expect(issues.filter((i) => i.port === 'gate')).toEqual([]);
    expect(issues.filter((i) => i.port === 'sink')).toEqual([]);
  });
});
