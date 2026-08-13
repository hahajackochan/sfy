import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-worker");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of ["index.html", "prd", "prototype", "annex"]) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
}

console.log(`Cloudflare Workers static assets created: ${output}`);
