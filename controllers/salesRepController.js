const { models } = require('../models/database');

const {
  User,
  SalesRepresentative,
  SalesRepresentativeStore,
  SalesRepresentativeProduct,
  Store,
  Offer,
  Product,
  Category,
  Sale,
  Plan
} = models;

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseStorageLifeDays(storageLife) {
  if (!storageLife) return null;
  const raw = String(storageLife).trim().toLowerCase();
  const match = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  if (Number.isNaN(value) || value <= 0) return null;

  if (raw.includes('нед')) return Math.round(value * 7);
  if (raw.includes('мес')) return Math.round(value * 30);
  if (raw.includes('год') || raw.includes('лет')) return Math.round(value * 365);
  if (raw.includes('д')) return Math.round(value);

  return Math.round(value);
}

async function resolveSalesRepLinkIds(req) {
  const tokenSalesRepId = req.user && req.user.salesRepresentativeId;
  const tokenUserId = req.user && req.user.userId;

  const linkIds = new Set();

  if (tokenSalesRepId) {
    const [salesRep, userById] = await Promise.all([
      SalesRepresentative.findOne({ id: tokenSalesRepId }).lean(),
      User.findOne({ id: tokenSalesRepId, role: 'SALES_REPRESENTATIVE' }).lean()
    ]);

    if (salesRep) {
      linkIds.add(salesRep.id);
    }
    if (userById) {
      linkIds.add(userById.id);
      if (userById.email) {
        const salesRepByEmail = await SalesRepresentative.findOne({ email: userById.email }).lean();
        if (salesRepByEmail) linkIds.add(salesRepByEmail.id);
      }
    }
  }

  if (!linkIds.size && tokenUserId) {
    const userById = await User.findOne({ id: tokenUserId, role: 'SALES_REPRESENTATIVE' }).lean();
    if (userById) {
      linkIds.add(userById.id);
      if (userById.email) {
        const salesRepByEmail = await SalesRepresentative.findOne({ email: userById.email }).lean();
        if (salesRepByEmail) linkIds.add(salesRepByEmail.id);
      }
    }
  }

  return Array.from(linkIds);
}

async function getSalesRepStoresContext(req) {
  const linkIds = await resolveSalesRepLinkIds(req);
  if (!linkIds.length) {
    return {
      storeIds: [],
      storesById: new Map(),
      stores: [],
      isFound: false
    };
  }

  const links = await SalesRepresentativeStore.find({
    salesRepresentativeId: { $in: linkIds }
  }).lean();
  const storeIds = Array.from(new Set(links.map(link => link.storeId)));
  const stores = storeIds.length
    ? await Store.find({ id: { $in: storeIds } }).lean()
    : [];
  const storesById = new Map(stores.map(store => [store.id, store]));

  return {
    storeIds,
    storesById,
    stores,
    isFound: true
  };
}

async function loadOffersWithProducts(storeIds) {
  const offers = storeIds.length
    ? await Offer.find({ storeId: { $in: storeIds } }).lean()
    : [];
  const productIds = Array.from(new Set(offers.map(offer => offer.productId)));
  const products = productIds.length
    ? await Product.find({ id: { $in: productIds } }).lean()
    : [];
  const productById = new Map(products.map(product => [product.id, product]));

  return { offers, productById, products };
}

async function getMyProductGroups(req, res) {
  try {
    const context = await getSalesRepStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({ items: [], total: 0 });
    }

    const { offers, productById } = await loadOffersWithProducts(context.storeIds);
    if (!offers.length) {
      return res.json({ items: [], total: 0 });
    }

    const categoryIds = new Set();
    productById.forEach(product => {
      if (product.categoryId) categoryIds.add(product.categoryId);
    });

    const categories = categoryIds.size
      ? await Category.find({ id: { $in: Array.from(categoryIds) } }).lean()
      : [];
    const categoryById = new Map(categories.map(category => [category.id, category]));

    const groupByCategory = new Map();

    for (const offer of offers) {
      const product = productById.get(offer.productId);
      if (!product) continue;
      const categoryId = product.categoryId || 'unknown';
      const category = categoryById.get(product.categoryId) || null;
      if (!groupByCategory.has(categoryId)) {
        groupByCategory.set(categoryId, {
          categoryId: category ? category.id : null,
          categoryName: category ? category.name : null,
          productCount: 0,
          offerCount: 0,
          totalQuantity: 0
        });
      }
      const group = groupByCategory.get(categoryId);
      group.offerCount += 1;
      group.totalQuantity += offer.quantity || 0;
    }

    const productsByCategory = new Map();
    productById.forEach(product => {
      const categoryId = product.categoryId || 'unknown';
      if (!productsByCategory.has(categoryId)) {
        productsByCategory.set(categoryId, new Set());
      }
      productsByCategory.get(categoryId).add(product.id);
    });

    productsByCategory.forEach((productSet, categoryId) => {
      const group = groupByCategory.get(categoryId);
      if (group) group.productCount = productSet.size;
    });

    const items = Array.from(groupByCategory.values());
    res.json({
      items,
      total: items.length
    });
  } catch (error) {
    console.error('Ошибка при получении групп товаров ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении групп товаров' });
  }
}

