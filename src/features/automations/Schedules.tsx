import { useAppStore } from "@/store";
import { paneCount, type Every, type Automation, type SimpleWhen } from "./lib/scheduler";
import { isValidCron } from "./lib/cron";
import { fmtStamp } from "./format";
import { Pane } from "@/shared/ui/overlay/Pane";
import { Chip } from "@/shared/ui/data/Chip";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { SelectField } from "@/shared/ui/controls/Field";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

const EVERY_OPTS: Every[] = ["minute", "hour", "day", "weekday"];

function runsTable(runs: Automation["runs"]) {
  if (runs.length === 0) {
    return (
      <Box className="mono" style={{ padding: 14, textAlign: "center", color: "var(--fg-dim)", fontSize: 11, border: "1px dashed var(--border)", borderRadius: 6 }}>
        no runs yet
      </Box>
    );
  }
  return (
    <Box className="runs-table">
      {runs.map((r, i) => (
        <Box className="r" key={i}>
          <Box as="span" className="t">{fmtStamp(r.at)}</Box>
          <Box as="span" className={"st " + r.status}>{r.status === "ok" ? "✓ ok" : r.status === "skipped" ? "− skipped" : "✗ fail"}</Box>
          <Box as="span" className="out">{r.note}</Box>
        </Box>
      ))}
    </Box>
  );
}

/** The Schedules tab — the full-width list of automations. Selecting one opens the slide-in
 *  <ScheduleDrawer> (rendered in the screen overlay), matching the MCP + Skills editor drawers (#1824). */
export function SchedulesTab({ selectedId, onSelect, onNew }: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const automations = useAppStore(s => s.automations);

  if (automations.length === 0) {
    return (
      <EmptyState
        title="No automations yet"
        description="Schedule a command to fire into a console pane on a cadence."
        actions={<Button variant="primary" onClick={onNew}>+ New automation</Button>}
      />
    );
  }

  const armedCount = automations.filter(a => a.armed).length;
  return (
    <Box className="sched-layout">
      <Card className="sched-list">
        <Box className="head">
          <Box className="head-row">
            <h3>Schedules</h3>
            <Box as="span" className="hint">{automations.length} total · {armedCount} armed</Box>
          </Box>
        </Box>
        <Box className="scroll">
          {automations.map(a => (
            <Box key={a.id} className={"sched-row" + (a.id === selectedId ? " on" : "")} onClick={() => onSelect(a.id)}>
              <Box className="l1">
                <Box as="span" className={"dot" + (a.armed ? "" : " off")} />
                <Box as="span" className="spacer" />
                <Chip style={{ fontSize: 9.5 }}>{a.action}</Chip>
              </Box>
              <Box className="name">{a.name}</Box>
              <Box className="meta">
                <Text as="span">{a.when.kind === "simple"
                  ? `⏱ every ${a.when.every}${a.when.every !== "minute" ? " · " + a.when.at : ""}`
                  : `⏱ cron · ${a.when.expr}`}</Text>
                <Text as="span">{a.targetTab ? `→ ${a.targetTab} › pane ${a.targetPaneIdx + 1}` : "→ (no target)"}</Text>
              </Box>
            </Box>
          ))}
          <Box style={{ padding: "12px 14px" }}>
            <Button variant="ghost" style={{ width: "100%", justifyContent: "center" }} onClick={onNew}>+ new automation</Button>
          </Box>
        </Box>
      </Card>
    </Box>
  );
}

/** The slide-in editor for the selected schedule — the unified <Pane> drawer (#1824), the same
 *  chrome as the MCP server/hook + Skills drawers. Rendered in the AutomationsWorkspace overlay. */
