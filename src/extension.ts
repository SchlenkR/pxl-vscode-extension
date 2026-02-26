import * as vscode from "vscode";
import * as cp from "child_process";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { createSimulatorClient } from "./simulatorClient";
import { SimulatorPanel, SimulatorSidebarProvider } from "./simulatorPanel";
import { FileExplorerProvider, PxlFileItem } from "./fileExplorerProvider";
import { SimulatorStatusProvider } from "./simulatorStatusProvider";
import { ConfigSidebarProvider } from "./configPanel";

function getBaseUrl(): string {
  return vscode.workspace
    .getConfiguration("pxl")
    .get<string>("simulatorHost", "http://127.0.0.1:5001");
}

function pingSimulator(): Promise<boolean> {
  const url = new URL(`${getBaseUrl()}/metadata`);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function getSimulatorBinary(extensionPath: string): string | undefined {
  const platform = process.platform;
  const arch = process.arch;

  let rid: string;
  if (platform === "darwin" && arch === "arm64") rid = "osx-arm64";
  else if (platform === "darwin") rid = "osx-x64";
  else if (platform === "linux" && arch === "arm64") rid = "linux-arm64";
  else if (platform === "linux") rid = "linux-x64";
  else if (platform === "win32") rid = "win-x64";
  else return undefined;

  const exeName = platform === "win32" ? "Pxl.Simulator.Host.exe" : "Pxl.Simulator.Host";
  const binPath = path.join(extensionPath, "bin", rid, exeName);
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    return undefined;
  }
}

