// Recomputes the SHA-256 of the single inline <script> in public/index.html and writes it into
// the Content-Security-Policy in public/_headers. Run after ANY edit inside that <script>:
//   npm run csp:update
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function inlineScriptHash(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (blocks.length !== 1) throw new Error(`expected exactly 1 inline <script>, found ${blocks.length}`);
  return 'sha256-' + createHash('sha256').update(blocks[0][1], 'utf8').digest('base64');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const htmlPath = new URL('../public/index.html', import.meta.url);
  const hdrPath  = new URL('../public/_headers', import.meta.url);
  const hash = inlineScriptHash(readFileSync(htmlPath, 'utf8'));
  const before = readFileSync(hdrPath, 'utf8');
  const after = before.replace(/'sha256-[A-Za-z0-9+/=]+'/, `'${hash}'`);
  if (after === before && !before.includes(`'${hash}'`)) {
    throw new Error("no 'sha256-…' token found in public/_headers script-src");
  }
  writeFileSync(hdrPath, after);
  console.log(`CSP script-src updated → '${hash}'`);
}
