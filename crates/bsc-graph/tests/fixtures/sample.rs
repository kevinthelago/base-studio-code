// Fixture for the tree-sitter extractor (#2775). `quick_sort` collides with the TS `quickSort`
// (both map to the `quick-sort` concept → a duplicate); `bfs` maps to a concept; `some_helper`
// does not.

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

fn bfs(adj: &[Vec<usize>], start: usize) -> Vec<usize> {
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
    // Not a seed concept — stays unmatched.
}
