import * as vscode from "vscode";

type StatusItemId = "host-online" | "host-offline" | "watcher-running" | "watcher-stopped";

export class StatusItem extends vscode.TreeItem {
  constructor(
    public readonly itemId: StatusItemId,
    label: string,
    description: string,
    icon: vscode.ThemeIcon,
    contextVal?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = icon;
    this.contextValue = contextVal ?? itemId;
  }
}

export class SimulatorStatusProvider
  implements vscode.TreeDataProvider<StatusItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    StatusItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _onRunningFileChanged = new vscode.EventEmitter<string>();
  readonly onRunningFileChanged = this._onRunningFileChanged.event;

  private hostOnline = false;
  private watcherRunning = false;
  private watcherFile = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private getBaseUrl: () => string) {}

  getRunningFile(): string {
    return this.watcherRunning ? this.watcherFile : "";
  }

  start(): void {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 5000);
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  refresh(): void {
    this.poll();
  }

  isOnline(): boolean {
    return this.hostOnline;
  }

  private async poll(): Promise<void> {
    const baseUrl = this.getBaseUrl();
    try {
      const resp = await fetch(`${baseUrl}/api/watcher/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        this.hostOnline = true;
        try {
          const data = (await resp.json()) as {
            running: boolean;
            currentFile: string;
          };
          this.watcherRunning = data.running;
          this.watcherFile = data.currentFile ?? "";
        } catch {
          // Status endpoint might return non-JSON
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
    this._onDidChangeTreeData.fire();
    this._onRunningFileChanged.fire(this.getRunningFile());
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<StatusItem[]> {
    const baseUrl = this.getBaseUrl();
    const port = (() => {
      try {
        return new URL(baseUrl).port || "80";
      } catch {
        return "5001";
      }
    })();

    const items: StatusItem[] = [];

    if (this.hostOnline) {
      const hostItem = new StatusItem(
        "host-online",
        "Simulator Host",
        `port ${port}`,
        new vscode.ThemeIcon(
          "circle-filled",
          new vscode.ThemeColor("testing.iconPassed")
        ),
        "hostOnline"
      );
      items.push(hostItem);

      if (this.watcherRunning) {
        const fileName = this.watcherFile
          ? this.watcherFile.split("/").pop()
          : "";
        items.push(
          new StatusItem(
            "watcher-running",
            "Running",
            fileName ?? "",
            new vscode.ThemeIcon(
              "play",
              new vscode.ThemeColor("testing.iconPassed")
            ),
            "watcher"
          )
        );
      } else {
        items.push(
          new StatusItem(
            "watcher-stopped",
            "Idle",
            "",
            new vscode.ThemeIcon("debug-pause"),
            "watcher"
          )
        );
      }
    } else {
      const hostItem = new StatusItem(
        "host-offline",
        "Simulator Host",
        `port ${port}`,
        new vscode.ThemeIcon(
          "circle-filled",
          new vscode.ThemeColor("testing.iconFailed")
        ),
        "hostOffline"
      );
      items.push(hostItem);
    }

    return items;
  }
}
