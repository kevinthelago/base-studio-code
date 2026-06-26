# Hotkeys

Hotkeys are **rebindable** and **Console-scoped** (#1218): the listeners attach only
on the Console screen and detach while a pane is maximized. Because bindings are
user-editable, this file does **not** enumerate them — a hand-maintained list drifts
from the code the moment a key changes.

## Where to find them

- **In the app:** open **Settings → Keyboard** for the full, live list grouped by
  category (screen navigation, pane focus/fullscreen, view switching, broadcast,
  zoom, …), where you can also rebind any shortcut or reset to defaults.
- **In the code (source of truth):** the canonical registry is
  `src/features/settings/lib/shortcuts.ts` (`SHORTCUT_REGISTRY` / `SHORTCUT_GROUPS`);
  the dispatcher is `src/shared/hooks/useHotkeys.ts`. Digit detection uses `e.code`
  (e.g. `"Digit1"`) so chords like `Alt+Shift+1` resolve regardless of keyboard
  layout or OS input method.

To document a specific binding elsewhere, read it from `SHORTCUT_REGISTRY` rather than
copying it here.
