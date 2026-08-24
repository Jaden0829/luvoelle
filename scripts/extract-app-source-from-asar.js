'use strict';

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const [, , archiveArgument, outputArgument] = process.argv;

if (!archiveArgument || !outputArgument) {
  console.error('Usage: node extract-app-source-from-asar.js <app.asar> <output-directory>');
  process.exit(2);
}

const archivePath = path.resolve(archiveArgument);
const outputPath = path.resolve(outputArgument);
const allowedDirectories = new Set(['.github', 'assets', 'build', 'docs', 'scripts', 'src', 'tests']);
const allowedFiles = new Set([
  '.gitignore',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package-lock.json',
  'package.json'
]);

fs.mkdirSync(outputPath, { recursive: true });

const entries = asar.listPackage(archivePath);
let extractedCount = 0;

for (const listedEntry of entries) {
  const archiveEntry = listedEntry.replace(/^[/\\]+/, '');
  const normalized = archiveEntry.replace(/\\/g, '/');
  if (!normalized) continue;

  const firstSegment = normalized.split('/')[0];
  const isAllowed = allowedDirectories.has(firstSegment) || allowedFiles.has(normalized);
  if (!isAllowed) continue;

  const fileInfo = asar.statFile(archivePath, archiveEntry, false);
  if ('files' in fileInfo || 'link' in fileInfo) continue;

  let data;
  try {
    data = asar.extractFile(archivePath, archiveEntry);
  } catch (error) {
    if (/is a directory|found a directory or link|EISDIR/i.test(String(error && error.message))) continue;
    throw new Error(`Unable to extract ${normalized}: ${error.message}`);
  }

  const destination = path.join(outputPath, ...normalized.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data);
  extractedCount += 1;
}

if (!fs.existsSync(path.join(outputPath, 'package.json')) || !fs.existsSync(path.join(outputPath, 'src'))) {
  throw new Error('The reconstructed snapshot is incomplete: package.json or src is missing.');
}

console.log(`Extracted ${extractedCount} application-source files from ${path.basename(archivePath)}.`);
