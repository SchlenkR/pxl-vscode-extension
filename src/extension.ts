import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { createSimulatorClient } from "./simulatorClient";
import { SimulatorPanel, SimulatorSidebarProvider } from "./simulatorPanel";
import { FileExplorerProvider, PxlFileItem } from "./fileExplorerProvider";
import { StatusSidebarProvider } from "./statusPanel";
import { httpRequest, findFreePort, setBaseUrl, setExternalBaseUrl } from "./shared";

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

  // Auto-run script when a .cs file is saved (same as pxl.runScript)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!doc.fileName.endsWith(".cs")) return;
      if (!statusProvider.getRunningFile()) return;
      await runPixogram(doc.fileName);
    })
  );

  // Keep file explorer in sync with running file
  statusProvider.onRunningFileChanged((file) => {
    fileExplorer.setRunningFile(file);
  });

  // --- Background Simulator Process (always running) ---

  let disposed = false;
  let restartCount = 0;
  let chosenPort: number | undefined;

  function spawnSimulatorProcess(port: number): boolean {
    const binary = getSimulatorBinary(context.extensionPath);
    if (!binary) return false;

    const workspaceDir = getWorkspaceDir();
    const args: string[] = ["--port", String(port)];
    if (workspaceDir) {
      args.push("--clock-repo", workspaceDir);
    }

    outputChannel.appendLine(`Starting Simulator Host: ${binary} (port ${port})`);

    const proc = cp.spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed) outputChannel.appendLine(`[host] ${trimmed}`);
      }
    });

    let stderrShownAt = 0;
    proc.stderr?.on("data", (data: Buffer) => {
      let hadOutput = false;
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          outputChannel.appendLine(`[host:err] ${trimmed}`);
          hadOutput = true;
        }
      }
      // Throttle: only surface the output channel at most once every 5s
      // (avoids harassment when the host emits an stderr storm).
      if (hadOutput) {
        const now = Date.now();
        if (now - stderrShownAt > 5000) {
          stderrShownAt = now;
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
    // Pick a port once (reused across restarts)
    if (!chosenPort) {
      try {
        chosenPort = await findFreePort();
      } catch (err) {
        vscode.window.showErrorMessage(`Could not find a free port for the Simulator: ${err}`);
        return false;
      }
      setBaseUrl(`http://127.0.0.1:${chosenPort}`);
      const externalUri = await vscode.env.asExternalUri(
        vscode.Uri.parse(`http://127.0.0.1:${chosenPort}`)
      );
      setExternalBaseUrl(externalUri.toString(true).replace(/\/$/, ""));
      outputChannel.appendLine(`Using port ${chosenPort} for Simulator Host (external: ${externalUri.toString(true)}).`);
    }

    // Already responding? Done.
    if (await pingSimulator()) {
      restartCount = 0;
      statusProvider.refresh();
      return true;
    }

    // Start process (no-op if already spawned)
    if (!simulatorProcess) {
      if (!spawnSimulatorProcess(chosenPort)) {
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

  async function runPixogram(filePath: string) {
    if (!(await ensureSimulatorRunning())) return;

    try {
      outputChannel.show(true);
      await client.runScript(filePath);
      statusProvider.refresh();
      vscode.commands.executeCommand("pxlSimulatorView.focus");
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to run script: ${err}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.runScript", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".cs")) {
        vscode.window.showWarningMessage(
          "Open a .cs file to run as a pixogram."
        );
        return;
      }
      await runPixogram(editor.document.fileName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.restartScript", async () => {
      const running = statusProvider.getRunningFile();
      if (!running) return;
      await runPixogram(running);
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
      async (item?: PxlFileItem) => {
        const filePath = item?.node?.uri?.fsPath
          ?? vscode.window.activeTextEditor?.document.fileName;
        if (!filePath || !filePath.endsWith(".cs")) {
          vscode.window.showWarningMessage("Open or select a .cs file to run as a pixogram.");
          return;
        }
        await runPixogram(filePath);
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
      async (item?: PxlFileItem) => {
        const filePath = item?.node?.uri?.fsPath
          ?? vscode.window.activeTextEditor?.document.fileName;
        if (!filePath || !filePath.endsWith(".cs")) {
          vscode.window.showWarningMessage("Open or select a .cs file to publish.");
          return;
        }
        await publishPixogram(filePath);
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

            // Copy API documentation (llms.txt, docs/) to workspace root
            const llmsTxt = path.join(extractedRoot, "llms.txt");
            if (fs.existsSync(llmsTxt)) {
              fs.copyFileSync(llmsTxt, path.join(workspaceDir, "llms.txt"));
            }
            const docsDir = path.join(extractedRoot, "docs");
            if (fs.existsSync(docsDir)) {
              const targetDocsDir = path.join(workspaceDir, "docs");
              fs.mkdirSync(targetDocsDir, { recursive: true });
              await new Promise<void>((resolve, reject) => {
                cp.exec(
                  `cp -R "${docsDir}/"* "${targetDocsDir}/"`,
                  (err) => (err ? reject(err) : resolve())
                );
              });
            }

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

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.newPixogram", async (item?: PxlFileItem) => {
      let folderUri = item?.node?.uri;

      // Called from Command Palette (no tree item) → show folder picker
      if (!folderUri) {
        const picks = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Select folder",
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (!picks || picks.length === 0) return;
        folderUri = picks[0];
      }

      const name = await vscode.window.showInputBox({
        prompt: "Name for the new pixogram",
        value: "MyPixogram",
        validateInput: (v) => {
          if (!v.trim()) return "Name cannot be empty";
          if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v.trim())) return "Use letters, digits, hyphens, underscores";
          return undefined;
        },
      });
      if (!name) return;

      const templatePath = vscode.Uri.joinPath(context.extensionUri, "media", "templates", "new-pixogram.cs").fsPath;
      let content: string;
      try {
        content = fs.readFileSync(templatePath, "utf8");
      } catch {
        vscode.window.showErrorMessage("Pixogram template not found. Rebuild the extension.");
        return;
      }

      const trimmed = name.trim();
      content = content.replace(/MyPixogramName/g, trimmed);
      content = content.replace(/Human Readable Name/g, trimmed);

      const fileName = trimmed + ".cs";
      const fileUri = vscode.Uri.joinPath(folderUri, fileName);
      if (fs.existsSync(fileUri.fsPath)) {
        vscode.window.showErrorMessage(`File "${fileName}" already exists.`);
        return;
      }

      fs.writeFileSync(fileUri.fsPath, content, "utf8");
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);
      fileExplorer.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.newFolder", async (item: PxlFileItem) => {
      const folderUri = item?.node?.uri;
      if (!folderUri) return;

      const name = await vscode.window.showInputBox({
        prompt: "Folder name",
        validateInput: (v) => {
          if (!v.trim()) return "Name cannot be empty";
          if (v.includes("/") || v.includes("\\") || v.includes("..")) return "Invalid folder name";
          return undefined;
        },
      });
      if (!name) return;

      const newDir = vscode.Uri.joinPath(folderUri, name.trim());
      try {
        fs.mkdirSync(newDir.fsPath);
        fileExplorer.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to create folder: ${err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.revealInExplorer", (item: PxlFileItem) => {
      if (item?.node?.uri) {
        vscode.commands.executeCommand("revealInExplorer", item.node.uri);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pxl.openDevDocu", async () => {
      // Try workspace llms.txt first (from "Get Example Pixograms"), then bundled copy
      const workspaceDir = getWorkspaceDir();
      const candidates = [
        workspaceDir ? path.join(workspaceDir, "llms.txt") : "",
        vscode.Uri.joinPath(context.extensionUri, "media", "docs", "llms.txt").fsPath,
      ].filter(Boolean);

      let docPath: string | undefined;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          docPath = candidate;
          break;
        }
      }

      if (!docPath) {
        vscode.window.showErrorMessage(
          "Dev documentation not found. Run 'Get Example Pixograms' first, or rebuild the extension."
        );
        return;
      }

      // Copy to a .md temp file so VS Code renders it as Markdown preview
      const tmpDir = path.join(context.globalStorageUri.fsPath, "docs");
      fs.mkdirSync(tmpDir, { recursive: true });
      const mdPath = path.join(tmpDir, "PXL-Dev-Documentation.md");
      fs.copyFileSync(docPath, mdPath);

      const mdUri = vscode.Uri.file(mdPath);
      await vscode.commands.executeCommand("markdown.showPreview", mdUri);
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
