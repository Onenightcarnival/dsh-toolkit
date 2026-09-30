/** Plugin-owned uv distribution. No system/desktop executable discovery or global PATH writes. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { EnvironmentStatus, McpServer } from './protocol.ts'

export const UV_VERSION = '0.12.10'
// astral-sh/uv release version and SHA256 checksums are pinned together.
const RELEASES: Record<string, { triple: string; sha256: string }> = {
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', sha256: 'f65744f94072152b1f86ba2aace4d01f1124d9a8ecb235805039e3718c36cac2' },
  'win32-arm64': { triple: 'aarch64-pc-windows-msvc', sha256: 'ee985c51c0c9c1f82267a5d80f959b34a7ff888c109182bd3b2b35c4661bbcde' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', sha256: '51c6170e8e3a01cef9f33b94f582b7b81ac65046f55d40afb35f9cff5a68c179' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', sha256: '5296d5aa2b9143360405eea866f8ef4d5dc8986b164eb0dc35e8f876a9304d30' },
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', sha256: '173d95a0c32d18c896c46ba6fafbf3cf9c14ab74b033f81b76c883ef492a976b' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', sha256: '9ff6b9d4665edcdd3a88dcc73cd1eb641754deb927f14e8c62ebfde6bf4f5f5e' },
}
const execute = promisify(execFile)
const MAX_ARCHIVE = 100 * 1024 * 1024

export class EnvironmentMissingError extends Error {
  readonly issue = 'environment-missing'
  constructor() { super('请先到「设置 → 环境依赖」安装或修复 uv / uvx。') }
}

/** Verify the exact release archive before any extraction or execution. */
export function verifyArchive(bytes: Uint8Array, expected: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('uv 下载校验失败，请重试。')
}

export class ManagedEnvironment {
  readonly root: string
  readonly target = `${process.platform}-${process.arch}`
  private readonly release = RELEASES[this.target]
  private readonly suffix = process.platform === 'win32' ? '.exe' : ''
  private phase?: EnvironmentStatus['state']
  private progress?: number
  private error?: string
  private operation?: Promise<void>
  private readonly download: typeof fetch

  constructor(home: string, download: typeof fetch = fetch) {
    this.root = resolve(home, 'tools', 'dsh-config-center')
    this.download = download
  }

