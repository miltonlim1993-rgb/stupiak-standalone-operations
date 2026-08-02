import { errorResponse } from './http.js'
import {
  handleD1PrinterProfileApi,
  handleD1PrinterProfileEntity,
} from './label-d1-printer.js'
import {
  handleD1CreateLabel,
  handleD1FinishSource,
  handleD1LabelCatalog,
  handleD1ReprintLabel,
} from './label-d1-operations.js'

export async function handleD1Labels(request, env, url) {
  const handlers = [
    handleD1PrinterProfileEntity,
    handleD1LabelCatalog,
    handleD1PrinterProfileApi,
    handleD1CreateLabel,
    handleD1ReprintLabel,
    handleD1FinishSource,
  ]
  try {
    for (const handler of handlers) {
      const response = await handler(request, env, url)
      if (response) return response
    }
    return null
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
