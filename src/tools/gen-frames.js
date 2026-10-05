const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRAMES_DIR = path.join(ROOT, 'src', 'images', 'frames');
const OUT = path.join(ROOT, 'src', 'data', 'frames-data.js');

if (!fs.existsSync(FRAMES_DIR)) {
  console.error('请先运行 extract-frames.sh 生成帧序列');
  process.exit(1);
}

const groups = fs.readdirSync(FRAMES_DIR)
  .filter((d) => fs.statSync(path.join(FRAMES_DIR, d)).isDirectory());

const lines = ['// 自动生成：由 gen-frames.js 扫描 images/frames 生成，请勿手改', 'export const FRAMES = {'];
groups.forEach((g) => {
  const files = fs.readdirSync(path.join(FRAMES_DIR, g))
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort();
  lines.push(`  ${g}: [${files.map((f) => `require('../images/frames/${g}/${f}')`).join(', ')}],`);
});
lines.push('};');

fs.mkdirSync(path.join(ROOT, 'src', 'data'), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log('生成完成:', OUT, '共', groups.length, '组帧');
