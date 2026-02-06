const crypto = require('crypto');
const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { calculateDistance, getCoordinatesFromLink } = require('../utils/distance');

const { Product, Offer, Store, Brand, User, BrandDistributorRequest, DistributorProductPrice } = models;
const { checkAndDisableExpiredPayments } = require('../utils/paymentExpiration');

const STORE_ROLES = ['STORE', 'STORE_USER'];

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

function calculateExpirationDate(productionDate, storageLife) {
  if (!productionDate || !storageLife) return null;
  const storageDays = parseStorageLifeDays(storageLife);
  if (!storageDays) return null;
  const expirationDate = new Date(productionDate);
  expirationDate.setDate(expirationDate.getDate() + storageDays);
  return expirationDate;
}

async function createProduct(req, res) {
  try {
    const {
      name,
      description,
      categoryId,
      images,
      sku,
      brandId,
      packageInfo,
      // Себестоимость от бренда
      costPrice,
      costCurrency,
      // Поля для карточек товаров бренда
      storageLife,
      productionDate,
      allergens,
      ageRestrictions
    } = req.body;

    const resolvedBrandId = brandId || (req.user && req.user.brandId) || null;

    // Проверка обязательных полей (проверяем не только наличие, но и что строки не пустые)
    const missingFields = [];
    if (!name || (typeof name === 'string' && name.trim() === '')) missingFields.push('name');
    if (!categoryId || (typeof categoryId === 'string' && categoryId.trim() === '')) missingFields.push('categoryId');
    if (!sku || (typeof sku === 'string' && sku.trim() === '')) missingFields.push('sku');
    if (!resolvedBrandId) missingFields.push('brandId');
    if (!storageLife || (typeof storageLife === 'string' && storageLife.trim() === '')) missingFields.push('storageLife');
    if (!productionDate) missingFields.push('productionDate');

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `Отсутствуют обязательные поля: ${missingFields.join(', ')}`
      });
    }

    let brandName = null;

    // Если указан brandId, проверяем бренд и получаем его название
    const brand = await Brand.findOne({ id: resolvedBrandId }).lean();
    if (!brand) {
      return res.status(400).json({ error: 'Бренд не найден' });
    }
    brandName = brand.name;

    const parsedProductionDate = new Date(productionDate);
    if (Number.isNaN(parsedProductionDate.getTime())) {
      return res.status(400).json({ error: 'Некорректная дата изготовления' });
    }

    const expirationDate = calculateExpirationDate(parsedProductionDate, storageLife);

    const product = await Product.create({
      id: generateId(),
      name,
      description: description || null,
      categoryId,
      brandId: resolvedBrandId,
      brandName,
      images: images || [],
      sku,
      packageInfo: packageInfo !== undefined ? String(packageInfo) : null,
      // Себестоимость от бренда
      costPrice: costPrice !== undefined ? costPrice : null,
      costCurrency: costCurrency || 'RUB',
      // Поля для карточек товаров бренда
      storageLife: storageLife || null,
      productionDate: parsedProductionDate,
      expirationDate,
      allergens: allergens || null,
      ageRestrictions: ageRestrictions || null
    });

    // Создаем уведомления для всех дистрибьюторов, подключенных к этому бренду
    try {
      const { createNotificationForDistributorUsers } = require('./notificationController');
      const { models } = require('../models/database');
      const { BrandDistributorRequest } = models;

      // Находим всех дистрибьюторов, подключенных к этому бренду
      const connections = await BrandDistributorRequest.find({
        brandId: resolvedBrandId,
        status: 'ACCEPTED'
      }).lean();

      // Создаем уведомления для каждого дистрибьютора
      for (const connection of connections) {
        await createNotificationForDistributorUsers({
          distributorId: connection.distributorId,
          type: 'NEW_PRODUCT_FROM_BRAND',
          title: 'Новый товар от бренда',
          message: `Бренд "${brandName}" выложил новый товар: ${name}`,
          metadata: {
            brandId: resolvedBrandId,
            brandName,
            productId: product.id,
            productName: name,
            distributorId: connection.distributorId
          }
        });
      }
    } catch (notificationError) {
      console.error('Ошибка при создании уведомлений о новом товаре:', notificationError);
      // Не прерываем процесс, если уведомления не создались
    }

    res.status(201).json(product.toObject());
  } catch (error) {
    console.error('Ошибка при создании товара:', error);
    res.status(500).json({ error: 'Ошибка при создании товара' });
  }
}

