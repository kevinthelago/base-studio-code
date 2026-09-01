// Fixture for signature extraction (epic-a-graph-finds-its-own-duplicates, slice 1). Every function
// here exists to pin ONE shape the extractor has to get right, and each was chosen because getting it
// wrong is silent: a dropped parameter or a type read as absent produces a plausible signature that is
// simply not the one in the source.

// THREE TYPE STATES in one signature: known, absent, and opaque. The whole reason `TypeRef` is three
// states rather than `Option<String>` — `n` and `x` must not read as the same thing.
export function threeStates(xs: string[], n, x: any): number {
  return xs.length + (n as number) + (x as number);
}

// A DESTRUCTURED parameter. Its "name" is the pattern verbatim: there is no identifier to take, and
// inventing one (`arg0`, or the first key) would be a name the source never used.
export function destructured({ ok, code }: { ok: boolean; code: number }): string {
  return ok ? `ok:${code}` : `fail:${code}`;
}

// AN UNTYPED ARROW. Its parameter is a bare `identifier` with no `pattern` field — the shape an
// allow-list of parameter node kinds drops in silence, which is why `collect_params` walks named
// children instead.
export const untypedArrow = (value) => String(value);

// AN ARROW WITH A CONTRACT, bound to a const. The parameters live on the VALUE, not on the
// declarator, so a signature read off the binding node finds nothing at all.
export const typedArrow = (xs: number[], seed: number): number => xs.reduce((a, b) => a + b, seed);

// `unknown` is OPAQUE, not known. It is a real TypeScript type that means precisely "I will not tell
// you", so it can never support a claim that two functions take the same thing.
export function opaqueUnknown(input: unknown): void {
  void input;
}

// NO RETURN ANNOTATION — inferred, so absent. Distinct from `: void`, which is a real declared type.
export function inferredReturn(a: number, b: number) {
  return a + b;
}

// NO PARAMETERS AT ALL — arity 0, which is a real bucket and not a missing signature.
export function noParams(): string {
  return "constant";
}

class Registry {
  private items: string[] = [];
  // A METHOD DEFINITION. Same three fields as a function declaration, different node kind — and the
  // one shape that reaches the extractor only through `method_definition`.
  add(item: string, at: number): boolean {
    this.items.splice(at, 0, item);
    return true;
  }
}
export const registry = new Registry();
