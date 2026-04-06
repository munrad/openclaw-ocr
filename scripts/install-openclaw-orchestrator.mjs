#!/usr/bin/env node
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SKILL_NAME = 'openclaw-orchestrator';
export const OCR_PACKAGE_BIN = 'ocr';
export const INSTALLER_BIN = 'openclaw-orchestrator-install';

function platformCommand(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command;
}

function normalizeString(value) {
  return String(value || '').trim();
}

export function resolveRepoRoot(fromUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), '..');
}

export function resolveCodexHome(env = process.env, homeDir = os.homedir()) {
  const configured = normalizeString(env.CODEX_HOME);
  return configured ? path.resolve(configured) : path.resolve(homeDir, '.codex');
}

export function resolveSkillSourceDir(repoRoot) {
  return path.resolve(repoRoot, 'skills', SKILL_NAME);
}

export function resolveSkillTargetDir({ targetDir, env = process.env, homeDir = os.homedir() } = {}) {
  if (targetDir) return path.resolve(targetDir);
  return path.resolve(resolveCodexHome(env, homeDir), 'skills', SKILL_NAME);
}

export function parseSkillFrontmatterName(skillMdPath) {
  const source = readFileSync(skillMdPath, 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`SKILL.md is missing YAML frontmatter: ${skillMdPath}`);
  const nameMatch = match[1].match(/^name:\s*(.+)$/m);
  if (!nameMatch) throw new Error(`SKILL.md is missing "name" frontmatter: ${skillMdPath}`);
  return nameMatch[1].trim().replace(/^["']|["']$/g, '');
}

export function validateSkillSource(skillSourceDir, expectedName = SKILL_NAME) {
  if (!existsSync(skillSourceDir)) {
    throw new Error(`Skill source directory not found: ${skillSourceDir}`);
  }
  if (!lstatSync(skillSourceDir).isDirectory()) {
    throw new Error(`Skill source must be a directory: ${skillSourceDir}`);
  }

  const skillMdPath = path.join(skillSourceDir, 'SKILL.md');
  const openaiYamlPath = path.join(skillSourceDir, 'agents', 'openai.yaml');
  if (!existsSync(skillMdPath)) throw new Error(`Missing SKILL.md: ${skillMdPath}`);
  if (!existsSync(openaiYamlPath)) throw new Error(`Missing agents/openai.yaml: ${openaiYamlPath}`);

  const skillName = parseSkillFrontmatterName(skillMdPath);
  if (skillName !== expectedName) {
    throw new Error(`SKILL.md name must be "${expectedName}", got "${skillName}"`);
  }

  return {
    ok: true,
    skill_name: skillName,
    skill_md: skillMdPath,
    openai_yaml: openaiYamlPath,
  };
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertSafeSyncPaths(sourceDir, targetDir) {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedTarget = path.resolve(targetDir);
  if (resolvedSource === resolvedTarget) {
    throw new Error('Skill source and target directories must differ.');
  }
  if (isPathInside(resolvedSource, resolvedTarget) || isPathInside(resolvedTarget, resolvedSource)) {
    throw new Error('Skill source and target directories must not nest inside each other.');
  }
}

function createSyncState(dryRun) {
  return {
    dry_run: dryRun,
    copied_files: [],
    removed_paths: [],
    created_dirs: [],
  };
}

function ensureDirectory(dirPath, state) {
  if (existsSync(dirPath)) return;
  state.created_dirs.push(dirPath);
  if (!state.dry_run) mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath, state) {
  if (!existsSync(targetPath)) return;
  state.removed_paths.push(targetPath);
  if (!state.dry_run) rmSync(targetPath, { recursive: true, force: true });
}

function syncEntry(sourcePath, targetPath, state) {
  const sourceStat = lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Symlinked files are not supported in installer source: ${sourcePath}`);
  }

  if (sourceStat.isDirectory()) {
    if (existsSync(targetPath) && !lstatSync(targetPath).isDirectory()) {
      removePath(targetPath, state);
    }
    ensureDirectory(targetPath, state);
    syncDirectory(sourcePath, targetPath, { dryRun: state.dry_run, state });
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported source entry type: ${sourcePath}`);
  }

  if (existsSync(targetPath) && !lstatSync(targetPath).isFile()) {
    removePath(targetPath, state);
  }
  ensureDirectory(path.dirname(targetPath), state);
  state.copied_files.push(targetPath);
  if (!state.dry_run) cpSync(sourcePath, targetPath, { force: true });
}

export function syncDirectory(sourceDir, targetDir, { dryRun = false, state = createSyncState(dryRun) } = {}) {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedTarget = path.resolve(targetDir);

  if (!existsSync(resolvedSource) || !lstatSync(resolvedSource).isDirectory()) {
    throw new Error(`Source directory not found: ${resolvedSource}`);
  }

  ensureDirectory(resolvedTarget, state);

  const sourceEntries = new Set(readdirSync(resolvedSource));
  const targetEntries = existsSync(resolvedTarget) ? readdirSync(resolvedTarget) : [];

  for (const entry of targetEntries) {
    if (!sourceEntries.has(entry)) {
      removePath(path.join(resolvedTarget, entry), state);
    }
  }

  for (const entry of sourceEntries) {
    syncEntry(path.join(resolvedSource, entry), path.join(resolvedTarget, entry), state);
  }

  return state;
}

function formatExecError(err) {
  const stderr = normalizeString(err?.stderr);
  const stdout = normalizeString(err?.stdout);
  if (stderr) return stderr;
  if (stdout) return stdout;
  return normalizeString(err?.message) || 'unknown command failure';
}

export function installOcrCli(repoRoot, {
  dryRun = false,
  env = process.env,
  execFileSync = defaultExecFileSync,
} = {}) {
  const npmCommand = platformCommand('npm');
  const ocrCommand = platformCommand(OCR_PACKAGE_BIN);
  const commands = [
    { command: npmCommand, args: ['install', '-g', repoRoot], cwd: repoRoot },
    { command: ocrCommand, args: ['--help'], cwd: repoRoot },
  ];

  if (dryRun) {
    return {
      status: 'dry_run',
      commands,
    };
  }

  try {
    execFileSync(npmCommand, ['install', '-g', repoRoot], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`Failed to install OCR CLI: ${formatExecError(err)}`);
  }

  try {
    execFileSync(ocrCommand, ['--help'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`OCR CLI verification failed: ${formatExecError(err)}`);
  }

  return {
    status: 'installed',
    commands,
  };
}

export function parseInstallerArgs(argv) {
  const args = {
    skillOnly: false,
    ocrOnly: false,
    dryRun: false,
    json: false,
    noRestartNote: false,
    targetDir: '',
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    switch (token) {
      case '--skill-only':
        args.skillOnly = true;
        break;
      case '--ocr-only':
        args.ocrOnly = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-restart-note':
        args.noRestartNote = true;
        break;
      case '--target':
        args.targetDir = normalizeString(argv[index + 1]);
        if (!args.targetDir) throw new Error('--target requires a path');
        index += 1;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (args.skillOnly && args.ocrOnly) {
    throw new Error('--skill-only and --ocr-only are mutually exclusive');
  }

  return args;
}

export function installerHelpText() {
  return [
    'Usage: openclaw-orchestrator-install [options]',
    '',
    'Options:',
    '  --skill-only         Sync only the skill into ${CODEX_HOME:-~/.codex}/skills',
    '  --ocr-only           Install or refresh only the OCR CLI',
    '  --target <path>      Override the destination skill directory',
    '  --dry-run            Show planned actions without changing anything',
    '  --json               Print JSON summary',
    '  --no-restart-note    Suppress the restart reminder',
    '  --help, -h           Show this help',
    '',
    'Default behavior installs or refreshes both the OCR CLI and the',
    `personal skill at \${CODEX_HOME:-~/.codex}/skills/${SKILL_NAME}.`,
  ].join('\n');
}

export function buildHumanSummary(report) {
  const lines = [
    'OpenClaw Orchestrator installer',
    `repo root: ${report.repo_root}`,
    `skill source: ${report.skill_source}`,
    `skill target: ${report.skill_target}`,
    `skill sync: ${report.skill_sync.status}`,
    `ocr install: ${report.ocr_install.status}`,
  ];

  if (report.skill_sync.status !== 'skipped') {
    lines.push(
      `skill sync stats: copied=${report.skill_sync.copied_files} removed=${report.skill_sync.removed_paths} dirs=${report.skill_sync.created_dirs}`
    );
  }

  if (!report.no_restart_note) {
    lines.push('next step: Restart Codex/OpenClaw to pick up the installed skill.');
  }

  return lines.join('\n');
}

export function runInstaller(options = {}, deps = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const repoRoot = options.repoRoot || resolveRepoRoot(options.fromUrl || import.meta.url);
  const skillSourceDir = options.skillSourceDir || resolveSkillSourceDir(repoRoot);
  const skillTargetDir = resolveSkillTargetDir({
    targetDir: options.targetDir,
    env,
    homeDir,
  });
  const dryRun = Boolean(options.dryRun);
  const skillOnly = Boolean(options.skillOnly);
  const ocrOnly = Boolean(options.ocrOnly);

  if (skillOnly && ocrOnly) {
    throw new Error('--skill-only and --ocr-only are mutually exclusive');
  }

  validateSkillSource(skillSourceDir);
  if (!ocrOnly) {
    assertSafeSyncPaths(skillSourceDir, skillTargetDir);
  }

  const report = {
    ok: true,
    dry_run: dryRun,
    repo_root: repoRoot,
    skill_name: SKILL_NAME,
    skill_source: skillSourceDir,
    skill_target: skillTargetDir,
    skill_sync: {
      status: ocrOnly ? 'skipped' : (dryRun ? 'dry_run' : 'synced'),
      copied_files: 0,
      removed_paths: 0,
      created_dirs: 0,
    },
    ocr_install: {
      status: skillOnly ? 'skipped' : (dryRun ? 'dry_run' : 'installed'),
      commands: [],
    },
    no_restart_note: Boolean(options.noRestartNote),
    next_step: options.noRestartNote ? '' : 'Restart Codex/OpenClaw',
  };

  if (!ocrOnly) {
    const syncState = syncDirectory(skillSourceDir, skillTargetDir, { dryRun });
    report.skill_sync = {
      status: dryRun ? 'dry_run' : 'synced',
      copied_files: syncState.copied_files.length,
      removed_paths: syncState.removed_paths.length,
      created_dirs: syncState.created_dirs.length,
    };
  }

  if (!skillOnly) {
    report.ocr_install = installOcrCli(repoRoot, {
      dryRun,
      env,
      execFileSync: deps.execFileSync || defaultExecFileSync,
    });
  }

  return report;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseInstallerArgs(argv);
  if (args.help) {
    process.stdout.write(`${installerHelpText()}\n`);
    return;
  }

  const report = runInstaller(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${buildHumanSummary(report)}\n`);
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${normalizeString(err?.message) || String(err)}\n`);
    process.exit(1);
  }
}
