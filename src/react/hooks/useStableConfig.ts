import { useRef } from 'react';
import type { SearchConfig } from '../../types';

type Scalar = Exclude<keyof SearchConfig<unknown>, 'keys'>;
const SCALARS = [
  'threshold',
  'fuzzyMaxDistance',
  'caseSensitive',
  'sortAlgorithm',
  'useWorker',
  'fuzzyMode',
] as const satisfies readonly Scalar[];
// A new SearchConfig field fails typecheck here until it is added to SCALARS.
type Exhaustive = Exclude<Scalar, (typeof SCALARS)[number]> extends never ? true : never;
export const SCALARS_EXHAUSTIVE: Exhaustive = true;

/** Structural equality of two configs (keys element-wise, every scalar field). `Object.is` so NaN equals NaN. */
export function configEqual<T>(a: SearchConfig<T>, b: SearchConfig<T>): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const f of SCALARS) if (!Object.is(a[f], b[f])) return false;
  const ka: unknown = a.keys;
  const kb: unknown = b.keys;
  if (ka === kb) return true;
  if (!Array.isArray(ka) || !Array.isArray(kb) || ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const x = ka[i] as { name?: unknown; weight?: unknown } | null;
    const y = kb[i] as { name?: unknown; weight?: unknown } | null;
    if (x === y) continue;
    if (!x || !y || !Object.is(x.name, y.name) || !Object.is(x.weight, y.weight)) return false;
  }
  return true;
}

/**
 * Returns the previously seen config object while the new one is structurally
 * equal, so hooks can key on config CONTENT: an inline `{ keys: [...] }` literal
 * (a new identity every render) no longer restarts effects or rebuilds searchers.
 * @internal
 */
export function useStableConfig<T>(config: SearchConfig<T>): SearchConfig<T> {
  const ref = useRef(config);
  if (ref.current !== config && !configEqual(ref.current, config)) ref.current = config;
  return ref.current;
}
