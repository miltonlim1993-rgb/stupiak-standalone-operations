function clean(value = '') {
  return String(value ?? '').trim()
}

const OPENING_SECTIONS = {
  sauce: { cn: '酱料', en: 'Sauces' },
  material: { cn: '基础食材', en: 'Materials' },
  frozen: { cn: '肉饼与冷冻品', en: 'Patties and Frozen Items' },
  packaging: { cn: '堂食包装', en: 'Dine-in Packaging' },
  drinks: { cn: '饮料准备', en: 'Drink Preparation' },
  powder: { cn: '粉类与 Premix', en: 'Powders and Premixes' },
}

const OPENING_ITEMS = {
  'op-01': ['芝士酱 × 4瓶', 'Cheese Sauce × 4 Bottles', '室温或冷藏保存；确认至少准备4瓶。', 'Store at room temperature or chilled; confirm at least 4 bottles are ready.'],
  'op-02': ['美乃滋酱 × 4瓶', 'Mayo Sauce × 4 Bottles', '室温或冷藏保存；确认至少准备4瓶。', 'Store at room temperature or chilled; confirm at least 4 bottles are ready.'],
  'op-03': ['咖喱酱 × 2瓶', 'Curry Sauce × 2 Bottles', '室温或冷藏保存；确认至少准备2瓶。', 'Store at room temperature or chilled; confirm at least 2 bottles are ready.'],
  'op-04': ['Ogoma 酱 × 2瓶', 'Ogoma Sauce × 2 Bottles', '室温或冷藏保存；确认至少准备2瓶。', 'Store at room temperature or chilled; confirm at least 2 bottles are ready.'],
  'op-05': ['Yuzu 酱 × 2瓶', 'Yuzu Sauce × 2 Bottles', '室温或冷藏保存；确认至少准备2瓶。', 'Store at room temperature or chilled; confirm at least 2 bottles are ready.'],
  'op-06': ['SSS 酱 × 1瓶', 'SSS Sauce × 1 Bottle', '室温保存；确认至少准备1瓶。', 'Store at room temperature; confirm at least 1 bottle is ready.'],
  'op-07': ['人造牛油 × 2盒', 'Margarine × 2 Containers', '室温保存；确认至少准备2盒。', 'Store at room temperature; confirm at least 2 containers are ready.'],
  'op-08': ['片装芝士 × 1盒', 'Sliced Cheese × 1 Container', '室温或冷藏保存；确认至少准备1盒。', 'Store at room temperature or chilled; confirm at least 1 container is ready.'],
  'op-09': ['生菜 × 2盒或1容器', 'Lettuce × 2 Boxes or 1 Container', '室温或冷藏保存；确认达到开档备用量。', 'Store at room temperature or chilled; confirm the opening standby quantity is ready.'],
  'op-10': ['汉堡面包 × 20包', 'Burger Buns × 20 Packs', '确认至少准备20包。', 'Confirm at least 20 packs are ready.'],
  'op-11': ['猪肉饼 × 2盒', 'Pork Patties × 2 Containers', '按开档需求准备2盒并进行解冻。', 'Prepare 2 containers for opening and defrost as required.'],
  'op-11-storage': ['猪肉饼储存状态', 'Pork Patty Storage Condition', '选择当前实际储存或解冻状态。', 'Select the actual storage or defrosting condition.'],
  'op-12': ['牛肉饼 × 1盒', 'Beef Patties × 1 Container', '保持冷冻并按营业需要切分准备。', 'Keep frozen and portion or cut as required for service.'],
  'op-13': ['鸡肉饼 × 1盒', 'Chicken Patties × 1 Container', '保持冷冻并按营业需要切分准备。', 'Keep frozen and portion or cut as required for service.'],
  'op-14': ['Hash Brown × 2盒', 'Hash Browns × 2 Boxes', '冷冻保存；确认至少准备2盒。', 'Keep frozen; confirm at least 2 boxes are ready.'],
  'op-15': ['Popcorn Chicken × 4–6包', 'Popcorn Chicken × 4–6 Packs', '冷冻或冷藏保存；确认准备4至6包。', 'Keep frozen or chilled; confirm 4 to 6 packs are ready.'],
  'op-16': ['Spicy Popcorn Chicken × 4–6包', 'Spicy Popcorn Chicken × 4–6 Packs', '冷冻或冷藏保存；确认准备4至6包。', 'Keep frozen or chilled; confirm 4 to 6 packs are ready.'],
  'op-17': ['Yuzu Chicken × 4–6份', 'Yuzu Chicken × 4–6 Portions', '冷冻或冷藏保存；确认准备4至6份。', 'Keep frozen or chilled; confirm 4 to 6 portions are ready.'],
  'op-18': ['Spicy Yuzu Chicken × 4–6份', 'Spicy Yuzu Chicken × 4–6 Portions', '冷冻或冷藏保存；确认准备4至6份。', 'Keep frozen or chilled; confirm 4 to 6 portions are ready.'],
  'op-19': ['中份薯条', 'Medium Fries', '冷冻保存，并按营业需要尽量提前分装准备。', 'Keep frozen and prepare as much as practical for service.'],
  'op-20': ['大份薯条', 'Large Fries', '冷冻保存，并按营业需要尽量提前分装准备。', 'Keep frozen and prepare as much as practical for service.'],
  'op-21': ['Y500 黑色长方盒', 'Y500 Black Rectangular Container', '至少准备1包。', 'Prepare at least 1 pack.'],
  'op-22': ['Y750 黑色长方盒', 'Y750 Black Rectangular Container', '至少准备1包。', 'Prepare at least 1 pack.'],
  'op-23': ['单点包装', 'À La Carte Packaging', '按营业需要尽量提前准备。', 'Prepare as much as practical for service.'],
  'op-24': ['中份套餐包装', 'Medium Set Packaging', '按营业需要尽量提前准备。', 'Prepare as much as practical for service.'],
  'op-25': ['大份套餐包装', 'Large Set Packaging', '按营业需要尽量提前准备。', 'Prepare as much as practical for service.'],
  'op-26': ['泰式奶茶', 'Thai Milk Tea', '至少准备2套备用量。', 'Prepare at least 2 standby sets.'],
  'op-27': ['泰式绿茶', 'Thai Green Tea', '正常需求准备2套；非繁忙时段至少1套。', 'Prepare 2 sets for normal demand, or at least 1 set during non-busy periods.'],
  'op-28': ['伯爵茶', 'Earl Grey Tea', '准备1套；非繁忙时段至少半套。', 'Prepare 1 set, or at least half a set during non-busy periods.'],
  'op-29': ['巧克力饮料材料', 'Chocolate Drink Mix', '至少准备1包备用。', 'Prepare at least 1 standby pack.'],
  'op-30': ['盐 × 2瓶', 'Salt × 2 Bottles', '室温保存；确认至少准备2瓶。', 'Store at room temperature; confirm at least 2 bottles are ready.'],
  'op-31': ['黑胡椒粉 × 2瓶', 'Black Pepper × 2 Bottles', '室温保存；确认至少准备2瓶。', 'Store at room temperature; confirm at least 2 bottles are ready.'],
  'op-32': ['辣椒粉 × 2瓶', 'Chilli Powder × 2 Bottles', '室温保存；确认至少准备2瓶。', 'Store at room temperature; confirm at least 2 bottles are ready.'],
  'op-33': ['Yuzu 粉 × 1盒', 'Yuzu Powder × 1 Container', '室温保存；确认至少准备1盒。', 'Store at room temperature; confirm at least 1 container is ready.'],
  'op-34': ['Spicy Yuzu 粉 × 1盒', 'Spicy Yuzu Powder × 1 Container', '室温保存；确认至少准备1盒。', 'Store at room temperature; confirm at least 1 container is ready.'],
  'op-35': ['Yuzu Premix × 1盒', 'Yuzu Premix × 1 Container', '只可冷藏保存；确认至少准备1盒。', 'Chiller storage only; confirm at least 1 container is ready.'],
  'op-36': ['Spicy Yuzu Premix × 1盒', 'Spicy Yuzu Premix × 1 Container', '只可冷藏保存；确认至少准备1盒。', 'Chiller storage only; confirm at least 1 container is ready.'],
}

