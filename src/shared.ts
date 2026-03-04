import * as vscode from "vscode";
import * as http from "http";
import * as net from "net";

// Set once when the extension spawns the simulator on a free port.
// Before it's set, callers must handle the empty string gracefully.
let baseUrl = "";

export function setBaseUrl(url: string): void {
  baseUrl = url;
}

export function getBaseUrl(): string {
  return baseUrl;
}

function getPortRange(): { start: number; end: number } {
  const raw = vscode.workspace.getConfiguration("pxl").get<string>("simulatorPortRange", "5010-5099");
  const match = raw.match(/^(\d+)-(\d+)$/);
  if (match) return { start: parseInt(match[1]), end: parseInt(match[2]) };
  return { start: 5010, end: 5099 };
}

export function findFreePort(): Promise<number> {
  const { start, end } = getPortRange();
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    // Try a random port in range to reduce collision likelihood
    const port = start + Math.floor(Math.random() * (end - start + 1));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      // Port taken — scan sequentially
      tryNextPort(start, end, start, resolve, reject);
    });
  });
}

function tryNextPort(port: number, end: number, rangeStart: number, resolve: (port: number) => void, reject: (err: Error) => void): void {
  if (port > end) {
    reject(new Error(`No free port found in range ${rangeStart}-${end}`));
    return;
  }
  const server = net.createServer();
  server.unref();
  server.listen(port, "127.0.0.1", () => {
    server.close(() => resolve(port));
  });
  server.on("error", () => {
    tryNextPort(port + 1, end, rangeStart, resolve, reject);
  });
}

export function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

export function httpRequest(method: string, path: string, body?: object, timeoutMs = 10000): Promise<string> {
  const url = new URL(`${getBaseUrl()}${path}`);
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
        timeout: timeoutMs,
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
