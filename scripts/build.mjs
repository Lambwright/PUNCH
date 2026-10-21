// Compiles punch-bubbles.jsx and splices it into index.html (single-file app).
// Usage: npm run build
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html");
const JSX = join(ROOT, "punch-bubbles.jsx");
const ESBUILD = join(ROOT, "node_modules", "esbuild", "bin", "esbuild");

const BODY_START_MARKER = 'const API_BASE = "https://punch-worker';
const TAIL_MARKER = 'ReactDOM.createRoot(document.getElementById("root"))';

function compile() {
  return execFileSync(
    process.execPath,
    [ESBUILD, JSX, "--jsx=transform", "--jsx-factory=React.createElement", "--jsx-fragment=React.Fragment"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
}

function stripModuleBits(compiled) {
  const lines = compiled.split("\n");
  // The JSX starts with three imports (react, d3, lucide-react); the page gets them as globals.
  if (!/^import /.test(lines[0]) || !/^import /.test(lines[1]) || !/^import /.test(lines[2])) {
    throw new Error("Expected 3 leading import lines in compiled output; got:\n" + lines.slice(0, 4).join("\n"));
  }
  let body = lines.slice(3).join("\n");
  const before = body;
  body = body.replace(/export default function PunchBubbles\(/, "function PunchBubbles(");
  if (body === before) throw new Error("Did not find 'export default function PunchBubbles(' to de-export");
  if (/\bexport default\b/.test(body)) throw new Error("Leftover 'export default' in body after strip");
  if (/^import /m.test(body)) throw new Error("Leftover 'import' statement in body after strip");
  return body.replace(/^\s*\n/, "");
}

// Syntax-check every inline <script> of the assembled page.
function checkInlineScripts(html) {
  const dir = mkdtempSync(join(tmpdir(), "punch-check-"));
  try {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    scripts.forEach((m, i) => {
      const file = join(dir, `inline-${i}.js`);
      writeFileSync(file, m[1]);
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    });
    return scripts.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const html = readFileSync(HTML, "utf8");
const bodyStart = html.indexOf(BODY_START_MARKER);
const tailStart = html.indexOf(TAIL_MARKER);
if (bodyStart < 0) throw new Error("BODY_START_MARKER not found in index.html");
if (tailStart < 0) throw new Error("TAIL_MARKER not found in index.html");

const header = html.slice(0, bodyStart);
const tail = html.slice(tailStart);
const assembled = header + stripModuleBits(compile()) + "\n\n" + tail;

const n = checkInlineScripts(assembled);
writeFileSync(HTML, assembled);
console.log(`Wrote index.html (${assembled.length} bytes); ${n} inline script(s) pass syntax check`);
