import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const BG_COLOR = '#FAF9F7';
const SVG_PATH = path.join(root, 'docs/design/orbital-logo-light-lg.svg');

// Fix the SVG dimensions (source uses width="100%" height="100%")
const svgRaw = fs.readFileSync(SVG_PATH, 'utf8')
  .replace('width="100%"', 'width="1080"')
  .replace('height="100%"', 'height="1080"');
const svgBuffer = Buffer.from(svgRaw);

// --- iOS ---
// Modern Xcode 15+ single-size approach: one 1024x1024 PNG
async function generateIOS() {
  const outDir = path.join(root, 'ios/OrbitalMobile/Images.xcassets/AppIcon.appiconset');

  // Logo with padding on background
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG_COLOR } })
    .composite([{
      input: await sharp(svgBuffer).resize(720, 720).toBuffer(),
      gravity: 'center',
    }])
    .png()
    .toFile(path.join(outDir, 'Icon-1024.png'));

  // Update Contents.json to single-size format
  const contents = {
    images: [{
      filename: 'Icon-1024.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    }],
    info: { author: 'xcode', version: 1 },
  };
  fs.writeFileSync(path.join(outDir, 'Contents.json'), JSON.stringify(contents, null, 2) + '\n');
  console.log('iOS: Icon-1024.png + Contents.json written');
}

// --- Android ---
// Adaptive icons: foreground (logo on transparent) + background (solid color)
// Plus legacy static icons for pre-API 26
const ANDROID_DENSITIES = [
  { name: 'mdpi', size: 48, adaptive: 108 },
  { name: 'hdpi', size: 72, adaptive: 162 },
  { name: 'xhdpi', size: 96, adaptive: 216 },
  { name: 'xxhdpi', size: 144, adaptive: 324 },
  { name: 'xxxhdpi', size: 192, adaptive: 432 },
];

async function generateAndroid() {
  const resDir = path.join(root, 'android/app/src/main/res');

  for (const density of ANDROID_DENSITIES) {
    const mipmapDir = path.join(resDir, `mipmap-${density.name}`);
    fs.mkdirSync(mipmapDir, { recursive: true });

    // Legacy static icon (logo on background, full size)
    const legacyIcon = await sharp({ create: { width: density.size, height: density.size, channels: 4, background: BG_COLOR } })
      .composite([{
        input: await sharp(svgBuffer).resize(Math.round(density.size * 0.7), Math.round(density.size * 0.7)).toBuffer(),
        gravity: 'center',
      }])
      .png()
      .toBuffer();

    fs.writeFileSync(path.join(mipmapDir, 'ic_launcher.png'), legacyIcon);
    fs.writeFileSync(path.join(mipmapDir, 'ic_launcher_round.png'), legacyIcon);

    // Adaptive foreground (logo centered on transparent, 108dp canvas)
    const fgSize = density.adaptive;
    const logoSize = Math.round(fgSize * 0.48); // logo in inner 72dp safe zone
    const foreground = await sharp({ create: { width: fgSize, height: fgSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{
        input: await sharp(svgBuffer).resize(logoSize, logoSize).toBuffer(),
        gravity: 'center',
      }])
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(mipmapDir, 'ic_launcher_foreground.png'), foreground);
  }

  // Adaptive icon XML files
  const anydpiDir = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpiDir, { recursive: true });

  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher.xml'), adaptiveXml);
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher_round.xml'), adaptiveXml);

  // Background color resource
  const valuesDir = path.join(resDir, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  const colorsPath = path.join(valuesDir, 'ic_launcher_background.xml');
  const colorsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG_COLOR}</color>
</resources>
`;
  fs.writeFileSync(colorsPath, colorsXml);

  console.log('Android: legacy icons, adaptive foregrounds, and XML configs written');
}

await generateIOS();
await generateAndroid();
console.log('Done!');
