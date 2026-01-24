const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');

const { Plan, CategoryPlan, User, SalesRepresentative, Distributor, Category } = models;

// Функция для разрешения торгового представителя (из distributorController)
async function resolveSalesRepresentative(distributorId, salesRepresentativeId) {
  const [salesRepresentative, user] = await Promise.all([
    SalesRepresentative.findOne({ id: salesRepresentativeId }).lean(),
    User.findOne({ id: salesRepresentativeId, role: 'SALES_REPRESENTATIVE' }).lean()
  ]);

  let resolvedSalesRep = salesRepresentative;
  if (!resolvedSalesRep && user && user.email) {
    resolvedSalesRep = await SalesRepresentative.findOne({ email: user.email }).lean();
  }

  if (!resolvedSalesRep && !user) {
    return {
      salesRepresentative: null,
      user: null,
      linkId: null,
      linkIds: [],
      isAllowed: false
    };
  }

  const linkIds = Array.from(
    new Set([resolvedSalesRep && resolvedSalesRep.id, user && user.id].filter(Boolean))
  );
  const linkId = resolvedSalesRep ? resolvedSalesRep.id : user ? user.id : null;

  if (!distributorId) {
    return {
      salesRepresentative: resolvedSalesRep,
      user,
      linkId,
      linkIds,
      isAllowed: true
    };
  }

  const allowedBySalesRep =
    resolvedSalesRep && resolvedSalesRep.distributorId === distributorId;
  const allowedByUser = user && user.distributorId === distributorId;

  return {
    salesRepresentative: resolvedSalesRep,
    user,
    linkId,
    linkIds,
    isAllowed: allowedBySalesRep || allowedByUser
  };
}

// Создание плана (дистрибьютор)
async function createPlan(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут создавать планы' });
    }

    const { salesRepresentativeId, targetAmount, targetQuantity, period, description, startDate, endDate } = req.body;

    if (!salesRepresentativeId || targetAmount === undefined || targetQuantity === undefined || !period) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля: salesRepresentativeId, targetAmount, targetQuantity, period' });
    }

    if (targetAmount < 0 || targetQuantity < 0) {
      return res.status(400).json({ error: 'targetAmount и targetQuantity должны быть неотрицательными числами' });
    }

    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    // Проверяем существование торгового представителя и его принадлежность дистрибьютору
    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(403).json({ error: 'Торговый представитель не принадлежит этому дистрибьютору' });
    }

    // Проверяем, нет ли уже плана на этот период
    const existingPlan = await Plan.findOne({
      salesRepresentativeId: resolved.linkId,
      distributorId,
      period
    }).lean();

    if (existingPlan) {
      return res.status(409).json({ error: 'План на этот период уже существует' });
    }

    // Создаем план
    const plan = await Plan.create({
      id: generateId(),
      salesRepresentativeId: resolved.linkId,
      distributorId,
      targetAmount,
      targetQuantity,
      period,
      description: description || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null
    });

    res.status(201).json(plan.toObject());
  } catch (error) {
    console.error('Ошибка при создании плана:', error);
    res.status(500).json({ error: 'Ошибка при создании плана' });
  }
}

// Получение планов торгового представителя (для самого ТП)
async function getMyPlans(req, res) {
  try {
    const tokenSalesRepId = req.user && req.user.salesRepresentativeId;
    const tokenUserId = req.user && req.user.userId;

    if (!tokenSalesRepId && !tokenUserId) {
      return res.status(403).json({ error: 'Только торговые представители могут просматривать свои планы' });
    }

    // Разрешаем ID торгового представителя
    let resolvedSalesRepId = null;
    if (tokenSalesRepId) {
      const resolved = await resolveSalesRepresentative(null, tokenSalesRepId);
      if (resolved.linkId) {
        resolvedSalesRepId = resolved.linkId;
      }
    }
    if (!resolvedSalesRepId && tokenUserId) {
      const user = await User.findOne({ id: tokenUserId, role: 'SALES_REPRESENTATIVE' }).lean();
      if (user) {
        const salesRepByEmail = await SalesRepresentative.findOne({ email: user.email }).lean();
        resolvedSalesRepId = salesRepByEmail ? salesRepByEmail.id : user.id;
      }
    }

    if (!resolvedSalesRepId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    // Получаем планы
    const plans = await Plan.find({ salesRepresentativeId: resolvedSalesRepId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      items: plans,
      total: plans.length
    });
  } catch (error) {
    console.error('Ошибка при получении планов ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении планов' });
  }
}

