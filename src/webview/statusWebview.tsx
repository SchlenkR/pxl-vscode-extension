import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();

interface Status {
  hostOnline: boolean;
  watcherRunning: boolean;
  watcherFile: string;
  port: string;
}

interface Device { name: string; address: string; }
interface PxlConfig { devices: Device[]; activeDevices: string[]; simulator: boolean; }
interface DiscoveredClock { ip: string; hostname: string; }

const Icon = {
  plus: <svg width="14" height="14" viewBox="0 0 16 16"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z" fill="currentColor"/></svg>,
  scan: <svg width="14" height="14" viewBox="0 0 16 16"><path d="M15.25 0a.75.75 0 01.75.75V5h-1.5V1.5H11V0h4.25zm-14.5 0H5v1.5H1.5V5H0V.75A.75.75 0 01.75 0zM0 11v4.25c0 .414.336.75.75.75H5v-1.5H1.5V11H0zm14.5 0v3.5H11V16h4.25a.75.75 0 00.75-.75V11h-1.5zM9.5 3.5v2H11v1H9.5v2h-1v-2H7v-1h1.5v-2h1zM8 10a2 2 0 100-4 2 2 0 000 4zm0 1.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" fill="currentColor"/></svg>,
  cloudUpload: <svg width="14" height="14" viewBox="0 0 16 16"><path d="M11.5 7C9.015 7 7 9.015 7 11.5C7 13.985 9.015 16 11.5 16C13.985 16 16 13.985 16 11.5C16 9.015 13.985 7 11.5 7ZM13.854 11.854C13.659 12.049 13.342 12.049 13.147 11.854L12.001 10.708V14.001C12.001 14.277 11.777 14.501 11.501 14.501C11.225 14.501 11.001 14.277 11.001 14.001V10.708L9.855 11.854C9.66 12.049 9.343 12.049 9.148 11.854C8.953 11.659 8.953 11.342 9.148 11.147L11.148 9.147C11.196 9.099 11.251 9.063 11.31 9.039C11.368 9.015 11.432 9.001 11.498 9.001H11.504C11.571 9.001 11.634 9.015 11.692 9.039C11.75 9.063 11.805 9.099 11.852 9.145L11.855 9.148L13.855 11.148C14.05 11.343 14.05 11.66 13.855 11.855L13.854 11.854ZM4.25 12H6V13H4.25C2.455 13 1 11.545 1 9.75C1 8.029 2.338 6.62 4.03 6.507C4.273 4.53 5.958 3 8 3C9.862 3 11.411 4.278 11.857 6H10.811C10.397 4.838 9.303 4 8 4C6.343 4 5 5.343 5 7C5 7.276 4.776 7.5 4.5 7.5H4.25C3.007 7.5 2 8.507 2 9.75C2 10.993 3.007 12 4.25 12Z" fill="currentColor"/></svg>,
  rename: <svg width="14" height="14" viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z" fill="currentColor"/></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 16 16"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2a1 1 0 011-1h2a1 1 0 011 1v1zm-1 0V2H7v1h2zm-4 1v9h6V4H5zm1 2h1v5H6V6zm3 0h1v5H9V6z" fill="currentColor"/></svg>,
  stop: <svg width="12" height="12" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" fill="currentColor"/></svg>,
  restart: <svg width="12" height="12" viewBox="0 0 16 16"><path d="M12.75 8a4.5 4.5 0 01-8.61 1.834l-1.391.565A6.001 6.001 0 0014.25 8 6 6 0 003.5 4.334V2.5H2v4h4V5H3.83A4.5 4.5 0 0112.75 8z" fill="currentColor"/></svg>,
};

