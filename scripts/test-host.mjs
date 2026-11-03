import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temporary = mkdtempSync(join(tmpdir(), 'dsh-council-host-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Do not inherit the launching profile, provider credentials, NODE_OPTIONS, or
// user npm configuration. Downloaded dependency lifecycle scripts are disabled.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|COMSPEC|PATHEXT|TMPDIR|TMP|TEMP|LANG|LC_ALL|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i.test(key)))
Object.assign(environment, {
  HOME: temporary, USERPROFILE: temporary, DSH_HOME: join(temporary, 'home'), DSH_TELEMETRY_DISABLED: '1',
  npm_config_userconfig: join(temporary, '.npmrc'), npm_config_ignore_scripts: 'true',
  // Share only immutable public package downloads, never the user's npm config.
  npm_config_cache: process.env.DSH_TEST_NPM_CACHE ?? join(homedir(), '.npm'),
})
writeFileSync(environment.npm_config_userconfig, 'registry=https://registry.npmjs.org/\n')
function environmentDiagnostics() {
  const packages = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/cordis-plugin-loader',
    'sharp', '@img/sharp-darwin-arm64', 'koffi', '@koromix/koffi-darwin-arm64', 'node-pty',
    'node-addon-require-builtin', 'node-addon-require-builtin-darwin-arm64', 'node-addon-native-custom-loader']
  const versions = Object.fromEntries(packages.map(name => {
    const path = join(temporary, 'node_modules', name, 'package.json')
    return [name, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : null]
  }))
  return { node: process.version, executable: realpathSync(process.execPath), abi: process.versions.modules,
    platform: process.platform, arch: process.arch, versions }
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: temporary, env: environment, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024, ...options })
  if (result.error) throw new Error(`${result.error.message}\n${result.stdout}\n${result.stderr}`)
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
try {
  const [packed] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root }))
  assert.equal(packed.name, manifest.name)
  assert.equal(packed.version, manifest.version)
  for (const file of ['lib/index.js', 'lib/index.d.ts', 'LICENSE', 'cordis.patch.yml', ...manifest.files.filter(file => !file.endsWith('/'))]) {
    assert(packed.files.some(item => item.path === file), `Missing packed release file: ${file}`)
  }
  assert(readFileSync(join(root, 'cordis.patch.yml'), 'utf8').includes(`name: '${manifest.name}'`), 'Bundle patch must resolve this exact package')
  assert(!packed.files.some(file => /(?:tests|scripts|node_modules|coverage|promo)\//.test(file.path) || /(?:^|\/)\.env(?:\.|$)/.test(file.path)))
  const version = process.env.DSH_TEST_VERSION ?? '0.2.1-rc.5'
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'DSH_TEST_VERSION must name one exact version, not latest or a range')
  // The old CLI's ^ vendor ranges now select an incompatible Loader activation
  // lifecycle. Test its release-time vendor tuple, not that upstream mixture.
  const overrides = version === '0.1.2-rc.1' ? {
    '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/cordis-plugin-loader': '1.0.3',
    '@deepseek-ai/cordis-plugin-include': '1.0.7', '@deepseek-ai/cordis-plugin-group': '1.0.2',
    '@deepseek-ai/cordis-plugin-hmr': '1.0.17', '@deepseek-ai/cordis-plugin-timer': '1.1.4',
    '@deepseek-ai/cosmokit': '1.8.3', '@deepseek-ai/schemastery': '3.18.2',
  } : {}
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module', overrides }))
  process.stdout.write(`Testing packed plugin against DSH ${version}\n`)
  const cachedModules = process.env.DSH_TEST_NODE_MODULES
  if (cachedModules === undefined) {
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`])
  } else {
    assert(isAbsolute(cachedModules), 'Reusable test node_modules path must be absolute')
    const cached = JSON.parse(readFileSync(join(cachedModules, '@deepseek-ai/dsh/package.json'), 'utf8'))
    assert.equal(cached.version, version, 'Reusable runtime version must match the test target')
    symlinkSync(cachedModules, join(temporary, 'node_modules'), 'dir')
  }
  const bin = join(temporary, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  run(process.execPath, [bin, 'plugin', '--profile', 'web', 'add', join(temporary, packed.filename)])
  const profile = JSON.parse(readFileSync(join(environment.DSH_HOME, 'profiles/web/package.json'), 'utf8'))
  assert(profile.dependencies[manifest.name], 'The scoped package must be installed into the profile')
  assert(profile.dsh.profile.bundles.includes(manifest.name), 'The package bundle must activate automatically')
  const profilePackage = realpathSync(join(environment.DSH_HOME, 'profiles/web/node_modules', manifest.name))
  const installedManifest = JSON.parse(readFileSync(join(profilePackage, 'package.json'), 'utf8'))
  assert.equal(installedManifest.name, manifest.name)
  assert.equal(installedManifest.version, packed.version)
  assert(readFileSync(join(profilePackage, 'lib/index.js')).equals(readFileSync(join(root, 'lib/index.js'))),
    'Installed Host code differs from the packed build')
  assert(readFileSync(join(profilePackage, 'client.js')).equals(readFileSync(join(root, 'client.js'))),
    'Installed Client code differs from the packed build')
  // Legacy Loader resolves bare imports beside its own runtime, not the profile.
  // Link the SAME installed packed artifact into our disposable runtime root;
  // never alter a supplied reusable node_modules tree or a real user profile.
  if (cachedModules === undefined) {
    const modules = join(temporary, 'node_modules')
    assert.equal(realpathSync(modules), join(realpathSync(temporary), 'node_modules'))
    const runtimePackage = join(modules, manifest.name)
    if (!existsSync(runtimePackage)) {
      mkdirSync(dirname(runtimePackage), { recursive: true })
      symlinkSync(profilePackage, runtimePackage, 'dir')
    } else assert.equal(realpathSync(runtimePackage), profilePackage, 'Runtime resolves a different Council artifact')
  }
  copyFileSync(join(root, 'tests/fixtures/host.mjs'), join(temporary, 'host.mjs'))
  const documentedConfig = readFileSync(join(root, 'README.md'), 'utf8').match(/```yaml\n([\s\S]*?)\n```/)?.[1]
  assert(documentedConfig, 'README configuration example is missing')
  writeFileSync(join(temporary, 'smoke.patch.yml'), `- insert:\n    - id: council-smoke\n      name: ${JSON.stringify(join(temporary, 'host.mjs'))}\n${documentedConfig}\n`)
  const output = run(process.execPath, [bin, '--profile', 'web', '--patch', join(temporary, 'smoke.patch.yml'), '--port', '0', '--no-open'], { timeout: 60_000 })
  assert(output.includes('COUNCIL_HOST_OK'), output)
  const report = JSON.parse(readFileSync(join(temporary, 'report.json'), 'utf8'))
  assert.equal(report.calls, 8)
  assert.equal(report.guardChecks, report.api === 'activation' ? 10 : 8)
  assert.equal(report.continuations, report.api === 'activation' ? 2 : 0)
  assert.deepEqual(report.locales, ['en', 'zh'])
  assert.equal(report.coldReloads, 2)
  assert.equal(report.chat.supported, version !== '0.1.2-rc.1')
  if (report.chat.supported) {
    assert.equal(report.chat.calls, 12)
    assert.equal(report.chat.runs, 3)
    assert.equal(report.chat.continuations, 1)
    assert.equal(report.chat.parentFollowups, 1)
    assert.equal(report.chat.guardChecks, 16)
    assert.deepEqual(report.chat.deniedProbes, ['route', 'max-tokens', 'huge-system'])
  }
  process.stdout.write(`${JSON.stringify({ version, package: `${packed.name}@${packed.version}`, integrity: packed.integrity, ...report })}\n`)
  process.stdout.write(`Host smoke passed: exact topic routes/caps, bilingual output and persistence; ${report.chat.supported ? 'chat consent, shared material, pending/clear, compact handoff and cold route/output/window guards' : 'legacy topic-only compatibility (chat capability not claimed)'}.\n`)
} catch (error) {
  try { process.stderr.write(`HOST_ENV_DIAGNOSTICS ${JSON.stringify(environmentDiagnostics())}\n`) }
  catch (diagnosticError) { process.stderr.write(`Host environment diagnostics unavailable: ${diagnosticError.message}\n`) }
  throw error
} finally {
  if (process.env.DSH_TEST_KEEP_TEMP === '1') {
    process.stdout.write(`Retained test directory: ${temporary}\n`)
  } else {
    const target = realpathSync(temporary)
    assert.equal(dirname(target), realpathSync(tmpdir()))
    assert(basename(target).startsWith('dsh-council-host-'))
    rmSync(target, { recursive: true, force: true })
    assert(!existsSync(target), 'Isolated Host directory was not cleaned up')
    process.stdout.write(`Cleaned isolated Host directory: ${target}\n`)
  }
}
