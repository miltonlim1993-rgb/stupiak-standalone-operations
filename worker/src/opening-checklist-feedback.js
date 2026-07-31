function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value || {}))
}

function findSection(config, id) {
  return (config.sections || []).find((section) => String(section.id || '') === id)
}

function findPhotoGroup(config, id) {
  return (config.photo_groups || []).find((group) => String(group.id || '') === id)
}

export function applyOpeningChecklistFeedback(template, config) {
  const templateId = String(template?.id || '')
  const checklistKey = String(config?.checklist_key || '')
  if (templateId !== 'tmpl-rr-opening-checklist-v3' && checklistKey !== 'opening') return config

  const next = cloneConfig(config)
  next.version = Math.max(2, Number(next.version || 1))
  next.schedule = {
    ...(next.schedule || {}),
    due_time: '12:00',
    due_day_offset: 0,
    lock_time: '12:15',
    lock_day_offset: 0,
  }

  const drinks = findSection(next, 'drinks')
  if (drinks) {
    drinks.name_cn = drinks.name_cn || '饮料准备'
    drinks.name_en = drinks.name_en || 'Drink Preparation'
    drinks.items = Array.isArray(drinks.items) ? drinks.items : []
    if (!drinks.items.some((item) => String(item.id || '') === 'op-29-description')) {
      drinks.items.push({
        id: 'op-29-description',
        name: 'Tea pot quantity & standby description',
        name_cn: '茶壶数量与备用状态说明',
        name_en: 'Tea pot quantity & standby description',
        instruction: 'Photograph the yellow tea pots, then state the quantity and standby condition for Thai milk tea, Thai green tea and Earl Grey. Also state the chocolate pack quantity.',
        instruction_cn: '拍黄色茶壶整体照，然后写明 Thai milk tea、Thai green tea、Earl Grey 各有几壶／几 set、是否达到备用数量，并注明 Chocolate 有多少包。',
        instruction_en: 'Photograph the yellow tea pots, then state the quantity and standby condition for Thai milk tea, Thai green tea and Earl Grey. Also state the chocolate pack quantity.',
        response_type: 'TEXT',
        required: true,
        placeholder: 'Example: Milk tea 2 pots ready; green tea 2 pots ready; Earl Grey 1 pot ready; chocolate 1 pack.',
        placeholder_cn: '例：奶茶 2 壶 Ready；绿茶 2 壶 Ready；Earl Grey 1 壶 Ready；Chocolate 1 包。',
        photo_group_id: 'opening-drinks',
        corrective_action_on_fail: false,
      })
    }
  }

  const frozen = findPhotoGroup(next, 'opening-frozen')
  if (frozen) {
    frozen.min_photos = 1
    frozen.max_photos = 4
    frozen.sample_caption = 'Use up to four photos when needed. Clearly show pork, beef and chicken patties, hash brown, popcorn, yuzu items and fries, with quantities and storage condition visible.'
    frozen.sample_caption_cn = '需要时可拍最多 4 张。清楚拍到猪肉、牛肉和鸡肉 Patty、Hash Brown、Popcorn、Yuzu 食材及薯条，并让数量和储存状态看得见。'
    frozen.sample_caption_en = frozen.sample_caption
  }

  const drinkPhotos = findPhotoGroup(next, 'opening-drinks')
  if (drinkPhotos) {
    drinkPhotos.min_photos = 1
    drinkPhotos.max_photos = 3
    drinkPhotos.sample_caption = 'Photograph the yellow tea pots together from an angle that shows the number of pots and visible fill level. Include the chocolate standby pack when possible, then complete the quantity description above.'
    drinkPhotos.sample_caption_cn = '把黄色茶壶一起拍入镜，角度要看得到茶壶数量和可见液面；可以的话也拍到 Chocolate 备用包，然后填写上面的数量说明。'
    drinkPhotos.sample_caption_en = drinkPhotos.sample_caption
  }

  return next
}
