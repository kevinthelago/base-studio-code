// JSX outline (#4169, epic #3604) — reduce a `.tsx` source to the TREE OF ELEMENTS it renders, so the
// graph copy of a page and the file copy can be compared structurally rather than byte-for-byte.
//
// WHY NOT a byte diff: the graph copy of a page is a transcription of the file with deliberate rewrites —
// a generated header comment, the CSS side-effect import stripped, barrel re-exports dropped, sibling
// specifiers rewritten to `@/components/<id>` (see `scripts/gen-*-graph.cjs`). Those differ by design, so a
// text diff is all noise. What must NOT differ is the SKELETON: the elements the page renders and how they
// nest. That is the "N nodes differ" signal #4169 asks shadow mode to report.
//
// WHY NOT a real parser: the loader's compile step is esbuild-wasm (browser-only), and shadow mode has to
// run everywhere the report is wanted — including a node test. This scanner is a lexical approximation: it
// walks the source skipping comments, strings and template literals, and records every JSX element it
// opens. It is deliberately NOT exact.
//
// The approximation is SOUND for the one job it has, because the comparison is SYMMETRIC: both sides are
// scanned by this same function, and the graph copy is a transcription of the file copy. A quirk (a
// generic arrow read as a tag, JSX inside a template literal missed) lands identically on both sides and
// cancels in the diff. What survives is real drift — an element added to the file and never carried to the
// graph node, which is exactly the migration risk this reports on.

/** One JSX element in the outline: its tag and the elements nested inside it. */
export interface OutlineNode {
  tag: string;
  children: OutlineNode[];
}

/** A JSX tag name: components (`Foo`, `Foo.Bar`), intrinsics (`div`), namespaced (`svg:use`). */
const TAG = /^[A-Za-z_$][A-Za-z0-9_$.:-]*/;

/** Token positions where a `<` at brace depth 0 can legitimately open JSX (`return <div/>`, `? <a/> : <b/>`,
 *  `{cond && <Row/>}`, `=> <Card/>`, an argument, an array element). Anything else — most importantly an
 *  identifier, as in `a < b` or `useState<Foo>(` — is NOT JSX. Only consulted OUTSIDE a JSX element; inside
 *  one, children context makes `<` unambiguous. */
const JSX_START_CONTEXT = /(^|[({[,;:=?&|!+*}>]|\b(?:return|default|case|typeof|await|yield|in|of|as)\s*)\s*$/;

/** Scan `source` and return the ROOT JSX elements it renders, each with its nested children. */
export function outlineJsx(source: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  let i = 0;

  const push = (node: OutlineNode): void => {
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
  };

  while (i < source.length) {
    const c = source[i];

    // — skip the regions a `<` inside cannot be JSX we care about —
    if (c === "/" && source[i + 1] === "/") {
      i = lineEnd(source, i);
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(source, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(source, i);
      continue;
    }

    if (c !== "<") {
      i++;
      continue;
    }

    // — a `<`: closing tag, fragment, or an opening element —
    if (source[i + 1] === "/") {
      const gt = source.indexOf(">", i);
      if (gt < 0) break;
      if (stack.length) stack.pop();
      i = gt + 1;
      continue;
    }
    if (source[i + 1] === ">") {
      // `<>` — a fragment. Counted as a node: dropping one changes the tree the same way any wrapper does.
      const node: OutlineNode = { tag: "Fragment", children: [] };
      push(node);
      stack.push(node);
      i += 2;
      continue;
    }

    const name = TAG.exec(source.slice(i + 1))?.[0];
    // Outside a JSX element the `<` must sit where an expression can start, or it is a comparison / a type
    // argument. Inside one we are in children position, where `<` always opens an element.
    // A 32-char look-back window, not `slice(0, i)`: the pattern is anchored at its end, so only the tail
    // can match — and re-slicing the whole prefix at every `<` makes a 30k-char page quadratic.
    if (!name || (stack.length === 0 && !JSX_START_CONTEXT.test(source.slice(Math.max(0, i - 32), i)))) {
      i++;
      continue;
    }

    const tagEnd = findTagEnd(source, i + 1 + name.length);
    if (tagEnd.close < 0) break;
    const node: OutlineNode = { tag: name, children: [] };
    push(node);
    // Attribute expressions can render JSX of their own (`renderRow={(r) => <Row … />}`), and drift hides
    // there as readily as in children — so the attribute region is scanned too, and what it renders is
    // attached as children of the element that holds it.
    for (const child of outlineJsx(source.slice(i + 1 + name.length, tagEnd.close))) node.children.push(child);
    if (!tagEnd.selfClosing) stack.push(node);
    i = tagEnd.close + 1;
  }

  return roots;
}

/** Flatten an outline to one path per element (`Screen>TabBar>Chip`), depth-first. Compared as a MULTISET
 *  by [`diffOutlines`], so a repeated element counts once per occurrence and no sibling index is needed. */
export function outlinePaths(roots: OutlineNode[], prefix = ""): string[] {
  const paths: string[] = [];
  for (const node of roots) {
    const path = prefix ? `${prefix}>${node.tag}` : node.tag;
    paths.push(path);
    paths.push(...outlinePaths(node.children, path));
  }
  return paths;
}

/** Total elements in an outline — the denominator for "N of M nodes differ". */
export function countNodes(roots: OutlineNode[]): number {
  return roots.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

// ————— lexical skips —————

function lineEnd(src: string, from: number): number {
  const nl = src.indexOf("\n", from);
  return nl < 0 ? src.length : nl + 1;
}

/** Past the closing quote of a `'`/`"` literal opened at `from` (escapes respected; an unterminated
 *  literal — which a lexical scan can produce from an apostrophe in a comment it mis-skipped — stops at
 *  the newline rather than swallowing the rest of the file). */
function skipQuoted(src: string, from: number, quote: string): number {
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === "\n") return i + 1;
  }
  return src.length;
}

/** Past the closing backtick of a template literal — INCLUDING its `${…}` holes. JSX inside a template
 *  hole is not something this codebase writes, and skipping the whole literal keeps the scanner simple. */
function skipTemplate(src: string, from: number): number {
  let depth = 0;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "$" && src[i + 1] === "{") { depth++; i++; }
    else if (c === "}" && depth > 0) depth--;
    else if (c === "`" && depth === 0) return i + 1;
  }
  return src.length;
}

/** The `>` closing an opening tag, skipping attribute strings and `{…}` expression braces.
 *  `close` is the index of that `>` (−1 if unterminated); `selfClosing` reports a `/>`. */
function findTagEnd(src: string, from: number): { close: number; selfClosing: boolean } {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c) - 1; continue; }
    if (c === "`") { i = skipTemplate(src, i) - 1; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth = Math.max(0, depth - 1); continue; }
    if (c === ">" && depth === 0) {
      return { close: i, selfClosing: /\/\s*$/.test(src.slice(from, i)) };
    }
  }
  return { close: -1, selfClosing: false };
}
