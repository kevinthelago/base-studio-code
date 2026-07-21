// Fixture for the tree-sitter extractor (#2775) + call-graph extraction (#2779). Impl-only (#2961):
// every fn is harvested as a candidate keyed `<kebab-name>.rs`. `quick_sort` shares its kebab id
// `quick-sort` with the TS `quickSort` (one candidate per tech). `merge_sort` calls `merge(...)`, so
// the extractor lifts a same-tech compose edge merge-sort.rs → merge.rs (the SAME edge the TS fixture
// produces, in the other tech); a recursive self-call is NOT composition and is dropped.

pub fn quick_sort<T: Ord + Clone>(xs: &[T]) -> Vec<T> {
    if xs.len() <= 1 {
        return xs.to_vec();
    }
    let pivot = xs[0].clone();
    let left: Vec<T> = xs[1..].iter().filter(|x| **x < pivot).cloned().collect();
    let right: Vec<T> = xs[1..].iter().filter(|x| **x >= pivot).cloned().collect();
    let mut out = quick_sort(&left);
    out.push(pivot);
    out.extend(quick_sort(&right));
    out
}

fn merge<T: Ord + Clone>(left: &[T], right: &[T]) -> Vec<T> {
    let mut out = Vec::with_capacity(left.len() + right.len());
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        if left[i] <= right[j] {
            out.push(left[i].clone());
            i += 1;
        } else {
            out.push(right[j].clone());
            j += 1;
        }
    }
    out.extend_from_slice(&left[i..]);
    out.extend_from_slice(&right[j..]);
    out
}

pub fn merge_sort<T: Ord + Clone>(xs: &[T]) -> Vec<T> {
    if xs.len() <= 1 {
        return xs.to_vec();
    }
    let mid = xs.len() / 2;
    let left = merge_sort(&xs[..mid]);
    let right = merge_sort(&xs[mid..]);
    merge(&left, &right)
}

fn bfs(adj: &[Vec<usize>], start: usize) -> Vec<usize> {
    some_helper();
    let mut order = Vec::new();
    let mut seen = vec![false; adj.len()];
    let mut queue = std::collections::VecDeque::from([start]);
    seen[start] = true;
    while let Some(node) = queue.pop_front() {
        order.push(node);
        for &next in &adj[node] {
            if !seen[next] {
                seen[next] = true;
                queue.push_back(next);
            }
        }
    }
    order
}

fn some_helper() {
    // A tiny helper, harvested as its own candidate — no concept ontology (#2961).
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_only_helper() {
        // A #[test] fn inside a #[cfg(test)] module — the harvester must SKIP it (#2955), never treat
        // it as a reusable library candidate.
        let _ = super::merge(&[1], &[2]);
    }
}
