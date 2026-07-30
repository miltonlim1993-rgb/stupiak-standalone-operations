import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  randomizeTrainingQuestions,
  TRAINING_QUESTION_RANDOM_VERSION,
} from '../../web/src/lib/training-question-random-core-v31.js'

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('random training selector keeps up to 50 questions per quiz and renumbers them', () => {
  const rows = [
    ...Array.from({ length: 70 }, (_, index) => ({ id: `a-${index + 1}`, quiz_id: 'quiz-a', question_order: index + 1 })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `b-${index + 1}`, quiz_id: 'quiz-b', question_order: index + 1 })),
  ]

  const result = randomizeTrainingQuestions(rows, 50, () => 0.37)
  const quizA = result.filter((row) => row.quiz_id === 'quiz-a')
  const quizB = result.filter((row) => row.quiz_id === 'quiz-b')

  assert.equal(TRAINING_QUESTION_RANDOM_VERSION, '4.6.30-random-50-v31')
  assert.equal(quizA.length, 50)
  assert.equal(quizB.length, 3)
  assert.equal(new Set(quizA.map((row) => row.id)).size, 50)
  assert.deepEqual(quizA.map((row) => row.question_order), Array.from({ length: 50 }, (_, index) => index + 1))
  assert.deepEqual(quizB.map((row) => row.question_order), [1, 2, 3])
})

test('runtime installs randomized question loading before Training renders', () => {
  const runtime = read('web/src/lib/training-question-random-v31.js')
  const main = read('web/src/main.jsx')
  const baseline = JSON.parse(read('config/training-content-baseline-v31.json'))

  assert.match(runtime, /randomizeTrainingQuestions\(await originalList\(\.\.\.args\), 50\)/)
  assert.match(main, /installTrainingQuestionRandomV31\(\)/)
  assert.match(main, /trainingQuestionBank: 'random-up-to-50-v31'/)
  assert.equal(baseline.sop.activeStepCount, 12)
  assert.equal(baseline.course.questionBankSize, 70)
  assert.equal(baseline.course.questionsPerAttempt, 50)
  assert.deepEqual(baseline.visualStatus.missingNewScenarioImages, 4)
})
