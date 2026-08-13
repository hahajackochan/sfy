import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of ["index.html", "prd", "prototype", "annex"]) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
}

await cp(path.join(root, "cloudflare", "_worker.js"), path.join(output, "_worker.js"));

console.log(`Cloudflare Pages bundle created: ${output}`);