const OPENING_PHOTOS = {
  'opening-sauce': ['酱料准备', 'Sauce Setup', '拍摄全部已准备酱料，标签朝外并能看见数量。', 'Show all prepared sauces with labels facing out and quantities visible.'],
  'opening-material': ['基础食材准备', 'Material Setup', '拍摄人造牛油、片装芝士、生菜和汉堡面包的备用状态。', 'Show margarine, sliced cheese, lettuce and burger buns at the required standby level.'],
  'opening-frozen': ['肉饼与冷冻品准备', 'Patties and Frozen Items', '拍摄肉饼、Hash Brown、Popcorn Chicken、Yuzu Chicken 和薯条的准备与储存状态。', 'Show patties, hash browns, popcorn chicken, yuzu chicken and fries prepared and stored correctly.'],
  'opening-packaging': ['堂食包装准备', 'Dine-in Packaging', '拍摄 Y500、Y750 及套餐包装整齐备用。', 'Show Y500, Y750 and set packaging prepared neatly.'],
  'opening-drinks': ['饮料准备', 'Drink Preparation', '拍摄茶类和巧克力饮料材料的备用量。', 'Show tea and chocolate drink preparation at the standby quantity.'],
  'opening-powder': ['粉类与 Premix', 'Powders and Premixes', '拍摄粉类和 Premix 已补充、贴好标签并正确储存。', 'Show powders and premixes filled, labeled and stored correctly.'],
}