  private get directory(): string { return join(this.root, 'uv', UV_VERSION, this.target) }
  private executable(name: 'uv' | 'uvx'): string { return join(this.directory, name + this.suffix) }
  private get supported(): boolean {
    if (!this.release) return false
    // Published Linux builds here require glibc; do not install a mismatched binary on musl.
    return process.platform !== 'linux' || Boolean((process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime)
  }

  /** Dedicated interpreter/tool/cache locations; explicit values also survive the kernel's env scrub. */
  environment(): Record<string, string> {
    return {
      UV_CACHE_DIR: join(this.root, 'cache'),
      UV_PYTHON_INSTALL_DIR: join(this.root, 'python'),
      UV_TOOL_DIR: join(this.root, 'tools'),
      UV_TOOL_BIN_DIR: join(this.root, 'bin'),
      UV_PYTHON_PREFERENCE: 'only-managed',
      UV_PYTHON_DOWNLOADS: 'automatic',
      UV_NO_CONFIG: '1',
      UV_SYSTEM_CERTS: '1',
    }
  }

  /** Recognize bare aliases or our versioned paths, never adopt unrelated absolute paths. */
  tool(command: string | undefined): 'uv' | 'uvx' | undefined {
    if (command === undefined) return undefined
    const alias = process.platform === 'win32' ? command.toLowerCase().replace(/\.exe$/, '') : command
    if (alias === 'uv' || alias === 'uvx') return alias
    const local = relative(join(this.root, 'uv'), resolve(command)).split(sep)
    if (local.length !== 3 || !/^\d+\.\d+\.\d+$/.test(local[0]!) || local[1] !== this.target) return undefined
    const name = basename(local[2]!, this.suffix)
    return name === 'uv' || name === 'uvx' ? name : undefined
  }

  /** Present managed commands as uv/uvx; hide only environment values owned by this manager. */
  editable(server: McpServer): McpServer {
    if (server.transport !== 'stdio' || !this.tool(server.command)) return server
    const managed = this.environment()
    const env = Object.fromEntries(Object.entries(server.env ?? {}).filter(([key, value]) => managed[key] !== value))
    return { ...server, command: this.tool(server.command), env: Object.keys(env).length ? env : undefined }
  }

  /** Resolve the same persisted invocation for both the probe and the official MCP client. */
  async prepare(server: McpServer, requireReady = true): Promise<McpServer> {
    const tool = server.transport === 'stdio' ? this.tool(server.command) : undefined
    if (!tool) return server
    if (requireReady && !(await this.status()).ready) throw new EnvironmentMissingError()
    return this.invocation(server)
  }

  invocation(server: McpServer): McpServer {
    const tool = server.transport === 'stdio' ? this.tool(server.command) : undefined
    return tool ? { ...server, command: this.executable(tool), env: { ...server.env, ...this.environment() } } : server
  }

  private async check(directory: string): Promise<string> {
    for (const tool of ['uv', 'uvx']) {
      const { stdout } = await execute(join(directory, tool + this.suffix), ['--version'], { windowsHide: true, timeout: 10_000, env: { ...scrubbedParentEnv(), ...this.environment() } })
      if (!new RegExp(`^${tool} ${UV_VERSION.replaceAll('.', '\\.')}[ (\\r\\n]`).test(stdout)) throw new Error('uv 版本校验失败。')
    }
    return UV_VERSION
  }

  async status(): Promise<EnvironmentStatus> {
    let version: string | undefined
    let broken = false
    if (this.supported) {
      try { version = await this.check(this.directory) }
      catch (error) { broken = (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    }
    return {
      state: this.phase ?? (!this.supported ? 'unsupported' : version ? 'ready' : broken ? 'error' : 'missing'),
      ready: version !== undefined,
      supported: this.supported,
      target: this.target,
      recommendedVersion: UV_VERSION,
      version,
      path: this.executable('uv'),
      dataDirectory: this.root,
      progress: this.progress,
      error: this.error ?? (broken ? '已安装的 uv 无法运行，请修复环境。' : undefined),
    }
  }

  /** Start one background install per manager; the file lock also serializes separate DSH processes. */
  install(afterInstall?: () => Promise<void>): void {
    if (this.operation) return
    if (!this.supported) throw new Error('暂不支持当前系统或处理器架构。')
    this.phase = 'installing'
    this.error = undefined
    this.progress = undefined
    this.operation = this.installRelease().then(afterInstall).then(() => { this.phase = undefined }, error => {
      this.phase = 'error'
      this.error = error instanceof Error ? error.message : String(error)
    }).finally(() => { this.operation = undefined; this.progress = undefined })
  }

  /** Await completion for host teardown and integration tests. */
  async settled(): Promise<void> { await this.operation }

  private async installRelease(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await withFileLock(join(this.root, 'installation'), async () => {
      const temporary = await mkdtemp(join(this.root, '.install-'))
      let preserveBackup = false
      try {
        const extension = process.platform === 'win32' ? 'zip' : 'tar.gz'
        const archiveName = `uv-${this.release!.triple}.${extension}`
        this.phase = 'downloading'
        const response = await this.download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archiveName}`, { signal: AbortSignal.timeout(300_000), redirect: 'follow' })
        if (!response.ok || !response.body) throw new Error(`uv 下载失败：HTTP ${response.status}`)
        const total = Number(response.headers.get('content-length'))
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length
          if (size > MAX_ARCHIVE) throw new Error('uv 下载文件超过大小限制。')
          chunks.push(chunk)
          this.progress = total > 0 ? Math.min(100, Math.round(size * 100 / total)) : undefined
        }
        const bytes = Buffer.concat(chunks)
        this.phase = 'verifying'
        verifyArchive(bytes, this.release!.sha256)
        const archive = join(temporary, archiveName)
        await writeFile(archive, bytes)
        const entries = ['uv', 'uvx'].map(name => process.platform === 'win32' ? name + this.suffix : `uv-${this.release!.triple}/${name}`)
        this.phase = 'installing'
        await execute('tar', ['-xmf', archive, '-C', temporary, ...entries], { windowsHide: true, timeout: 60_000 })
        const extracted = process.platform === 'win32' ? temporary : join(temporary, `uv-${this.release!.triple}`)
        const candidate = join(temporary, 'ready')
        await mkdir(candidate)
        for (const name of ['uv', 'uvx']) {
          await rename(join(extracted, name + this.suffix), join(candidate, name + this.suffix))
          if (process.platform !== 'win32') await chmod(join(candidate, name), 0o755)
        }
        await this.check(candidate)
        await mkdir(join(this.root, 'uv', UV_VERSION), { recursive: true })
        const backup = join(temporary, 'previous')
        let previous = false
        try { await rename(this.directory, backup); previous = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('uv 正在使用或目录不可写。请停止相关 MCP 后重试。') }
        try { await rename(candidate, this.directory) }
        catch (error) {
          if (previous) {
            try { await rename(backup, this.directory) }
            catch { preserveBackup = true; throw new Error(`uv 替换失败，原版本保留在 ${backup}。请关闭相关 MCP 后重试。`) }
          }
          throw error
        }
        await writeFileAtomic(join(this.root, 'installed.json'), JSON.stringify({ version: UV_VERSION, target: this.target, installedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
      } finally {
        // temporary is created directly under our private root; never remove a user-supplied path.
        if (!preserveBackup) await rm(temporary, { recursive: true, force: true })
      }
    }, { waitMs: 360_000 })
  }
}
