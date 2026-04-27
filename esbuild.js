const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  // Copy pixogram template from pxl-clock repo
  const templateSrc = path.join(__dirname, "../pxl-clock/apps/demos/00-empty.cs");
  const templateDest = path.join(__dirname, "media/templates/new-pixogram.cs");
  if (fs.existsSync(templateSrc)) {
    fs.mkdirSync(path.dirname(templateDest), { recursive: true });
    let templateContent = fs.readFileSync(templateSrc, "utf8");
    // Replace pinned package version with wildcard so new pixograms always use the latest
    templateContent = templateContent.replace(/^(#:package\s+Pxl@).+$/m, "$1*");
    fs.writeFileSync(templateDest, templateContent);
    console.log("[esbuild] Copied pixogram template from pxl-clock");
  } else {
    console.warn("[esbuild] Warning: pxl-clock template not found at", templateSrc);
  }

  // Copy dev documentation (llms.txt) from pxl-clock repo
  const docsSrc = path.join(__dirname, "../pxl-clock/llms.txt");
  const docsDest = path.join(__dirname, "media/docs/llms.txt");
  if (fs.existsSync(docsSrc)) {
    fs.mkdirSync(path.dirname(docsDest), { recursive: true });
    fs.copyFileSync(docsSrc, docsDest);
    console.log("[esbuild] Copied dev documentation from pxl-clock");
  } else {
    console.warn("[esbuild] Warning: pxl-clock llms.txt not found at", docsSrc);
  }

  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      {
        name: "fix-signalr-dynamic-require",
        setup(build) {
          // SignalR uses dynamic require() calls (via a webpack-aware
          // requireFunc pattern) that esbuild can't resolve at bundle time.
          // We patch the output to:
          // 1. Skip the Node.js HTTP path (tough-cookie/node-fetch/fetch-cookie)
          //    when native fetch is available (modern Node.js ≥18)
          // 2. Wrap ws/eventsource requires with try-catch fallbacks
          build.onEnd(() => {
            const outfile = "dist/extension.js";
            let code = fs.readFileSync(outfile, "utf8");

            // Patch 1: FetchHttpClient enters the dynamic-require path when
            // `typeof fetch === "undefined" || Platform.isNode`. Remove the
            // Platform.isNode check so modern Node.js uses native fetch.
            // Minified:     typeof fetch>"u"||xx.Platform.isNode
            // Non-minified: typeof fetch === "undefined" || Utils_1.Platform.isNode
            code = code.replace(
              /typeof\s+fetch\s*(?:===?\s*"undefined"|>"u")\s*\|\|\s*\w+\.Platform\.isNode/g,
              'typeof fetch>"u"'
            );

            // Patch 2: Wrap ws/eventsource dynamic requires in try-catch.
            // Falls back to globalThis.WebSocket (set by simulatorClient.ts).
            code = code.replace(
              /(\w+)\s*=\s*(\w+)\("ws"\)\s*[,;]\s*(\w+)\s*=\s*\w+\("eventsource"\)/g,
              'try{$1=$2("ws")}catch(_e){$1=globalThis.WebSocket};try{$3=$2("eventsource")}catch(_e2){}'
            );

            fs.writeFileSync(outfile, code);
          });
        },
      },
      {
        name: "watch-logger",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error("[esbuild] Build failed:", result.errors);
            } else {
              console.log("[esbuild] Build succeeded");
            }
          });
        },
      },
    ],
  });

  // Webview bundle (React, browser platform)
  // Force all React imports to resolve to the extension's copy (avoid dual React 18/19)
  const reactDir = path.dirname(require.resolve("react/package.json"));
  const reactDomDir = path.dirname(require.resolve("react-dom/package.json"));

  const webviewCtx = await esbuild.context({
    entryPoints: [
      "src/webview/simulatorWebview.tsx",
      "src/webview/statusWebview.tsx",
    ],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    platform: "browser",
    outdir: "dist",
    jsx: "automatic",
    alias: {
      "react": reactDir,
      "react-dom": reactDomDir,
    },
    logLevel: "silent",
    plugins: [
      {
        name: "webview-logger",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error("[esbuild:webview] Build failed:", result.errors);
            } else {
              console.log("[esbuild:webview] Build succeeded");
            }
          });
        },
      },
    ],
  });

  if (watch) {
    await ctx.watch();
    await webviewCtx.watch();
    console.log("[esbuild] Watching for changes...");
  } else {
    await ctx.rebuild();
    await webviewCtx.rebuild();
    await ctx.dispose();
    await webviewCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
