import assert from 'node:assert/strict'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyCount, duplicateCounts, removeModelAndProjector, removeModelFile, type LibraryFile } from '../../src/main/library.js'

let n = 0
const ok = (label: string) => {
  n += 1
  console.log('  ok', label)
}

const root = join(tmpdir(), `lowerbeam-library-${process.pid}`)
await mkdir(root, { recursive: true })

console.log('copies across folders')
{
  const files: LibraryFile[] = [
    { path: '/a/model.gguf', fileName: 'model.gguf', fileSize: 10 },
    { path: '/b/model.gguf', fileName: 'model.gguf', fileSize: 10 },
    { path: '/c/other.gguf', fileName: 'other.gguf', fileSize: 10 }
  ]
  const counts = duplicateCounts(files)
  assert.equal(copyCount(files[0]!, counts), 2)
  assert.equal(copyCount(files[2]!, counts), 1)
  ok('the same name and size count as copies, a different name does not')
}

console.log('\ndeleting a library file')
{
  const dir = join(root, 'models')
  const elsewhere = join(root, 'outside')
  await mkdir(dir, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  const file = join(dir, 'plain.gguf')
  await writeFile(file, 'abcdefghij')
  const freed = await removeModelFile(file, [file], [dir])
  assert.equal(freed, 10)
  await assert.rejects(() => removeModelFile(file, [file], [dir]))
  ok('a normal file is unlinked and its size is what was freed')

  const blob = join(dir, 'blob')
  const link = join(dir, 'linked.gguf')
  const other = join(dir, 'again.gguf')
  await writeFile(blob, '0123456789')
  await symlink(blob, link)
  await symlink(blob, other)
  const kept = await removeModelFile(link, [link, other], [dir])
  assert.equal(kept, 0)
  const gone = await removeModelFile(other, [other], [dir])
  assert.equal(gone, 10)
  await assert.rejects(() => stat(blob))
  ok('a shared blob stays until the last link inside the library is removed')

  const outside = join(elsewhere, 'secret')
  const alias = join(dir, 'alias.gguf')
  await writeFile(outside, 'secret-bytes')
  await symlink(outside, alias)
  const skipped = await removeModelFile(alias, [alias], [dir])
  assert.equal(skipped, 0)
  assert.equal(await readFile(outside, 'utf8'), 'secret-bytes')
  ok('a link whose target is outside the scanned folders does not delete that target')

  await assert.rejects(
    () => removeModelFile(join(dir, 'missing.gguf'), [file], [dir]),
    /not in the model library/
  )
  ok('a path the scan did not return is refused')
}

console.log('\na vision projector goes with its model')
{
  const dir = join(root, 'vision')
  await mkdir(dir, { recursive: true })
  const model = join(dir, 'See.gguf')
  const projector = join(dir, 'mmproj-See.gguf')
  const shared = join(dir, 'mmproj-Shared.gguf')
  const other = join(dir, 'Also.gguf')
  const third = join(dir, 'Third.gguf')
  await writeFile(model, 'model-bytes')
  await writeFile(projector, 'proj-bytes!')
  await writeFile(shared, 'shared-proj')
  await writeFile(other, 'other-model')
  await writeFile(third, 'third-model')
  const paired = [
    { path: model, projectorPath: projector },
    { path: other, projectorPath: shared },
    { path: third, projectorPath: shared }
  ]
  const freed = await removeModelAndProjector(model, paired, [dir])
  assert.equal(freed, 'model-bytes'.length + 'proj-bytes!'.length)
  await assert.rejects(() => stat(model))
  await assert.rejects(() => stat(projector))
  assert.equal(await readFile(shared, 'utf8'), 'shared-proj')
  ok('the paired projector is unlinked with the model')

  const second = await removeModelAndProjector(other, [
    { path: other, projectorPath: shared },
    { path: third, projectorPath: shared }
  ], [dir])
  assert.equal(second, 'other-model'.length)
  await assert.rejects(() => stat(other))
  assert.equal(await readFile(shared, 'utf8'), 'shared-proj')
  ok('a projector another model still names is left on disk')

  const last = await removeModelAndProjector(third, [{ path: third, projectorPath: shared }], [dir])
  await assert.rejects(() => stat(third))
  await assert.rejects(() => stat(shared))
  assert.equal(last, 'third-model'.length + 'shared-proj'.length)
  ok('the projector is removed with the last model that uses it')

  const blob = join(dir, 'mmproj-blob')
  const link = join(dir, 'mmproj-Linked.gguf')
  const linkedModel = join(dir, 'Linked.gguf')
  await writeFile(blob, 'blob-bytes')
  await writeFile(linkedModel, 'linked-model')
  await symlink(blob, link)
  const viaLink = await removeModelAndProjector(linkedModel, [{ path: linkedModel, projectorPath: link }], [dir])
  assert.equal(viaLink, 'linked-model'.length + 'blob-bytes'.length)
  await assert.rejects(() => stat(link))
  await assert.rejects(() => stat(blob))
  ok('a projector symlink and its blob inside a scanned folder are both removed')
}

console.log(`\n${n} assertions passed`)