async function getMyStockControl(req, res) {
  try {
    const context = await getSalesRepStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({ items: [], total: 0 });
    }

    const threshold = parseNumber(req.query.threshold, 5);
    const requestedStoreId = req.query.storeId;
    if (requestedStoreId && !context.storeIds.includes(requestedStoreId)) {
      return res.status(403).json({ error: 'Нет доступа к указанному магазину' });
    }

    const storeIds = requestedStoreId ? [requestedStoreId] : context.storeIds;
    const { offers, productById } = await loadOffersWithProducts(storeIds);

    const now = new Date();
    const items = offers.map(offer => {
      const product = productById.get(offer.productId) || null;
      const store = context.storesById.get(offer.storeId) || null;
      let expiryDate = product && product.expirationDate ? new Date(product.expirationDate) : null;
      let daysLeft = null;
      if (!expiryDate && product && product.productionDate && product.storageLife) {
        const storageDays = parseStorageLifeDays(product.storageLife);
        if (storageDays) {
          expiryDate = new Date(product.productionDate);
          expiryDate.setDate(expiryDate.getDate() + storageDays);
        }
      }
      if (expiryDate) {
        daysLeft = Math.ceil((expiryDate - now) / (24 * 60 * 60 * 1000));
      }
      return {
        ...offer,
        lowStock: (offer.quantity || 0) <= threshold,
        expiryDate,
        daysLeft,
        product: product
          ? {
              id: product.id,
              name: product.name,
              sku: product.sku,
              brandId: product.brandId,
              brandName: product.brandName,
              categoryId: product.categoryId,
              storageLife: product.storageLife,
              productionDate: product.productionDate
            }
          : null,
        store: store
          ? {
              id: store.id,
              name: store.name,
              address: store.address
            }
          : null
      };
    });

    res.json({
      items,
      total: items.length,
      threshold
    });
  } catch (error) {
    console.error('Ошибка при контроле остатков ТП:', error);
    res.status(500).json({ error: 'Ошибка при контроле остатков' });
  }
}

async function getMyAiAnalytics(req, res) {
  try {
    const context = await getSalesRepStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({
        stores: { total: 0, ids: [] },
        summary: { shortageCount: 0, expiringCount: 0, reorderCount: 0 },
        shortage: { threshold: 0, items: [] },
        expiring: { days: 0, items: [] },
        reorderRecommendations: { targetStock: 0, items: [] },
        plan: { byProduct: [], byBrand: [] }
      });
    }

    const threshold = parseNumber(req.query.threshold, 5);
    const expiringDays = parseNumber(req.query.expiringDays, 14);
    const targetStock = parseNumber(req.query.targetStock, 20);
    const now = new Date();

    const { offers, productById } = await loadOffersWithProducts(context.storeIds);

    const shortage = [];
    const expiring = [];
    const reorder = [];

    const productPlanMap = new Map();
    const brandPlanMap = new Map();

    for (const offer of offers) {
      const product = productById.get(offer.productId);
      if (!product) continue;

      const quantity = offer.quantity || 0;
      const store = context.storesById.get(offer.storeId) || null;

      if (quantity <= threshold) {
        shortage.push({
          offerId: offer.id,
          storeId: offer.storeId,
          storeName: store ? store.name : null,
          productId: product.id,
          productName: product.name,
          quantity
        });
      }

      let expiryDate = product.expirationDate ? new Date(product.expirationDate) : null;
      if (!expiryDate && product.productionDate && product.storageLife) {
        const storageDays = parseStorageLifeDays(product.storageLife);
        if (storageDays) {
          expiryDate = new Date(product.productionDate);
          expiryDate.setDate(expiryDate.getDate() + storageDays);
        }
      }
      if (expiryDate) {
        const daysLeft = Math.ceil((expiryDate - now) / (24 * 60 * 60 * 1000));
        if (daysLeft <= expiringDays && daysLeft >= 0) {
          expiring.push({
            offerId: offer.id,
            storeId: offer.storeId,
            storeName: store ? store.name : null,
            productId: product.id,
            productName: product.name,
            quantity,
            expiryDate,
            daysLeft
          });
        }
      }

      if (quantity < targetStock) {
        reorder.push({
          offerId: offer.id,
          storeId: offer.storeId,
          storeName: store ? store.name : null,
          productId: product.id,
          productName: product.name,
          quantity,
          recommendedOrder: Math.max(0, targetStock - quantity)
        });
      }

      const productKey = product.id;
      if (!productPlanMap.has(productKey)) {
        productPlanMap.set(productKey, {
          productId: product.id,
          productName: product.name,
          brandId: product.brandId,
          brandName: product.brandName || null,
          totalQuantity: 0,
          stores: new Set(),
          recommendOrderTotal: 0
        });
      }
      const productEntry = productPlanMap.get(productKey);
      productEntry.totalQuantity += quantity;
      productEntry.stores.add(offer.storeId);
      productEntry.recommendOrderTotal += Math.max(0, targetStock - quantity);

      const brandKey = product.brandId || 'unknown';
      if (!brandPlanMap.has(brandKey)) {
        brandPlanMap.set(brandKey, {
          brandId: product.brandId || null,
          brandName: product.brandName || null,
          totalQuantity: 0,
          stores: new Set(),
          products: new Set(),
          recommendOrderTotal: 0
        });
      }
      const brandEntry = brandPlanMap.get(brandKey);
      brandEntry.totalQuantity += quantity;
      brandEntry.stores.add(offer.storeId);
      brandEntry.products.add(product.id);
      brandEntry.recommendOrderTotal += Math.max(0, targetStock - quantity);
    }

    const planByProduct = Array.from(productPlanMap.values()).map(entry => ({
      productId: entry.productId,
      productName: entry.productName,
      brandId: entry.brandId,
      brandName: entry.brandName,
      totalQuantity: entry.totalQuantity,
      storesCount: entry.stores.size,
      recommendOrderTotal: entry.recommendOrderTotal
    }));

    const planByBrand = Array.from(brandPlanMap.values()).map(entry => ({
      brandId: entry.brandId,
      brandName: entry.brandName,
      totalQuantity: entry.totalQuantity,
      storesCount: entry.stores.size,
      productsCount: entry.products.size,
      recommendOrderTotal: entry.recommendOrderTotal
    }));

    res.json({
      stores: { total: context.storeIds.length, ids: context.storeIds },
      summary: {
        shortageCount: shortage.length,
        expiringCount: expiring.length,
        reorderCount: reorder.length
      },
      shortage: { threshold, items: shortage },
      expiring: { days: expiringDays, items: expiring },
      reorderRecommendations: { targetStock, items: reorder },
      plan: { byProduct: planByProduct, byBrand: planByBrand }
    });
  } catch (error) {
    console.error('Ошибка при AI-аналитике ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении AI-аналитики' });
  }
}

