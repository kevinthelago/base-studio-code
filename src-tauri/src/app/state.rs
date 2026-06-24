
#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Crash-recovery flag (#1041): true when the PREVIOUS shutdown was UNCLEAN — the `.session-lock`
/// marker survived because the `RunEvent::Exit` handler never ran (crash / kill / power loss /
/// force-quit). A clean quit deletes the marker, so a normal restart reads `false`. The frontend
/// reads this once (`was_unclean_shutdown`) to offer restoring the sessions that were running.
pub(crate) struct UncleanShutdown(pub bool);
