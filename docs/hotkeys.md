# Hotkeys

All hotkeys are global and active regardless of which element has focus, except when the cursor is inside a text input or textarea.

---

## Screen Navigation

| Key | Action |
|-----|--------|
| `F1` | Switch to **Console** |
| `F2` | Switch to **Knowledge Store** |
| `F3` | Switch to **Automations** |
| `F4` | Switch to **GitHub** |
| `F5` | Switch to **Settings** |

---

## Pane Focus & Fullscreen

Panes are numbered left-to-right, top-to-bottom within the active console tab layout.

| Key | Action |
|-----|--------|
| `Ctrl+1` – `Ctrl+9` | **First press** — focus that pane (accent border highlight) |
| `Ctrl+N` *(focused)* | **Second press** — fullscreen that pane (fills the entire console area) |
| `Ctrl+N` *(fullscreened)* | **Third press** — restore the pane to the grid |

> Pressing `Ctrl+N` on a *different* pane while one is focused clears the previous focus and focuses the new one. If a pane is fullscreened and you press a different `Ctrl+N`, the fullscreen is exited and the new pane becomes focused.

Only applies while on the **Console** screen. Keys higher than the pane count for the active layout are ignored (e.g. `Ctrl+5` is a no-op in a 2×2 layout).

---

## Pane View Switching

| Key | Action |
|-----|--------|
| `Alt+1` | Switch **focused pane** to **Console** view |
| `Alt+2` | Switch **focused pane** to **Files** view |
| `Alt+3` | Switch **focused pane** to **Branches** view |
| `Alt+4` | Switch **focused pane** to **Changes** view |
| `Alt+5` | Switch **focused pane** to **Log** view |
| `Alt+Shift+1` – `Alt+Shift+5` | Switch **all panes** to the corresponding view |

> `Alt+1`–`Alt+5` require a focused pane (`Ctrl+N` to focus one first). `Alt+Shift+N` applies to all panes unconditionally.

Only applies while on the **Console** screen.

---

## Implementation Notes

Hotkeys are implemented in `src/hooks/useHotkeys.ts` and mounted once in `src/App.tsx`. Digit detection uses `e.code` (e.g. `"Digit1"`) rather than `e.key` so that modifier combinations like `Alt+Shift+1` resolve correctly regardless of keyboard layout or OS input method.
