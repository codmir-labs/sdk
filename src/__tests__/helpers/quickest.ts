/**
 * The shortest of at most `runs` runs of `fn`, in milliseconds, and no more runs than it takes to get under `bound`. A
 * busy machine makes one run slow; a cost that is really there makes every run slow.
 */
export function quickest(fn: () => unknown, bound: number, runs = 6): number {
  let best = Infinity;
  for (let i = 0; i < runs && best >= bound; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}
