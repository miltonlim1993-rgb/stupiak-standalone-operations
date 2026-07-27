import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const taskPath = fileURLToPath(
  new URL(
    '../../web/src/pages/TasksV3.jsx',
    import.meta.url,
  ),
)

const dashboardPath = fileURLToPath(
  new URL(
    '../../web/src/pages/DashboardV3.jsx',
    import.meta.url,
  ),
)

test(
  'Task content always shows bilingual Sheet fields without a selector',
  () => {
    const source = readFileSync(taskPath, 'utf8')

    assert.match(
      source,
      /const language = 'bilingual'/,
    )

    assert.match(
      source,
      /cn=\{title\.cn\} en=\{title\.en\} mode=\{language\}/,
    )

    assert.match(
      source,
      /cn=\{item\.instruction_cn\}[\s\S]*?mode=\{language\}/,
    )

    assert.match(
      source,
      /cn=\{item\.completion_standard_cn\}[\s\S]*?mode=\{language\}/,
    )

    assert.doesNotMatch(
      source,
      /LanguageButton/,
    )

    assert.doesNotMatch(
      source,
      /Content: EN/,
    )

    assert.doesNotMatch(
      source,
      /Content: 中文/,
    )

    assert.doesNotMatch(
      source,
      /chefops\.task\.content-language/,
    )

    assert.doesNotMatch(
      source,
      /localStorage\.setItem/,
    )
  },
)

test(
  'Task system shell remains English while progress title is dynamic',
  () => {
    const source = readFileSync(taskPath, 'utf8')

    assert.match(
      source,
      />Tasks<\/h1>/,
    )

    assert.match(
      source,
      /\{meta\.en\} Tasks Progress/,
    )

    assert.match(
      source,
      /mode="en"/,
    )

    assert.match(
      source,
      />Start Task<\/span>/,
    )

    assert.match(
      source,
      />Open Task<\/span>/,
    )

    assert.match(
      source,
      />Save Progress<\/span>/,
    )

    assert.match(
      source,
      />Complete<\/span>/,
    )
  },
)

test(
  'Dashboard task summary remains English',
  () => {
    const source = readFileSync(
      dashboardPath,
      'utf8',
    )

    assert.match(source, /Morning Shift/)
    assert.match(source, /Evening Shift/)
    assert.match(source, /Today’s Tasks/)
    assert.match(source, /Issues \/ Overdue/)

    assert.doesNotMatch(
      source,
      /[\u3400-\u9fff]/,
    )
  },
)
