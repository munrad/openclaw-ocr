import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  OCR_PACKAGE_BIN,
  SKILL_NAME,
  main,
  resolveCodexHome,
  resolveRepoRoot,
  resolveSkillTargetDir,
  runInstaller,
  syncDirectory,
  validateSkillSource,
} from '../scripts/install-openclaw-orchestrator.mjs';

function withTempDir(prefix, fn) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeSkillFixture(rootDir, skillName = SKILL_NAME) {
  const skillRoot = path.join(rootDir, 'skills', skillName);
  mkdirSync(path.join(skillRoot, 'agents'), { recursive: true });
  mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
  writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    `name: ${skillName}`,
    'description: Test fixture skill',
    '---',
    '',
    '# Fixture',
    '',
    'body',
    '',
  ].join('\n'));
  writeFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'interface:\n  display_name: "Fixture"\n');
  writeFileSync(path.join(skillRoot, 'references', 'fixture.md'), 'fixture');
  return skillRoot;
}

function read(pathname) {
  return readFileSync(pathname, 'utf8');
}

test('resolveCodexHome and resolveSkillTargetDir honor CODEX_HOME defaults', () => {
  const homeDir = '/tmp/install-home';
  assert.equal(resolveCodexHome({}, homeDir), path.resolve(homeDir, '.codex'));
  assert.equal(resolveCodexHome({ CODEX_HOME: '/tmp/custom-codex' }, homeDir), path.resolve('/tmp/custom-codex'));
  assert.equal(
    resolveSkillTargetDir({ env: { CODEX_HOME: '/tmp/custom-codex' }, homeDir }),
    path.resolve('/tmp/custom-codex', 'skills', SKILL_NAME),
  );
});

test('validateSkillSource accepts the packaged skill in this repo', () => {
  const repoRoot = resolveRepoRoot();
  const validation = validateSkillSource(path.join(repoRoot, 'skills', SKILL_NAME));
  assert.equal(validation.ok, true);
  assert.match(validation.skill_md, /SKILL\.md$/);
  assert.match(validation.openai_yaml, /agents\/openai\.yaml$/);
});

test('syncDirectory copies new files and removes stale files', () => withTempDir('openclaw-sync-', (tempDir) => {
  const sourceDir = path.join(tempDir, 'source');
  const targetDir = path.join(tempDir, 'target');
  const skillRoot = writeSkillFixture(sourceDir);

  mkdirSync(path.join(targetDir, 'agents'), { recursive: true });
  mkdirSync(path.join(targetDir, 'references'), { recursive: true });
  writeFileSync(path.join(targetDir, 'SKILL.md'), 'old');
  writeFileSync(path.join(targetDir, 'agents', 'openai.yaml'), 'old');
  writeFileSync(path.join(targetDir, 'references', 'stale.md'), 'stale');

  const state = syncDirectory(skillRoot, targetDir);
  assert.equal(read(path.join(targetDir, 'SKILL.md')), read(path.join(skillRoot, 'SKILL.md')));
  assert.equal(read(path.join(targetDir, 'agents', 'openai.yaml')), read(path.join(skillRoot, 'agents', 'openai.yaml')));
  assert.equal(existsSync(path.join(targetDir, 'references', 'stale.md')), false);
  assert.ok(state.copied_files.some((entry) => entry.endsWith('SKILL.md')));
  assert.ok(state.removed_paths.some((entry) => entry.endsWith('stale.md')));
}));

test('runInstaller syncs the skill and plans OCR install commands', () => withTempDir('openclaw-installer-plan-', (tempDir) => {
  const repoRoot = path.join(tempDir, 'repo');
  const targetDir = path.join(tempDir, 'codex-home', 'skills', SKILL_NAME);
  writeSkillFixture(repoRoot);

  const calls = [];
  const report = runInstaller({
    repoRoot,
    targetDir,
  }, {
    execFileSync(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return '';
    },
  });

  assert.equal(report.skill_sync.status, 'synced');
  assert.equal(report.ocr_install.status, 'installed');
  assert.equal(existsSync(path.join(targetDir, 'SKILL.md')), true);
  assert.deepEqual(calls.map((entry) => entry.command), ['npm', OCR_PACKAGE_BIN]);
  assert.deepEqual(calls[0].args, ['install', '-g', repoRoot]);
  assert.deepEqual(calls[1].args, ['--help']);
}));

test('installer CLI supports dry-run JSON output without touching target', () => withTempDir('openclaw-installer-dry-run-', (tempDir) => {
  const targetDir = path.join(tempDir, 'codex-home', 'skills', SKILL_NAME);
  const stdoutChunks = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    stdoutChunks.push(String(chunk));
    if (typeof encoding === 'function') return encoding();
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    main([
      '--skill-only',
      '--dry-run',
      '--json',
      '--target',
      targetDir,
    ]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const payload = JSON.parse(stdoutChunks.join(''));
  assert.equal(payload.skill_sync.status, 'dry_run');
  assert.equal(payload.ocr_install.status, 'skipped');
  assert.equal(existsSync(targetDir), false);
}));