// Получение планов конкретного торгового представителя (для дистрибьютора)
async function getSalesRepresentativePlans(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать планы торговых представителей' });
    }

    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }

    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    // Проверяем существование торгового представителя и его принадлежность дистрибьютору
    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(403).json({ error: 'Торговый представитель не принадлежит этому дистрибьютору' });
    }

    // Получаем планы
    const plans = await Plan.find({
      salesRepresentativeId: resolved.linkId,
      distributorId
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      items: plans,
      total: plans.length
    });
  } catch (error) {
    console.error('Ошибка при получении планов ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении планов торгового представителя' });
  }
}

// Обновление плана (дистрибьютор)
async function updatePlan(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { planId } = req.params;
    const { targetAmount, targetQuantity, period, description, startDate, endDate } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут обновлять планы' });
    }

    if (!planId) {
      return res.status(400).json({ error: 'ID плана обязателен' });
    }

    // Проверяем существование плана и принадлежность дистрибьютору
    const plan = await Plan.findOne({ id: planId, distributorId }).lean();
    if (!plan) {
      return res.status(404).json({ error: 'План не найден' });
    }

    // Подготавливаем обновления
    const update = { updatedAt: new Date() };
    if (targetAmount !== undefined) {
      if (targetAmount < 0) {
        return res.status(400).json({ error: 'targetAmount должен быть неотрицательным числом' });
      }
      update.targetAmount = targetAmount;
    }
    if (targetQuantity !== undefined) {
      if (targetQuantity < 0) {
        return res.status(400).json({ error: 'targetQuantity должен быть неотрицательным числом' });
      }
      update.targetQuantity = targetQuantity;
    }
    if (period !== undefined) {
      update.period = period;
      // Проверяем, нет ли другого плана на этот период для этого ТП
      const existingPlan = await Plan.findOne({
        salesRepresentativeId: plan.salesRepresentativeId,
        distributorId,
        period,
        id: { $ne: planId }
      }).lean();

      if (existingPlan) {
        return res.status(409).json({ error: 'План на этот период уже существует' });
      }
    }
    if (description !== undefined) update.description = description;
    if (startDate !== undefined) update.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) update.endDate = endDate ? new Date(endDate) : null;

    // Обновляем план
    const updatedPlan = await Plan.findOneAndUpdate(
      { id: planId },
      update,
      { new: true }
    ).lean();

    res.json(updatedPlan);
  } catch (error) {
    console.error('Ошибка при обновлении плана:', error);
    res.status(500).json({ error: 'Ошибка при обновлении плана' });
  }
}

// Удаление плана (дистрибьютор)
async function deletePlan(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { planId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут удалять планы' });
    }

    if (!planId) {
      return res.status(400).json({ error: 'ID плана обязателен' });
    }

    // Проверяем существование плана и принадлежность дистрибьютору
    const plan = await Plan.findOne({ id: planId, distributorId }).lean();
    if (!plan) {
      return res.status(404).json({ error: 'План не найден' });
    }

    // Удаляем план
    await Plan.deleteOne({ id: planId });

    res.json({
      message: 'План успешно удален'
    });
  } catch (error) {
    console.error('Ошибка при удалении плана:', error);
    res.status(500).json({ error: 'Ошибка при удалении плана' });
  }
}