function pair(target, key, cn, en) {
  const chineseKey = `${key}_cn`
  const englishKey = `${key}_en`
  if (!clean(target[chineseKey]) && clean(cn)) target[chineseKey] = clean(cn)
  if (!clean(target[englishKey]) && clean(en)) target[englishKey] = clean(en)
  if (!clean(target[key]) && clean(target[englishKey])) target[key] = clean(target[englishKey])
  return target
}

function setPair(target, key, cn, en) {
  const chinese = clean(cn)
  const english = clean(en)
  if (chinese) target[`${key}_cn`] = chinese
  if (english) {
    target[`${key}_en`] = english
    target[key] = english
  }
  return target
}

function enrichOpening(config) {
  for (const section of config.sections || []) {
    const translatedSection = OPENING_SECTIONS[section.id]
    if (translatedSection) setPair(section, 'name', translatedSection.cn, translatedSection.en)
    else pair(section, 'name', section.name_cn, section.name_en || section.name)

    for (const item of section.items || []) {
      const translated = OPENING_ITEMS[item.id]
      if (translated) {
        setPair(item, 'name', translated[0], translated[1])
        setPair(item, 'instruction', translated[2], translated[3])
      } else {
        pair(item, 'name', item.name_cn, item.name_en || item.name)
        pair(item, 'instruction', item.instruction_cn, item.instruction_en || item.instruction)
      }
      pair(
        item,
        'completion_standard',
        item.completion_standard_cn || '达到任务标准；发现不足时先处理，无法处理时报告异常。',
        item.completion_standard_en || 'Meet the task standard; correct shortages first and report an issue when they cannot be resolved.',
      )
    }
  }

  for (const group of config.photo_groups || []) {
    const translated = OPENING_PHOTOS[group.id]
    if (translated) {
      setPair(group, 'name', translated[0], translated[1])
      setPair(group, 'sample_caption', translated[2], translated[3])
    } else {
      pair(group, 'name', group.name_cn, group.name_en || group.name)
      pair(group, 'sample_caption', group.sample_caption_cn, group.sample_caption_en || group.sample_caption)
    }
  }
}

function enrichGeneric(config) {
  pair(config, 'title', config.title_cn, config.title_en || config.title)
  pair(config, 'instruction', config.instruction_cn, config.instruction_en || config.instruction)
  pair(config, 'completion_standard', config.completion_standard_cn, config.completion_standard_en)

  if (config.schedule) {
    pair(config.schedule, 'shift_name', config.schedule.shift_name_cn, config.schedule.shift_name_en || config.schedule.shift_name)
  }

  for (const section of config.sections || []) {
    pair(section, 'name', section.name_cn, section.name_en || section.name)
    for (const item of section.items || []) {
      pair(item, 'name', item.name_cn, item.name_en || item.name)
      pair(item, 'instruction', item.instruction_cn, item.instruction_en || item.instruction)
      pair(item, 'completion_standard', item.completion_standard_cn, item.completion_standard_en)
    }
  }

  for (const group of config.photo_groups || []) {
    pair(group, 'name', group.name_cn, group.name_en || group.name)
    pair(group, 'sample_caption', group.sample_caption_cn, group.sample_caption_en || group.sample_caption)
  }
}

export function normalizeTaskBilingual(task = {}) {
  const config = structuredClone(task.config || {})
  enrichGeneric(config)

  const checklistKey = clean(config.checklist_key).toLowerCase()
  if (checklistKey === 'opening' || checklistKey.startsWith('opening-')) enrichOpening(config)

  const display = {
    ...(task.display || {}),
    task_name_cn: clean(config.title_cn || task.display?.task_name_cn || task.display?.name_cn),
    task_name_en: clean(config.title_en || task.display?.task_name_en || task.display?.name_en || task.title),
    instruction_cn: clean(config.instruction_cn || task.display?.instruction_cn),
    instruction_en: clean(config.instruction_en || task.display?.instruction_en || task.description),
    completion_standard_cn: clean(config.completion_standard_cn || task.display?.completion_standard_cn),
    completion_standard_en: clean(config.completion_standard_en || task.display?.completion_standard_en),
  }

  return {
    ...task,
    config,
    display,
    bilingual_content: true,
  }
}
