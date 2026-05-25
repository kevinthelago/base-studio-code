import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { KbBlock } from "../../data/mock";

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  ok?: boolean;
}

interface UiMessage {
  role: "user" | "assistant";
  text?: string;
  toolCalls?: ToolCall[];
  error?: string;
}

type ApiTextBlock    = { type: "text"; text: string };
type ApiToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ApiToolResult   = { type: "tool_result"; tool_use_id: string; content: string };
type ApiContentBlock = ApiTextBlock | ApiToolUseBlock | ApiToolResult;
type ApiMessage      = { role: "user" | "assistant"; content: string | ApiContentBlock[] };

const KB_TOOLS = [
  {
    name: "apply_tag",
    description: "Add a tag to the currently selected knowledge block.",
    input_schema: {
      type: "object",
      properties: { tag: { type: "string", description: "Tag name to add (without #)" } },
      required: ["tag"],
    },
  },
  {
    name: "remove_tag",
    description: "Remove a tag from the currently selected knowledge block.",
    input_schema: {
      type: "object",
      properties: { tag: { type: "string", description: "Tag name to remove (without #)" } },
      required: ["tag"],
    },
  },
  {
    name: "rename_block",
    description: "Rename the currently selected knowledge block.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string", description: "New title for the block" } },
      required: ["title"],
    },
  },
  {
    name: "update_content",
    description: "Replace the full markdown content of the currently selected knowledge block.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string", description: "New markdown content" } },
      required: ["content"],
    },
  },
];