// Создание плана по категории (дистрибьютор)
async function createCategoryPlan(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут создавать планы по категориям' });
    }

    const { salesRepresentativeId, categoryId, targetAmount, targetQuantity, period, description, startDate, endDate } = req.body;

    if (!salesRepresentativeId || !categoryId || targetAmount === undefined || targetQuantity === undefined || !period) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля: salesRepresentativeId, categoryId, targetAmount, targetQuantity, period' });
    }

    if (targetAmount < 0 || targetQuantity < 0) {
      return res.status(400).json({ error: 'targetAmount и targetQuantity должны быть неотрицательными числами' });
    }

    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    // Проверяем существование категории
    const category = await Category.findOne({ id: categoryId }).lean();
    if (!category) {
      return res.status(404).json({ error: 'Категория не найдена' });
    }

    // Проверяем существование торгового представителя и его принадлежность дистрибьютору
    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(403).json({ error: 'Торговый представитель не принадлежит этому дистрибьютору' });
    }

    // Проверяем, нет ли уже плана по этой категории на этот период
    const existingPlan = await CategoryPlan.findOne({
      salesRepresentativeId: resolved.linkId,
      distributorId,
      categoryId,
      period
    }).lean();

    if (existingPlan) {
      return res.status(409).json({ error: 'План по этой категории на этот период уже существует' });
    }

    // Создаем план по категории
    const categoryPlan = await CategoryPlan.create({
      id: generateId(),
      salesRepresentativeId: resolved.linkId,
      distributorId,
      categoryId,
      targetAmount,
      targetQuantity,
      period,
      description: description || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null
    });

    res.status(201).json(categoryPlan.toObject());
  } catch (error) {
    console.error('Ошибка при создании плана по категории:', error);
    res.status(500).json({ error: 'Ошибка при создании плана по категории' });
  }
}

// Получение планов по категориям торгового представителя (для самого ТП)
async function getMyCategoryPlans(req, res) {
  try {
    const tokenSalesRepId = req.user && req.user.salesRepresentativeId;
    const tokenUserId = req.user && req.user.userId;

    if (!tokenSalesRepId && !tokenUserId) {
      return res.status(403).json({ error: 'Только торговые представители могут просматривать свои планы по категориям' });
    }

    // Разрешаем ID торгового представителя
    let resolvedSalesRepId = null;
    if (tokenSalesRepId) {
      const resolved = await resolveSalesRepresentative(null, tokenSalesRepId);
      if (resolved.linkId) {
        resolvedSalesRepId = resolved.linkId;
      }
    }
    if (!resolvedSalesRepId && tokenUserId) {
      const user = await User.findOne({ id: tokenUserId, role: 'SALES_REPRESENTATIVE' }).lean();
      if (user) {
        const salesRepByEmail = await SalesRepresentative.findOne({ email: user.email }).lean();
        resolvedSalesRepId = salesRepByEmail ? salesRepByEmail.id : user.id;
      }
    }

    if (!resolvedSalesRepId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    // Получаем планы по категориям
    const categoryPlans = await CategoryPlan.find({ salesRepresentativeId: resolvedSalesRepId })
      .sort({ createdAt: -1 })
      .lean();

    // Получаем информацию о категориях
    const categoryIds = [...new Set(categoryPlans.map(plan => plan.categoryId))];
    const categories = categoryIds.length
      ? await Category.find({ id: { $in: categoryIds } }).lean()
      : [];
    const categoryMap = new Map(categories.map(cat => [cat.id, cat]));

    // Добавляем информацию о категориях к планам
    const plansWithCategories = categoryPlans.map(plan => ({
      ...plan,
      category: categoryMap.get(plan.categoryId) || null
    }));

    res.json({
      items: plansWithCategories,
      total: plansWithCategories.length
    });
  } catch (error) {
    console.error('Ошибка при получении планов по категориям ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении планов по категориям' });
  }
}

// Получение планов по категориям конкретного торгового представителя (для дистрибьютора)
async function getSalesRepresentativeCategoryPlans(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать планы по категориям торговых представителей' });
    }

    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }

    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    // Проверяем существование торгового представителя и его принадлежность дистрибьютору
    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(403).json({ error: 'Торговый представитель не принадлежит этому дистрибьютору' });
    }

    // Получаем планы по категориям
    const categoryPlans = await CategoryPlan.find({
      salesRepresentativeId: resolved.linkId,
      distributorId
    })
      .sort({ createdAt: -1 })
      .lean();

    // Получаем информацию о категориях
    const categoryIds = [...new Set(categoryPlans.map(plan => plan.categoryId))];
    const categories = categoryIds.length
      ? await Category.find({ id: { $in: categoryIds } }).lean()
      : [];
    const categoryMap = new Map(categories.map(cat => [cat.id, cat]));

    // Добавляем информацию о категориях к планам
    const plansWithCategories = categoryPlans.map(plan => ({
      ...plan,
      category: categoryMap.get(plan.categoryId) || null
    }));

    res.json({
      items: plansWithCategories,
      total: plansWithCategories.length
    });
  } catch (error) {
    console.error('Ошибка при получении планов по категориям ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении планов по категориям торгового представителя' });
  }
}

