const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const packageMetadata = require('../package.json');

assert.equal(packageMetadata.license, 'PolyForm-Noncommercial-1.0.0');
assert.match(read('LICENSE'), /^# PolyForm Noncommercial License 1\.0\.0/m);
assert.match(read('LICENSE'), /^Required Notice: Copyright \(c\) 2026 Jaden0829, Luvoelle project\./m);
assert.match(read('NOTICE'), /^Required Notice: Copyright \(c\) 2026 Jaden0829, Luvoelle project\./m);
assert.match(read('COMMERCIAL_LICENSE.md'), /商业授权/);
assert.match(read('TRADEMARKS.md'), /Fork 必须/);
assert.match(read('ASSETS_LICENSE.md'), /assets\/pet-character-hd\.png/);
assert.match(read('CLA.md'), /再许可/);
assert.match(read('CONTRIBUTING.md'), /CLA/);
assert.match(read('SECURITY.md'), /Private vulnerability reporting/);
assert.match(read('THIRD_PARTY_NOTICES.md'), /LICENSES\//);
assert.ok(fs.existsSync(path.join(root, 'LICENSES', 'MIT.txt')));
assert.ok(fs.existsSync(path.join(root, 'LICENSES', 'Apache-2.0.txt')));

const packagedFiles = packageMetadata.build.files;
for (const file of ['LICENSE', 'NOTICE', 'COMMERCIAL_LICENSE.md', 'TRADEMARKS.md', 'ASSETS_LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'LICENSES/**/*']) {
  assert.ok(packagedFiles.includes(file), `${file} is missing from packaged files`);
}

const attributes = read('.gitattributes');
for (const privatePath of ['/artifacts', '/docs/provenance', '/scripts/build-provenance-manifest.ps1']) {
  assert.match(attributes, new RegExp(`^${privatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} export-ignore$`, 'm'));
}

const readme = read('README.md');
assert.match(readme, /不是 OSI 定义的开源软件/);
assert.doesNotMatch(readme, /应用源码采用 MIT License/);

process.stdout.write(`${JSON.stringify({
  license: packageMetadata.license,
  sourceAvailable: true,
  commercialAuthorizationRequired: true,
  trademarkReserved: true,
  contributorRelicensingCovered: true,
  packagedNotices: true,
  privateHistoryExportIgnored: true,
})}\n`);