function buildSystem(block: KbBlock): string {
  return `You are a knowledge-base assistant embedded in a developer tool. You help manage and improve knowledge blocks.

Currently selected block:
- ID: ${block.id}
- Title: ${block.title}
- Tags: ${block.tags.length ? block.tags.map((t) => `#${t}`).join(", ") : "none"}
- Lines: ${block.lines}

You can use tools to modify this block (apply/remove tags, rename it, update its content). Always confirm what you changed after each action. Be concise.`;
}

interface Props {
  block: KbBlock;
}

export function KbConsole({ block }: Props) {
  const { claudeApiKey, applyKbTag, removeKbTag, renameKbBlock, updateKbBlockContent } = useAppStore();
  const [uiMsgs, setUiMsgs] = useState<UiMessage[]>([]);
  const [apiMsgs, setApiMsgs] = useState<ApiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [uiMsgs]);

  // Reset conversation when block changes
  useEffect(() => {
    setUiMsgs([]);
    setApiMsgs([]);
  }, [block.id]);

  async function runLoop(msgs: ApiMessage[]): Promise<void> {
    let current = msgs;

    for (;;) {
      let response: { content: ApiContentBlock[]; stop_reason: string };
      try {
        response = await invoke<{ content: ApiContentBlock[]; stop_reason: string }>("kb_chat", {
          messages: current,
          system: buildSystem(block),
          tools: KB_TOOLS,
          apiKey: claudeApiKey,
        });
      } catch (err) {
        setUiMsgs((prev) => [...prev, { role: "assistant", error: String(err) }]);
        setLoading(false);
        return;
      }

      const toolUseBlocks = response.content.filter(
        (b): b is ApiToolUseBlock => b.type === "tool_use"
      );
      const textBlocks = response.content.filter(
        (b): b is ApiTextBlock => b.type === "text"
      );
      const text = textBlocks.map((b) => b.text).join("\n").trim() || undefined;

      if (toolUseBlocks.length === 0) {
        if (text) setUiMsgs((prev) => [...prev, { role: "assistant", text }]);
        setLoading(false);
        return;
      }

      // Execute tools locally
      const resolvedCalls: ToolCall[] = [];
      const resultBlocks: ApiToolResult[] = [];

      for (const tb of toolUseBlocks) {
        let result: string;
        let ok = true;
        try {
          if (tb.name === "apply_tag") {
            const tag = tb.input.tag as string;
            applyKbTag(block.id, tag);
            result = `Applied #${tag}`;
          } else if (tb.name === "remove_tag") {
            const tag = tb.input.tag as string;
            removeKbTag(block.id, tag);
            result = `Removed #${tag}`;
          } else if (tb.name === "rename_block") {
            const title = tb.input.title as string;
            renameKbBlock(block.id, title);
            result = `Renamed to "${title}"`;
          } else if (tb.name === "update_content") {
            const content = tb.input.content as string;
            updateKbBlockContent(block.id, content);
            result = `Updated content (${content.split("\n").length} lines)`;
          } else {
            result = `Unknown tool: ${tb.name}`;
            ok = false;
          }
        } catch (e) {
          result = `Error: ${String(e)}`;
          ok = false;
        }
        resolvedCalls.push({ id: tb.id, name: tb.name, input: tb.input, result, ok });
        resultBlocks.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }

      setUiMsgs((prev) => [
        ...prev,
        { role: "assistant", text, toolCalls: resolvedCalls },
      ]);

      current = [
        ...current,
        { role: "assistant", content: response.content },
        { role: "user", content: resultBlocks },
      ];
      setApiMsgs(current);
    }
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    const userText = input.trim();
    setInput("");
    setLoading(true);

    const nextMsgs: ApiMessage[] = [...apiMsgs, { role: "user", content: userText }];
    setUiMsgs((prev) => [...prev, { role: "user", text: userText }]);
    setApiMsgs(nextMsgs);

    await runLoop(nextMsgs);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        padding: "6px 14px",
        borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-panel)",
        display: "flex", alignItems: "center", gap: 8,
        flexShrink: 0,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
          background: loading ? "var(--accent)" : "var(--success)",
          boxShadow: loading ? "0 0 6px var(--accent)" : "none",
        }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
          kb-assistant · {block.id}
        </span>
        {!claudeApiKey && (
          <span style={{
            marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10,
            color: "var(--warn)",
          }}>
            ⚠ add API key in Settings → Integrations
          </span>
        )}
        {uiMsgs.length > 0 && (
          <button
            className="btn ghost"
            style={{ marginLeft: claudeApiKey ? "auto" : 8, height: 20, fontSize: 10 }}
            onClick={() => { setUiMsgs([]); setApiMsgs([]); }}
          >
            clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}
      >
        {uiMsgs.length === 0 && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)",
            textAlign: "center", paddingTop: 20,
          }}>
            Ask me to tag, rename, or rewrite this block.
          </div>
        )}

        {uiMsgs.map((msg, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start", gap: 3 }}>
            {msg.role === "user" ? (
              <div style={{
                maxWidth: "82%", padding: "7px 11px",
                borderRadius: "10px 10px 2px 10px",
                background: "var(--accent)", color: "#fff",
                fontSize: 12, lineHeight: 1.55,
              }}>
                {msg.text}
              </div>
            ) : (
              <>
                {msg.error && (
                  <div style={{
                    maxWidth: "90%", padding: "7px 11px",
                    borderRadius: "2px 10px 10px 10px",
                    background: "var(--bg-elev)",
                    border: "1px solid var(--danger)",
                    fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
                  }}>
                    {msg.error}
                  </div>
                )}
                {msg.toolCalls?.map((tc, j) => (
                  <div key={j} style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    background: "var(--bg-elev)",
                    border: "1px solid var(--border-soft)",
                    fontFamily: "var(--mono)", fontSize: 10.5,
                    display: "flex", alignItems: "center", gap: 6,
                    maxWidth: "92%",
                  }}>
                    <span style={{ color: "var(--fg-dim)" }}>⚙</span>
                    <span style={{ color: "var(--accent)" }}>{tc.name}</span>
                    <span style={{ color: "var(--fg-dim)" }}>·</span>
                    <span style={{
                      color: "var(--fg-muted)", flex: 1,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {Object.entries(tc.input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}
                    </span>
                    <span style={{ color: "var(--fg-dim)", flexShrink: 0 }}>→</span>
                    <span style={{
                      color: tc.ok !== false ? "var(--success)" : "var(--danger)",
                      flexShrink: 0,
                    }}>
                      {tc.ok !== false ? "✓" : "✗"} {tc.result}
                    </span>
                  </div>
                ))}
                {msg.text && (
                  <div style={{
                    maxWidth: "90%", padding: "7px 11px",
                    borderRadius: "2px 10px 10px 10px",
                    background: "var(--bg-elev)",
                    border: "1px solid var(--border-soft)",
                    fontSize: 12, lineHeight: 1.55, color: "var(--fg)",
                    whiteSpace: "pre-wrap",
                  }}>
                    {msg.text}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", gap: 4, padding: "4px 2px" }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{
                width: 5, height: 5, borderRadius: "50%",
                background: "var(--accent)", opacity: 0.7,
                animation: `pulse 1.2s ease-in-out ${i * 0.25}s infinite`,
              }} />
            ))}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div style={{
        padding: "8px 10px",
        borderTop: "1px solid var(--border-soft)",
        background: "var(--bg-panel)",
        display: "flex", gap: 7, flexShrink: 0,
      }}>
        <textarea
          className="input"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Claude to modify this block…"
          style={{
            flex: 1, resize: "none",
            fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.5,
            padding: "5px 9px",
          }}
        />
        <button
          className="btn primary"
          onClick={handleSend}
          disabled={loading || !input.trim() || !claudeApiKey}
          style={{ height: 30, alignSelf: "flex-end", whiteSpace: "nowrap", fontSize: 11 }}
        >
          {loading ? "…" : "send"}
        </button>
      </div>
    </div>
  );
}