// Обновление плана по категории (дистрибьютор)
async function updateCategoryPlan(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { planId } = req.params;
    const { categoryId, targetAmount, targetQuantity, period, description, startDate, endDate } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут обновлять планы по категориям' });
    }

    if (!planId) {
      return res.status(400).json({ error: 'ID плана обязателен' });
    }

    // Проверяем существование плана и принадлежность дистрибьютору
    const plan = await CategoryPlan.findOne({ id: planId, distributorId }).lean();
    if (!plan) {
      return res.status(404).json({ error: 'План по категории не найден' });
    }

    // Если изменяется категория, проверяем её существование
    if (categoryId !== undefined && categoryId !== plan.categoryId) {
      const category = await Category.findOne({ id: categoryId }).lean();
      if (!category) {
        return res.status(404).json({ error: 'Категория не найдена' });
      }
    }

    // Подготавливаем обновления
    const update = { updatedAt: new Date() };
    if (categoryId !== undefined) {
      update.categoryId = categoryId;
    }
    if (targetAmount !== undefined) {
      if (targetAmount < 0) {
        return res.status(400).json({ error: 'targetAmount должен быть неотрицательным числом' });
      }
      update.targetAmount = targetAmount;
    }
    if (targetQuantity !== undefined) {
      if (targetQuantity < 0) {
        return res.status(400).json({ error: 'targetQuantity должен быть неотрицательным числом' });
      }
      update.targetQuantity = targetQuantity;
    }
    if (period !== undefined) {
      update.period = period;
      // Проверяем, нет ли другого плана по этой категории на этот период для этого ТП
      const finalCategoryId = categoryId !== undefined ? categoryId : plan.categoryId;
      const existingPlan = await CategoryPlan.findOne({
        salesRepresentativeId: plan.salesRepresentativeId,
        distributorId,
        categoryId: finalCategoryId,
        period,
        id: { $ne: planId }
      }).lean();

      if (existingPlan) {
        return res.status(409).json({ error: 'План по этой категории на этот период уже существует' });
      }
    }
    if (description !== undefined) update.description = description;
    if (startDate !== undefined) update.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) update.endDate = endDate ? new Date(endDate) : null;

    // Обновляем план
    const updatedPlan = await CategoryPlan.findOneAndUpdate(
      { id: planId },
      update,
      { new: true }
    ).lean();

    res.json(updatedPlan);
  } catch (error) {
    console.error('Ошибка при обновлении плана по категории:', error);
    res.status(500).json({ error: 'Ошибка при обновлении плана по категории' });
  }
}

// Удаление плана по категории (дистрибьютор)
async function deleteCategoryPlan(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { planId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут удалять планы по категориям' });
    }

    if (!planId) {
      return res.status(400).json({ error: 'ID плана обязателен' });
    }

    // Проверяем существование плана и принадлежность дистрибьютору
    const plan = await CategoryPlan.findOne({ id: planId, distributorId }).lean();
    if (!plan) {
      return res.status(404).json({ error: 'План по категории не найден' });
    }

    // Удаляем план
    await CategoryPlan.deleteOne({ id: planId });

    res.json({
      message: 'План по категории успешно удален'
    });
  } catch (error) {
    console.error('Ошибка при удалении плана по категории:', error);
    res.status(500).json({ error: 'Ошибка при удалении плана по категории' });
  }
}

module.exports = {
  createPlan,
  getMyPlans,
  getSalesRepresentativePlans,
  updatePlan,
  deletePlan,
  createCategoryPlan,
  getMyCategoryPlans,
  getSalesRepresentativeCategoryPlans,
  updateCategoryPlan,
  deleteCategoryPlan
};