function App() {
  const [status, setStatus] = useState<Status>({ hostOnline: false, watcherRunning: false, watcherFile: "", port: "5001" });
  const [config, setConfig] = useState<PxlConfig | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<DiscoveredClock[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addAddress, setAddAddress] = useState("");
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [renameName, setRenameName] = useState("");

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "status") setStatus({ hostOnline: msg.hostOnline, watcherRunning: msg.watcherRunning, watcherFile: msg.watcherFile, port: msg.port });
      if (msg.type === "config") setConfig(msg.config);
      if (msg.type === "scanResults") { setScanResults(msg.results); setScanning(false); }
      if (msg.type === "scanError") { setScanResults([]); setScanning(false); }
    };
    window.addEventListener("message", handler);
    vscodeApi.postMessage({ command: "requestStatus" });
    vscodeApi.postMessage({ command: "loadConfig" });
    return () => window.removeEventListener("message", handler);
  }, []);

  function saveConfig(updated: PxlConfig) {
    setConfig(updated);
    vscodeApi.postMessage({ command: "saveConfig", config: updated });
  }

  function toggleDevice(name: string) {
    if (!config) return;
    const isActive = config.activeDevices.includes(name);
    saveConfig({
      ...config,
      activeDevices: isActive
        ? config.activeDevices.filter(n => n !== name)
        : [...config.activeDevices, name],
    });
  }

  function removeDevice(device: Device) {
    if (!config) return;
    saveConfig({
      ...config,
      devices: config.devices.filter(d => d.name !== device.name),
      activeDevices: config.activeDevices.filter(n => n !== device.name),
    });
  }

  function addDevice() {
    if (!config || !addName.trim() || !addAddress.trim()) return;
    saveConfig({
      ...config,
      devices: [...config.devices, { name: addName.trim(), address: addAddress.trim() }],
    });
    setAddName("");
    setAddAddress("");
    setAdding(false);
  }

  function doRename() {
    if (!config || !renaming || !renameName.trim()) return;
    const oldName = renaming.name;
    saveConfig({
      ...config,
      devices: config.devices.map(d => d.name === oldName ? { ...d, name: renameName.trim() } : d),
      activeDevices: config.activeDevices.map(n => n === oldName ? renameName.trim() : n),
    });
    setRenaming(null);
    setRenameName("");
  }

  function doScan() {
    setScanning(true);
    setScanResults(null);
    vscodeApi.postMessage({ command: "scan" });
  }

  function addFromScan(clock: DiscoveredClock) {
    if (!config) return;
    if (config.devices.some(d => d.address === clock.ip)) return;
    saveConfig({
      ...config,
      devices: [...config.devices, { name: clock.hostname, address: clock.ip }],
    });
    setScanResults(prev => prev ? prev.filter(c => c.ip !== clock.ip) : null);
  }

  const fileName = status.watcherFile ? status.watcherFile.split("/").pop() : "";

  return (
    <div style={S.root}>
      {/* --- Status --- */}
      <div style={S.statusRow}>
        <span style={S.statusIconCell}><span style={{ ...S.dot, background: status.hostOnline ? "#4caf50" : "#f44336" }} /></span>
        <span style={S.statusLabel}>Simulator Host</span>
        <span style={S.statusDesc}>port {status.port}</span>
      </div>
      <div style={S.statusRow}>
        <span style={{ ...S.statusIconCell, color: status.hostOnline && status.watcherRunning ? "#4caf50" : "var(--vscode-descriptionForeground)", fontSize: 10 }}>
          {status.hostOnline && status.watcherRunning ? "\u25B6" : "\u275A\u275A"}
        </span>
        <span style={S.statusLabel}>{status.hostOnline && status.watcherRunning ? "Running" : "Idle"}</span>
        {status.watcherRunning && <span style={S.fileName} title={fileName}>{fileName}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 2, visibility: status.watcherRunning ? "visible" : "hidden" }}>
          <button style={S.smallBtn} title="Stop" onClick={() => vscodeApi.postMessage({ command: "stop" })}>{Icon.stop}</button>
          <button style={S.smallBtn} title="Restart" onClick={() => vscodeApi.postMessage({ command: "restart" })}>{Icon.restart}</button>
        </div>
      </div>

      <div style={S.divider} />

      {/* --- Clocks --- */}
      <div style={S.sectionRow}>
        <div style={S.section}>Clocks</div>
        <div style={{ display: "flex", gap: 2 }}>
          <button style={S.iconBtn} title="Add manually" onClick={() => setAdding(true)}>{Icon.plus}</button>
          <button style={S.iconBtn} title="Scan for PXL Clocks" onClick={doScan} disabled={scanning}>{Icon.scan}</button>
        </div>
      </div>

      {config && config.devices.length === 0 && <div style={S.muted}>No clocks added yet</div>}

      {config && config.devices.map(device => (
        <div key={device.name} style={S.deviceCard}>
          <label style={S.deviceMain}>
            <input
              type="checkbox"
              checked={config.activeDevices.includes(device.name)}
              onChange={() => toggleDevice(device.name)}
            />
            <div style={S.deviceInfo}>
              <span style={S.deviceName}>{device.name}</span>
              <span style={S.deviceAddr}>{device.address}</span>
            </div>
          </label>
          <div style={S.deviceActions}>
            <button
              style={{ ...S.iconBtn, opacity: status.watcherRunning ? 0.7 : 0.2 }}
              title="Publish to this clock"
              disabled={!status.watcherRunning}
              onClick={() => vscodeApi.postMessage({ command: "publish", address: device.address, deviceName: device.name })}
            >{Icon.cloudUpload}</button>
            <button style={S.iconBtn} title="Rename" onClick={() => { setRenaming(device); setRenameName(device.name); }}>{Icon.rename}</button>
            <button style={S.iconBtn} title="Delete" onClick={() => removeDevice(device)}>{Icon.trash}</button>
          </div>
        </div>
      ))}

      {adding && (
        <div style={S.dialog}>
          <div style={S.section}>ADD DEVICE</div>
          <input style={S.input} placeholder="Name" value={addName} onChange={e => setAddName(e.target.value)} autoFocus />
          <input style={S.input} placeholder="IP Address" value={addAddress} onChange={e => setAddAddress(e.target.value)} />
          <div style={S.btnRow}>
            <button style={S.btn} onClick={addDevice}>Add</button>
            <button style={S.btn} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      {renaming && (
        <div style={S.dialog}>
          <div style={S.section}>RENAME</div>
          <input style={S.input} placeholder="New name" value={renameName} onChange={e => setRenameName(e.target.value)} autoFocus />
          <div style={S.btnRow}>
            <button style={S.btn} onClick={doRename}>Rename</button>
            <button style={S.btn} onClick={() => setRenaming(null)}>Cancel</button>
          </div>
        </div>
      )}

      {scanResults !== null && (
        <div style={{ marginTop: 12 }}>
          <div style={S.section}>SCAN RESULTS ({scanResults.length})</div>
          {scanResults.length === 0 && <div style={S.muted}>No PXL Clocks found.</div>}
          {scanResults.map(clock => {
            const known = config?.devices.some(d => d.address === clock.ip) ?? false;
            return (
              <div key={clock.ip} style={{ ...S.scanRow, opacity: known ? 0.5 : 1 }}>
                <span style={S.scanName}>{clock.hostname}</span>
                <span style={S.scanAddr}>{clock.ip}{known ? " (added)" : ""}</span>
                {!known && <button style={S.linkBtn} onClick={() => addFromScan(clock)}>Add</button>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { padding: "8px 12px", fontFamily: "var(--vscode-font-family)", fontSize: 13, color: "var(--vscode-foreground)" },
  statusRow: { display: "flex", alignItems: "center", gap: 6, padding: "3px 0" },
  statusIconCell: { width: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: "50%" },
  statusLabel: { fontWeight: 500 },
  statusDesc: { fontSize: 12, color: "var(--vscode-descriptionForeground)" },
  fileName: { fontSize: 12, color: "var(--vscode-descriptionForeground)", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  smallBtn: { background: "none", border: "none", color: "var(--vscode-foreground)", cursor: "pointer", padding: 3, borderRadius: 3, display: "flex", alignItems: "center", opacity: 0.7 },
  divider: { height: 1, background: "var(--vscode-widget-border, #333)", margin: "8px 0" },
  sectionRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, marginBottom: 6 },
  section: { fontSize: 11, fontWeight: 600, color: "var(--vscode-descriptionForeground)", textTransform: "uppercase" as const, letterSpacing: 0.5 },
  muted: { fontSize: 12, color: "var(--vscode-descriptionForeground)", padding: "4px 8px" },
  deviceCard: { display: "flex", alignItems: "center", padding: "6px 8px", borderRadius: 4, marginBottom: 2, background: "var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))" },
  deviceMain: { display: "flex", alignItems: "center", gap: 6, flex: 1, cursor: "pointer", minWidth: 0 },
  deviceInfo: { display: "flex", flexDirection: "column" as const, gap: 1, minWidth: 0 },
  deviceName: { fontSize: 13, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" },
  deviceAddr: { fontSize: 11, color: "var(--vscode-descriptionForeground)", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" },
  deviceActions: { display: "flex", gap: 2, flexShrink: 0 },
  iconBtn: { background: "none", border: "none", color: "var(--vscode-foreground)", cursor: "pointer", padding: 4, borderRadius: 3, display: "flex", alignItems: "center", opacity: 0.5 },
  btnRow: { display: "flex", gap: 6, marginTop: 8 },
  btn: { background: "var(--vscode-button-background)", color: "var(--vscode-button-foreground)", border: "none", borderRadius: 3, padding: "4px 12px", fontSize: 12, cursor: "pointer" },
  linkBtn: { background: "none", border: "none", color: "var(--vscode-textLink-foreground)", cursor: "pointer", padding: 0, fontSize: 12 },
  scanRow: { display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" },
  scanName: { fontSize: 13, fontWeight: 500 },
  scanAddr: { fontSize: 11, color: "var(--vscode-descriptionForeground)", flex: 1 },
  dialog: { marginTop: 12, padding: "8px 10px", background: "var(--vscode-input-background)", borderRadius: 4, border: "1px solid var(--vscode-widget-border)" },
  input: { display: "block", width: "100%", marginTop: 6, padding: "4px 8px", fontSize: 13, background: "var(--vscode-input-background)", color: "var(--vscode-input-foreground)", border: "1px solid var(--vscode-input-border, var(--vscode-widget-border))", borderRadius: 3, outline: "none", boxSizing: "border-box" as const },
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
