// usePreviewData (#2940 / #3439) — resolves a component's preview data into the override map
// `ComponentPreviewFrame` feeds `componentPreviewFiles`, in the resolution order
//
//     curated binding (#2940)  →  shape tier (#3439)  →  samplePropValue (the component's own sample)
//
// 1. A curated `PREVIEW_BINDINGS` row runs the bound librarian algorithm's `vizCode` in the sandbox,
//    normalizes it (`vizRunToDataset`), shapes it for the prop (`adaptDataset`) — ASYNC.
// 2. Otherwise, if the component declares a supported `DataShape`, the SHAPE TIER feeds it real
//    algorithm-generated data with no per-component row (`shapePreviewData`) — SYNC (the trace programs
//    run on the main thread).
// 3. Otherwise `{}` → the component's own sample shows.
//
// Fail-SOFT throughout: a missing impl/`vizCode`, a sandbox error, an unusable dataset, or a shape with
// no landable prop all resolve to `{}`, so a preview is never broken.
import { useEffect, useMemo, useState } from "react";
import { KNOWLEDGE, implById, runInSandbox, vizRunToDataset, datasetForStructure } from "@/features/algorithms";
import type { ComponentRecord } from "./lib/model";
import { bindingFor, adaptDataset } from "./lib/previewBindings";
import { shapePreviewData } from "./lib/shapePreview";

const EMPTY: Record<string, string> = {};

/** The preview-data override map for `comp` (`{ prop: JS-source literal }`), or `{}` until/unless a bound
 *  algorithm or a supported shape resolves. Safe to pass straight to `componentPreviewFiles(..., previewData)`. */
export function usePreviewData(comp: ComponentRecord): Record<string, string> {
  const binding = bindingFor(comp.kitId, comp.name);
  const [data, setData] = useState<Record<string, string>>(EMPTY);

  // Shape tier (#3439): SYNC — only when there is NO curated binding (that path wins). The trace programs
  // run on the main thread, so this needs no effect; memoized on the component identity that determines it.
  const shapeData = useMemo(
    () => (binding ? EMPTY : shapePreviewData(comp, datasetForStructure)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- comp identity (kitId/name/shapes/props) determines it
    [binding, comp.kitId, comp.name],
  );

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

  return binding ? data : shapeData;
}