async function getMySalesRepresentative(req, res) {
  try {
    const tokenSalesRepId = req.user && req.user.salesRepresentativeId;
    const tokenUserId = req.user && req.user.userId;

    if (!tokenSalesRepId && !tokenUserId) {
      return res.status(403).json({ error: 'Только торговые представители могут просматривать свои данные' });
    }

    // Получаем данные из User
    let user = null;
    if (tokenUserId) {
      user = await User.findOne({ id: tokenUserId, role: 'SALES_REPRESENTATIVE' }).lean();
    } else if (tokenSalesRepId) {
      user = await User.findOne({ id: tokenSalesRepId, role: 'SALES_REPRESENTATIVE' }).lean();
    }

    // Получаем данные из SalesRepresentative
    let salesRep = null;
    if (user && user.email) {
      salesRep = await SalesRepresentative.findOne({ email: user.email }).lean();
    } else if (tokenSalesRepId) {
      salesRep = await SalesRepresentative.findOne({ id: tokenSalesRepId }).lean();
    }

    if (!user && !salesRep) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    // Возвращаем email, firstName, lastName, middleName, phoneNumber
    // Приоритет: данные из SalesRepresentative (более полные), если нет - из User
    const result = {
      email: user ? user.email : salesRep.email,
      firstName: salesRep?.firstName || user?.firstName || null,
      lastName: salesRep?.lastName || user?.lastName || null,
      middleName: salesRep?.middleName || null,
      phoneNumber: salesRep?.phoneNumber || null
    };

    res.json(result);
  } catch (error) {
    console.error('Ошибка при получении данных торгового представителя:', error);
    res.status(500).json({ error: 'Ошибка при получении данных торгового представителя' });
  }
}

async function updateMySalesRepresentative(req, res) {
  try {
    const tokenSalesRepId = req.user && req.user.salesRepresentativeId;
    const tokenUserId = req.user && req.user.userId;
    const { firstName, lastName, middleName, phoneNumber } = req.body;

    if (!tokenSalesRepId && !tokenUserId) {
      return res.status(403).json({ error: 'Только торговые представители могут обновлять свои данные' });
    }

    // Валидация обязательных полей
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Поля firstName и lastName обязательны' });
    }

    // Получаем данные из User
    let user = null;
    if (tokenUserId) {
      user = await User.findOne({ id: tokenUserId, role: 'SALES_REPRESENTATIVE' }).lean();
    } else if (tokenSalesRepId) {
      user = await User.findOne({ id: tokenSalesRepId, role: 'SALES_REPRESENTATIVE' }).lean();
    }

    // Получаем данные из SalesRepresentative
    let salesRep = null;
    if (user && user.email) {
      salesRep = await SalesRepresentative.findOne({ email: user.email }).lean();
    } else if (tokenSalesRepId) {
      salesRep = await SalesRepresentative.findOne({ id: tokenSalesRepId }).lean();
    }

    if (!user && !salesRep) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    // Формируем полное имя для обратной совместимости
    const fullName = [lastName, firstName, middleName].filter(Boolean).join(' ').trim() || firstName;

    // Обновляем User, если он существует
    if (user) {
      await User.findOneAndUpdate(
        { id: user.id },
        { 
          firstName, 
          lastName: lastName || '',
          updatedAt: new Date() 
        }
      );
    }

    // Обновляем SalesRepresentative, если он существует
    if (salesRep) {
      await SalesRepresentative.findOneAndUpdate(
        { id: salesRep.id },
        { 
          name: fullName,
          firstName,
          lastName,
          middleName: middleName || null,
          phoneNumber: phoneNumber || null,
          updatedAt: new Date() 
        }
      );
    }

    // Возвращаем обновленные данные
    const updatedUser = user ? await User.findOne({ id: user.id }).lean() : null;
    const updatedSalesRep = salesRep ? await SalesRepresentative.findOne({ id: salesRep.id }).lean() : null;

    const result = {
      email: updatedUser ? updatedUser.email : updatedSalesRep.email,
      firstName: updatedSalesRep?.firstName || updatedUser?.firstName || null,
      lastName: updatedSalesRep?.lastName || updatedUser?.lastName || null,
      middleName: updatedSalesRep?.middleName || null,
      phoneNumber: updatedSalesRep?.phoneNumber || null
    };

    res.json({
      message: 'Данные успешно обновлены',
      salesRepresentative: result
    });
  } catch (error) {
    console.error('Ошибка при обновлении данных торгового представителя:', error);
    res.status(500).json({ error: 'Ошибка при обновлении данных торгового представителя' });
  }
}

