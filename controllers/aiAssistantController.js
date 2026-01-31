const { getDistributorAIAssistantResponse, getDemandForecastFromAI } = require('../utils/gemini');

// Вспомогательная функция для извлечения JSON из текста
function extractJson(text) {
  if (!text) return null;
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
const { models } = require('../models/database');

const { User, Distributor, Store, SalesRepresentativeStore, Product, Offer, Sale, BrandDistributorRequest, Category, Brand } = models;

const STORE_ROLES = ['STORE', 'STORE_USER'];

// Вспомогательная функция для парсинга срока годности
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

/**
 * Обработка сообщения от дистрибьютора к ИИ-помощнику
 * POST /api/ai-assistant/message
 */
async function handleAIAssistantMessage(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    // Проверяем, что пользователь является дистрибьютором
    const user = await User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(403).json({
        error: 'Доступ запрещен. Только дистрибьюторы могут использовать ИИ-помощника'
      });
    }

    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    // Получаем информацию о дистрибьюторе для контекста
    const distributor = await Distributor.findOne({ id: user.distributorId }).lean();

    // Формируем контекст (можно расширить в будущем)
    const context = distributor
      ? `Дистрибьютор: ${distributor.name || 'Не указано'}\nID: ${distributor.id}`
      : '';

    // Получаем ответ от ИИ-помощника
    const response = await getDistributorAIAssistantResponse({
      message: message.trim(),
      context
    });

    res.json({
      success: true,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при обработке сообщения ИИ-помощника:', error);
    res.status(500).json({
      error: 'Ошибка при обработке сообщения',
      message: error.message
    });
  }
}

/**
 * Готовый вопрос 1: Сколько торговых представителей у меня сейчас?
 * GET /api/ai-assistant/questions/sales-reps-count
 */
async function getSalesRepsCount(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(403).json({
        error: 'Доступ запрещен. Только дистрибьюторы могут использовать ИИ-помощника'
      });
    }

    const distributorId = user.distributorId;
    const count = await User.countDocuments({
      distributorId,
      role: 'SALES_REPRESENTATIVE',
      isActive: true
    });

    const data = { count };
    const question = 'Сколько торговых представителей у меня сейчас?';

    const response = await getDistributorAIAssistantResponse({
      message: `${question}\n\nДанные: ${JSON.stringify(data, null, 2)}`,
      context: `Дистрибьютор: ${user.distributorId}`
    });

    res.json({
      success: true,
      question,
      data,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при получении количества торговых представителей:', error);
    res.status(500).json({
      error: 'Ошибка при обработке запроса',
      message: error.message
    });
  }
}

/**
 * Готовый вопрос 2: Какие магазины сейчас без торгового представителя?
 * GET /api/ai-assistant/questions/stores-without-sales-reps
 */
async function getStoresWithoutSalesReps(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(403).json({
        error: 'Доступ запрещен. Только дистрибьюторы могут использовать ИИ-помощника'
      });
    }

    const distributorId = user.distributorId;

    // Получаем все магазины дистрибьютора
    const storeUsers = await User.find({
      distributorId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    const storeIds = Array.from(
      new Set(storeUsers.map(user => user.storeId).filter(Boolean))
    );

    const stores = storeIds.length
      ? await Store.find({ id: { $in: storeIds } }).lean()
      : [];

    // Получаем все связи магазинов с торговыми представителями
    const links = await SalesRepresentativeStore.find({
      distributorId,
      storeId: { $in: storeIds }
    }).lean();

    const storesWithSalesReps = new Set(links.map(link => link.storeId));
    const storesWithoutSalesReps = stores.filter(store => !storesWithSalesReps.has(store.id));

    const data = {
      total: storesWithoutSalesReps.length,
      stores: storesWithoutSalesReps.map(store => ({
        id: store.id,
        name: store.name,
        address: store.address
      }))
    };

    const question = 'Какие магазины сейчас без торгового представителя?';

    const response = await getDistributorAIAssistantResponse({
      message: `${question}\n\nДанные: ${JSON.stringify(data, null, 2)}`,
      context: `Дистрибьютор: ${user.distributorId}`
    });

    res.json({
      success: true,
      question,
      data,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при получении магазинов без торговых представителей:', error);
    res.status(500).json({
      error: 'Ошибка при обработке запроса',
      message: error.message
    });
  }
}

/**
 * Готовый вопрос 3: Какие бренды сейчас дают наибольший оборот?
 * GET /api/ai-assistant/questions/top-brands-turnover
 */
async function getTopBrandsTurnover(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(403).json({
        error: 'Доступ запрещен. Только дистрибьюторы могут использовать ИИ-помощника'
      });
    }

    const distributorId = user.distributorId;

    // Получаем все магазины дистрибьютора
    const storeUsers = await User.find({
      distributorId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    const storeIds = Array.from(new Set(storeUsers.map(user => user.storeId).filter(Boolean)));

    if (storeIds.length === 0) {
      const data = { brands: [], totalRevenue: 0 };
      const question = 'Какие бренды сейчас дают наибольший оборот?';
      const response = await getDistributorAIAssistantResponse({
        message: `${question}\n\nДанные: ${JSON.stringify(data, null, 2)}`,
        context: `Дистрибьютор: ${user.distributorId}`
      });

      return res.json({
        success: true,
        question,
        data,
        response,
        timestamp: new Date().toISOString()
      });
    }

    // Период: последние 30 дней
    const end = new Date();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    // Получаем завершенные продажи
    const allSales = await Sale.find({
      storeId: { $in: storeIds },
      status: 'COMPLETED'
    }).lean();

    const sales = allSales.filter(sale => {
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
      return saleDate >= start && saleDate <= end;
    });

    // Получаем информацию о товарах
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

    // Агрегация по брендам
    const brandStats = new Map();

    sales.forEach(sale => {
      if (sale.items) {
        sale.items.forEach(item => {
          const product = productById.get(item.productId);
          if (!product) return;

          const brandId = product.brandId;
          if (!brandStats.has(brandId)) {
            brandStats.set(brandId, {
              brandId,
              brandName: product.brandName || 'Неизвестный бренд',
              totalRevenue: 0,
              totalSales: 0,
              totalQuantity: 0
            });
          }

          const stat = brandStats.get(brandId);
          stat.totalRevenue += item.totalPrice || 0;
          stat.totalSales += 1;
          stat.totalQuantity += item.quantity || 0;
        });
      }
    });

    const brands = Array.from(brandStats.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 10); // Топ 10

    const totalRevenue = brands.reduce((sum, brand) => sum + brand.totalRevenue, 0);

    const data = {
      period: {
        startDate: start.toISOString(),
        endDate: end.toISOString()
      },
      brands: brands.map(brand => ({
        brandName: brand.brandName,
        totalRevenue: Math.round(brand.totalRevenue * 100) / 100,
        totalSales: brand.totalSales,
        totalQuantity: brand.totalQuantity
      })),
      totalRevenue: Math.round(totalRevenue * 100) / 100
    };

    const question = 'Какие бренды сейчас дают наибольший оборот?';

    const response = await getDistributorAIAssistantResponse({
      message: `${question}\n\nДанные: ${JSON.stringify(data, null, 2)}`,
      context: `Дистрибьютор: ${user.distributorId}`
    });

    res.json({
      success: true,
      question,
      data,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при получении оборота по брендам:', error);
    res.status(500).json({
      error: 'Ошибка при обработке запроса',
      message: error.message
    });
  }
}

/**
 * Готовый вопрос 4: Какие товары скоро истекают по сроку годности?
 * GET /api/ai-assistant/questions/expiring-products
 */
async function getExpiringProducts(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(403).json({
        error: 'Доступ запрещен. Только дистрибьюторы могут использовать ИИ-помощника'
      });
    }

    const distributorId = user.distributorId;

    // Получаем все магазины дистрибьютора
    const storeUsers = await User.find({
      distributorId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    const storeIds = Array.from(
      new Set(storeUsers.map(user => user.storeId).filter(Boolean))
    );

    if (storeIds.length === 0) {
      const data = { items: [], total: 0 };
      const question = 'Какие товары скоро истекают по сроку годности?';
      const response = await getDistributorAIAssistantResponse({
        message: `${question}\n\nДанные: ${JSON.stringify(data, null, 2)}`,
        context: `Дистрибьютор: ${user.distributorId}`
      });

      return res.json({
        success: true,
        question,
        data,
        response,
        timestamp: new Date().toISOString()
      });
    }

    // Параметры
    const warningDays = parseInt(req.query.warningDays) || 14; // По умолчанию 14 дней

    // Получаем предложения и товары
    const offers = await Offer.find({ storeId: { $in: storeIds } }).lean();
    const productIds = Array.from(new Set(offers.map(offer => offer.productId)));
    const products = productIds.length
      ? await Product.find({ id: { $in: productIds } }).lean()
      : [];
    const productById = new Map(products.map(p => [p.id, p]));

    // Получаем магазины
    const stores = await Store.find({ id: { $in: storeIds } }).lean();
    const storesById = new Map(stores.map(s => [s.id, s]));

    const now = new Date();
    const expiringItems = [];

    offers.forEach(offer => {
      const product = productById.get(offer.productId);
      if (!product) return;

      const store = storesById.get(offer.storeId);
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
            storeName: store.name,
            storeAddress: store.address,
            productName: product.name,
            sku: product.sku,
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

    const data = {
      warningDays,
      items: expiringItems.slice(0, 50), // Ограничиваем до 50 товаров
      total: expiringItems.length
    };

    const question = 'Какие товары скоро истекают по сроку годности?';

    const response = await getDistributorAIAssistantResponse({
      message: `${question}\n\nДанные: ${JSON.stringify(data, null, 2)}`,
      context: `Дистрибьютор: ${user.distributorId}`
    });

    res.json({
      success: true,
      question,
      data,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при получении товаров с истекающим сроком годности:', error);
    res.status(500).json({
      error: 'Ошибка при обработке запроса',
      message: error.message
    });
  }
}

/**
 * Прогноз спроса (AI)
 * GET /api/ai-assistant/demand-forecast
 * 
 * Query параметры:
 * - period: период прогноза в днях (по умолчанию 30)
 * - productId: фильтр по товару (опционально)
 * - categoryId: фильтр по категории (опционально)
 * - brandId: фильтр по бренду (опционально)
 * - storeId: фильтр по магазину (опционально)
 * - historyDays: количество дней истории для анализа (по умолчанию 90)
 */
async function getDemandForecast(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(403).json({
        error: 'Доступ запрещен. Только дистрибьюторы могут использовать прогноз спроса'
      });
    }

    const distributorId = user.distributorId;

    // Параметры запроса
    const forecastPeriodDays = parseInt(req.query.period) || 30; // Период прогноза
    const historyDays = parseInt(req.query.historyDays) || 90; // Период истории для анализа
    const productId = req.query.productId || null;
    const categoryId = req.query.categoryId || null;
    const brandId = req.query.brandId || null;
    const storeId = req.query.storeId || null;

    // Получаем все магазины дистрибьютора
    const storeUsers = await User.find({
      distributorId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    const allStoreIds = Array.from(
      new Set(storeUsers.map(user => user.storeId).filter(Boolean))
    );

    if (allStoreIds.length === 0) {
      return res.json({
        success: true,
        forecast: {
          period: {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + forecastPeriodDays * 24 * 60 * 60 * 1000).toISOString()
          },
          products: [],
          categories: [],
          brands: [],
          summary: {
            totalForecastedQuantity: 0,
            totalForecastedRevenue: 0,
            averageDailyDemand: 0
          }
        },
        timestamp: new Date().toISOString()
      });
    }

    // Фильтруем магазины, если указан storeId
    const storeIds = storeId
      ? (allStoreIds.includes(storeId) ? [storeId] : [])
      : allStoreIds;

    if (storeIds.length === 0 && storeId) {
      return res.status(404).json({ error: 'Магазин не найден или не принадлежит дистрибьютору' });
    }

    // Период истории для анализа
    const historyEnd = new Date();
    const historyStart = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);
    historyStart.setHours(0, 0, 0, 0);
    historyEnd.setHours(23, 59, 59, 999);

    // Получаем завершенные продажи за период истории
    const allSales = await Sale.find({
      storeId: { $in: storeIds },
      status: 'COMPLETED'
    }).lean();

    // Фильтруем по дате
    const sales = allSales.filter(sale => {
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
      return saleDate >= historyStart && saleDate <= historyEnd;
    });

    // Получаем информацию о товарах
    const productIds = new Set();
    sales.forEach(sale => {
      if (sale.items) {
        sale.items.forEach(item => {
          productIds.add(item.productId);
        });
      }
    });

    // Применяем фильтры
    let productFilter = { id: { $in: Array.from(productIds) } };
    if (productId) productFilter.id = productId;
    if (categoryId) productFilter.categoryId = categoryId;
    if (brandId) productFilter.brandId = brandId;

    const products = productIds.size
      ? await Product.find(productFilter).lean()
      : [];

    const productById = new Map(products.map(p => [p.id, p]));

    // Если указан productId, но товар не найден
    if (productId && products.length === 0) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Агрегация продаж по товарам
    const productStats = new Map();

    sales.forEach(sale => {
      if (sale.items) {
        sale.items.forEach(item => {
          const product = productById.get(item.productId);
          if (!product) return;

          // Применяем фильтры
          if (productId && product.id !== productId) return;
          if (categoryId && product.categoryId !== categoryId) return;
          if (brandId && product.brandId !== brandId) return;

          if (!productStats.has(item.productId)) {
            productStats.set(item.productId, {
              productId: item.productId,
              productName: item.productName,
              sku: item.sku,
              brandId: product.brandId,
              brandName: product.brandName,
              categoryId: product.categoryId,
              totalQuantity: 0,
              totalRevenue: 0,
              saleCount: 0,
              dailyStats: new Map() // Дата -> { quantity, revenue, count }
            });
          }

          const stat = productStats.get(item.productId);
          stat.totalQuantity += item.quantity || 0;
          stat.totalRevenue += item.totalPrice || 0;
          stat.saleCount += 1;

          // Статистика по дням
          const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
          const dateKey = saleDate.toISOString().split('T')[0]; // YYYY-MM-DD

          if (!stat.dailyStats.has(dateKey)) {
            stat.dailyStats.set(dateKey, { quantity: 0, revenue: 0, count: 0 });
          }
          const dailyStat = stat.dailyStats.get(dateKey);
          dailyStat.quantity += item.quantity || 0;
          dailyStat.revenue += item.totalPrice || 0;
          dailyStat.count += 1;
        });
      }
    });

    // Подготавливаем данные для AI
    const productsData = Array.from(productStats.values()).map(stat => {
      const dailyStatsArray = Array.from(stat.dailyStats.entries())
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const avgDailyQuantity = stat.totalQuantity / Math.max(historyDays, 1);
      const avgDailyRevenue = stat.totalRevenue / Math.max(historyDays, 1);

      return {
        productId: stat.productId,
        productName: stat.productName,
        sku: stat.sku,
        brandName: stat.brandName,
        categoryId: stat.categoryId,
        totalQuantity: stat.totalQuantity,
        totalRevenue: stat.totalRevenue,
        saleCount: stat.saleCount,
        avgDailyQuantity,
        avgDailyRevenue,
        dailyStats: dailyStatsArray.slice(-30) // Последние 30 дней для анализа тренда
      };
    });

    // Агрегация по категориям
    const categoryStats = new Map();
    productsData.forEach(product => {
      if (!product.categoryId) return;
      if (!categoryStats.has(product.categoryId)) {
        categoryStats.set(product.categoryId, {
          categoryId: product.categoryId,
          totalQuantity: 0,
          totalRevenue: 0,
          productCount: 0
        });
      }
      const catStat = categoryStats.get(product.categoryId);
      catStat.totalQuantity += product.totalQuantity;
      catStat.totalRevenue += product.totalRevenue;
      catStat.productCount += 1;
    });

    // Агрегация по брендам
    const brandStats = new Map();
    productsData.forEach(product => {
      if (!product.brandName) return;
      if (!brandStats.has(product.brandName)) {
        brandStats.set(product.brandName, {
          brandName: product.brandName,
          totalQuantity: 0,
          totalRevenue: 0,
          productCount: 0
        });
      }
      const brandStat = brandStats.get(product.brandName);
      brandStat.totalQuantity += product.totalQuantity;
      brandStat.totalRevenue += product.totalRevenue;
      brandStat.productCount += 1;
    });

    // Формируем промпт для AI
    const forecastPrompt = `Ты эксперт по прогнозированию спроса на товары. Проанализируй исторические данные о продажах и сделай прогноз спроса на следующие ${forecastPeriodDays} дней.

ИСТОРИЧЕСКИЙ ПЕРИОД: ${historyDays} дней (с ${historyStart.toISOString().split('T')[0]} по ${historyEnd.toISOString().split('T')[0]})
ПЕРИОД ПРОГНОЗА: ${forecastPeriodDays} дней

ДАННЫЕ О ПРОДАЖАХ:
${JSON.stringify(productsData.slice(0, 50), null, 2)}

${categoryStats.size > 0 ? `СТАТИСТИКА ПО КАТЕГОРИЯМ:\n${JSON.stringify(Array.from(categoryStats.values()), null, 2)}\n` : ''}
${brandStats.size > 0 ? `СТАТИСТИКА ПО БРЕНДАМ:\n${JSON.stringify(Array.from(brandStats.values()), null, 2)}\n` : ''}

ЗАДАЧА:
1. Проанализируй тренды продаж по каждому товару
2. Учти сезонность, если она есть
3. Сделай прогноз спроса (количество единиц) на следующие ${forecastPeriodDays} дней
4. Рассчитай прогнозируемую выручку на основе средних цен
5. Укажи уровень уверенности прогноза (high/medium/low)

КРИТИЧЕСКИ ВАЖНО: Верни ТОЛЬКО валидный JSON без дополнительного текста, комментариев или объяснений. Начни ответ сразу с символа открывающей фигурной скобки и закончи символом закрывающей фигурной скобки.

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON, БЕЗ МАРКДАУНА):
{
  "forecast": {
    "products": [
      {
        "productId": "id товара",
        "productName": "название",
        "forecastedQuantity": число,
        "forecastedRevenue": число,
        "dailyAverage": число,
        "confidence": "high/medium/low",
        "trend": "increasing/stable/decreasing",
        "notes": "краткое пояснение"
      }
    ],
    "summary": {
      "totalForecastedQuantity": число,
      "totalForecastedRevenue": число,
      "averageDailyDemand": число
    }
  }
}

ПРАВИЛА:
- Если данных недостаточно для прогноза, укажи confidence: "low"
- Если тренд неясен, укажи trend: "stable"
- Будь реалистичным в прогнозах, не завышай цифры
- Учитывай, что если товар продавался редко, прогноз должен быть консервативным
- НЕ добавляй markdown форматирование
- НЕ добавляй пояснения до или после JSON
- Верни ТОЛЬКО чистый JSON объект`;

    // Получаем прогноз от AI
    let aiForecast;
    try {
      const aiResponse = await getDemandForecastFromAI({
        prompt: forecastPrompt,
        context: `Дистрибьютор: ${distributorId}, Прогноз спроса на ${forecastPeriodDays} дней`
      });

      // Пытаемся извлечь JSON из ответа
      aiForecast = extractJson(aiResponse);
      if (!aiForecast) {
        console.warn('Не удалось извлечь JSON из ответа AI, используем экстраполяцию');
        console.warn('Ответ AI (первые 1000 символов):', aiResponse ? aiResponse.substring(0, 1000) : 'пустой ответ');
      } else {
        console.log('Успешно извлечен JSON из ответа AI');
      }
    } catch (error) {
      console.error('Ошибка при получении прогноза от AI:', error);
    }

    // Если AI не вернул прогноз, используем простую экстраполяцию
    if (!aiForecast || !aiForecast.forecast) {
      aiForecast = {
        forecast: {
          products: productsData.map(product => {
            const forecastedQuantity = Math.round(product.avgDailyQuantity * forecastPeriodDays);
            const forecastedRevenue = product.avgDailyRevenue * forecastPeriodDays;
            return {
              productId: product.productId,
              productName: product.productName,
              forecastedQuantity,
              forecastedRevenue: Math.round(forecastedRevenue * 100) / 100,
              dailyAverage: Math.round(product.avgDailyQuantity * 100) / 100,
              confidence: product.saleCount < 10 ? 'low' : product.saleCount < 30 ? 'medium' : 'high',
              trend: 'stable',
              notes: 'Прогноз основан на среднем дневном спросе'
            };
          }),
          summary: {
            totalForecastedQuantity: 0,
            totalForecastedRevenue: 0,
            averageDailyDemand: 0
          }
        }
      };

      // Рассчитываем итоги
      aiForecast.forecast.summary.totalForecastedQuantity = aiForecast.forecast.products.reduce(
        (sum, p) => sum + p.forecastedQuantity, 0
      );
      aiForecast.forecast.summary.totalForecastedRevenue = Math.round(
        aiForecast.forecast.products.reduce((sum, p) => sum + p.forecastedRevenue, 0) * 100
      ) / 100;
      aiForecast.forecast.summary.averageDailyDemand = Math.round(
        aiForecast.forecast.summary.totalForecastedQuantity / forecastPeriodDays * 100
      ) / 100;
    }

    // Добавляем информацию о категориях и брендах
    const categoriesForecast = Array.from(categoryStats.entries()).map(([categoryId, stat]) => {
      const categoryProducts = productsData.filter(p => p.categoryId === categoryId);
      const categoryForecast = aiForecast.forecast.products.filter(p =>
        categoryProducts.some(cp => cp.productId === p.productId)
      );
      return {
        categoryId,
        totalForecastedQuantity: categoryForecast.reduce((sum, p) => sum + p.forecastedQuantity, 0),
        totalForecastedRevenue: Math.round(
          categoryForecast.reduce((sum, p) => sum + p.forecastedRevenue, 0) * 100
        ) / 100,
        productCount: categoryForecast.length
      };
    });

    const brandsForecast = Array.from(brandStats.entries()).map(([brandName, stat]) => {
      const brandProducts = productsData.filter(p => p.brandName === brandName);
      const brandForecast = aiForecast.forecast.products.filter(p =>
        brandProducts.some(bp => bp.productId === p.productId)
      );
      return {
        brandName,
        totalForecastedQuantity: brandForecast.reduce((sum, p) => sum + p.forecastedQuantity, 0),
        totalForecastedRevenue: Math.round(
          brandForecast.reduce((sum, p) => sum + p.forecastedRevenue, 0) * 100
        ) / 100,
        productCount: brandForecast.length
      };
    });

    res.json({
      success: true,
      forecast: {
        period: {
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + forecastPeriodDays * 24 * 60 * 60 * 1000).toISOString(),
          days: forecastPeriodDays
        },
        history: {
          startDate: historyStart.toISOString(),
          endDate: historyEnd.toISOString(),
          days: historyDays
        },
        filters: {
          productId: productId || null,
          categoryId: categoryId || null,
          brandId: brandId || null,
          storeId: storeId || null
        },
        products: aiForecast.forecast.products,
        categories: categoriesForecast,
        brands: brandsForecast,
        summary: aiForecast.forecast.summary
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при получении прогноза спроса:', error);
    res.status(500).json({
      error: 'Ошибка при обработке запроса',
      message: error.message
    });
  }
}

module.exports = {
  handleAIAssistantMessage,
  getSalesRepsCount,
  getStoresWithoutSalesReps,
  getTopBrandsTurnover,
  getExpiringProducts,
  getDemandForecast
};
