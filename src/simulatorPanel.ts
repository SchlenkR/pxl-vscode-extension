import * as vscode from "vscode";

/** Generate HTML that loads the bundled React webview */
function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "simulatorWebview.js")
  );

  const hostUrl = vscode.workspace
    .getConfiguration("pxl")
    .get<string>("simulatorHost", "http://127.0.0.1:5001");
  const wsUrl = hostUrl.replace(/^http/, "ws");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${hostUrl} ${wsUrl};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PXL Simulator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { overflow: hidden; background: #000; }
    #root { height: 100vh; }
    .app-content { flex: 1; display: flex; overflow: hidden; }
    .simulator-container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .ledMatrix { display: grid; gap: 0.3%; box-sizing: border-box; margin-left: auto; margin-right: auto; width: 100%; height: 100%; }
    .led { position: relative; border-radius: 0; overflow: visible; box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Main editor panel (opens beside the editor) */
export class SimulatorPanel {
  public static readonly viewType = "pxl.simulatorCanvas";
  private static instance: SimulatorPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  public static show(extensionUri: vscode.Uri): SimulatorPanel {
    if (SimulatorPanel.instance) {
      SimulatorPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return SimulatorPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      SimulatorPanel.viewType,
      "PXL Simulator",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist"),
          vscode.Uri.joinPath(extensionUri, "media"),
        ],
        retainContextWhenHidden: true,
      }
    );

    SimulatorPanel.instance = new SimulatorPanel(panel, extensionUri);
    return SimulatorPanel.instance;
  }

  public static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ): SimulatorPanel {
    if (SimulatorPanel.instance) {
      SimulatorPanel.instance.dispose();
    }
    SimulatorPanel.instance = new SimulatorPanel(panel, extensionUri);
    return SimulatorPanel.instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.panel.webview.html = getWebviewHtml(this.panel.webview, extensionUri);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => handleWebviewMessage(msg),
      null,
      this.disposables
    );
  }

  private dispose() {
    SimulatorPanel.instance = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** Side panel webview (in the PXL Clock sidebar) */
export class SimulatorSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pxlSimulatorView";
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

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
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(
      (msg) => handleWebviewMessage(msg),
      null,
      this.disposables
    );
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function handleWebviewMessage(msg: { command: string; url?: string }) {
  switch (msg.command) {
    case "stop":
      vscode.commands.executeCommand("pxl.stopScript");
      break;
    case "restart":
      vscode.commands.executeCommand("pxl.restartScript");
      break;
    case "openLink":
      if (msg.url) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
      break;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
