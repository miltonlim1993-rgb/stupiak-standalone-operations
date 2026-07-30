export const TRAINING_QUESTION_RANDOM_VERSION = '4.6.30-random-50-v31'

export function shuffleQuestions(rows, random = Math.random) {
  const copy = [...(Array.isArray(rows) ? rows : [])]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = copy[index]
    copy[index] = copy[swapIndex]
    copy[swapIndex] = current
  }
  return copy
}

export function randomizeTrainingQuestions(rows, maxQuestions = 50, random = Math.random) {
  const groups = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const quizId = String(row?.quiz_id || '')
    if (!groups.has(quizId)) groups.set(quizId, [])
    groups.get(quizId).push(row)
  }

  const limit = Math.max(1, Number(maxQuestions) || 50)
  return [...groups.values()].flatMap((group) => shuffleQuestions(group, random)
    .slice(0, limit)
    .map((row, index) => ({
      ...row,
      question_order: index + 1,
    })))
}
