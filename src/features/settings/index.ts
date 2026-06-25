// Settings feature — public API (#1309): the Settings screen (GitHub, Integrations, Appearance,
// Keyboard, Performance, Logs, Diagnostics, …). Its lib (appearance/keybindings/shortcuts) is in
// @/features/settings/lib/*. Settings has no dedicated store slice — it reads scattered core state.
export { SettingsScreen } from "./SettingsScreen";
