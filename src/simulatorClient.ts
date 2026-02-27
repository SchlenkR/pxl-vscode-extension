import * as signalR from "@microsoft/signalr";
import * as vscode from "vscode";
import WebSocket from "ws";
import { getBaseUrl, httpRequest } from "./shared";

// SignalR's Node.js code path uses a dynamic require("ws") that esbuild can't
// bundle. By setting the global WebSocket, our esbuild post-process plugin can
// fall back to it when the dynamic require fails.
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket;
}

export interface SimulatorClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  runScript(filePath: string): Promise<void>;
  stopScript(): Promise<void>;
  restartScript(): Promise<void>;
  publishPixogram(filePath: string, deviceAddress: string): Promise<void>;
  onFrame(handler: (frame: Uint8Array) => void): vscode.Disposable;
  onLog(handler: (message: string) => void): vscode.Disposable;
  onScriptsChanged(handler: () => void): vscode.Disposable;
  dispose(): void;
}

export function createSimulatorClient(
  outputChannel: vscode.OutputChannel
): SimulatorClient {
  let canvasConnection: signalR.HubConnection | null = null;
  let devConnection: signalR.HubConnection | null = null;
  let connected = false;

  const frameHandlers = new Set<(frame: Uint8Array) => void>();
  const logHandlers = new Set<(message: string) => void>();
  const scriptsChangedHandlers = new Set<() => void>();

  function log(message: string) {
    outputChannel.appendLine(message);
  }

  async function connect(): Promise<void> {
    if (connected) return;

    const baseUrl = getBaseUrl();
    log(`Connecting to ${baseUrl}...`);

    canvasConnection = new signalR.HubConnectionBuilder()
      .withUrl(`${baseUrl}/canvasHub`)
      .withAutomaticReconnect()
      .build();

    devConnection = new signalR.HubConnectionBuilder()
      .withUrl(`${baseUrl}/devHub`)
      .withAutomaticReconnect()
      .build();

    // The server sends Color[] as JSON objects: {r, g, b, a} with byte values 0-255.
    // (System.Text.Json serializes only the byte-backed properties with camelCase.)
    canvasConnection.on(
      "ReceiveFrame",
      (data: Array<{ r: number; g: number; b: number }>) => {
        const bytes = new Uint8Array(data.length * 3);
        for (let i = 0; i < data.length; i++) {
          const c = data[i];
          bytes[i * 3] = c.r;
          bytes[i * 3 + 1] = c.g;
          bytes[i * 3 + 2] = c.b;
        }
        for (const handler of frameHandlers) {
          handler(bytes);
        }
      }
    );

    devConnection.on("WatcherLog", (message: string) => {
      log(`[watcher] ${message}`);
      for (const handler of logHandlers) {
        handler(message);
      }
    });

    devConnection.on("ScriptsChanged", () => {
      for (const handler of scriptsChangedHandlers) {
        handler();
      }
    });

    canvasConnection.onreconnecting(() => log("Canvas hub reconnecting..."));
    canvasConnection.onreconnected(() => log("Canvas hub reconnected."));
    canvasConnection.onclose(() => {
      log("Canvas hub disconnected.");
      connected = false;
    });

    devConnection.onreconnecting(() => log("Dev hub reconnecting..."));
    devConnection.onreconnected(() => log("Dev hub reconnected."));

    try {
      await canvasConnection.start();
      await devConnection.start();
      connected = true;
      log("Connected to PXL Simulator.");
    } catch (err) {
      log(`Connection failed: ${err}`);
      throw err;
    }
  }

  async function disconnect(): Promise<void> {
    if (canvasConnection) {
      await canvasConnection.stop();
      canvasConnection = null;
    }
    if (devConnection) {
      await devConnection.stop();
      devConnection = null;
    }
    connected = false;
    log("Disconnected from PXL Simulator.");
  }

  async function apiPost(path: string, body?: object): Promise<string> {
    const maxRetries = 10;
    const retryDelayMs = 1500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await httpRequest("POST", path, body);
      } catch (err: any) {
        const isConnectionError =
          err?.code === "ECONNREFUSED" ||
          err?.code === "ECONNRESET" ||
          err?.message?.includes("socket hang up");

        if (isConnectionError && attempt < maxRetries) {
          log(`Simulator not ready (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs}ms...`);
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`API ${path}: simulator not reachable after ${maxRetries} attempts`);
  }

  async function runScript(filePath: string): Promise<void> {
    log(`Running script: ${filePath}`);
    await apiPost("/api/watcher/run", { filePath });
  }

  async function stopScript(): Promise<void> {
    log("Stopping script...");
    await apiPost("/api/watcher/stop");
  }

  async function restartScript(): Promise<void> {
    log("Restarting script...");
    await apiPost("/api/watcher/restart");
  }

  async function publishPixogram(filePath: string, deviceAddress: string): Promise<void> {
    log(`Publishing ${filePath} to ${deviceAddress}...`);
    await httpRequest("POST", "/api/publish", { scriptPath: filePath, deviceAddress });
  }

  function onFrame(handler: (frame: Uint8Array) => void): vscode.Disposable {
    frameHandlers.add(handler);
    return new vscode.Disposable(() => frameHandlers.delete(handler));
  }

  function onLog(handler: (message: string) => void): vscode.Disposable {
    logHandlers.add(handler);
    return new vscode.Disposable(() => logHandlers.delete(handler));
  }

  function onScriptsChanged(handler: () => void): vscode.Disposable {
    scriptsChangedHandlers.add(handler);
    return new vscode.Disposable(() => scriptsChangedHandlers.delete(handler));
  }

  function dispose() {
    disconnect().catch(() => {});
    frameHandlers.clear();
    logHandlers.clear();
    scriptsChangedHandlers.clear();
  }

  return {
    connect,
    disconnect,
    isConnected: () => connected,
    runScript,
    stopScript,
    restartScript,
    publishPixogram,
    onFrame,
    onLog,
    onScriptsChanged,
    dispose,
  };
}
