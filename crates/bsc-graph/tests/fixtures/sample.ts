// Fixture for the tree-sitter extractor (#2775). Names chosen to exercise concept mapping:
// quickSort / mergeSort / binarySearch resolve to seed concepts; helperThing does not.

export function quickSort<T>(xs: T[]): T[] {
  if (xs.length <= 1) return xs.slice();
  const [pivot, ...rest] = xs;
  const left = rest.filter((x) => x < pivot);
  const right = rest.filter((x) => x >= pivot);
  return [...quickSort(left), pivot, ...quickSort(right)];
}

export const mergeSort = <T>(xs: T[]): T[] => {
  if (xs.length <= 1) return xs.slice();
  const mid = xs.length >> 1;
  const left = mergeSort(xs.slice(0, mid));
  const right = mergeSort(xs.slice(mid));
  return [...left, ...right];
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
