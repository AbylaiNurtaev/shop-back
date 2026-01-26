const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');

const { Offer, Product, Category, User, BrandDistributorRequest } = models;

const STORE_ROLES = ['STORE', 'STORE_USER'];

// Получение storeId для владельца магазина
async function getStoreIdForStoreOwner(user) {
  if (!user || !user.userId) {
    return null;
  }

  const userDoc = await User.findOne({ 
    id: user.userId, 
    role: { $in: STORE_ROLES } 
  }).lean();
  return userDoc ? userDoc.storeId : null;
}

async function createOffer(req, res) {
  try {
    const { productId, storeId, price, currency, isAvailable, quantity } = req.body;

    if (!productId || !storeId || price === undefined || !currency) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }

    // Получаем товар для проверки бренда
    const product = await Product.findOne({ id: productId }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Получаем пользователя магазина для проверки дистрибьютора
    const storeUser = await User.findOne({
      storeId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    if (!storeUser) {
      return res.status(404).json({ error: 'Магазин не найден или не активен' });
    }

    // Если магазин привязан к дистрибьютору, проверяем связь бренда с дистрибьютором
    if (storeUser.distributorId) {
      const brandDistributorConnection = await BrandDistributorRequest.findOne({
        brandId: product.brandId,
        distributorId: storeUser.distributorId,
        status: 'ACCEPTED'
      }).lean();

      if (!brandDistributorConnection) {
        return res.status(403).json({
          error: 'Товар не может быть добавлен: бренд не подключен к дистрибьютору этого магазина'
        });
      }
    }

    const offer = await Offer.create({
      id: generateId(),
      productId,
      storeId,
      price,
      currency,
      isAvailable: isAvailable !== undefined ? isAvailable : true,
      quantity: quantity || 0
    });

    res.status(201).json(offer.toObject());
  } catch (error) {
    console.error('Ошибка при создании оффера:', error);
    res.status(500).json({ error: 'Ошибка при создании оффера' });
  }
}

async function getOfferById(req, res) {
  try {
    const { offerId } = req.params;
    const offer = await Offer.findOne({ id: offerId }).lean();

    if (!offer) {
      return res.status(404).json({ error: 'Оффер не найден' });
    }

    const product = await Product.findOne({ id: offer.productId }).lean();
    if (!product) {
      return res.json({ ...offer, product: null });
    }
    const category = await Category.findOne({ id: product.categoryId }).lean();

    res.json({
      ...offer,
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandName: product.brandName,
        packageInfo: product.packageInfo,
        brandId: product.brandId,
        storageLife: product.storageLife,
        productionDate: product.productionDate,
        allergens: product.allergens,
        ageRestrictions: product.ageRestrictions,
        category: category ? { id: category.id, name: category.name } : null
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении оффера' });
  }
}

async function getOffers(req, res) {
  try {
    let query = {};
    if (req.user && req.user.userId) {
      const user = await models.User.findOne({ id: req.user.userId }).lean();
      if (user && user.storeId) {
        query = { storeId: user.storeId };
      } else if (req.user && req.user.brandId) {
        const brandProducts = await Product.find({ brandId: req.user.brandId }, 'id').lean();
        const brandProductIds = brandProducts.map(product => product.id);
        query = brandProductIds.length > 0
          ? { productId: { $in: brandProductIds } }
          : { productId: { $in: [] } };
      }
    }

    const offers = await Offer.find(query).lean();
    const productIds = offers.map(offer => offer.productId);
    const products = productIds.length > 0
      ? await Product.find({ id: { $in: productIds } }).lean()
      : [];
    const categoryIds = [...new Set(products.map(product => product.categoryId))];
    const categories = categoryIds.length > 0
      ? await Category.find({ id: { $in: categoryIds } }).lean()
      : [];
    const productById = new Map(products.map(product => [product.id, product]));
    const categoryById = new Map(categories.map(category => [category.id, category]));

    res.json({
      items: offers.map(offer => {
        const product = productById.get(offer.productId) || null;
        const category = product ? categoryById.get(product.categoryId) || null : null;
        return {
          ...offer,
          product: product
            ? {
                id: product.id,
                name: product.name,
                sku: product.sku,
                brandName: product.brandName,
                  packageInfo: product.packageInfo,
                  brandId: product.brandId,
                  storageLife: product.storageLife,
                  productionDate: product.productionDate,
                  allergens: product.allergens,
                  ageRestrictions: product.ageRestrictions,
                category: category ? { id: category.id, name: category.name } : null
              }
            : null
        };
      }),
      total: offers.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении списка офферов' });
  }
}

async function updateOffer(req, res) {
  try {
    const { offerId } = req.params;
    let { price, currency, isAvailable, quantity } = req.body;

    // Проверяем существование оффера
    const offer = await Offer.findOne({ id: offerId }).lean();
    if (!offer) {
      return res.status(404).json({ error: 'Оффер не найден' });
    }

    // Проверяем права доступа: владелец магазина может обновлять только свои офферы
    const userStoreId = await getStoreIdForStoreOwner(req.user);
    if (userStoreId && offer.storeId !== userStoreId) {
      return res.status(403).json({ 
        error: 'Нет доступа к этому офферу. Вы можете изменять только цены товаров своего магазина' 
      });
    }

    // Если пользователь не является владельцем магазина, проверяем другие роли (например, ADMIN)
    if (!userStoreId) {
      // Проверяем, является ли пользователь администратором
      if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ 
          error: 'Только владелец магазина может изменять цены товаров' 
        });
      }
    }

    // Преобразуем цену в число, если она передана как строка
    if (price !== undefined && price !== null) {
      const numPrice = typeof price === 'string' ? parseFloat(price) : price;
      if (isNaN(numPrice) || numPrice < 0) {
        return res.status(400).json({ error: 'Цена должна быть неотрицательным числом' });
      }
      price = numPrice;
    }

    const update = { updatedAt: new Date() };
    // Явно обновляем цену, даже если она равна 0
    if (price !== undefined && price !== null) {
      update.price = price;
      console.log(`Обновление цены оффера ${offerId}: старая цена = ${offer.price}, новая цена = ${price}`);
    }
    if (currency !== undefined) update.currency = currency;
    if (isAvailable !== undefined) update.isAvailable = isAvailable;
    if (quantity !== undefined) update.quantity = quantity;

    const updatedOffer = await Offer.findOneAndUpdate({ id: offerId }, update, {
      new: true
    }).lean();

    console.log(`Оффер ${offerId} обновлен. Финальная цена: ${updatedOffer.price}`);

    res.json(updatedOffer);
  } catch (error) {
    console.error('Ошибка при обновлении оффера:', error);
    res.status(500).json({ error: 'Ошибка при обновлении оффера' });
  }
}

async function deleteOffer(req, res) {
  try {
    const { offerId } = req.params;
    const result = await Offer.deleteOne({ id: offerId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Оффер не найден' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении оффера' });
  }
}

module.exports = {
  createOffer,
  getOfferById,
  getOffers,
  updateOffer,
  deleteOffer
};