async function getProductById(req, res) {
  try {
    const { productId } = req.params;
    const product = await Product.findOne({ id: productId }).lean();

    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Если это не владелец товара (бренд), проверяем оплату
    const isOwner = req.user && req.user.role === 'BRAND' && req.user.brandId === product.brandId;
    if (!isOwner) {
      // Проверяем, оплачен ли товар и не истекла ли оплата
      if (!product.isPayed || !product.paymentExpiresAt || new Date() >= new Date(product.paymentExpiresAt)) {
        return res.status(403).json({ error: 'Товар недоступен (не оплачен или срок оплаты истек)' });
      }
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении товара' });
  }
}

async function getProducts(req, res) {
  try {
    // Проверяем и отключаем товары с истекшей оплатой перед получением списка
    await checkAndDisableExpiredPayments();

    const { brandId } = req.query;
    let query = {};

    // Фильтр по brandId, если указан
    if (brandId) {
      query.brandId = brandId;
    }

    // Если пользователь авторизован как бренд, фильтруем по его brandId
    // Бренды видят все свои товары (включая неоплаченные)
    if (req.user && req.user.role === 'BRAND' && req.user.brandId && !brandId) {
      query.brandId = req.user.brandId;
    }

    // Если пользователь - магазин, фильтруем товары по дистрибьютору
    if (req.user && req.user.userId) {
      const user = await User.findOne({ id: req.user.userId }).lean();
      if (user && user.storeId && (user.role === 'STORE' || user.role === 'STORE_USER')) {
        // Магазин видит только товары брендов, подключенных к его дистрибьютору
        if (user.distributorId) {
          // Получаем все бренды, подключенные к дистрибьютору магазина
          const brandDistributorConnections = await BrandDistributorRequest.find({
            distributorId: user.distributorId,
            status: 'ACCEPTED'
          }).lean();

          const allowedBrandIds = brandDistributorConnections.map(conn => conn.brandId);
          
          if (allowedBrandIds.length === 0) {
            // Если нет подключенных брендов, возвращаем пустой список
            return res.json({
              items: [],
              total: 0
            });
          }

          // Фильтруем товары по разрешенным брендам
          if (query.brandId) {
            // Если указан конкретный brandId, проверяем, что он в списке разрешенных
            if (!allowedBrandIds.includes(query.brandId)) {
              return res.json({
                items: [],
                total: 0
              });
            }
          } else {
            // Если brandId не указан, фильтруем по всем разрешенным брендам
            query.brandId = { $in: allowedBrandIds };
          }
        } else {
          // Если магазин не привязан к дистрибьютору, не показываем товары
          return res.json({
            items: [],
            total: 0
          });
        }
      }
    }

    // Для всех остальных пользователей (дистрибьюторы, админы и т.д.)
    // показываем только оплаченные и не истекшие товары
    if (!req.user || req.user.role !== 'BRAND') {
      query.isPayed = true;
      query.paymentExpiresAt = { $gt: new Date() };
    }

    const products = await Product.find(query).lean();

    // Если пользователь - магазин, добавляем информацию об Offer (цена магазина) и себестоимость от дистрибьютора
    let enrichedProducts = products;
    if (req.user && req.user.userId) {
      const user = await User.findOne({ id: req.user.userId }).lean();
      if (user && user.storeId && (user.role === 'STORE' || user.role === 'STORE_USER')) {
        const productIds = products.map(p => p.id);
        
        // Получаем Offers (цены магазина)
        const offers = productIds.length > 0
          ? await Offer.find({ productId: { $in: productIds }, storeId: user.storeId }).lean()
          : [];
        const offerByProductId = new Map(offers.map(offer => [offer.productId, offer]));

        // Получаем себестоимости от дистрибьютора
        const costPrices = user.distributorId && productIds.length > 0
          ? await DistributorProductPrice.find({
              distributorId: user.distributorId,
              productId: { $in: productIds }
            }).lean()
          : [];
        const costPriceByProductId = new Map(costPrices.map(cp => [cp.productId, cp]));

        enrichedProducts = products.map(product => {
          const offer = offerByProductId.get(product.id);
          const costPrice = costPriceByProductId.get(product.id);
          return {
            ...product,
            // Себестоимость от дистрибьютора (из DistributorProductPrice)
            costPrice: costPrice ? costPrice.costPrice : null,
            costCurrency: costPrice ? costPrice.costCurrency : null,
            // Цена магазина (из Offer, если существует)
            storePrice: offer ? offer.price : null,
            storeCurrency: offer ? offer.currency : null,
            // Информация о наличии товара в магазине
            hasOffer: !!offer,
            offerQuantity: offer ? offer.quantity : null
          };
        });
      }
    }

    res.json({
      items: enrichedProducts,
      total: enrichedProducts.length
    });
  } catch (error) {
    console.error('Ошибка при получении списка товаров:', error);
    res.status(500).json({ error: 'Ошибка при получении списка товаров' });
  }
}

// Получение товаров конкретного бренда
async function getBrandProducts(req, res) {
  try {
    // Проверяем и отключаем товары с истекшей оплатой перед получением списка
    await checkAndDisableExpiredPayments();

    const { brandId } = req.params;

    const brand = await Brand.findOne({ id: brandId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Если пользователь - магазин, проверяем связь бренда с дистрибьютором
    if (req.user && req.user.userId) {
      const user = await User.findOne({ id: req.user.userId }).lean();
      if (user && user.storeId && (user.role === 'STORE' || user.role === 'STORE_USER')) {
        if (user.distributorId) {
          // Проверяем, подключен ли бренд к дистрибьютору магазина
          const brandDistributorConnection = await BrandDistributorRequest.findOne({
            brandId,
            distributorId: user.distributorId,
            status: 'ACCEPTED'
          }).lean();

          if (!brandDistributorConnection) {
            return res.status(403).json({
              error: 'Бренд не подключен к дистрибьютору этого магазина'
            });
          }
        } else {
          // Если магазин не привязан к дистрибьютору, не показываем товары
          return res.status(403).json({
            error: 'Магазин не привязан к дистрибьютору'
          });
        }
      }
    }

    // Если запрос делает сам бренд, показываем все товары
    // Если запрос делает другой пользователь, показываем только оплаченные и не истекшие
    let query = { brandId };
    if (!req.user || req.user.role !== 'BRAND' || req.user.brandId !== brandId) {
      query.isPayed = true;
      query.paymentExpiresAt = { $gt: new Date() };
    }

    const products = await Product.find(query).lean();

    res.json({
      items: products,
      total: products.length
    });
  } catch (error) {
    console.error('Ошибка при получении товаров бренда:', error);
    res.status(500).json({ error: 'Ошибка при получении товаров бренда' });
  }
}

async function updateProduct(req, res) {
  try {
    const { productId } = req.params;
    const {
      name,
      description,
      categoryId,
      images,
      sku,
      brandId,
      packageInfo,
      unitsPerPack,
      // Себестоимость от бренда
      costPrice,
      costCurrency,
      // Поля для карточек товаров бренда
      storageLife,
      productionDate,
      allergens,
      ageRestrictions
    } = req.body;

    const existingProduct = await Product.findOne({ id: productId }).lean();
    if (!existingProduct) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (categoryId !== undefined) update.categoryId = categoryId;
    if (images !== undefined) update.images = images;
    if (sku !== undefined) update.sku = sku;
    if (packageInfo !== undefined) update.packageInfo = packageInfo !== null ? String(packageInfo) : null;
    if (unitsPerPack !== undefined) {
      if (unitsPerPack === null) {
        update.unitsPerPack = null;
      } else {
        const numUnitsPerPack = typeof unitsPerPack === 'string' ? parseInt(unitsPerPack, 10) : unitsPerPack;
        if (isNaN(numUnitsPerPack) || numUnitsPerPack < 1) {
          return res.status(400).json({ error: 'unitsPerPack должен быть положительным числом' });
        }
        update.unitsPerPack = numUnitsPerPack;
      }
    }

    // Себестоимость от бренда
    if (costPrice !== undefined) update.costPrice = costPrice;
    if (costCurrency !== undefined) update.costCurrency = costCurrency;

    // Поля для карточек товаров бренда
    if (storageLife !== undefined) update.storageLife = storageLife;
    if (productionDate !== undefined) {
      if (!productionDate) {
        update.productionDate = null;
      } else {
        const parsedProductionDate = new Date(productionDate);
        if (Number.isNaN(parsedProductionDate.getTime())) {
          return res.status(400).json({ error: 'Некорректная дата изготовления' });
        }
        update.productionDate = parsedProductionDate;
      }
    }
    if (allergens !== undefined) update.allergens = allergens;
    if (ageRestrictions !== undefined) update.ageRestrictions = ageRestrictions;

    if (storageLife !== undefined || productionDate !== undefined) {
      const resolvedProductionDate =
        productionDate !== undefined ? update.productionDate : existingProduct.productionDate;
      const resolvedStorageLife =
        storageLife !== undefined ? update.storageLife : existingProduct.storageLife;
      update.expirationDate = calculateExpirationDate(resolvedProductionDate, resolvedStorageLife);
    }

    // Обновление brandId
    if (brandId !== undefined) {
      const brand = await Brand.findOne({ id: brandId }).lean();
      if (!brand) {
        return res.status(400).json({ error: 'Бренд не найден' });
      }
      update.brandId = brandId;
      update.brandName = brand.name;
    }

    const product = await Product.findOneAndUpdate({ id: productId }, update, {
      new: true
    }).lean();

    res.json(product);
  } catch (error) {
    console.error('Ошибка при обновлении товара:', error);
    res.status(500).json({ error: 'Ошибка при обновлении товара' });
  }
}

async function deleteProduct(req, res) {
  try {
    const { productId } = req.params;
    const result = await Product.deleteOne({ id: productId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении товара' });
  }
}

async function searchProducts(req, res) {
  try {
    // Проверяем и отключаем товары с истекшей оплатой перед поиском
    await checkAndDisableExpiredPayments();

    const { location, radiusMeters, search } = req.body;

    if (!location || location.lat === undefined || location.lng === undefined) {
      return res.status(400).json({ error: 'Отсутствует информация о местоположении' });
    }

    const radius = radiusMeters || 10000; // По умолчанию 10 км
    const searchTerm = (search || '').toLowerCase();

    // Фильтруем товары по поисковому запросу
    // В поиске показываем только оплаченные и не истекшие товары
    const query = {
      isPayed: true,
      paymentExpiresAt: { $gt: new Date() }
    };
    if (searchTerm) {
      query.$and = [
        {
          $or: [
            { name: { $regex: searchTerm, $options: 'i' } },
            { description: { $regex: searchTerm, $options: 'i' } }
          ]
        }
      ];
    }

    const products = await Product.find(query).lean();
    if (products.length === 0) {
      return res.json({ items: [], total: 0 });
    }

    const productIds = products.map(product => product.id);
    const offers = await Offer.find({
      productId: { $in: productIds },
      isAvailable: true
    }).lean();

    const storeIds = [...new Set(offers.map(offer => offer.storeId))];
    const stores = storeIds.length > 0
      ? await Store.find({ id: { $in: storeIds } }).lean()
      : [];
    const storeById = new Map(stores.map(store => [store.id, store]));

    const offersByProduct = new Map();
    for (const offer of offers) {
      const store = storeById.get(offer.storeId);
      if (!store || !store.location) continue;

      let coords = null;
      if (store.locationCoords && store.locationCoords.lat !== null && store.locationCoords.lng !== null) {
        coords = { lat: store.locationCoords.lat, lon: store.locationCoords.lng };
      } else {
        coords = await getCoordinatesFromLink(store.location);
        if (coords) {
          await Store.updateOne(
            { id: store.id },
            { locationCoords: { lat: coords.lat, lng: coords.lon } }
          );
        }
      }
      if (!coords) continue;

      const distance = calculateDistance(
        location.lat,
        location.lng,
        coords.lat,
        coords.lon
      );
      if (distance > radius) continue;

      const mappedOffer = {
        offerId: offer.id,
        price: offer.price,
        currency: offer.currency,
        isAvailable: offer.isAvailable,
        store: {
          id: store.id,
          name: store.name,
          address: store.address,
          location: store.location,
          distanceMeters: Math.round(distance)
        }
      };

      if (!offersByProduct.has(offer.productId)) {
        offersByProduct.set(offer.productId, []);
      }
      offersByProduct.get(offer.productId).push(mappedOffer);
    }

    const result = products
      .map(product => {
        const offersWithStores = (offersByProduct.get(product.id) || [])
          .sort((a, b) => a.store.distanceMeters - b.store.distanceMeters);

        if (offersWithStores.length === 0) return null;

        return {
          product: {
            id: product.id,
            name: product.name,
            description: product.description,
            images: product.images,
            categoryId: product.categoryId,
            sku: product.sku,
            brandName: product.brandName,
            packageInfo: product.packageInfo,
            brandId: product.brandId,
            storageLife: product.storageLife,
            productionDate: product.productionDate,
            allergens: product.allergens,
            ageRestrictions: product.ageRestrictions
          },
          offers: offersWithStores
        };
      })
      .filter(item => item !== null);

    res.json({
      items: result,
      total: result.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при поиске товаров' });
  }
}

function buildSkuCandidate() {
  return `SKU-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function generateUniqueSku(req, res) {
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = buildSkuCandidate();
      const exists = await Product.exists({ sku: candidate });
      if (!exists) {
        return res.json({ sku: candidate });
      }
    }
    return res.status(500).json({ error: 'Не удалось сгенерировать уникальный артикул' });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка при генерации артикула' });
  }
}

// Оплата одного товара брендом (активация на выбранный период)
// Оплата происходит на фронтенде, здесь только активация
async function payProduct(req, res) {
  try {
    const { productId } = req.params;
    const { periodMonths } = req.body; // Период оплаты в месяцах: 6, 9 или 12

    // Проверяем, что пользователь является брендом
    if (!req.user || req.user.role !== 'BRAND' || !req.user.brandId) {
      return res.status(403).json({ error: 'Только бренды могут оплачивать товары' });
    }

    // Валидация периода оплаты
    const allowedPeriods = [6, 9, 12];
    const period = periodMonths ? parseInt(periodMonths, 10) : null;
    
    if (!period || !allowedPeriods.includes(period)) {
      return res.status(400).json({ 
        error: 'Период оплаты обязателен и должен быть 6, 9 или 12 месяцев',
        allowedPeriods: allowedPeriods
      });
    }

    const product = await Product.findOne({ id: productId }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Проверяем, что товар принадлежит этому бренду
    if (product.brandId !== req.user.brandId) {
      return res.status(403).json({ error: 'Вы можете оплачивать только свои товары' });
    }

    // Устанавливаем оплату на выбранный период
    const paymentDate = new Date();
    const paymentExpiresAt = new Date(paymentDate);
    // Добавляем месяцы к дате оплаты
    paymentExpiresAt.setMonth(paymentExpiresAt.getMonth() + period);

    const updatedProduct = await Product.findOneAndUpdate(
      { id: productId },
      {
        isPayed: true,
        paymentDate,
        paymentExpiresAt,
        updatedAt: new Date()
      },
      { new: true }
    ).lean();

    const periodText = period === 6 ? '6 месяцев' : period === 9 ? '9 месяцев' : '12 месяцев';
    res.json({
      message: `Товар успешно оплачен. Показ товара активен на ${periodText}.`,
      product: updatedProduct
    });
  } catch (error) {
    console.error('Ошибка при оплате товара:', error);
    res.status(500).json({ 
      error: 'Ошибка при оплате товара',
      details: error.message 
    });
  }
}

// Оплата нескольких товаров брендом (активация на выбранный период)
// Оплата происходит на фронтенде, здесь только активация
async function payMultipleProducts(req, res) {
  try {
    const { productIds, periodMonths } = req.body; // Период оплаты в месяцах: 6, 9 или 12

    // Проверяем, что пользователь является брендом
    if (!req.user || req.user.role !== 'BRAND' || !req.user.brandId) {
      return res.status(403).json({ error: 'Только бренды могут оплачивать товары' });
    }

    // Валидация списка товаров
    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'Список товаров не указан или пустой' });
    }

    // Валидация периода оплаты
    const allowedPeriods = [6, 9, 12];
    const period = periodMonths ? parseInt(periodMonths, 10) : null;
    
    if (!period || !allowedPeriods.includes(period)) {
      return res.status(400).json({ 
        error: 'Период оплаты обязателен и должен быть 6, 9 или 12 месяцев',
        allowedPeriods: allowedPeriods
      });
    }

    // Проверяем все товары
    const products = await Product.find({ id: { $in: productIds } }).lean();
    
    if (products.length !== productIds.length) {
      return res.status(404).json({ error: 'Некоторые товары не найдены' });
    }

    // Проверяем, что все товары принадлежат этому бренду
    const notOwnedProducts = products.filter(p => p.brandId !== req.user.brandId);
    if (notOwnedProducts.length > 0) {
      return res.status(403).json({ 
        error: 'Вы можете оплачивать только свои товары',
        notOwnedProducts: notOwnedProducts.map(p => ({ id: p.id, name: p.name }))
      });
    }

    // Устанавливаем оплату на выбранный период для всех товаров
    const paymentDate = new Date();
    const paymentExpiresAt = new Date(paymentDate);
    // Добавляем месяцы к дате оплаты
    paymentExpiresAt.setMonth(paymentExpiresAt.getMonth() + period);

    await Product.updateMany(
      { id: { $in: productIds } },
      {
        isPayed: true,
        paymentDate,
        paymentExpiresAt,
        updatedAt: new Date()
      }
    );

    // Получаем обновленные товары
    const updatedProducts = await Product.find({ id: { $in: productIds } }).lean();

    const periodText = period === 6 ? '6 месяцев' : period === 9 ? '9 месяцев' : '12 месяцев';
    res.json({
      message: `${updatedProducts.length} товаров успешно оплачено. Показ товаров активен на ${periodText}.`,
      products: updatedProducts
    });
  } catch (error) {
    console.error('Ошибка при оплате товаров:', error);
    res.status(500).json({ 
      error: 'Ошибка при оплате товаров',
      details: error.message 
    });
  }
}

module.exports = {
  createProduct,
  getProductById,
  getProducts,
  getBrandProducts,
  updateProduct,
  deleteProduct,
  searchProducts,
  generateUniqueSku,
  payProduct,
  payMultipleProducts
};
