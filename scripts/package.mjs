#!/usr/bin/env node
/**
 * 打包：把 edge-ext/、油猴脚本、安装说明打成一个可直接分发的 zip。
 *
 *   release/Ameflow-vX.Y.Z.zip
 *     Ameflow-vX.Y.Z/
 *       edge-ext/manifest.json
 *       edge-ext/content.js
 *       Ameflow.user.js
 *       使用说明.md
 *
 * 文件名保持中文（用户是中文用户），所以必须走 UTF-8 标志位，见 scripts/zip.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function main() {
  if (!exists('edge-ext/content.js')) throw new Error('先跑 npm run build');

  const manifest = JSON.parse(read('edge-ext/manifest.json').toString('utf8'));
  const version = manifest.version;
  const dir = `Ameflow-v${version}`;

  const entries = [
    ['edge-ext/manifest.json', 'edge-ext/manifest.json'],
    ['edge-ext/content.js', 'edge-ext/content.js'],
    ['dist/Ameflow.user.js', 'Ameflow.user.js'],
    ['README.md', '使用说明.md'],
  ];

  const files = entries.map(([from, to]) => {
    if (!exists(from)) throw new Error(`缺文件：${from}（先 npm run build）`);
    return { name: `${dir}/${to}`, data: read(from) };
  });

  const zip = makeZip(files);
  const out = `release/${dir}.zip`;
  fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, out), zip);

  console.log(`打包完成 ${out}  (${(zip.length / 1024).toFixed(1)} KB)`);
  for (const f of files) console.log(`  ${f.name}  ${f.data.length} B`);
  return out;
}

main();
