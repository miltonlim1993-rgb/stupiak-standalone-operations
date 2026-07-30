import { opsClient } from '@/api/opsClient'

export const TRAINING_QUESTION_RANDOM_VERSION = '4.6.30-random-50-v31'

function shuffle(rows) {
  const copy = [...rows]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const current = copy[index]
    copy[index] = copy[swapIndex]
    copy[swapIndex] = current
  }
  return copy
}

export function randomizeTrainingQuestions(rows, maxQuestions = 50) {
  const groups = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const quizId = String(row?.quiz_id || '')
    if (!groups.has(quizId)) groups.set(quizId, [])
    groups.get(quizId).push(row)
  }

  return [...groups.values()].flatMap((group) => shuffle(group)
    .slice(0, Math.max(1, Number(maxQuestions) || 50))
    .map((row, index) => ({
      ...row,
      question_order: index + 1,
    })))
}

export function installTrainingQuestionRandomV31() {
  const entity = opsClient?.entities?.TrainingQuestion
  if (!entity?.list || entity.list.__stupiaksRandomQuestionV31) return

  const originalList = entity.list.bind(entity)
  const randomList = async (...args) => randomizeTrainingQuestions(await originalList(...args), 50)
  randomList.__stupiaksRandomQuestionV31 = true
  entity.list = randomList
}