// Получение списка закрепленных товаров торгового представителя
async function getMyProducts(req, res) {
  try {
    // Проверяем и отключаем товары с истекшей оплатой перед получением списка
    const { checkAndDisableExpiredPayments } = require('../utils/paymentExpiration');
    await checkAndDisableExpiredPayments();

    const linkIds = await resolveSalesRepLinkIds(req);
    if (!linkIds.length) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    const links = await SalesRepresentativeProduct.find({
      salesRepresentativeId: { $in: linkIds }
    }).lean();

    if (!links.length) {
      return res.json({
        items: [],
        total: 0,
        message: 'Нет закрепленных товаров'
      });
    }

    const productIds = links.map(link => link.productId);
    const products = await Product.find({ id: { $in: productIds } }).lean();

    // Получаем информацию о категориях для товаров
    const categoryIds = Array.from(new Set(products.map(p => p.categoryId).filter(Boolean)));
    const categories = categoryIds.length
      ? await Category.find({ id: { $in: categoryIds } }).lean()
      : [];
    const categoryById = new Map(categories.map(cat => [cat.id, cat]));

    // Обогащаем товары информацией о категориях
    const enrichedProducts = products.map(product => ({
      ...product,
      categoryName: product.categoryId ? (categoryById.get(product.categoryId)?.name || null) : null
    }));

    res.json({
      items: enrichedProducts,
      total: enrichedProducts.length
    });
  } catch (error) {
    console.error('Ошибка при получении товаров ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении товаров торгового представителя' });
  }
}

