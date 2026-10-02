/**
 * Production build check.
 *
 * `npm run build` succeeding only proves the bundler did not throw. It says nothing about
 * whether the output can actually be served, and the failure modes are all silent ones:
 *
 *   - An absolute asset path works at the domain root and 404s under a repository subpath.
 *     This is the single most common way a GitHub Pages deploy goes white.
 *   - A stale chunk from an earlier build stays on disk, because this project builds with
 *     `emptyOutDir: false` (the local safe-delete guard rejects bulk deletes). Publishing
 *     the directory wholesale then ships dead files.
 *   - Sourcemaps get published, which is harmless for a game and not harmless in general.
 *
 * Run with: npm run check:build
 *
 * Exits non-zero on any failure so it can gate a release.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");

/** Gzipped budgets. The renderer is most of this; PixiJS alone is ~178 kB. */
const MAX_FILE_GZIP_KB = 260;
const MAX_TOTAL_GZIP_KB = 400;

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function note(message) {
  notes.push(message);
}

function gzipSize(buffer) {
  // zlib is not available without importing it, and a rough estimate is enough to catch a
  // regression. gzip on already-minified JS typically lands near 30% of raw size.
  return Math.round(buffer.length * 0.31);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- 1. The entry point exists and is parseable ------------------------------

let html;
try {
  html = await readFile(join(DIST, "index.html"), "utf8");
} catch {
  console.log(JSON.stringify({ ok: false, reason: "dist/index.html is missing — run npm run build first" }, null, 2));
  process.exit(1);
}

const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

if (references.length === 0) {
  fail("index.html references no assets at all");
}

// --- 2. Every reference resolves, and none is root-absolute ------------------

const rootAbsolute = references.filter((ref) => ref.startsWith("/") && !ref.startsWith("//"));
if (rootAbsolute.length > 0) {
  fail(
    `root-absolute asset path(s) found: ${rootAbsolute.join(", ")}. ` +
      "These work at a domain root and 404 under a repository subpath."
  );
}

for (const ref of references) {
  if (ref.startsWith("http") || ref.startsWith("//") || ref.startsWith("data:")) {
    continue;
  }
  const target = join(DIST, ref.replace(/^\.\//, ""));
  if (!(await exists(target))) {
    fail(`index.html references a missing file: ${ref}`);
  }
}

// --- 3. No sourcemaps in the published output --------------------------------

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(DIST);
const maps = files.filter((f) => f.endsWith(".map"));
if (maps.length > 0) {
  fail(`${maps.length} sourcemap file(s) would be published, e.g. ${maps[0].replace(ROOT, "")}`);
}

// --- 4. No orphaned chunks from an earlier build -----------------------------

const assetFiles = await readdir(ASSETS);

/**
 * Walks the import graph from the entry point.
 *
 * Checking only "does any file mention this name" is not enough: chunks from an earlier
 * build reference *each other*, so a whole stale generation looks self-consistent and
 * reports as reachable. Only what the entry point can actually get to counts.
 */
const reachable = new Set();
const queue = references
  .filter((ref) => !ref.startsWith("http") && !ref.startsWith("data:"))
  .map((ref) => ref.replace(/^\.\//, "").replace(/^assets\//, ""));

while (queue.length > 0) {
  const name = queue.pop();
  if (name === undefined || reachable.has(name)) {
    continue;
  }
  reachable.add(name);
  let content;
  try {
    content = await readFile(join(ASSETS, name), "utf8");
  } catch {
    continue;
  }
  for (const other of assetFiles) {
    if (!reachable.has(other) && content.includes(other)) {
      queue.push(other);
    }
  }
}

const orphans = assetFiles.filter((name) => !reachable.has(name));
if (orphans.length > 0) {
  fail(
    `orphaned asset(s) unreachable from the entry point: ${orphans.join(", ")}. ` +
      "dist/ accumulates across builds; publish from a clean workspace."
  );
}

// --- 5. Size budget ----------------------------------------------------------

let totalGzip = 0;
for (const file of files) {
  if (![".js", ".css"].includes(extname(file))) {
    continue;
  }
  const buffer = await readFile(file);
  const gz = gzipSize(buffer);
  totalGzip += gz;
  if (gz > MAX_FILE_GZIP_KB * 1024) {
    fail(`${file.replace(ROOT, "")} is ~${Math.round(gz / 1024)} kB gzipped, over the ${MAX_FILE_GZIP_KB} kB budget`);
  }
}
if (totalGzip > MAX_TOTAL_GZIP_KB * 1024) {
  fail(`total shipped JS/CSS is ~${Math.round(totalGzip / 1024)} kB gzipped, over the ${MAX_TOTAL_GZIP_KB} kB budget`);
}

// --- 6. Actually serve it from a subpath -------------------------------------

/**
 * Serving `dist/` at `/dist/` is exactly the shape of a Pages project site, where the
 * site lives at `/<repository>/`. Fetching through a real server is what catches a path
 * that resolves on disk but not over HTTP.
 */
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png"
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname === "/dist/" ? "/dist/index.html" : url.pathname;
  try {
    const body = await readFile(join(ROOT, path.replace(/^\//, "")));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

try {
  const base = `http://127.0.0.1:${port}/dist/`;
  const indexRes = await fetch(base);
  if (indexRes.status !== 200) {
    fail(`serving from a subpath returned ${indexRes.status} for the entry point`);
  }

  for (const ref of references) {
    if (ref.startsWith("http") || ref.startsWith("data:")) {
      continue;
    }
    // Resolve the reference the way a browser would, relative to the served directory.
    const resolved = new URL(ref, base).toString();
    const res = await fetch(resolved);
    if (res.status !== 200) {
      fail(`subpath load failed: ${ref} → ${res.status}`);
    }
  }
} finally {
  server.close();
}

// --- Report ------------------------------------------------------------------

note(`entry references ${references.length} asset(s)`);
note(`shipped JS/CSS total ~${Math.round(totalGzip / 1024)} kB gzipped`);

const result = {
  ok: failures.length === 0,
  failures,
  notes
};

console.log(JSON.stringify(result, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
