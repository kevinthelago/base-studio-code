// usePreviewData (#2940) — resolves a component's preview-data BINDING into the override map
// `ComponentPreviewFrame` feeds `componentPreviewFiles`: run the bound librarian algorithm's `vizCode`
// in the sandbox, normalize its output (`vizRunToDataset`), shape it for the prop (`adaptDataset`), and
// return `{ [prop]: <JS-source literal> }`. The studio-network payoff — a preview renders real
// algorithm-generated data instead of its `[]`/trivial sample.
//
// Fail-SOFT by design: no binding, a missing impl/`vizCode`, a sandbox error, or an unusable dataset all
// resolve to `{}` (the empty override), so the preview simply falls back to the component's own sample.
// Async on the main thread (the sandbox run is a Promise), gated by the component identity so a switch
// re-resolves and a stale result never lands on the wrong component.
import { useEffect, useState } from "react";
import { KNOWLEDGE, implById, runInSandbox, vizRunToDataset } from "@/features/algorithms";
import type { ComponentRecord } from "./lib/model";
import { bindingFor, adaptDataset } from "./lib/previewBindings";

const EMPTY: Record<string, string> = {};

/** The preview-data override map for `comp` (`{ prop: JS-source literal }`), or `{}` until/unless a bound
 *  algorithm resolves. Safe to pass straight to `componentPreviewFiles(..., previewData)`. */
export function usePreviewData(comp: ComponentRecord): Record<string, string> {
  const binding = bindingFor(comp.kitId, comp.name);
  const [data, setData] = useState<Record<string, string>>(EMPTY);

  // Key the resolve on the identity that determines the result — the bound algorithm + prop. A different
  // component (no binding) resets to EMPTY synchronously below via the early clear.
  const key = binding ? `${binding.algorithm}:${binding.prop}` : "";

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- intentional reset: clear stale data when the
       bound component changes or its algorithm has no runnable vizCode (mirrors ComponentPreviewFrame). */
    if (!binding) { setData(EMPTY); return; }
    const impl = implById(KNOWLEDGE, binding.algorithm);
    const vizCode = impl?.vizCode?.trim();
    if (!vizCode) { setData(EMPTY); return; }
    /* eslint-enable react-hooks/set-state-in-effect */

    let cancelled = false;
    void runInSandbox(vizCode)
      .then((run) => {
        if (cancelled) return;
        const value = adaptDataset(vizRunToDataset(run), binding.adapter);
        setData(value == null ? EMPTY : { [binding.prop]: JSON.stringify(value) });
      })
      .catch(() => { if (!cancelled) setData(EMPTY); });

    return () => { cancelled = true; };
    // `key` captures the binding's algorithm+prop; `comp.kitId`/`comp.name` feed `binding` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return binding ? data : EMPTY;
}
