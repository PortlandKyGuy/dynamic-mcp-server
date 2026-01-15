#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function sanitizeAscii(input) {
  if (!input) return '';
  return String(input).replace(/[^\x20-\x7E]/g, '').trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function bumpVersion(version, bumpType) {
  const parts = String(version).split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid version: ${version}`);
  }
  const [major, minor, patch] = parts;
  switch (bumpType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump type: ${bumpType}`);
  }
}

function updateChangelog(changelogPath, newVersion, date, prTitle, prNumber) {
  const header = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n';
  let content = '';
  if (fs.existsSync(changelogPath)) {
    content = fs.readFileSync(changelogPath, 'utf8');
  } else {
    content = header;
  }

  const safeTitle = sanitizeAscii(prTitle) || 'Update';
  const prLine = prNumber ? `- PR #${prNumber}: ${safeTitle}` : `- ${safeTitle}`;
  const entry = `## ${newVersion} - ${date}\n${prLine}\n\n`;

  const firstSectionIndex = content.indexOf('\n## ');
  if (firstSectionIndex === -1) {
    if (!content.startsWith('# Changelog')) {
      content = header;
    }
    content = content.trimEnd() + '\n\n' + entry;
  } else {
    content = content.slice(0, firstSectionIndex + 1) + entry + content.slice(firstSectionIndex + 1);
  }

  fs.writeFileSync(changelogPath, content);
}

function main() {
  const bumpType = process.argv[2] || 'patch';
  const prTitle = process.argv[3] || '';
  const prNumber = process.argv[4] || '';

  const root = process.cwd();
  const pkgPath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const changelogPath = path.join(root, 'CHANGELOG.md');

  const pkg = readJson(pkgPath);
  const newVersion = bumpVersion(pkg.version, bumpType);
  pkg.version = newVersion;
  writeJson(pkgPath, pkg);

  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    lock.version = newVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = newVersion;
    }
    writeJson(lockPath, lock);
  }

  const date = new Date().toISOString().slice(0, 10);
  updateChangelog(changelogPath, newVersion, date, prTitle, prNumber);

  console.log(`Bumped version to ${newVersion}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
