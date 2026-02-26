import * as vscode from "vscode";

interface DirNode {
  name: string;
  uri: vscode.Uri;
  isDirectory: boolean;
  children: DirNode[];
}

const ICON_FRAME_COUNT = 5;
const ASSET_EXTENSIONS = new Set([".png", ".gif", ".jpg", ".jpeg", ".bmp", ".webp", ".ico", ".svg"]);

export class PxlFileItem extends vscode.TreeItem {
  constructor(
    public readonly node: DirNode,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    isRunning: boolean,
    iconFrame: number,
    extensionUri?: vscode.Uri
  ) {
    super(node.name, collapsibleState);

    this.tooltip = node.uri.fsPath;
    this.resourceUri = node.uri;

    if (node.isDirectory) {
      this.contextValue = "directory";
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      const isCsFile = node.name.endsWith(".cs");
      this.contextValue = isCsFile ? "csFile" : "file";

      if (isCsFile && isRunning && extensionUri) {
        const frame = iconFrame % ICON_FRAME_COUNT;
        this.iconPath = vscode.Uri.joinPath(extensionUri, "media", `pxl-active-${frame}.svg`);
      } else {
        this.iconPath = vscode.ThemeIcon.File;
      }

      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [node.uri],
      };
    }
  }
}

export class FileExplorerProvider
  implements vscode.TreeDataProvider<PxlFileItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    PxlFileItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private runningFile = "";
  private extensionUri?: vscode.Uri;
  private iconFrame = 0;
  private animationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(extensionUri?: vscode.Uri) {
    this.extensionUri = extensionUri;
    // Watch for relevant file changes in workspace
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.{cs,png,gif,jpg,jpeg,bmp,webp,ico,svg}");
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidDelete(() => this.refresh());
  }

  setRunningFile(filePath: string): void {
    const changed = this.runningFile !== filePath;
    this.runningFile = filePath;

    if (filePath && !this.animationTimer) {
      // Start icon animation when a file is running
      this.animationTimer = setInterval(() => {
        this.iconFrame++;
        this._onDidChangeTreeData.fire();
      }, 800);
    } else if (!filePath && this.animationTimer) {
      // Stop animation when nothing is running
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }

    if (changed) {
      this._onDidChangeTreeData.fire();
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
  }

  getTreeItem(element: PxlFileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PxlFileItem): Promise<PxlFileItem[]> {
    if (element) {
      return element.node.children.map((child) =>
        this.toTreeItem(child)
      );
    }

    // Root level: scan workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const rootUri = workspaceFolders[0].uri;
    const tree = await this.buildTree(rootUri);
    return tree.map((node) => this.toTreeItem(node));
  }

  private toTreeItem(node: DirNode): PxlFileItem {
    const state = node.isDirectory
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const isRunning =
      !node.isDirectory &&
      this.runningFile !== "" &&
      this.runningFile.endsWith(node.name);
    return new PxlFileItem(node, state, isRunning, this.iconFrame, this.extensionUri);
  }

  private async buildTree(dirUri: vscode.Uri): Promise<DirNode[]> {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const nodes: DirNode[] = [];

    for (const [name, type] of entries) {
      if (
        name.startsWith(".") ||
        name === "bin" ||
        name === "obj" ||
        name === "node_modules" ||
        name === "build"
      )
        continue;

      const childUri = vscode.Uri.joinPath(dirUri, name);

      if (type === vscode.FileType.Directory) {
        const children = await this.buildTree(childUri);
        if (children.length > 0) {
          nodes.push({ name, uri: childUri, isDirectory: true, children });
        }
      } else {
        const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
        if (ext === ".cs" || ASSET_EXTENSIONS.has(ext)) {
          nodes.push({ name, uri: childUri, isDirectory: false, children: [] });
        }
      }
    }

    // Sort: directories first, then alphabetically
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }
}
