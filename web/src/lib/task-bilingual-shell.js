const TEXT = new Map([
  ['Tasks', '任务 / Tasks'],
  ['Morning', '早班 / Morning'],
  ['Evening', '晚班 / Evening'],
  ['All', '全部 / All'],
  ['Morning Shift', '早班 / Morning Shift'],
  ['Evening Shift', '晚班 / Evening Shift'],
  ['Night Shift', '晚班 / Night Shift'],
  ['Current Shift', '当前班次 / Current Shift'],
  ['Daily Operations', '日常营业 / Daily Operations'],
  ['Server-time controlled', '服务器时间控制 / Server-time controlled'],
  ['Morning Tasks Progress', '早班任务进度 / Morning Tasks Progress'],
  ['Evening Tasks Progress', '晚班任务进度 / Evening Tasks Progress'],
  ['All Tasks Progress', '全部任务进度 / All Tasks Progress'],
  ['Pending', '待完成 / Pending'],
  ['Locked', '未开放 / Locked'],
  ['In Progress', '进行中 / In Progress'],
  ['Completed', '已完成 / Completed'],
  ['Issues', '异常 / Issues'],
  ['Issue', '异常 / Issue'],
  ['Overdue', '逾期 / Overdue'],
  ['Start Task', '开始任务 / Start Task'],
  ['Open Task', '打开任务 / Open Task'],
  ['No tasks are configured for this shift.', '当前班次没有配置任务 / No tasks are configured for this shift.'],
  ['Select another shift or refresh the task list.', '请选择其他班次或刷新任务列表 / Select another shift or refresh the task list.'],
  ['Instruction', '操作说明 / Instruction'],
  ['Completion Standard', '完成标准 / Completion Standard'],
  ['Photo Requirement', '照片要求 / Photo Requirement'],
  ['Photo Required', '必须拍照 / Photo Required'],
  ['Photo Required for Issues', '出现异常时必须拍照 / Photo Required for Issues'],
  ['No Photo Required', '不需要照片 / No Photo Required'],
  ['Task Photos', '任务照片 / Task Photos'],
  ['Issue Photo', '异常照片 / Issue Photo'],
  ['At least one on-site photo is required when reporting an issue.', '报告异常时至少需要一张现场照片 / At least one on-site photo is required when reporting an issue.'],
  ['Take Issue Photo', '拍摄异常照片 / Take Issue Photo'],
  ['Completion Notes', '完成备注 / Completion Notes'],
  ['Save Progress', '保存进度 / Save Progress'],
  ['Complete', '完成任务 / Complete'],
  ['Report Issue', '报告异常 / Report Issue'],
  ['Unable', '无法完成 / Unable'],
  ['Unable to Complete', '无法完成 / Unable to Complete'],
  ['Issue Reported', '已报告异常 / Issue Reported'],
  ['Step completed', '步骤已完成 / Step Completed'],
  ['Take Photo', '拍照 / Take Photo'],
  ['Retake / Add Photo', '重拍／添加照片 / Retake / Add Photo'],
  ['Ready', '已准备 / Ready'],
  ['Short', '不足 / Short'],
  ['N/A', '不适用 / N/A'],
  ['Good', '正常 / Good'],
  ['Action Taken', '已处理 / Action Taken'],
  ['Not Needed', '无需处理 / Not Needed'],
  ['Done', '完成 / Done'],
  ['Cleaned', '已清洁 / Cleaned'],
  ['Needs Attention', '需要处理 / Needs Attention'],
  ['Pass', '通过 / Pass'],
  ['Fail', '不通过 / Fail'],
  ['Frozen', '冷冻 / Frozen'],
  ['Chilled', '冷藏 / Chilled'],
  ['Room Temperature', '室温 / Room Temperature'],
  ['Defrosting', '解冻中 / Defrosting'],
  ['Incorrect Storage', '储存错误 / Incorrect Storage'],
])

const PLACEHOLDERS = new Map([
  ['Remark', '备注 / Remark'],
  ['Corrective action', '处理方式 / Corrective Action'],
  ['Actual temperature', '实际温度 / Actual Temperature'],
  ['Actual quantity', '实际数量 / Actual Quantity'],
])

function onTaskPage() {
  return window.location.pathname === '/tasks'
}

function translatedDynamic(source) {
  const trimmed = String(source || '').trim()
  const exact = TEXT.get(trimmed)
  if (exact) return exact

  const completed = trimmed.match(/^(\d+)\s*\/\s*(\d+)\s+completed$/i)
  if (completed) return `已完成 ${completed[1]} / ${completed[2]} · Completed ${completed[1]} / ${completed[2]}`

  const required = trimmed.match(/^(\d+)\s*\/\s*(\d+)\s+Required$/i)
  if (required) return `${required[1]}/${required[2]} 必拍 / Required`

  const available = trimmed.match(/^Available after\s+(\d{1,2}:\d{2})$/i)
  if (available) return `${available[1]} 后开放 / Available after ${available[1]}`

  return ''
}

function replaceTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return
  const source = String(node.nodeValue || '')
  const translated = translatedDynamic(source)
  if (!translated) return
  const leading = source.match(/^\s*/)?.[0] || ''
  const trailing = source.match(/\s*$/)?.[0] || ''
  node.nodeValue = `${leading}${translated}${trailing}`
}

function replaceLeafElement(element) {
  if (!(element instanceof Element) || element.children.length) return
  const source = String(element.textContent || '')
  const translated = translatedDynamic(source)
  if (translated && source.trim() !== translated) element.textContent = translated
}

function normalizeElement(element) {
  if (!(element instanceof Element)) return
  for (const input of element.matches('input, textarea') ? [element] : element.querySelectorAll('input, textarea')) {
    const translated = PLACEHOLDERS.get(String(input.getAttribute('placeholder') || '').trim())
    if (translated) input.setAttribute('placeholder', translated)
  }

  replaceLeafElement(element)
  for (const leaf of element.querySelectorAll('*')) replaceLeafElement(leaf)

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    replaceTextNode(node)
    node = walker.nextNode()
  }
}

function apply() {
  if (!onTaskPage()) return
  const root = document.querySelector('#root')
  if (root) normalizeElement(root)
}

export function installTaskBilingualShell() {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return

  const observer = new MutationObserver((records) => {
    if (!onTaskPage()) return
    for (const record of records) {
      if (record.type === 'characterData') replaceTextNode(record.target)
      for (const node of record.addedNodes || []) {
        if (node.nodeType === Node.TEXT_NODE) replaceTextNode(node)
        else if (node instanceof Element) normalizeElement(node)
      }
    }
  })

  const start = () => {
    apply()
    if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  window.addEventListener('popstate', () => queueMicrotask(apply))
  window.addEventListener('hashchange', () => queueMicrotask(apply))
}
