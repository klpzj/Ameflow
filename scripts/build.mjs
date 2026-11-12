#!/usr/bin/env node
/**
 * 构建：把 src/ 里的唯一源码派生成两种产物
 *
 *   src/content.js      —— 唯一源码（带油猴头，扩展里当普通脚本用也无害）
 *   src/manifest.json   —— 扩展清单模板，版本号是占位符
 *
 *   edge-ext/                       —— Edge「加载解压缩的扩展」的目标目录（进仓库，可直接加载）
 *     content.js
 *     manifest.json
 *   dist/Ameflow.user.js             —— 油猴版（构建产物，不进仓库）
 *
 * 版本号只写在 src/content.js 的 `const VER = 'vX.Y.Z'` 一处，
 * 由本脚本同步到 manifest 与油猴头，避免三处各写一遍对不上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function write(p, s) {
  const abs = path.join(ROOT, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, s);
  return p;
}

export function build() {
  const src = read('src/content.js');

  // 1) 版本号：唯一来源
  const m = src.match(/const VER\s*=\s*'v(\d+(?:\.\d+){1,3})'/);
  if (!m) throw new Error("src/content.js 里找不到 `const VER = 'vX.Y.Z'`");
  const version = m[1];

  // 2) 油猴头里的 @version 跟着改
  if (!/^\/\/ @version\s+\S+$/m.test(src)) throw new Error('油猴头里没有 @version');
  const content = src.replace(/^\/\/ @version\s+\S+$/m, `// @version      ${version}`);

  // 3) 扩展清单：填版本号并校验几条硬约束
  const manifest = JSON.parse(read('src/manifest.json'));
  manifest.version = version;
  if (manifest.manifest_version !== 3) throw new Error('只支持 MV3');
  if (manifest.permissions || manifest.host_permissions) {
    throw new Error('这个扩展不需要任何 permissions，别加');
  }
  for (const cs of manifest.content_scripts || []) {
    if (cs.run_at !== 'document_start') {
      // 反挂机检测必须在页面脚本之前打补丁，改晚了就失效
      throw new Error('content_scripts.run_at 必须是 document_start');
    }
    for (const u of cs.matches || []) {
      if (!/\*$/.test(u)) throw new Error(`matches 必须以 /* 结尾：${u}`);
    }
  }

  const out = [
    write('edge-ext/content.js', content),
    write('edge-ext/manifest.json', JSON.stringify(manifest, null, 2) + '\n'),
    write('dist/Ameflow.user.js', content),
  ];

  // 4) package.json 的版本必须和源码一致，否则 release 包名会乱
  //    比较时忽略末尾的 .0，因为清单只要求 1~4 段数字，"1.0" 与 "1.0.0" 同义
  const pkg = JSON.parse(read('package.json'));
  const norm = (v) => v.replace(/(\.0)+$/, '');
  if (norm(pkg.version) !== norm(version)) {
    console.warn(`  ! package.json 是 ${pkg.version}，源码是 ${version}（不影响运行，建议对齐）`);
  }

  console.log(`构建完成 v${version}`);
  for (const f of out) console.log('  ' + f);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
