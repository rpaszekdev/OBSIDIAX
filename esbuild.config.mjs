import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

// CSS bundle: inlines @xterm/xterm/css/xterm.css (resolved from node_modules)
// plus our own rules into the single styles.css Obsidian auto-loads. Without
// xterm.css the terminal's helper layer breaks layout (rows shoved down ~40px).
const cssContext = await esbuild.context({
  entryPoints: ["src/styles.css"],
  bundle: true,
  outfile: "styles.css",
  loader: { ".css": "css" },
  logLevel: "info",
  minify: production,
});

// Obsidian provides `obsidian`, `electron`, and Node builtins at runtime.
// node-pty is a native module — keep it external so esbuild never tries to bundle the .node binary.
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "node-pty",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await Promise.all([context.rebuild(), cssContext.rebuild()]);
  process.exit(0);
} else {
  await Promise.all([context.watch(), cssContext.watch()]);
}