function getWorkspaceDir(): string {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath ?? "";
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("PXL Clock");
  const client = createSimulatorClient(outputChannel);

  let simulatorProcess: cp.ChildProcess | undefined;

  // Simulator status view
  const statusProvider = new SimulatorStatusProvider(getBaseUrl);
  const statusView = vscode.window.createTreeView("pxlSimulatorStatus", {
    treeDataProvider: statusProvider,
  });
  context.subscriptions.push(statusView);
  statusProvider.start();

  // Simulator sidebar webview (Preview in sidebar)
  const sidebarProvider = new SimulatorSidebarProvider(
    context.extensionUri
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SimulatorSidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // File explorer view — scans workspace locally
  const fileExplorer = new FileExplorerProvider(context.extensionUri);
  const filesView = vscode.window.createTreeView("pxlFiles", {
    treeDataProvider: fileExplorer,
    showCollapseAll: true,
  });
  context.subscriptions.push(filesView);

  // Device config webview (Devices in sidebar)
  const configProvider = new ConfigSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConfigSidebarProvider.viewType,
      configProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Update watcher status from log messages
  client.onLog((message) => {
    if (
      message.includes("Running:") ||
      message.includes("Restarting") ||
      message.includes("Stopped") ||
      message.includes("Error")
    ) {
      statusProvider.refresh();
      fileExplorer.setRunningFile(statusProvider.getRunningFile());
    }
  });

  // Refresh file tree when scripts change
  client.onScriptsChanged(() => fileExplorer.refresh());

  // Keep file explorer in sync with running file
  statusProvider.onRunningFileChanged((file) => {
    fileExplorer.setRunningFile(file);
  });

  // --- Background Simulator Process (always running) ---

  let disposed = false;
  let restartCount = 0;

  function spawnSimulatorProcess(): boolean {
    const binary = getSimulatorBinary(context.extensionPath);
    if (!binary) return false;

    const workspaceDir = getWorkspaceDir();
    const args: string[] = [];
    if (workspaceDir) {
      args.push("--clock-repo", workspaceDir);
    }

    outputChannel.appendLine(`Starting Simulator Host: ${binary}`);

    const proc = cp.spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed) outputChannel.appendLine(`[host] ${trimmed}`);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          outputChannel.appendLine(`[host:err] ${trimmed}`);
          outputChannel.show(true);
        }
      }
    });

    proc.on("exit", (code) => {
      outputChannel.appendLine(`Simulator Host exited (code ${code})`);
      if (simulatorProcess === proc) simulatorProcess = undefined;
      statusProvider.refresh();

      // Auto-restart unless the extension is being disposed
      if (!disposed) {
        restartCount++;
        const delayMs = Math.min(restartCount * 2000, 10000);
        outputChannel.appendLine(
          `Simulator Host crashed — restarting in ${delayMs / 1000}s...`
        );
        setTimeout(() => {
          if (!disposed) ensureSimulatorRunning();
        }, delayMs);
      }
    });

    simulatorProcess = proc;
    return true;
  }

  async function ensureSimulatorRunning(): Promise<boolean> {
    // Already responding? Done.
    if (await pingSimulator()) {
      restartCount = 0;
      configProvider.refresh();
      return true;
    }

    // Start process (no-op if already spawned)
    if (!simulatorProcess) {
      if (!spawnSimulatorProcess()) {
        vscode.window.showErrorMessage(
          "Simulator Host binary not found. Run build-simulator.sh to build it."
        );
        return false;
      }
    }

    // Wait until it responds
    outputChannel.appendLine("Waiting for Simulator Host to become ready...");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await pingSimulator()) {
        restartCount = 0;
        statusProvider.refresh();
        configProvider.refresh();
        outputChannel.appendLine("Simulator Host is online.");
        return true;
      }
      if (!simulatorProcess) {
        // Process died — the exit handler will auto-restart it
        return false;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    vscode.window.showErrorMessage(
      "Simulator Host did not start in time. Check the PXL Clock output log."
    );
    return false;
  }

  // Start on activation
  ensureSimulatorRunning();

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.openSimulator", () => {
      SimulatorPanel.show(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.openSimulatorToSide", () => {
      vscode.commands.executeCommand("pxlSimulatorView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.runScript", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".cs")) {
        vscode.window.showWarningMessage(
          "Open a .cs file to run as a pixogram."
        );
        return;
      }

      if (!(await ensureSimulatorRunning())) return;

      try {
        await client.runScript(editor.document.fileName);
        statusProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to run script: ${err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.stopScript", async () => {
      try {
        await client.stopScript();
        statusProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to stop script: ${err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.refreshFiles", () => {
      fileExplorer.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.refreshStatus", () => {
      statusProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.showLog", () => {
      outputChannel.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pxl.openFile",
      async (filePath: string) => {
        try {
          const uri = vscode.Uri.file(filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to open file: ${err}`);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pxl.runFromTree",
      async (item: PxlFileItem) => {
        if (!(await ensureSimulatorRunning())) return;

        try {
          await client.runScript(item.node.uri.fsPath);
          statusProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to run script: ${err}`);
        }
      }
    )
  );

  async function loadDevicesFromSimulator(): Promise<Array<{ name: string; address: string }>> {
    try {
      const baseUrl = getBaseUrl();
      const url = new URL(`${baseUrl}/api/config`);
      const data = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", timeout: 3000 },
          (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d)); }
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      const config = JSON.parse(data) as { devices: Array<{ name: string; address: string }>; activeDevices: string[] };
      return config.devices;
    } catch {
      return [];
    }
  }

  async function publishPixogram(filePath: string) {
    if (!(await ensureSimulatorRunning())) return;

    const targets = await loadDevicesFromSimulator();

    if (targets.length === 0) {
      vscode.window.showWarningMessage(
        "No devices configured. Open the Devices panel in the PXL Clock sidebar to add devices."
      );
      return;
    }

    let target: { name: string; address: string };
    if (targets.length === 1) {
      target = targets[0];
    } else {
      const picked = await vscode.window.showQuickPick(
        targets.map((t) => ({ label: t.name, description: t.address, target: t })),
        { placeHolder: "Select target PXL Clock" }
      );
      if (!picked) return;
      target = picked.target;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Publishing to ${target.name}...` },
      async () => {
        try {
          await client.publishPixogram(filePath, target.address);
          vscode.window.showInformationMessage(`Published to ${target.name}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Publish failed: ${err}`);
        }
      }
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.publishPixogram", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".cs")) {
        vscode.window.showWarningMessage("Open a .cs file to publish.");
        return;
      }
      await publishPixogram(editor.document.fileName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pxl.publishFromTree",
      async (item: PxlFileItem) => {
        await publishPixogram(item.node.uri.fsPath);
      }
    )
  );

  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      client.dispose();
      statusProvider.dispose();
      fileExplorer.dispose();
      sidebarProvider.dispose();
      configProvider.dispose();
      if (simulatorProcess) {
        simulatorProcess.kill("SIGTERM");
      }
    },
  });

  // Restore SimulatorPanel on reload (fixes black tab)
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(SimulatorPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        panel.webview.options = {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
            vscode.Uri.joinPath(context.extensionUri, "media"),
          ],
        };
        SimulatorPanel.revive(panel, context.extensionUri);
      },
    })
  );

  outputChannel.appendLine("PXL Clock extension activated.");
}

export function deactivate() {}
