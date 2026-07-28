import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTaskBilingual } from '../src/task-bilingual-v5.js'

test('opening task receives Chinese and English for legacy English-only rows', () => {
  const task = normalizeTaskBilingual({
    id: 'task-opening',
    title: 'Opening Preparation Check',
    description: 'Check opening stock.',
    config: {
      checklist_key: 'opening',
      title_cn: '开档备料检查',
      title_en: 'Opening Preparation Check',
      instruction_cn: '按开档表检查。',
      instruction_en: 'Check the opening list.',
      completion_standard_cn: '达到开档标准。',
      completion_standard_en: 'Meet the opening standard.',
      sections: [
        {
          id: 'sauce',
          name: 'Sauce',
          items: [
            {
              id: 'op-01',
              name: 'Cheese sauce x 4b',
              instruction: 'Room temperature or chiller',
              response_type: 'STATUS',
              options: ['Ready', 'Short', 'N/A'],
            },
          ],
        },
      ],
      photo_groups: [
        {
          id: 'opening-sauce',
          name: 'Sauce Setup',
          sample_caption: 'Show sauce setup.',
        },
      ],
    },
  })

  assert.equal(task.bilingual_content, true)
  assert.equal(task.display.task_name_cn, '开档备料检查')
  assert.equal(task.display.task_name_en, 'Opening Preparation Check')
  assert.equal(task.config.sections[0].name_cn, '酱料')
  assert.equal(task.config.sections[0].name_en, 'Sauces')
  assert.equal(task.config.sections[0].items[0].name_cn, '芝士酱 × 4瓶')
  assert.equal(task.config.sections[0].items[0].name_en, 'Cheese Sauce × 4 Bottles')
  assert.match(task.config.sections[0].items[0].instruction_cn, /至少准备4瓶/)
  assert.match(task.config.sections[0].items[0].instruction_en, /at least 4 bottles/)
  assert.equal(task.config.photo_groups[0].name_cn, '酱料准备')
  assert.equal(task.config.photo_groups[0].name_en, 'Sauce Setup')
})

test('already bilingual task content is preserved', () => {
  const task = normalizeTaskBilingual({
    id: 'task-toilet',
    config: {
      checklist_key: 'toilet-full-cleaning',
      title_cn: '厕所完整清洁',
      title_en: 'Toilet Full Cleaning',
      instruction_cn: '按照步骤完成。',
      instruction_en: 'Complete every step.',
      sections: [
        {
          id: 'toilet',
          name_cn: '完整清洁步骤',
          name_en: 'Full Cleaning Steps',
          items: [
            {
              id: 'tf-01',
              name_cn: '清洁洗手盆与镜子',
              name_en: 'Clean Basin and Mirror',
              instruction_cn: '清洁并消毒。',
              instruction_en: 'Clean and sanitize.',
            },
          ],
        },
      ],
    },
  })

  assert.equal(task.config.title_cn, '厕所完整清洁')
  assert.equal(task.config.title_en, 'Toilet Full Cleaning')
  assert.equal(task.config.sections[0].items[0].name_cn, '清洁洗手盆与镜子')
  assert.equal(task.config.sections[0].items[0].name_en, 'Clean Basin and Mirror')
})
