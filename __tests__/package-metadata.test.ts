import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'examples') out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const imports = (pkg: string): string[] =>
  sourceFiles(join(root, 'src')).filter((file) =>
    new RegExp(`(?:from|import|require\\()\\s*['"]${pkg}['"]`).test(readFileSync(file, 'utf8')),
  );

describe('package metadata matches what the source imports', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };

  it('exsorted is loaded by the root entry, so it is not an optional peer', () => {
    expect(imports('exsorted').length).toBeGreaterThan(0);
    expect(pkg.peerDependencies.exsorted).toBeDefined();
    expect(pkg.peerDependenciesMeta.exsorted?.optional).not.toBe(true);
  });

  it('no source file imports the optional ex-flow, so the published typings never reference it', () => {
    expect(pkg.peerDependenciesMeta['ex-flow']?.optional).toBe(true);
    expect(imports('ex-flow')).toEqual([]);
  });
});
