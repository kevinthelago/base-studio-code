// Fixture for signature extraction (epic-a-graph-finds-its-own-duplicates, slice 1) — the Rust half.
// tree-sitter-rust spells a parameter differently from TypeScript and hands back the return type
// WITHOUT the leading colon, so both paths need pinning against real source rather than assumed.

/// Ordinary parameters and a real return type — the baseline.
pub fn two_typed(xs: &[u32], seed: u32) -> Vec<u32> {
    xs.iter().map(|x| x + seed).collect()
}

/// NO RETURN TYPE is the unit type, and it is ABSENT in the source. A signature that reported `()`
/// here would be inventing an annotation the author did not write.
pub fn no_return(xs: &mut Vec<u32>) {
    xs.push(0);
}

/// NO PARAMETERS — arity 0, the same real bucket the TypeScript side has.
pub fn no_params() -> &'static str {
    "constant"
}

/// A DESTRUCTURED (tuple) pattern, carried verbatim for the same reason as the TypeScript one.
pub fn destructured((lo, hi): (u32, u32)) -> u32 {
    hi.saturating_sub(lo)
}

pub struct Counter {
    n: u32,
}

impl Counter {
    /// A METHOD: `self` is the RECEIVER, not part of the contract a caller supplies, so it is not a
    /// parameter. Counting it would make every method's arity one too high and put it in the wrong
    /// bucket from every free function doing the same job.
    pub fn bump(&mut self, by: u32) -> u32 {
        self.n += by;
        self.n
    }
}
