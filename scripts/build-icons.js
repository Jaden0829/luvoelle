const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'assets', 'icon.svg');
const pngPath = path.join(root, 'assets', 'icon.png');
const icoPath = path.join(root, 'assets', 'icon.ico');
const previewDir = path.join(root, 'work', 'brand', 'sizes');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function makeIco(images) {
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = directorySize;

  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const renderer = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await renderer.loadFile(sourcePath);
  const source = await renderer.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  renderer.destroy();
  if (source.isEmpty()) throw new Error(`Unable to render ${sourcePath}`);

  fs.mkdirSync(previewDir, { recursive: true });
  const master = source.resize({ width: 512, height: 512, quality: 'best' }).toPNG();
  fs.writeFileSync(pngPath, master);

  const icoImages = icoSizes.map((size) => {
    const data = source.resize({ width: size, height: size, quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(previewDir, `icon-${size}.png`), data);
    return { size, data };
  });
  fs.writeFileSync(icoPath, makeIco(icoImages));
  console.log(JSON.stringify({ master: pngPath, ico: icoPath, sourceSize: source.getSize(), icoSizes }));
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
