import type { Task } from './tasks.js'

/**
 * Tasks for tests/harness/corpora/story.
 *
 * The workspace is that directory alone, not this repository, so the answer
 * key never sits beside the code. Selected with `node tests/harness/run.mjs
 * --corpus story`. They are not part of the default task set.
 */
export const STORY_TASKS: Task[] = [
  {
    id: 'story-locate-exits',
    family: 'locate',
    prompt: 'Where is the table of rooms, including which way north and south lead?',
    paths: ['engine.c'],
    symbols: ['rooms', 'north']
  },
  {
    id: 'story-explain-wall',
    family: 'explain',
    prompt: 'Why does going south from the cell fail?',
    phrases: [['-1'], ['wall']]
  },
  {
    id: 'story-fix-north',
    family: 'small-fix',
    mode: 'edit',
    prompt:
      'Going north from the cell should enter the hall. It currently says you cannot go that way. Fix engine.c. Do not add files.',
    mutate: {
      file: 'engine.c',
      find: '{ "cell", "You wake in a small, dark room. A door is to the north.", 1, -1 },',
      replace: '{ "cell", "You wake in a small, dark room. A door is to the north.", -1, -1 },'
    },
    expectFiles: ['engine.c'],
    check: {
      program: {
        sources: ['engine.c'],
        input: 'north\nquit\n',
        includes: 'A short hall.'
      }
    }
  }
]