export function ScheduleDrawer({ selected, onClose, onViewAllHistory }: {
  selected: Automation | null;
  onClose: () => void;
  onViewAllHistory: (id: string) => void;
}) {
  const { updateAutomation, setAutomationArmed, removeAutomation, tabs, paneNames } = useAppStore();
  const sel = selected;
  const close = onClose;

  const tabIdx = sel ? tabs.findIndex(t => t.name === sel.targetTab) : -1;
  const paneOpts = tabIdx >= 0 ? Array.from({ length: paneCount(tabs[tabIdx].layout) }, (_, i) => i) : [];
  const patchSimple = (p: Partial<SimpleWhen>) => {
    if (sel && sel.when.kind === "simple") updateAutomation(sel.id, { when: { ...sel.when, ...p } });
  };
  const setMode = (kind: "simple" | "cron") => {
    if (!sel || kind === sel.when.kind) return;
    updateAutomation(sel.id, {
      when: kind === "cron" ? { kind: "cron", expr: "0 9 * * *" } : { kind: "simple", every: "day", at: "09:00" },
    });
  };

  return (
    <Pane
      flush
      open={!!sel}
      onClose={close}
      onRemove={() => { if (sel) { removeAutomation(sel.id); close(); } }}
      header={sel && (
        <>
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke .name-input Pane-header title input, not a .field stack; TextField would change the header chrome */}
          <input className="name-input" value={sel.name} onChange={e => updateAutomation(sel.id, { name: e.target.value })} />
          <Box as="span" className={"toggle" + (sel.armed ? " on" : "")} title="armed" onClick={() => setAutomationArmed(sel.id, !sel.armed)} />
          <Text as="span" mono size={11} style={{ color: sel.armed ? "var(--success)" : "var(--fg-dim)" }}>{sel.armed ? "armed" : "disarmed"}</Text>
        </>
      )}
      body={sel && (
        <>
          {/* when */}
          <Box className="es"><Box className="es-row">
            <Box className="es-lbl accent">when</Box>
            <Stack gap={8}>
              <SegmentedControl
                options={[
                  { label: "simple", on: sel.when.kind === "simple", onClick: () => setMode("simple") },
                  { label: "cron", on: sel.when.kind === "cron", onClick: () => setMode("cron") },
                ]}
              />
              {sel.when.kind === "simple" ? (
                <Row gap={8} wrap className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  <Text as="span">every</Text>
                  {/* eslint-disable-next-line no-restricted-syntax -- inline select within a mono expression Row ("every … at …"); SelectField's .field stack would change layout */}
                  <select className="input" style={{ width: 120 }} value={sel.when.every} onChange={e => patchSimple({ every: e.target.value as Every })}>
                    {EVERY_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                  {sel.when.every !== "minute" && (
                    <>
                      <Text as="span">at</Text>
                      {/* eslint-disable-next-line no-restricted-syntax -- inline input within a mono expression Row; TextField's .field wrapper would change layout */}
                      <input className="input" style={{ width: 90 }} value={sel.when.at}
                        placeholder={sel.when.every === "hour" ? ":MM" : "HH:MM"}
                        onChange={e => patchSimple({ at: e.target.value })} />
                    </>
                  )}
                </Row>
              ) : (
                <Row gap={8} wrap className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  <Text as="span">cron</Text>
                  {/* eslint-disable-next-line no-restricted-syntax -- inline cron-expression input within a mono Row; TextField's .field wrapper would change layout */}
                  <input className="input" style={{ width: 200 }} value={sel.when.expr} placeholder="0 9 * * *" spellCheck={false}
                    onChange={e => updateAutomation(sel.id, { when: { kind: "cron", expr: e.target.value } })} />
                  {isValidCron(sel.when.expr)
                    ? <Text as="span" tone="dim" size={10}>min hour day-of-month month day-of-week</Text>
                    : <Text as="span" tone="danger" size={10}>invalid expression</Text>}
                </Row>
              )}
              <Box className="cron-strip">
                <Box as="span" className="label">next run</Box>
                <Box as="span" className="expr">{sel.armed ? fmtStamp(sel.nextRunAt) : "disarmed"}</Box>
                <Box as="span" style={{ flex: 1 }} />
                <Text as="span">last · <b>{sel.lastRunAt ? fmtStamp(sel.lastRunAt) : "never"}</b></Text>
              </Box>
            </Stack>
          </Box></Box>

          {/* target */}
          <Box className="es"><Box className="es-row">
            <Box className="es-lbl info">target</Box>
            {tabs.length === 0 ? (
              <Box className="hint">No console tabs open — open a console (and a pane) to target.</Box>
            ) : (
              <Grid cols={2} gap={10}>
                <SelectField label="console" value={sel.targetTab} onChange={v => updateAutomation(sel.id, { targetTab: v, targetPaneIdx: 0 })}>
                  {!tabs.some(t => t.name === sel.targetTab) && <option value={sel.targetTab}>{sel.targetTab || "(pick a console)"}</option>}
                  {tabs.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                </SelectField>
                <SelectField label="pane" value={String(sel.targetPaneIdx)} onChange={v => updateAutomation(sel.id, { targetPaneIdx: Number(v) })}>
                  {paneOpts.length === 0 && <option value={0}>Pane 1</option>}
                  {paneOpts.map(i => {
                    const nm = paneNames[tabIdx]?.[i];
                    return <option key={i} value={i}>Pane {i + 1}{nm ? ` · ${nm}` : ""}</option>;
                  })}
                </SelectField>
              </Grid>
            )}
          </Box></Box>

          {/* action */}
          <Box className="es"><Box className="es-row">
            <Box className="es-lbl success">action</Box>
            <Stack gap={10}>
              {/* eslint-disable-next-line no-restricted-syntax -- input is a direct Stack child in a bespoke .es-row edit-section (label via .es-lbl, separate hint); TextField's .field wrapper would change layout */}
              <input className="input" placeholder="command to run in the target pane…" value={sel.command ?? ""} onChange={e => updateAutomation(sel.id, { command: e.target.value })} />
              <Box as="span" className="hint">Typed into the target pane's session, then submitted.</Box>
            </Stack>
          </Box></Box>

          {/* history */}
          <Box className="es" style={{ background: "var(--bg-canvas)" }}><Box className="es-row">
            <Box className="es-lbl muted">history</Box>
            <Box>
              <Row align="baseline" gap={10} style={{ marginBottom: 10 }}>
                <Text as="span" mono size={11} tone="muted">last {sel.runs.length} runs</Text>
                <Box as="span" style={{ flex: 1 }} />
                {sel.runs.length > 0 && <Button variant="ghost" style={{ height: 22, fontSize: 10.5 }} onClick={() => onViewAllHistory(sel.id)}>view all →</Button>}
              </Row>
              {runsTable(sel.runs)}
            </Box>
          </Box></Box>
        </>
      )}
    />
  );
}
