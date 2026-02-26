import * as vscode from "vscode";
import * as http from "http";

function getBaseUrl(): string {
  return vscode.workspace
    .getConfiguration("pxl")
    .get<string>("simulatorHost", "http://127.0.0.1:5001");
}

function httpRequest(method: string, path: string, body?: object): Promise<string> {
  const baseUrl = getBaseUrl();
  const url = new URL(`${baseUrl}${path}`);
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`${method} ${path}: ${res.statusCode}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

export class ConfigSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pxlDeviceConfig";
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  private async sendConfig(webviewView: vscode.WebviewView) {
    try {
      const data = await httpRequest("GET", "/api/config");
      webviewView.webview.postMessage({ type: "config", config: JSON.parse(data) });
    } catch {
      webviewView.webview.postMessage({ type: "config", config: { devices: [], activeDevices: [], simulator: true } });
    }
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

    // Re-send config whenever the panel becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendConfig(webviewView);
      }
    });

    webviewView.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.command) {
          case "loadConfig":
            await this.sendConfig(webviewView);
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
        }
      },
      null,
      this.disposables
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "configWebview.js")
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

  /** Push fresh config to the webview (call after simulator comes online). */
  refresh() {
    if (this.view) {
      this.sendConfig(this.view);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
