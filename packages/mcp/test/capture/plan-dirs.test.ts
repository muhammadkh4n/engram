import { describe, expect, it } from 'vitest'
import { dropHeredocs, planDirsAfter, planRefs } from '../../src/capture/plan-dirs.js'

function call(input: Record<string, unknown>, name = 'Bash') {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name, input }] } }
}

const after = (entry: unknown, dirs: string[] = []) => planDirsAfter(entry, dirs)

describe('planDirsAfter', () => {
  it('counts only tool_use inputs; user text and tool results naming a plan do not', () => {
    expect(after({ type: 'user', message: { content: 'look at Plans/Active/tst-fourth/status.md' } })).toEqual([])
    expect(
      after({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Plans/Delivered/tst-other/status.md' }] } }),
    ).toEqual([])
    expect(after({ type: 'attachment', attachment: { content: 'Plans/Design Records/tst-third/status.md' } })).toEqual([])
    expect(after(call({ file_path: '/notes/Alpha/Plans/Active/tst-plan/status.md' }, 'Read'))).toEqual(['Active/tst-plan'])
  })

  it('reads both spellings as the same folder', () => {
    expect(after(call({ command: 'ls ~/work/plans/Active/tst-plan' }))).toEqual(['Active/tst-plan'])
    expect(after(call({ pattern: 'x', path: 'Plans/Active/tst-plan' }, 'Grep'))).toEqual(['Active/tst-plan'])
  })

  it('takes an edit plan from the file it edits, not from its text', () => {
    const ledger = '/notes/Alpha/Plans/Active/tst-plan/status.md'
    expect(
      after(call({ file_path: ledger, old_string: 'Plans/Design Records/tst-third', new_string: 'plans/Delivered/tst-other' }, 'Edit')),
    ).toEqual(['Active/tst-plan'])
    expect(after(call({ file_path: ledger, edits: [{ old_string: 'a', new_string: 'Plans/Active/tst-fourth' }] }, 'MultiEdit'))).toEqual([
      'Active/tst-plan',
    ])
  })

  it('ignores text bodies: Write content, an agent prompt, a description, any other key', () => {
    expect(after(call({ file_path: '/tmp/notes.md', content: 'see Plans/Delivered/tst-other' }, 'Write'))).toEqual([])
    expect(after(call({ prompt: 'read plans/Active/tst-fourth/status.md', description: 'Plans/Design Records/tst-third' }, 'Agent'))).toEqual([])
    expect(after(call({ command: 'true', description: 'check Plans/Delivered/tst-other' }))).toEqual([])
    expect(after(call({ query: 'Plans/Active/tst-plan' }, 'mcp__memory__recall'))).toEqual([])
    expect(after(call({ pattern: 'Plans/Delivered/tst-other' }, 'Glob'))).toEqual([])
  })

  it('counts path-bearing fields: file_path, path, notebook_path, paths and a Bash command', () => {
    expect(after(call({ pattern: '*.md', path: 'Plans/Design Records/tst-third' }, 'Glob'))).toEqual(['Design Records/tst-third'])
    expect(after(call({ command: 'cat plans/Active/tst-fourth/status.md' }))).toEqual(['Active/tst-fourth'])
    expect(after(call({ notebook_path: 'Plans/Active/tst-plan/x.ipynb' }, 'NotebookEdit'))).toEqual(['Active/tst-plan'])
    expect(after(call({ paths: ['Plans/Active/tst-plan/a.md', 'Plans/Delivered/tst-other/b.md'] }, 'mcp__vault__read_many'))).toEqual([
      'Delivered/tst-other',
      'Active/tst-plan',
    ])
  })

  it('reads a command field only on a Bash call', () => {
    expect(after(call({ command: 'cat Plans/Active/tst-plan/status.md' }, 'mcp__runner__exec'))).toEqual([])
  })

  it('puts the newest plan first, keeps earlier ones and holds at most 3', () => {
    let dirs: string[] = []
    for (const slug of ['tst-plan', 'tst-other', 'tst-third', 'tst-fourth']) {
      dirs = after(call({ command: `ls Plans/Active/${slug}` }), dirs)
    }
    expect(dirs).toEqual(['Active/tst-fourth', 'Active/tst-third', 'Active/tst-other'])
    expect(after(call({ command: 'ls Plans/Active/tst-other' }), dirs)).toEqual([
      'Active/tst-other',
      'Active/tst-fourth',
      'Active/tst-third',
    ])
    const unchanged = after({ type: 'assistant', message: { content: [{ type: 'text', text: 'Plans/Active/tst-plan' }] } }, dirs)
    expect(unchanged).toEqual(dirs)
    expect(unchanged).not.toBe(dirs)
  })
})

describe('dropHeredocs', () => {
  const plansOf = (command: string) => planRefs(dropHeredocs(command))

  it('drops a heredoc body; the command line around it still counts', () => {
    expect(plansOf("cat <<'EOF' > Plans/Active/tst-plan/status.md\nsee Plans/Delivered/tst-other\nEOF")).toEqual(['Active/tst-plan'])
    expect(plansOf('cat <<EOF\nPlans/Delivered/tst-other\nEOF\nls Plans/Active/tst-plan')).toEqual(['Active/tst-plan'])
    expect(plansOf('cat <<-EOF\n\tPlans/Delivered/tst-other\n\tEOF\nls Plans/Active/tst-plan')).toEqual(['Active/tst-plan'])
    expect(plansOf('git commit -F - <<"MSG"\nPlans/Delivered/tst-other\nMSG')).toEqual([])
    expect(plansOf('cat <<EOF\nEOF\nls Plans/Active/tst-plan')).toEqual(['Active/tst-plan'])
    expect(plansOf('cat <<< Plans/Active/tst-plan')).toEqual(['Active/tst-plan'])
  })

  it('opens a heredoc with a backslash-quoted word', () => {
    expect(plansOf('cat <<\\EOF\nPlans/Delivered/tst-other\nEOF\nls Plans/Active/tst-plan')).toEqual(['Active/tst-plan'])
    expect(plansOf('cat <<-\\EOF\n\tPlans/Delivered/tst-other\n\tEOF\nls Plans/Active/tst-plan')).toEqual(['Active/tst-plan'])
  })

  it('counts a heredoc only when a later line closes it; a shift operator leaves the command whole', () => {
    expect(plansOf("python3 -c 'x = 1 << n\nprint(x)' && cat plans/Active/tst-plan/status.md")).toEqual(['Active/tst-plan'])
    expect(plansOf("python3 - <<'EOF'\nPlans/Delivered/tst-other\nnever closed")).toEqual(['Delivered/tst-other'])
    expect(plansOf('cat <<-EOF\n\tPlans/Delivered/tst-other\n  EOF')).toEqual(['Delivered/tst-other'])
    expect(plansOf("cat <<A <<'B'\nPlans/Delivered/tst-other\nA\nPlans/Delivered/tst-other\nB\nls Plans/Active/tst-plan")).toEqual([
      'Active/tst-plan',
    ])
  })

  it('scans a command line full of shift operators without blowing up', () => {
    expect(plansOf(`${'a << b '.repeat(20_000)}\nls Plans/Active/tst-plan`)).toEqual(['Active/tst-plan'])
  })
})
