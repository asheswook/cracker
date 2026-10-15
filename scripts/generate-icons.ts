import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { characterIconSvg, characterSvg } from '../apps/web/src/appearance/character-svg';
import { defaultAppearance } from '../packages/appearance/schema';

const root = join(import.meta.dir, '..');
const background = '#3d5470';
const art = characterIconSvg(defaultAppearance, background, 1024);
const inner = art.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
const roundedWeb = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="c"><rect width="100" height="100" rx="22"/></clipPath></defs><g clip-path="url(#c)">${inner}</g></svg>`;

const work = await mkdtemp(join(tmpdir(), 'icons-'));
async function render(svg: string, size: number, target: string) {
  const source = join(work, `${crypto.randomUUID()}.svg`);
  await Bun.write(source, svg);
  const result = Bun.spawnSync(['rsvg-convert', '-w', String(size), '-h', String(size), source, '-o', join(root, target)]);
  if (result.exitCode !== 0) throw new Error(`rsvg-convert failed for ${target}: ${result.stderr.toString()}`);
}
try {
  await Bun.write(join(root, 'apps/web/public/icon.svg'), characterSvg(defaultAppearance, 64).replace(/ width="64" height="64"/, ''));
  await render(roundedWeb, 192, 'apps/web/public/icon-192.png');
  await render(roundedWeb, 512, 'apps/web/public/icon-512.png');
  await render(art, 512, 'apps/web/public/icon-maskable-512.png');
  await render(art, 180, 'apps/web/public/apple-touch-icon.png');
  await render(art, 1024, 'apps/apple/Assets/iOS.xcassets/AppIcon.appiconset/icon-1024x1024-1x.png');
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      await render(art, size * scale, `apps/apple/Assets/macOS.xcassets/AppIcon.appiconset/icon-${size}x${size}-${scale}x.png`);
} finally {
  await rm(work, { recursive: true, force: true });
}
