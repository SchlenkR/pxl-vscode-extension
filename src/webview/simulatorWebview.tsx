import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DeviceViewWrapper } from "pxl-device-view";
import { configs, VisualConfigName } from "pxl-device-view";
import type { LedMatrixConfig } from "pxl-device-view";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();

const BASE_URL = "http://127.0.0.1:5001";

function App() {
  const [mode, setMode] = useState<VisualConfigName>("clock");

  const cfg: LedMatrixConfig = {
    width: 24,
    height: 24,
    fps: 40,
    frameBufferSize: 3,
    relativeFbDelayUntilStart: 0.5,
    turnOffDelayAfterBufferUnderrun: 2000,
    cyclicBufferLogEveryMs: 0,
    visualConfig: configs[mode],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#000" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 10px",
        borderBottom: "1px solid var(--vscode-widget-border, #333)",
        background: "var(--vscode-sideBar-background)",
        flexShrink: 0,
      }}>
        <a href="#" onClick={(e) => { e.preventDefault(); vscodeApi.postMessage({ command: "openLink", url: "https://www.pxlclock.com/?ref=RONALD" }); }}
           style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
        <svg viewBox="0 0 310 110" width="50" height="18" style={{ flexShrink: 0, opacity: 0.7 }}>
          <rect fill="#aaa" height="19" width="19" x="5.5" y="5.5"/>
          <rect fill="#aaa" height="19" width="19" x="25.5" y="5.5"/>
          <rect fill="#aaa" height="19" width="19" x="45.5" y="5.5"/>
          <rect fill="#aaa" height="19" width="19" x="65.5" y="5.5"/>
          <rect fill="#aaa" height="19" width="19" x="105.5" y="5.5"/>
          <rect fill="#aaa" height="19" width="19" x="185.5" y="5.5"/>
          <rect fill="#aaa" height="19" width="19" x="225.5" y="5.5"/>
          <rect fill="#aaa" height="19" width="19" x="5.5" y="25.5"/>
          <rect fill="#aaa" height="19" width="19" x="65.5" y="25.5"/>
          <rect fill="#aaa" height="19" width="19" x="125.5" y="25.5"/>
          <rect fill="#aaa" height="19" width="19" x="165.5" y="25.5"/>
          <rect fill="#aaa" height="19" width="19" x="225.5" y="25.5"/>
          <rect fill="#aaa" height="19" width="19" x="5.5" y="45.5"/>
          <rect fill="#aaa" height="19" width="19" x="25.5" y="45.5"/>
          <rect fill="#aaa" height="19" width="19" x="45.5" y="45.5"/>
          <rect fill="#aaa" height="19" width="19" x="65.5" y="45.5"/>
          <rect fill="#aaa" height="19" width="19" x="145.5" y="45.5"/>
          <rect fill="#aaa" height="19" width="19" x="225.5" y="45.5"/>
          <rect fill="#aaa" height="19" width="19" x="5.5" y="65.5"/>
          <rect fill="#aaa" height="19" width="19" x="125.5" y="65.5"/>
          <rect fill="#aaa" height="19" width="19" x="165.5" y="65.5"/>
          <rect fill="#aaa" height="19" width="19" x="225.5" y="65.5"/>
          <rect fill="#aaa" height="19" width="19" x="5.5" y="85.5"/>
          <rect fill="#aaa" height="19" width="19" x="105.5" y="85.5"/>
          <rect fill="#aaa" height="19" width="19" x="185.5" y="85.5"/>
          <rect fill="#aaa" height="19" width="19" x="225.5" y="85.5"/>
          <rect fill="#aaa" height="19" width="19" x="245.5" y="85.5"/>
          <rect fill="#aaa" height="19" width="19" x="265.5" y="85.5"/>
          <rect fill="#aaa" height="19" width="19" x="285.5" y="85.5"/>
        </svg>
        </a>
        <Separator />
        <ToolbarButton title="Stop" onClick={() => vscodeApi.postMessage({ command: "stop" })}
          svg={<svg width="14" height="14" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" fill="#f44336"/></svg>} />
        <Separator />
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <DeviceViewWrapper cfg={cfg} sigrDisplayUrl={BASE_URL} />
    </div>
  );
}

function Separator() {
  return <div style={{ width: 1, height: 18, background: "var(--vscode-widget-border, #444)", margin: "0 6px" }} />;
}

function ToolbarButton({ title, onClick, svg }: { title: string; onClick: () => void; svg: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minWidth: 26, height: 26, border: "none", borderRadius: 4,
      background: "transparent", color: "var(--vscode-foreground)", cursor: "pointer", padding: "0 4px",
    }}>{svg}</button>
  );
}

function ModeToggle({ mode, onChange }: { mode: VisualConfigName; onChange: (m: VisualConfigName) => void }) {
  const btnStyle = (active: boolean): React.CSSProperties => ({
    border: "none", borderRadius: 0, background: active ? "var(--vscode-button-background, #0078d4)" : "transparent",
    color: active ? "var(--vscode-button-foreground, #fff)" : "var(--vscode-descriptionForeground)",
    fontSize: 11, padding: "3px 10px", height: 22, cursor: "pointer",
  });
  return (
    <div style={{ display: "flex", border: "1px solid var(--vscode-widget-border, #444)", borderRadius: 4, overflow: "hidden" }}>
      <button style={btnStyle(mode === "flat")} onClick={() => onChange("flat")}>Flat</button>
      <button style={btnStyle(mode === "clock")} onClick={() => onChange("clock")}>Clock</button>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
