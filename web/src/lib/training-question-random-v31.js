import { opsClient } from '@/api/opsClient'
import {
  randomizeTrainingQuestions,
  TRAINING_QUESTION_RANDOM_VERSION,
} from '@/lib/training-question-random-core-v31'

export { TRAINING_QUESTION_RANDOM_VERSION }

export function installTrainingQuestionRandomV31() {
  const entity = opsClient?.entities?.TrainingQuestion
  if (!entity?.list || entity.list.__stupiaksRandomQuestionV31) return

  const originalList = entity.list.bind(entity)
  const randomList = async (...args) => randomizeTrainingQuestions(await originalList(...args), 50)
  randomList.__stupiaksRandomQuestionV31 = true
  entity.list = randomList
}
