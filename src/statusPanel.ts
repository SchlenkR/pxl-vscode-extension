import * as vscode from "vscode";
import { getBaseUrl, getNonce, httpRequest } from "./shared";

/**
 * Combined Simulator Status + Device Config sidebar webview.
 * Replaces both SimulatorStatusProvider (TreeView) and ConfigSidebarProvider (webview).
 */
export class StatusSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pxlSimulatorStatus";
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  // Status polling state
  private hostOnline = false;
  private watcherRunning = false;
  private watcherFile = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Events (used by extension.ts for file explorer sync)
  private _onRunningFileChanged = new vscode.EventEmitter<string>();
  readonly onRunningFileChanged = this._onRunningFileChanged.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  getRunningFile(): string {
    return this.watcherRunning ? this.watcherFile : "";
  }

  start(): void {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 5000);
  }

  private async poll(): Promise<void> {
    const baseUrl = getBaseUrl();
    try {
      const resp = await fetch(`${baseUrl}/api/watcher/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        this.hostOnline = true;
        try {
          const data = (await resp.json()) as { running: boolean; currentFile: string };
          this.watcherRunning = data.running;
          this.watcherFile = data.currentFile ?? "";
        } catch {
          this.watcherRunning = false;
          this.watcherFile = "";
        }
      } else {
        this.hostOnline = false;
      }
    } catch {
      this.hostOnline = false;
      this.watcherRunning = false;
      this.watcherFile = "";
    }
    this.pushStatus();
    this._onRunningFileChanged.fire(this.getRunningFile());
  }

  private pushStatus(): void {
    if (!this.view) return;
    const baseUrl = getBaseUrl();
    const port = (() => {
      try { return new URL(baseUrl).port || "—"; }
      catch { return "—"; }
    })();
    this.view.webview.postMessage({
      type: "status",
      hostOnline: this.hostOnline,
      watcherRunning: this.watcherRunning,
      watcherFile: this.watcherFile,
      port,
    });
  }

  private async sendConfig(webview: vscode.Webview): Promise<void> {
    try {
      const data = await httpRequest("GET", "/api/config");
      webview.postMessage({ type: "config", config: JSON.parse(data) });
    } catch {
      webview.postMessage({ type: "config", config: { devices: [], activeDevices: [], simulator: true } });
    }
  }

  /** Trigger a status poll and push fresh config to the webview. */
  refresh(): void {
    this.poll();
    if (this.view) this.sendConfig(this.view.webview);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.pushStatus();
        this.sendConfig(webviewView.webview);
      }
    });

    webviewView.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.command) {
          case "requestStatus":
            this.pushStatus();
            break;
          case "loadConfig":
            await this.sendConfig(webviewView.webview);
            break;
          case "saveConfig":
            try {
              await httpRequest("PUT", "/api/config", msg.config);
            } catch (err) {
              vscode.window.showErrorMessage(`Failed to save config: ${err}`);
            }
            break;
          case "scan":
            try {
              const data = await httpRequest("POST", "/api/scan");
              webviewView.webview.postMessage({ type: "scanResults", results: JSON.parse(data) });
            } catch (err) {
              webviewView.webview.postMessage({ type: "scanError" });
              vscode.window.showErrorMessage(`Scan failed: ${err}`);
            }
            break;
          case "publish":
            if (this.watcherRunning && this.watcherFile && msg.address) {
              vscode.commands.executeCommand("pxl.publishToDevice", this.watcherFile, msg.address, msg.deviceName);
            }
            break;
          case "stop":
            vscode.commands.executeCommand("pxl.stopScript");
            break;
          case "restart":
            vscode.commands.executeCommand("pxl.restartScript");
            break;
          case "openLink":
            if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
            break;
        }
      },
      null,
      this.disposables
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "statusWebview.js")
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: transparent; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const d of this.disposables) d.dispose();
  }
}

