// Fixture for the tree-sitter extractor (#2775) + call-graph extraction (#2779). Impl-only (#2961):
// every fn is harvested as a candidate keyed `<kebab-name>.ts`. mergeSort's body calls merge(...), so
// the extractor lifts a same-tech compose edge merge-sort.ts → merge.ts (real-code composition); the
// recursive self-calls and the .slice()/.filter() member calls are NOT compose edges and are dropped.

export function quickSort<T>(xs: T[]): T[] {
  if (xs.length <= 1) return xs.slice();
  const [pivot, ...rest] = xs;
  const left = rest.filter((x) => x < pivot);
  const right = rest.filter((x) => x >= pivot);
  return [...quickSort(left), pivot, ...quickSort(right)];
}

function merge<T>(left: T[], right: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] <= right[j]) out.push(left[i++]);
    else out.push(right[j++]);
  }
  return [...out, ...left.slice(i), ...right.slice(j)];
}

export const mergeSort = <T>(xs: T[]): T[] => {
  if (xs.length <= 1) return xs.slice();
  const mid = xs.length >> 1;
  const left = mergeSort(xs.slice(0, mid));
  const right = mergeSort(xs.slice(mid));
  return merge(left, right);
};

function binarySearch<T>(xs: T[], target: T): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] === target) return mid;
    if (xs[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function helperThing(): void {
  // Not a seed concept — stays unmatched.
}
