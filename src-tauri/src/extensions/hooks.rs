use crate::*;

/// Overwrite `config.hooks` with the resolved hooks, grouped by event:
/// `{event: [{matcher?, hooks: [{type:"command", command}]}]}`. Empty → key removed.
pub(crate) fn write_session_hooks(config: &mut serde_json::Value, hooks: &[HookCfg]) {
    let obj = config.as_object_mut().unwrap();
    if hooks.is_empty() { obj.remove("hooks"); return; }
    let mut by_event = serde_json::Map::new();
    for h in hooks {
        let inner = serde_json::json!({ "type": "command", "command": h.command });
        let entry = if h.matcher.is_empty() {
            serde_json::json!({ "hooks": [inner] })
        } else {
            serde_json::json!({ "matcher": h.matcher, "hooks": [inner] })
        };
        by_event
            .entry(h.event.clone())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut().unwrap()
            .push(entry);
    }
    obj.insert("hooks".into(), serde_json::Value::Object(by_event));
}
