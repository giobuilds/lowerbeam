import { execFileSync } from 'node:child_process'
import { readdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Task } from './tasks.js'

/**
 * Mechanical acceptance, inside the workspace. The repository's node_modules
 * is linked in first — it is not part of any copy — so the suite and tsc can
 * run there exactly as they do here.
 */
export async function runChecks(root: string, repo: string, task: Task): Promise<string[]> {
  const failures: string[] = []
  const check = task.check
  if (!check) return failures
  // bubblewrap creates its mount point as a real directory, so a run that
  // executed anything leaves an empty node_modules behind; it has to go
  // before the link can take its place, or nothing in the suite resolves.
  const link = join(root, 'node_modules')
  try {
    const info = await stat(link)
    if (info.isDirectory()) await rm(link, { recursive: true, force: true })
  } catch {
    /* absent, which is fine */
  }
  try {
    await symlink(join(repo, 'node_modules'), link)
  } catch {
    /* already linked */
  }
  const sh = (cmd: string, args: string[]): { ok: boolean; out: string } => {
    try {
      const out = execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).toString()
      return { ok: true, out }
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer }
      return { ok: false, out: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` }
    }
  }
  if (check.suite) {
    const r = sh('node', ['tests/run.mjs', check.suite])
    if (!r.ok || !/assertions passed/.test(r.out) || /FAIL/.test(r.out)) {
      const line = r.out.split('\n').find((l) => /AssertionError|FAIL|Error/.test(l)) ?? 'suite failed'
      failures.push(`suite ${check.suite}: ${line.trim().slice(0, 100)}`)
    }
  }
  for (const project of check.typecheck ?? []) {
    const r = sh('npx', ['tsc', '--noEmit', '-p', `tsconfig.${project}.json`])
    if (!r.ok) failures.push(`typecheck ${project}: ${(r.out.split('\n').find((l) => /error TS/.test(l)) ?? 'failed').trim().slice(0, 100)}`)
  }
  if (check.absent) {
    const re = new RegExp(check.absent.pattern)
    for (const dir of check.absent.under) {
      for (const file of await walkFiles(join(root, dir))) {
        if (re.test(await readFile(file, 'utf8'))) failures.push(`still present: ${check.absent.pattern} in ${relative(root, file)}`)
      }
    }
  }
  if (check.present) {
    const re = new RegExp(check.present.pattern)
    for (const f of check.present.files) {
      let text = ''
      try {
        text = await readFile(join(root, f), 'utf8')
      } catch {
        failures.push(`missing file: ${f}`)
        continue
      }
      if (!re.test(text)) failures.push(`not found: ${check.present.pattern} in ${f}`)
    }
  }
  return failures
}

async function walkFiles(path: string): Promise<string[]> {
  let info
  try {
    info = await stat(path)
  } catch {
    return []
  }
  if (info.isFile()) return [path]
  const out: string[] = []
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const child = join(path, e.name)
    if (e.isDirectory()) out.push(...(await walkFiles(child)))
    else if (e.isFile()) out.push(child)
  }
  return out
}

