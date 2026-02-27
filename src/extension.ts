import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { createSimulatorClient } from "./simulatorClient";
import { SimulatorPanel, SimulatorSidebarProvider } from "./simulatorPanel";
import { FileExplorerProvider, PxlFileItem } from "./fileExplorerProvider";
import { StatusSidebarProvider } from "./statusPanel";
import { httpRequest } from "./shared";

function pingSimulator(): Promise<boolean> {
  return httpRequest("GET", "/metadata", undefined, 2000)
    .then(() => true)
    .catch(() => false);
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

  // Combined Simulator status + Device config webview
  const statusProvider = new StatusSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      StatusSidebarProvider.viewType,
      statusProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
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
      statusProvider.refresh();
      if (!simulatorProcess) {
        outputChannel.appendLine(
          "⚠ Simulator Host is already running but was NOT started by this extension. " +
          "Script run/stop may fail if it was started without --clock-repo."
        );
        outputChannel.show(true);
      }
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

    // Wait until it responds — show progress bar in status bar
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Starting Simulator…" },
      async () => {
        outputChannel.appendLine("Waiting for Simulator Host to become ready...");
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if (await pingSimulator()) {
            restartCount = 0;
            statusProvider.refresh();
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
    );
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
        outputChannel.show(true);
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
          outputChannel.show(true);
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
      const data = await httpRequest("GET", "/api/config", undefined, 3000);
      const config = JSON.parse(data) as { devices: Array<{ name: string; address: string }>; activeDevices: string[] };
      return config.devices;
    } catch {
      return [];
    }
  }

  async function doPublish(filePath: string, address: string, name: string) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Publishing to ${name}...` },
      async () => {
        try {
          await client.publishPixogram(filePath, address);
          vscode.window.showInformationMessage(`Published to ${name}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Publish failed: ${err}`);
        }
      }
    );
  }

  async function publishPixogram(filePath: string) {
    if (!(await ensureSimulatorRunning())) return;

    const targets = await loadDevicesFromSimulator();

    type PickItem = vscode.QuickPickItem & { target: { name: string; address: string } | null };
    const items: PickItem[] = targets.length > 0
      ? targets.map((t) => ({ label: t.name, description: t.address, target: t }))
      : [{ label: "$(warning) No PXL Clocks configured", description: "Add clocks in the Simulator panel first", target: null }];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: targets.length > 0 ? "Select target PXL Clock" : "No PXL Clocks available",
    });
    if (!picked || !picked.target) return;

    await doPublish(filePath, picked.target.address, picked.target.name);
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pxl.publishToDevice",
      async (filePath: string, address: string, deviceName: string) => {
        if (!(await ensureSimulatorRunning())) return;
        await doPublish(filePath, address, deviceName);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.initDemos", async () => {
      const workspaceDir = getWorkspaceDir();
      if (!workspaceDir) {
        vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }

      const input = await vscode.window.showInputBox({
        prompt: "Folder for example pixograms (relative to workspace root)",
        value: "apps",
        validateInput: (value) => {
          if (!value || !value.trim()) return "Path cannot be empty";
          const trimmed = value.trim();
          if (trimmed.includes("..")) return "Path must not contain '..'";
          if (path.isAbsolute(trimmed)) return "Path must be relative";
          return undefined;
        },
      });

      if (!input) return;
      const targetDir = path.join(workspaceDir, input.trim());

      // Check target: must be empty or non-existent
      try {
        const entries = fs.readdirSync(targetDir);
        if (entries.length > 0) {
          vscode.window.showErrorMessage(
            `Folder "${input.trim()}" is not empty. Choose an empty or new folder.`
          );
          return;
        }
      } catch {
        // Does not exist — fine, we'll create it
      }

      const repoUrl =
        "https://github.com/SchlenkR/pxl-clock/archive/refs/heads/main.zip";

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Downloading example pixograms...",
          cancellable: false,
        },
        async () => {
          const tmpDir = path.join(workspaceDir, ".pxl-tmp-" + Date.now());
          try {
            const zipPath = path.join(tmpDir, "repo.zip");
            fs.mkdirSync(tmpDir, { recursive: true });

            // Download zip
            await new Promise<void>((resolve, reject) => {
              const download = (url: string) => {
                const mod = url.startsWith("https") ? require("https") : require("http");
                mod.get(url, (res: any) => {
                  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    download(res.headers.location);
                    return;
                  }
                  if (res.statusCode !== 200) {
                    reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                  }
                  const file = fs.createWriteStream(zipPath);
                  res.pipe(file);
                  file.on("finish", () => { file.close(); resolve(); });
                  file.on("error", reject);
                }).on("error", reject);
              };
              download(repoUrl);
            });

            // Unzip
            await new Promise<void>((resolve, reject) => {
              cp.exec(
                `unzip -q "${zipPath}" -d "${tmpDir}"`,
                (err) => (err ? reject(err) : resolve())
              );
            });

            // Find the extracted apps folder
            const extractedRoot = path.join(tmpDir, "pxl-clock-main");
            const appsDir = path.join(extractedRoot, "apps");

            if (!fs.existsSync(appsDir)) {
              throw new Error("Could not find 'apps' folder in downloaded repository.");
            }

            // Copy apps/* to target
            fs.mkdirSync(targetDir, { recursive: true });
            await new Promise<void>((resolve, reject) => {
              cp.exec(
                `cp -R "${appsDir}/"* "${targetDir}/"`,
                (err) => (err ? reject(err) : resolve())
              );
            });

            fileExplorer.refresh();
            vscode.window.showInformationMessage(
              `Example pixograms installed to "${input.trim()}/".`
            );
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed to download examples: ${err}`
            );
          } finally {
            // Clean up
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {}
          }
        }
      );
    })
  );

  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      client.dispose();
      statusProvider.dispose();
      fileExplorer.dispose();
      sidebarProvider.dispose();
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