// Получение аналитики продаж для торгового представителя
async function getMySalesAnalytics(req, res) {
  try {
    const context = await getSalesRepStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({
        period: {
          startDate: null,
          endDate: null
        },
        stores: { total: 0, ids: [] },
        summary: {
          totalSales: 0,
          totalRevenue: 0,
          totalQuantity: 0,
          averageSale: 0
        },
        byPeriod: {
          daily: [],
          weekly: [],
          monthly: []
        },
        byStore: [],
        byProduct: [],
        byBrand: [],
        plans: []
      });
    }

    // Парсим даты из query параметров
    let startDate = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // По умолчанию 30 дней
    let endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
    
    // Устанавливаем startDate на начало дня (00:00:00)
    startDate.setHours(0, 0, 0, 0);
    // Устанавливаем endDate на конец дня (23:59:59.999)
    endDate.setHours(23, 59, 59, 999);

    // Получаем все завершенные продажи из магазинов ТП
    // Сначала получаем все завершенные продажи, затем фильтруем по дате
    const allCompletedSales = await Sale.find({
      storeId: { $in: context.storeIds },
      status: 'COMPLETED'
    })
      .sort({ completedAt: -1, createdAt: -1 })
      .lean();

    // Также получаем все продажи (включая DRAFT) для отладки
    const allSales = await Sale.find({
      storeId: { $in: context.storeIds }
    })
      .select('id storeId status completedAt createdAt totalAmount')
      .lean();

    // Фильтруем по дате: используем completedAt, если он есть, иначе createdAt
    const sales = allCompletedSales.filter(sale => {
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
      return saleDate >= startDate && saleDate <= endDate;
    });

    // Логирование для отладки
    console.log('Sales Analytics Debug:', {
      salesRepStoreIds: context.storeIds,
      allSalesCount: allSales.length,
      allSalesByStatus: allSales.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        return acc;
      }, {}),
      completedSalesCount: allCompletedSales.length,
      filteredSalesCount: sales.length,
      period: { 
        startDate: startDate.toISOString(), 
        endDate: endDate.toISOString() 
      },
      sampleSales: allSales.slice(0, 3).map(s => ({
        id: s.id,
        storeId: s.storeId,
        status: s.status,
        completedAt: s.completedAt,
        createdAt: s.createdAt
      }))
    });

    // Базовая статистика
    const totalSales = sales.length;
    const totalRevenue = sales.reduce((sum, sale) => sum + (sale.totalAmount || 0), 0);
    const averageSale = totalSales > 0 ? totalRevenue / totalSales : 0;

    // Подсчет общего количества проданных товаров
    let totalQuantity = 0;
    sales.forEach(sale => {
      if (sale.items) {
        sale.items.forEach(item => {
          totalQuantity += item.quantity || 0;
        });
      }
    });

    // Агрегация по магазинам
    const storeStats = new Map();
    // Агрегация по товарам в каждом магазине
    const storeProductStats = new Map(); // storeId -> Map<productId, stats>
    
    context.stores.forEach(store => {
      storeStats.set(store.id, {
        storeId: store.id,
        storeName: store.name,
        storeAddress: store.address,
        totalSales: 0,
        totalRevenue: 0,
        totalQuantity: 0
      });
      storeProductStats.set(store.id, new Map());
    });

    // Агрегация по товарам
    const productStats = new Map();

    // Агрегация по брендам
    const brandStats = new Map();

    // Агрегация по периодам
    const dailyStats = new Map();
    const weeklyStats = new Map();
    const monthlyStats = new Map();

    // Получаем информацию о товарах для обогащения данных
    const productIds = new Set();
    sales.forEach(sale => {
      if (sale.items) {
        sale.items.forEach(item => {
          productIds.add(item.productId);
        });
      }
    });

    const products = productIds.size
      ? await Product.find({ id: { $in: Array.from(productIds) } }).lean()
      : [];
    const productById = new Map(products.map(p => [p.id, p]));

    // Обрабатываем каждую продажу
    sales.forEach(sale => {
      // Используем completedAt, если он есть, иначе createdAt
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
      const storeStat = storeStats.get(sale.storeId);
      if (storeStat) {
        storeStat.totalSales += 1;
        storeStat.totalRevenue += sale.totalAmount || 0;
      }

      // Агрегация по дням
      const dayKey = saleDate.toISOString().split('T')[0]; // YYYY-MM-DD
      if (!dailyStats.has(dayKey)) {
        dailyStats.set(dayKey, { date: dayKey, totalSales: 0, totalRevenue: 0, totalQuantity: 0 });
      }
      const dayStat = dailyStats.get(dayKey);
      dayStat.totalSales += 1;
      dayStat.totalRevenue += sale.totalAmount || 0;

      // Агрегация по неделям
      const weekStart = new Date(saleDate);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Начало недели (воскресенье)
      const weekKey = weekStart.toISOString().split('T')[0];
      if (!weeklyStats.has(weekKey)) {
        weeklyStats.set(weekKey, { weekStart: weekKey, totalSales: 0, totalRevenue: 0, totalQuantity: 0 });
      }
      const weekStat = weeklyStats.get(weekKey);
      weekStat.totalSales += 1;
      weekStat.totalRevenue += sale.totalAmount || 0;

      // Агрегация по месяцам
      const monthKey = `${saleDate.getFullYear()}-${String(saleDate.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlyStats.has(monthKey)) {
        monthlyStats.set(monthKey, { month: monthKey, totalSales: 0, totalRevenue: 0, totalQuantity: 0 });
      }
      const monthStat = monthlyStats.get(monthKey);
      monthStat.totalSales += 1;
      monthStat.totalRevenue += sale.totalAmount || 0;

      // Обрабатываем позиции в продаже
      if (sale.items) {
        sale.items.forEach(item => {
          const quantity = item.quantity || 0;
          const revenue = item.totalPrice || 0;

          // Обновляем статистику по магазину
          if (storeStat) {
            storeStat.totalQuantity += quantity;
          }

          // Статистика по товарам в конкретном магазине
          const storeProductMap = storeProductStats.get(sale.storeId);
          if (storeProductMap) {
            if (!storeProductMap.has(item.productId)) {
              const product = productById.get(item.productId);
              storeProductMap.set(item.productId, {
                productId: item.productId,
                productName: item.productName || (product ? product.name : 'Неизвестный товар'),
                sku: item.sku,
                brandId: product ? product.brandId : null,
                brandName: product ? product.brandName : null,
                totalQuantity: 0,
                totalRevenue: 0,
                salesCount: 0
              });
            }
            const storeProductStat = storeProductMap.get(item.productId);
            storeProductStat.totalQuantity += quantity;
            storeProductStat.totalRevenue += revenue;
            storeProductStat.salesCount += 1;
          }

          // Обновляем статистику по дням, неделям, месяцам
          dayStat.totalQuantity += quantity;
          weekStat.totalQuantity += quantity;
          monthStat.totalQuantity += quantity;

          // Статистика по товарам
          if (!productStats.has(item.productId)) {
            const product = productById.get(item.productId);
            productStats.set(item.productId, {
              productId: item.productId,
              productName: item.productName || (product ? product.name : 'Неизвестный товар'),
              sku: item.sku,
              brandId: product ? product.brandId : null,
              brandName: product ? product.brandName : null,
              totalQuantity: 0,
              totalRevenue: 0,
              salesCount: 0,
              storeStats: new Map() // Статистика по магазинам для этого товара
            });
          }
          const productStat = productStats.get(item.productId);
          productStat.totalQuantity += quantity;
          productStat.totalRevenue += revenue;
          productStat.salesCount += 1;
          
          // Обновляем статистику по магазинам для этого товара
          if (!productStat.storeStats.has(sale.storeId)) {
            productStat.storeStats.set(sale.storeId, {
              storeId: sale.storeId,
              quantity: 0,
              revenue: 0
            });
          }
          const storeStatForProduct = productStat.storeStats.get(sale.storeId);
          storeStatForProduct.quantity += quantity;
          storeStatForProduct.revenue += revenue;

          // Статистика по брендам
          const product = productById.get(item.productId);
          if (product && product.brandId) {
            if (!brandStats.has(product.brandId)) {
              brandStats.set(product.brandId, {
                brandId: product.brandId,
                brandName: product.brandName || 'Неизвестный бренд',
                totalQuantity: 0,
                totalRevenue: 0,
                salesCount: 0,
                productsCount: new Set()
              });
            }
            const brandStat = brandStats.get(product.brandId);
            brandStat.totalQuantity += quantity;
            brandStat.totalRevenue += revenue;
            brandStat.salesCount += 1;
            brandStat.productsCount.add(item.productId);
          }
        });
      }
    });

    // Преобразуем Map в массивы и сортируем
    const byStore = Array.from(storeStats.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    // Преобразуем статистику по товарам в магазинах
    const byStoreProducts = Array.from(storeProductStats.entries()).map(([storeId, productMap]) => {
      const store = context.storesById.get(storeId);
      return {
        storeId: storeId,
        storeName: store ? store.name : 'Неизвестный магазин',
        storeAddress: store ? store.address : null,
        products: Array.from(productMap.values())
          .sort((a, b) => b.totalRevenue - a.totalRevenue)
          .map(stat => ({
            productId: stat.productId,
            productName: stat.productName,
            sku: stat.sku,
            brandId: stat.brandId,
            brandName: stat.brandName,
            totalQuantity: stat.totalQuantity,
            totalRevenue: Math.round(stat.totalRevenue * 100) / 100,
            salesCount: stat.salesCount
          }))
      };
    }).sort((a, b) => {
      // Сортируем магазины по общей выручке
      const aRevenue = a.products.reduce((sum, p) => sum + p.totalRevenue, 0);
      const bRevenue = b.products.reduce((sum, p) => sum + p.totalRevenue, 0);
      return bRevenue - aRevenue;
    });

    const byProduct = Array.from(productStats.values())
      .map(stat => {
        // Находим магазин с максимальными продажами для этого товара
        let topStore = null;
        if (stat.storeStats && stat.storeStats.size > 0) {
          const storeStatsArray = Array.from(stat.storeStats.values());
          const topStoreStat = storeStatsArray.reduce((max, current) => 
            current.quantity > max.quantity ? current : max
          );
          const store = context.storesById.get(topStoreStat.storeId);
          if (store) {
            topStore = {
              storeId: store.id,
              storeName: store.name,
              storeAddress: store.address,
              quantity: topStoreStat.quantity,
              revenue: Math.round(topStoreStat.revenue * 100) / 100
            };
          }
        }
        
        return {
          ...stat,
          productsCount: undefined,
          storeStats: undefined, // Удаляем внутреннюю структуру
          topStore: topStore // Добавляем информацию о топ магазине
        };
      })
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 20); // Топ 20 товаров

    const byBrand = Array.from(brandStats.values())
      .map(stat => ({
        ...stat,
        productsCount: stat.productsCount.size
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const daily = Array.from(dailyStats.values())
      .sort((a, b) => a.date.localeCompare(b.date));

    const weekly = Array.from(weeklyStats.values())
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    const monthly = Array.from(monthlyStats.values())
      .sort((a, b) => a.month.localeCompare(b.month));

    // Получаем планы для сравнения
    const linkIds = await resolveSalesRepLinkIds(req);
    const plans = linkIds.length
      ? await Plan.find({
          salesRepresentativeId: { $in: linkIds },
          startDate: { $lte: endDate },
          $or: [
            { endDate: { $gte: startDate } },
            { endDate: null }
          ]
        })
          .sort({ createdAt: -1 })
          .lean()
      : [];

    // Сравниваем факт с планами
    const plansWithProgress = plans.map(plan => {
      // Определяем период плана для сравнения
      let planStartDate = startDate;
      let planEndDate = endDate;

      if (plan.startDate) {
        planStartDate = new Date(Math.max(startDate.getTime(), new Date(plan.startDate).getTime()));
      }
      if (plan.endDate) {
        planEndDate = new Date(Math.min(endDate.getTime(), new Date(plan.endDate).getTime()));
      }

      // Получаем продажи за период плана
      const planSales = sales.filter(sale => {
        const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
        return saleDate >= planStartDate && saleDate <= planEndDate;
      });

      const planRevenue = planSales.reduce((sum, sale) => sum + (sale.totalAmount || 0), 0);
      let planQuantity = 0;
      planSales.forEach(sale => {
        if (sale.items) {
          sale.items.forEach(item => {
            planQuantity += item.quantity || 0;
          });
        }
      });

      return {
        ...plan,
        actualRevenue: planRevenue,
        actualQuantity: planQuantity,
        revenueProgress: plan.targetAmount > 0 ? (planRevenue / plan.targetAmount) * 100 : 0,
        quantityProgress: plan.targetQuantity > 0 ? (planQuantity / plan.targetQuantity) * 100 : 0,
        revenueRemaining: Math.max(0, plan.targetAmount - planRevenue),
        quantityRemaining: Math.max(0, plan.targetQuantity - planQuantity)
      };
    });

    res.json({
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      },
      stores: {
        total: context.storeIds.length,
        ids: context.storeIds
      },
      summary: {
        totalSales,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalQuantity,
        averageSale: Math.round(averageSale * 100) / 100
      },
      byPeriod: {
        daily,
        weekly,
        monthly
      },
      byStore,
      byProduct,
      byBrand,
      byStoreProducts, // Детальная статистика по товарам в каждом магазине
      plans: plansWithProgress
    });
  } catch (error) {
    console.error('Ошибка при получении аналитики продаж ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении аналитики продаж' });
  }
}

// Получение товаров с истекающим сроком годности
async function getExpiringProducts(req, res) {
  try {
    const context = await getSalesRepStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({ items: [], total: 0 });
    }

    // Парсим параметры
    const warningDays = parseNumber(req.query.warningDays, 14); // По умолчанию 14 дней
    const storeIds = context.storeIds;
    const { offers, productById } = await loadOffersWithProducts(storeIds);

    const now = new Date();
    const expiringItems = [];

    offers.forEach(offer => {
      const product = productById.get(offer.productId);
      if (!product) return;

      const store = context.storesById.get(offer.storeId);
      if (!store) return;

      // Вычисляем дату истечения срока годности
      let expiryDate = null;
      let daysLeft = null;

      if (product.expirationDate) {
        expiryDate = new Date(product.expirationDate);
      } else if (product.productionDate && product.storageLife) {
        const storageDays = parseStorageLifeDays(product.storageLife);
        if (storageDays) {
          expiryDate = new Date(product.productionDate);
          expiryDate.setDate(expiryDate.getDate() + storageDays);
        }
      }

      if (expiryDate) {
        daysLeft = Math.ceil((expiryDate - now) / (24 * 60 * 60 * 1000));
        
        // Добавляем товар, если срок годности истекает в ближайшие warningDays дней
        if (daysLeft >= 0 && daysLeft <= warningDays) {
          expiringItems.push({
            offerId: offer.id,
            storeId: store.id,
            storeName: store.name,
            storeAddress: store.address,
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            brandId: product.brandId,
            brandName: product.brandName,
            quantity: offer.quantity || 0,
            price: offer.price || 0,
            currency: offer.currency || 'RUB',
            expiryDate: expiryDate.toISOString(),
            daysLeft
          });
        }
      }
    });

    // Сортируем по количеству оставшихся дней (от меньшего к большему)
    expiringItems.sort((a, b) => a.daysLeft - b.daysLeft);

    res.json({
      items: expiringItems,
      total: expiringItems.length
    });
  } catch (error) {
    console.error('Ошибка при получении товаров с истекающим сроком годности:', error);
    res.status(500).json({ error: 'Ошибка при получении товаров с истекающим сроком годности' });
  }
}

// Получение товаров, которые плохо продаются
async function getPoorlySellingProducts(req, res) {
  try {
    const context = await getSalesRepStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({ items: [], total: 0 });
    }

    // Парсим параметры
    const minQuantity = parseNumber(req.query.minQuantity, 10); // Минимальный остаток для попадания в список
    const periodDays = parseNumber(req.query.periodDays, 30); // Период для анализа продаж (дней)
    const maxSales = parseNumber(req.query.maxSales, 5); // Максимальное количество продаж за период

    const storeIds = context.storeIds;
    const { offers, productById } = await loadOffersWithProducts(storeIds);

    // Вычисляем период для анализа продаж
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Получаем все завершенные продажи за период
    const sales = await Sale.find({
      storeId: { $in: storeIds },
      status: 'COMPLETED',
      $or: [
        {
          completedAt: { $exists: true, $ne: null, $gte: startDate, $lte: endDate }
        },
        {
          $or: [
            { completedAt: { $exists: false } },
            { completedAt: null }
          ],
          createdAt: { $gte: startDate, $lte: endDate }
        }
      ]
    }).lean();

    // Подсчитываем количество продаж по каждому товару
    const productSalesCount = new Map(); // productId -> количество продаж
    const productSalesQuantity = new Map(); // productId -> общее количество проданных штук

    sales.forEach(sale => {
      if (sale.items) {
        sale.items.forEach(item => {
          const currentCount = productSalesCount.get(item.productId) || 0;
          productSalesCount.set(item.productId, currentCount + 1);

          const currentQuantity = productSalesQuantity.get(item.productId) || 0;
          productSalesQuantity.set(item.productId, currentQuantity + (item.quantity || 0));
        });
      }
    });

    // Формируем список товаров, которые плохо продаются
    const poorlySellingItems = [];

    offers.forEach(offer => {
      const product = productById.get(offer.productId);
      if (!product) return;

      const store = context.storesById.get(offer.storeId);
      if (!store) return;

      const quantity = offer.quantity || 0;

      // Проверяем, попадает ли товар под критерии "плохо продается"
      // 1. Остаток больше минимального
      // 2. Количество продаж за период меньше максимального (или 0)
      if (quantity >= minQuantity) {
        const salesCount = productSalesCount.get(product.id) || 0;
        const soldQuantity = productSalesQuantity.get(product.id) || 0;

        if (salesCount <= maxSales) {
          poorlySellingItems.push({
            offerId: offer.id,
            storeId: store.id,
            storeName: store.name,
            storeAddress: store.address,
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            brandId: product.brandId,
            brandName: product.brandName,
            quantity: quantity,
            price: offer.price || 0,
            currency: offer.currency || 'RUB',
            salesCount: salesCount, // Количество продаж за период
            soldQuantity: soldQuantity, // Количество проданных штук за период
            periodDays: periodDays
          });
        }
      }
    });

    // Сортируем: сначала товары с большим остатком и нулевыми продажами, потом по остатку
    poorlySellingItems.sort((a, b) => {
      // Сначала товары без продаж
      if (a.salesCount === 0 && b.salesCount > 0) return -1;
      if (a.salesCount > 0 && b.salesCount === 0) return 1;
      // Потом по остатку (от большего к меньшему)
      return b.quantity - a.quantity;
    });

    res.json({
      items: poorlySellingItems,
      total: poorlySellingItems.length
    });
  } catch (error) {
    console.error('Ошибка при получении товаров, которые плохо продаются:', error);
    res.status(500).json({ error: 'Ошибка при получении товаров, которые плохо продаются' });
  }
}

// Получение продаж конкретного товара по магазинам (для торгового представителя)
async function getProductSalesByStores(req, res) {
  try {
    const { productId } = req.params;
    
    if (!productId) {
      return res.status(400).json({ error: 'ID товара обязателен' });
    }

    const context = await getSalesRepStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({
        productId,
        product: null,
        period: {
          startDate: null,
          endDate: null
        },
        stores: [],
        total: 0,
        summary: {
          totalSales: 0,
          totalRevenue: 0,
          totalQuantity: 0
        }
      });
    }

    // Парсим даты из query параметров
    let startDate = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // По умолчанию 30 дней
    let endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
    
    // Устанавливаем startDate на начало дня (00:00:00)
    startDate.setHours(0, 0, 0, 0);
    // Устанавливаем endDate на конец дня (23:59:59.999)
    endDate.setHours(23, 59, 59, 999);

    // Получаем информацию о товаре
    const product = await Product.findOne({ id: productId }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Получаем все завершенные продажи из магазинов ТП
    const allCompletedSales = await Sale.find({
      storeId: { $in: context.storeIds },
      status: 'COMPLETED'
    })
      .sort({ completedAt: -1, createdAt: -1 })
      .lean();

    // Фильтруем по дате и товару
    const sales = allCompletedSales.filter(sale => {
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
      if (saleDate < startDate || saleDate > endDate) return false;
      
      // Проверяем, есть ли в продаже нужный товар
      if (!sale.items || !Array.isArray(sale.items)) return false;
      return sale.items.some(item => item.productId === productId);
    });

    // Группируем продажи по магазинам
    const storeSalesMap = new Map();
    
    // Инициализируем статистику для каждого магазина
    context.stores.forEach(store => {
      storeSalesMap.set(store.id, {
        storeId: store.id,
        storeName: store.name,
        storeAddress: store.address,
        sales: [],
        totalSales: 0,
        totalRevenue: 0,
        totalQuantity: 0
      });
    });

    // Обрабатываем каждую продажу
    sales.forEach(sale => {
      const storeStat = storeSalesMap.get(sale.storeId);
      if (!storeStat) return;

      // Находим товар в продаже
      const productItem = sale.items.find(item => item.productId === productId);
      if (!productItem) return;

      const quantity = productItem.quantity || 0;
      const price = productItem.price || 0;
      const revenue = quantity * price;
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);

      storeStat.sales.push({
        saleId: sale.id,
        saleDate: saleDate.toISOString(),
        quantity,
        price,
        revenue: Math.round(revenue * 100) / 100,
        totalAmount: sale.totalAmount || 0,
        currency: sale.currency || 'RUB'
      });

      storeStat.totalSales += 1;
      storeStat.totalQuantity += quantity;
      storeStat.totalRevenue += revenue;
    });

    // Преобразуем в массив и сортируем
    const stores = Array.from(storeSalesMap.values())
      .filter(store => store.totalSales > 0) // Только магазины с продажами
      .sort((a, b) => b.totalRevenue - a.totalRevenue); // Сортируем по выручке

    // Общая статистика
    const summary = {
      totalSales: sales.length,
      totalRevenue: Math.round(
        stores.reduce((sum, store) => sum + store.totalRevenue, 0) * 100
      ) / 100,
      totalQuantity: stores.reduce((sum, store) => sum + store.totalQuantity, 0)
    };

    res.json({
      productId,
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandId: product.brandId,
        brandName: product.brandName
      },
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      },
      stores,
      total: stores.length,
      summary
    });
  } catch (error) {
    console.error('Ошибка при получении продаж товара по магазинам:', error);
    res.status(500).json({ error: 'Ошибка при получении продаж товара по магазинам' });
  }
}

module.exports = {
  getMyProductGroups,
  getMyStockControl,
  getMyAiAnalytics,
  getMySalesRepresentative,
  updateMySalesRepresentative,
  getMyProducts,
  getMySalesAnalytics,
  getExpiringProducts,
  getPoorlySellingProducts,
  getProductSalesByStores
};

