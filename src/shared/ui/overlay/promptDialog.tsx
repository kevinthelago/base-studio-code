// Promise-returning prompt / confirm dialogs built on the shared <Dialog> (#1738).
//
// These replace the blocking native window.prompt / window.confirm: those freeze the WebView,
// can't be styled, and can't be driven in tests. Each hook returns an imperative async fn plus a
// `dialog` element to render — so a call site reads almost exactly like the native one:
//
//   const { prompt, dialog } = usePromptDialog();
//   const name = await prompt({ title: "New role", label: "Role name" });   // string | null
//   ...
//   return <div>{children}{dialog}</div>;
//
//   const { confirm, dialog } = useConfirmDialog();
//   if (!(await confirm({ title: "Delete role", message: "Delete it?", danger: true }))) return;
//
// Resolution: OK/Confirm → the value/true; Cancel, Escape, overlay-click → null/false. A second
// open before the first settles resolves the first as cancelled (mirrors a dismissed native dialog).
import { useCallback, useRef, useState } from "react";
import { Dialog } from "./Dialog";

export interface PromptOpts {
  /** Dialog heading. */
  title: string;
  /** Optional descriptive line above the input. */
  label?: string;
  /** Input placeholder. */
  placeholder?: string;
  /** Initial input value (default ""). */
  initial?: string;
  /** Confirm button label (default "OK"). */
  confirmLabel?: string;
  /** Allow submitting an empty/whitespace value (default false — confirm is disabled when empty). */
  allowEmpty?: boolean;
}

interface PromptState extends PromptOpts { value: string }

export function usePromptDialog(): { prompt: (opts: PromptOpts) => Promise<string | null>; dialog: React.ReactNode } {
  const [state, setState] = useState<PromptState | null>(null);
  const resolveRef = useRef<((v: string | null) => void) | null>(null);

  const settle = useCallback((v: string | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setState(null);
    resolve?.(v);
  }, []);

  const prompt = useCallback((opts: PromptOpts) => {
    // A pending prompt is superseded → resolve it as cancelled before opening the new one.
    resolveRef.current?.(null);
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
      setState({ ...opts, value: opts.initial ?? "" });
    });
  }, []);

  const canSubmit = !!state && (state.allowEmpty || state.value.trim().length > 0);

  const dialog = state ? (
    <Dialog
      title={state.title}
      onDismiss={() => settle(null)}
      actions={
        <>
          <button className="btn" onClick={() => settle(null)}>Cancel</button>
          <button className="btn primary" disabled={!canSubmit} onClick={() => canSubmit && settle(state.value)}>
            {state.confirmLabel ?? "OK"}
          </button>
        </>
      }
    >
      {state.label && <div style={{ marginBottom: 8 }}>{state.label}</div>}
      <input
        className="input"
        // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: focus the prompt input when the dialog opens
        autoFocus
        value={state.value}
        placeholder={state.placeholder}
        style={{ width: "100%" }}
        onChange={(e) => setState((s) => (s ? { ...s, value: e.target.value } : s))}
        onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) settle(state.value); }}
      />
    </Dialog>
  ) : null;

  return { prompt, dialog };
}

export interface ConfirmOpts {
  /** Dialog heading. */
  title: string;
  /** Body message. */
  message: React.ReactNode;
  /** Confirm button label (default "Confirm"). */
  confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
  /** Render the dialog + confirm button in the danger style (default false). */
  danger?: boolean;
}

export function useConfirmDialog(): { confirm: (opts: ConfirmOpts) => Promise<boolean>; dialog: React.ReactNode } {
  const [state, setState] = useState<ConfirmOpts | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const settle = useCallback((v: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setState(null);
    resolve?.(v);
  }, []);

  const confirm = useCallback((opts: ConfirmOpts) => {
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setState(opts);
    });
  }, []);

  const dialog = state ? (
    <Dialog
      title={state.title}
      danger={state.danger}
      onDismiss={() => settle(false)}
      actions={
        <>
          <button className="btn" onClick={() => settle(false)}>{state.cancelLabel ?? "Cancel"}</button>
          <button className={`btn ${state.danger ? "danger" : "primary"}`} onClick={() => settle(true)}>
            {state.confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      {state.message}
    </Dialog>
  ) : null;

  return { confirm, dialog };
}
