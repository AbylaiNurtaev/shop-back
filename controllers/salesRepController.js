const { models } = require('../models/database');

const {
  User,
  SalesRepresentative,
  SalesRepresentativeStore,
  Store,
  Offer,
  Product,
  Category
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

module.exports = {
  getMyProductGroups,
  getMyStockControl,
  getMyAiAnalytics
};

