import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();

interface Device { name: string; address: string; }
interface PxlConfig { devices: Device[]; activeDevices: string[]; simulator: boolean; }
interface DiscoveredClock { ip: string; hostname: string; }

function App() {
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
      if (msg.type === "config") setConfig(msg.config);
      if (msg.type === "scanResults") { setScanResults(msg.results); setScanning(false); }
      if (msg.type === "scanError") { setScanResults([]); setScanning(false); }
    };
    window.addEventListener("message", handler);
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

  if (!config) return <div style={S.loading}>Loading...</div>;

  return (
    <div style={S.root}>
      <label style={S.toggle}>
        <input type="checkbox" checked={config.simulator} onChange={() => saveConfig({ ...config, simulator: !config.simulator })} />
        <span>Send to Simulator</span>
      </label>

      <div style={S.section}>DEVICES</div>

      {config.devices.length === 0 && <div style={S.muted}>No devices configured</div>}

      {config.devices.map(device => (
        <div key={device.name} style={S.deviceRow}>
          <input
            type="checkbox"
            checked={config.activeDevices.includes(device.name)}
            onChange={() => toggleDevice(device.name)}
          />
          <div style={S.deviceInfo} onClick={() => toggleDevice(device.name)}>
            <div style={S.deviceName}>{device.name}</div>
            <div style={S.deviceAddr}>{device.address}</div>
          </div>
          <button style={S.iconBtn} title="Rename" onClick={() => { setRenaming(device); setRenameName(device.name); }}>
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z" fill="currentColor"/></svg>
          </button>
          <button style={S.iconBtn} title="Delete" onClick={() => removeDevice(device)}>
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2a1 1 0 011-1h2a1 1 0 011 1v1zm-1 0V2H7v1h2zm-4 1v9h6V4H5zm1 2h1v5H6V6zm3 0h1v5H9V6z" fill="currentColor"/></svg>
          </button>
        </div>
      ))}

      <div style={S.btnRow}>
        <button style={S.btn} onClick={() => setAdding(true)}>Add</button>
        <button style={S.btn} onClick={doScan} disabled={scanning}>
          {scanning ? "Scanning..." : "Scan Network"}
        </button>
      </div>

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
            const known = config.devices.some(d => d.address === clock.ip);
            return (
              <div key={clock.ip} style={{ ...S.deviceRow, opacity: known ? 0.5 : 1 }}>
                <div style={S.deviceInfo}>
                  <div style={S.deviceName}>{clock.hostname}</div>
                  <div style={S.deviceAddr}>{clock.ip}{known ? " (added)" : ""}</div>
                </div>
                {!known && <button style={S.btn} onClick={() => addFromScan(clock)}>Add</button>}
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
  loading: { padding: 12, color: "var(--vscode-descriptionForeground)" },
  toggle: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginBottom: 8 },
  section: { fontSize: 11, fontWeight: 600, color: "var(--vscode-descriptionForeground)", textTransform: "uppercase" as const, marginTop: 12, marginBottom: 4, letterSpacing: 0.5 },
  muted: { fontSize: 12, color: "var(--vscode-descriptionForeground)", padding: "4px 0" },
  deviceRow: { display: "flex", alignItems: "center", gap: 6, padding: "3px 0" },
  deviceInfo: { flex: 1, cursor: "pointer", minWidth: 0 },
  deviceName: { fontSize: 13 },
  deviceAddr: { fontSize: 11, color: "var(--vscode-descriptionForeground)" },
  iconBtn: { background: "none", border: "none", color: "var(--vscode-foreground)", cursor: "pointer", padding: 3, borderRadius: 3, display: "flex", alignItems: "center", opacity: 0.7 },
  btnRow: { display: "flex", gap: 6, marginTop: 8 },
  btn: { background: "var(--vscode-button-background)", color: "var(--vscode-button-foreground)", border: "none", borderRadius: 3, padding: "4px 12px", fontSize: 12, cursor: "pointer" },
  dialog: { marginTop: 12, padding: "8px 10px", background: "var(--vscode-input-background)", borderRadius: 4, border: "1px solid var(--vscode-widget-border)" },
  input: { display: "block", width: "100%", marginTop: 6, padding: "4px 8px", fontSize: 13, background: "var(--vscode-input-background)", color: "var(--vscode-input-foreground)", border: "1px solid var(--vscode-input-border, var(--vscode-widget-border))", borderRadius: 3, outline: "none", boxSizing: "border-box" as const },
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
