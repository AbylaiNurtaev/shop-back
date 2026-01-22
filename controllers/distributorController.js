const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');

const { Distributor, User, Store, Brand, BrandDistributorRequest, SalesRepresentative, SalesRepresentativeStore } = models;

const STORE_ROLES = ['STORE', 'STORE_USER'];

function normalizeLocation(location) {
  if (typeof location === 'string') return location;
  if (location && typeof location === 'object' && typeof location.link === 'string') {
    return location.link;
  }
  return location;
}

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

async function createDistributor(req, res) {
  try {
    const { name, address, location, description, photos } = req.body;
    const normalizedLocation = normalizeLocation(location);

    if (!name || !address || !normalizedLocation) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }

    const distributor = await Distributor.create({
      id: generateId(),
      name,
      address,
      location: normalizedLocation,
      description: description || null,
      photos: photos || []
    });

    res.status(201).json(distributor.toObject());
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании дистрибьютора' });
  }
}

async function getDistributorById(req, res) {
  try {
    const { distributorId } = req.params;
    const distributor = await Distributor.findOne({ id: distributorId }).lean();

    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    res.json(distributor);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении дистрибьютора' });
  }
}

async function getDistributors(req, res) {
  try {
    const { country, city, categoryId, hasActiveStores } = req.query;
    
    // Базовый запрос
    const query = {};
    
    // Фильтр по стране
    if (country) {
      query.country = country;
    }
    
    // Фильтр по городу
    if (city) {
      query.city = city;
    }
    
    let distributors = await Distributor.find(query).lean();
    
    // Если нужна фильтрация по категориям или активным магазинам,
    // нужно дополнительно обработать результаты
    if (categoryId || hasActiveStores === 'true') {
      const distributorIds = distributors.map(d => d.id);
      
      // Если нужны только дистрибьюторы с активными магазинами
      if (hasActiveStores === 'true') {
        const usersWithStores = await User.find({
          distributorId: { $in: distributorIds },
          role: { $in: STORE_ROLES },
          isActive: true
        }).lean();
        
        const distributorsWithStores = new Set(
          usersWithStores.map(u => u.distributorId).filter(Boolean)
        );
        
        distributors = distributors.filter(d => distributorsWithStores.has(d.id));
      }
      
      // Если нужна фильтрация по категориям брендов
      // (это требует дополнительной логики, так как категории связаны с брендами, а не дистрибьюторами)
      // Пока оставим это для будущей реализации
    }
    
    // Добавляем информацию о количестве активных магазинов для каждого дистрибьютора
    const distributorIds = distributors.map(d => d.id);
    const storeCounts = await User.aggregate([
      {
        $match: {
          distributorId: { $in: distributorIds },
          role: { $in: STORE_ROLES },
          isActive: true
        }
      },
      {
        $group: {
          _id: '$distributorId',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const storeCountMap = {};
    storeCounts.forEach(item => {
      storeCountMap[item._id] = item.count;
    });
    
    // Добавляем количество магазинов к каждому дистрибьютору
    const distributorsWithStores = distributors.map(distributor => ({
      ...distributor,
      activeStoresCount: storeCountMap[distributor.id] || 0
    }));
    
    res.json({
      items: distributorsWithStores,
      total: distributorsWithStores.length
    });
  } catch (error) {
    console.error('Ошибка при получении списка дистрибьюторов:', error);
    res.status(500).json({ error: 'Ошибка при получении списка дистрибьюторов' });
  }
}

async function updateDistributor(req, res) {
  try {
    const { distributorId } = req.params;
    const { name, address, location, description, photos } = req.body;
    const normalizedLocation = normalizeLocation(location);

    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (address !== undefined) update.address = address;
    if (location !== undefined) update.location = normalizedLocation;
    if (description !== undefined) update.description = description;
    if (photos !== undefined) update.photos = photos;

    const distributor = await Distributor.findOneAndUpdate({ id: distributorId }, update, {
      new: true
    }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    res.json(distributor);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при обновлении дистрибьютора' });
  }
}

async function deleteDistributor(req, res) {
  try {
    const { distributorId } = req.params;
    const result = await Distributor.deleteOne({ id: distributorId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении дистрибьютора' });
  }
}

async function getMyDistributor(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }
    const user = await models.User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }
    const distributor = await Distributor.findOne({ id: user.distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }
    res.json(distributor);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении дистрибьютора' });
  }
}

// Отправка запроса на подключение от бренда к дистрибьютору
async function sendConnectionRequest(req, res) {
  try {
    const { distributorId } = req.params;
    const brandId = req.user && req.user.brandId;
    
    if (!brandId) {
      return res.status(403).json({ error: 'Только бренды могут отправлять запросы на подключение' });
    }
    
    if (!distributorId) {
      return res.status(400).json({ error: 'ID дистрибьютора обязателен' });
    }
    
    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }
    
    // Проверяем существование бренда
    const brand = await Brand.findOne({ id: brandId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }
    
    // Проверяем, не отправлен ли уже запрос
    const existingRequest = await BrandDistributorRequest.findOne({
      brandId,
      distributorId,
      status: 'PENDING'
    }).lean();
    
    if (existingRequest) {
      return res.status(409).json({ error: 'Запрос на подключение уже отправлен' });
    }
    
    // Проверяем, не принят ли уже запрос
    const acceptedRequest = await BrandDistributorRequest.findOne({
      brandId,
      distributorId,
      status: 'ACCEPTED'
    }).lean();
    
    if (acceptedRequest) {
      return res.status(409).json({ error: 'Бренд уже подключен к этому дистрибьютору' });
    }
    
    // Создаем запрос
    const request = await BrandDistributorRequest.create({
      id: generateId(),
      brandId,
      distributorId,
      status: 'PENDING'
    });
    
    // Отправляем email дистрибьютору
    const { sendEmail } = require('../utils/email');
    try {
      await sendEmail({
        to: distributor.email,
        subject: `Новый запрос на подключение от бренда ${brand.name}`,
        text: `Бренд "${brand.name}" отправил запрос на подключение к вашей дистрибьюторской сети.\n\nВойдите в кабинет, чтобы принять или отклонить запрос.`
      });
    } catch (emailError) {
      console.error('Ошибка при отправке email дистрибьютору:', emailError);
      // Не прерываем процесс, если email не отправился
    }
    
    res.status(201).json({
      message: 'Запрос на подключение отправлен',
      request: request.toObject()
    });
  } catch (error) {
    console.error('Ошибка при отправке запроса на подключение:', error);
    res.status(500).json({ error: 'Ошибка при отправке запроса на подключение' });
  }
}

// Получение всех запросов на подключение для дистрибьютора
async function getConnectionRequests(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать запросы' });
    }
    
    const requests = await BrandDistributorRequest.find({ distributorId })
      .sort({ createdAt: -1 })
      .lean();
    
    // Получаем информацию о брендах
    const brandIds = requests.map(r => r.brandId);
    const brands = await Brand.find({ id: { $in: brandIds } }).lean();
    const brandMap = {};
    brands.forEach(brand => {
      brandMap[brand.id] = brand;
    });
    
    // Объединяем запросы с информацией о брендах
    const requestsWithBrands = requests.map(request => ({
      ...request,
      brand: brandMap[request.brandId] || null
    }));
    
    res.json({
      items: requestsWithBrands,
      total: requestsWithBrands.length
    });
  } catch (error) {
    console.error('Ошибка при получении запросов на подключение:', error);
    res.status(500).json({ error: 'Ошибка при получении запросов на подключение' });
  }
}

// Принятие запроса на подключение
async function acceptConnectionRequest(req, res) {
  try {
    const { requestId } = req.params;
    const distributorId = req.user && req.user.distributorId;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут принимать запросы' });
    }
    
    const request = await BrandDistributorRequest.findOne({ id: requestId }).lean();
    if (!request) {
      return res.status(404).json({ error: 'Запрос не найден' });
    }
    
    if (request.distributorId !== distributorId) {
      return res.status(403).json({ error: 'Нет доступа к этому запросу' });
    }
    
    if (request.status !== 'PENDING') {
      return res.status(400).json({ error: 'Запрос уже обработан' });
    }
    
    // Обновляем статус запроса
    await BrandDistributorRequest.updateOne(
      { id: requestId },
      { status: 'ACCEPTED', updatedAt: new Date() }
    );
    
    // Отправляем email бренду
    const brand = await Brand.findOne({ id: request.brandId }).lean();
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    
    if (brand && distributor) {
      const { sendEmail } = require('../utils/email');
      try {
        await sendEmail({
          to: brand.email,
          subject: `Запрос на подключение принят`,
          text: `Ваш запрос на подключение к дистрибьютору "${distributor.name}" был принят.`
        });
      } catch (emailError) {
        console.error('Ошибка при отправке email бренду:', emailError);
      }
    }
    
    const updatedRequest = await BrandDistributorRequest.findOne({ id: requestId }).lean();
    res.json({
      message: 'Запрос принят',
      request: updatedRequest
    });
  } catch (error) {
    console.error('Ошибка при принятии запроса:', error);
    res.status(500).json({ error: 'Ошибка при принятии запроса' });
  }
}

// Отклонение запроса на подключение
async function rejectConnectionRequest(req, res) {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;
    const distributorId = req.user && req.user.distributorId;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут отклонять запросы' });
    }
    
    const request = await BrandDistributorRequest.findOne({ id: requestId }).lean();
    if (!request) {
      return res.status(404).json({ error: 'Запрос не найден' });
    }
    
    if (request.distributorId !== distributorId) {
      return res.status(403).json({ error: 'Нет доступа к этому запросу' });
    }
    
    if (request.status !== 'PENDING') {
      return res.status(400).json({ error: 'Запрос уже обработан' });
    }
    
    // Обновляем статус запроса
    await BrandDistributorRequest.updateOne(
      { id: requestId },
      { 
        status: 'REJECTED', 
        rejectedReason: reason || null,
        updatedAt: new Date() 
      }
    );
    
    // Отправляем email бренду
    const brand = await Brand.findOne({ id: request.brandId }).lean();
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    
    if (brand && distributor) {
      const { sendEmail } = require('../utils/email');
      try {
        await sendEmail({
          to: brand.email,
          subject: `Запрос на подключение отклонен`,
          text: `Ваш запрос на подключение к дистрибьютору "${distributor.name}" был отклонен.${reason ? `\n\nПричина: ${reason}` : ''}`
        });
      } catch (emailError) {
        console.error('Ошибка при отправке email бренду:', emailError);
      }
    }
    
    const updatedRequest = await BrandDistributorRequest.findOne({ id: requestId }).lean();
    res.json({
      message: 'Запрос отклонен',
      request: updatedRequest
    });
  } catch (error) {
    console.error('Ошибка при отклонении запроса:', error);
    res.status(500).json({ error: 'Ошибка при отклонении запроса' });
  }
}

// Получение списка торговых представителей дистрибьютора
async function getSalesRepresentatives(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать своих торговых представителей' });
    }
    
    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }
    
    // Получаем торговых представителей из User (role: 'SALES_REPRESENTATIVE' с distributorId)
    const salesRepresentatives = await User.find({ 
      role: 'SALES_REPRESENTATIVE',
      distributorId: distributorId,
      isActive: true
    })
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({
      items: salesRepresentatives,
      total: salesRepresentatives.length
    });
  } catch (error) {
    console.error('Ошибка при получении торговых представителей:', error);
    res.status(500).json({ error: 'Ошибка при получении торговых представителей' });
  }
}

// Добавление торгового представителя к дистрибьютору
async function addSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.body;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут добавлять торговых представителей' });
    }
    
    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }
    
    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }
    
    // Проверяем существование торгового представителя в User
    const salesRepresentativeUser = await User.findOne({ 
      id: salesRepresentativeId,
      role: 'SALES_REPRESENTATIVE'
    }).lean();
    
    if (!salesRepresentativeUser) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    
    // Проверяем, не закреплен ли уже торговый представитель за другим дистрибьютором
    if (salesRepresentativeUser.distributorId && salesRepresentativeUser.distributorId !== distributorId) {
      return res.status(409).json({ error: 'Торговый представитель уже закреплен за другим дистрибьютором' });
    }
    
    // Если уже закреплен за этим дистрибьютором
    if (salesRepresentativeUser.distributorId === distributorId) {
      return res.status(409).json({ error: 'Торговый представитель уже закреплен за вами' });
    }
    
    // Закрепляем торгового представителя за дистрибьютором (обновляем User)
    const updatedSalesRepresentative = await User.findOneAndUpdate(
      { id: salesRepresentativeId },
      { distributorId, updatedAt: new Date() },
      { new: true }
    ).lean();
    
    // Также обновляем SalesRepresentative, если он существует
    await SalesRepresentative.findOneAndUpdate(
      { email: salesRepresentativeUser.email },
      { distributorId, updatedAt: new Date() },
      { upsert: false }
    ).catch(() => {
      // Игнорируем ошибку, если записи нет
    });
    
    res.status(200).json({
      message: 'Торговый представитель успешно добавлен',
      salesRepresentative: updatedSalesRepresentative
    });
  } catch (error) {
    console.error('Ошибка при добавлении торгового представителя:', error);
    res.status(500).json({ error: 'Ошибка при добавлении торгового представителя' });
  }
}

// Удаление торгового представителя от дистрибьютора
async function removeSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;
    
    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут удалять торговых представителей' });
    }
    
    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }
    
    // Проверяем существование дистрибьютора
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }
    
    // Проверяем существование торгового представителя в User
    const salesRepresentativeUser = await User.findOne({ 
      id: salesRepresentativeId,
      role: 'SALES_REPRESENTATIVE'
    }).lean();
    
    if (!salesRepresentativeUser) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    
    // Проверяем, что торговый представитель закреплен за этим дистрибьютором
    if (salesRepresentativeUser.distributorId !== distributorId) {
      return res.status(403).json({ error: 'Торговый представитель не закреплен за вами' });
    }
    
    // Открепляем торгового представителя от дистрибьютора (обновляем User)
    const updatedSalesRepresentative = await User.findOneAndUpdate(
      { id: salesRepresentativeId },
      { distributorId: null, updatedAt: new Date() },
      { new: true }
    ).lean();
    
    // Также обновляем SalesRepresentative, если он существует
    await SalesRepresentative.findOneAndUpdate(
      { email: salesRepresentativeUser.email },
      { distributorId: null, updatedAt: new Date() },
      { upsert: false }
    ).catch(() => {
      // Игнорируем ошибку, если записи нет
    });
    
    res.json({
      message: 'Торговый представитель успешно откреплен',
      salesRepresentative: updatedSalesRepresentative
    });
  } catch (error) {
    console.error('Ошибка при удалении торгового представителя:', error);
    res.status(500).json({ error: 'Ошибка при удалении торгового представителя' });
  }
}

// Получение списка магазинов торгового представителя (для дистрибьютора)
async function getSalesRepresentativeStores(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать магазины ТП' });
    }

    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }

    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    const links = await SalesRepresentativeStore.find({
      salesRepresentativeId: { $in: resolved.linkIds },
      distributorId
    }).lean();

    const storeIds = links.map(link => link.storeId);
    const stores = storeIds.length
      ? await Store.find({ id: { $in: storeIds } }).lean()
      : [];

    res.json({
      items: stores,
      total: stores.length
    });
  } catch (error) {
    console.error('Ошибка при получении магазинов ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении магазинов торгового представителя' });
  }
}

// Добавление магазина торговому представителю
async function addStoreToSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;
    const { storeId } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут добавлять магазины ТП' });
    }

    if (!salesRepresentativeId || !storeId) {
      return res.status(400).json({ error: 'ID торгового представителя и ID магазина обязательны' });
    }

    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    const store = await Store.findOne({ id: storeId }).lean();
    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    const storeUsers = await User.find({
      storeId,
      role: { $in: STORE_ROLES },
      distributorId
    }).lean();

    if (!storeUsers.length) {
      return res.status(409).json({ error: 'Магазин не закреплен за этим дистрибьютором' });
    }

    const existingLink = await SalesRepresentativeStore.findOne({
      salesRepresentativeId: { $in: resolved.linkIds },
      storeId
    }).lean();

    if (existingLink) {
      return res.status(409).json({ error: 'Магазин уже закреплен за этим ТП' });
    }

    const link = await SalesRepresentativeStore.create({
      id: generateId(),
      salesRepresentativeId: resolved.linkId,
      storeId,
      distributorId
    });

    res.status(201).json({
      message: 'Магазин успешно добавлен торговому представителю',
      link: link.toObject()
    });
  } catch (error) {
    console.error('Ошибка при добавлении магазина ТП:', error);
    res.status(500).json({ error: 'Ошибка при добавлении магазина торговому представителю' });
  }
}

// Массовое добавление магазинов торговому представителю
async function addStoresToSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;
    const { storeIds } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут добавлять магазины ТП' });
    }

    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }

    if (!storeIds || !Array.isArray(storeIds) || storeIds.length === 0) {
      return res.status(400).json({ error: 'Массив storeIds обязателен и не должен быть пустым' });
    }

    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    // Проверяем существование всех магазинов
    const stores = await Store.find({ id: { $in: storeIds } }).lean();
    const foundStoreIds = new Set(stores.map(s => s.id));
    const notFoundStoreIds = storeIds.filter(id => !foundStoreIds.has(id));

    if (notFoundStoreIds.length > 0) {
      return res.status(404).json({ 
        error: 'Некоторые магазины не найдены',
        notFoundStoreIds 
      });
    }

    // Проверяем, что все магазины принадлежат этому дистрибьютору
    const storeUsers = await User.find({
      storeId: { $in: storeIds },
      role: { $in: STORE_ROLES },
      distributorId
    }).lean();

    const storeIdsByDistributor = new Set(
      storeUsers.map(u => u.storeId).filter(Boolean)
    );
    const notAssignedStoreIds = storeIds.filter(id => !storeIdsByDistributor.has(id));

    if (notAssignedStoreIds.length > 0) {
      return res.status(409).json({ 
        error: 'Некоторые магазины не закреплены за этим дистрибьютором',
        notAssignedStoreIds 
      });
    }

    // Проверяем существующие связи
    const existingLinks = await SalesRepresentativeStore.find({
      salesRepresentativeId: { $in: resolved.linkIds },
      storeId: { $in: storeIds },
      distributorId
    }).lean();

    const existingStoreIds = new Set(existingLinks.map(link => link.storeId));
    const newStoreIds = storeIds.filter(id => !existingStoreIds.has(id));

    if (newStoreIds.length === 0) {
      return res.status(409).json({ 
        error: 'Все указанные магазины уже закреплены за этим ТП',
        alreadyAssigned: Array.from(existingStoreIds)
      });
    }

    // Создаем новые связи
    const links = await Promise.all(
      newStoreIds.map(storeId =>
        SalesRepresentativeStore.create({
          id: generateId(),
          salesRepresentativeId: resolved.linkId,
          storeId,
          distributorId
        })
      )
    );

    res.status(201).json({
      message: 'Магазины успешно добавлены торговому представителю',
      added: links.map(link => link.toObject()),
      alreadyAssigned: Array.from(existingStoreIds),
      totalAdded: links.length,
      totalSkipped: existingStoreIds.size
    });
  } catch (error) {
    console.error('Ошибка при массовом добавлении магазинов ТП:', error);
    res.status(500).json({ error: 'Ошибка при массовом добавлении магазинов торговому представителю' });
  }
}

// Удаление магазина у торгового представителя
async function removeStoreFromSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId, storeId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут удалять магазины ТП' });
    }

    if (!salesRepresentativeId || !storeId) {
      return res.status(400).json({ error: 'ID торгового представителя и ID магазина обязательны' });
    }

    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    const link = await SalesRepresentativeStore.findOne({
      salesRepresentativeId: { $in: resolved.linkIds },
      storeId,
      distributorId
    }).lean();

    if (!link) {
      return res.status(404).json({ error: 'Связь магазина и ТП не найдена' });
    }

    await SalesRepresentativeStore.deleteOne({ id: link.id });

    res.json({
      message: 'Магазин успешно откреплен от торгового представителя'
    });
  } catch (error) {
    console.error('Ошибка при удалении магазина ТП:', error);
    res.status(500).json({ error: 'Ошибка при удалении магазина торгового представителя' });
  }
}

// Получение списка магазинов торгового представителя (для самого ТП)
async function getMySalesRepresentativeStores(req, res) {
  try {
    const tokenSalesRepId = req.user && req.user.salesRepresentativeId;
    const tokenUserId = req.user && req.user.userId;

    if (!tokenSalesRepId && !tokenUserId) {
      return res.status(403).json({ error: 'Только торговые представители могут просматривать свои магазины' });
    }

    let resolvedSalesRepId = null;
    let resolvedLinkIds = [];
    let resolvedByToken = null;
    if (tokenSalesRepId) {
      resolvedByToken = await resolveSalesRepresentative(null, tokenSalesRepId);
      if (resolvedByToken.linkId) {
        resolvedSalesRepId = resolvedByToken.linkId;
        resolvedLinkIds = resolvedByToken.linkIds;
      }
    }
    if (!resolvedSalesRepId && tokenUserId) {
      const user = await User.findOne({ id: tokenUserId, role: 'SALES_REPRESENTATIVE' }).lean();
      if (user) {
        const salesRepByEmail = await SalesRepresentative.findOne({ email: user.email }).lean();
        resolvedSalesRepId = salesRepByEmail ? salesRepByEmail.id : user.id;
        resolvedLinkIds = Array.from(
          new Set([salesRepByEmail && salesRepByEmail.id, user.id].filter(Boolean))
        );
      }
    }
    if (!resolvedSalesRepId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    const linkQueryIds = resolvedLinkIds.length ? resolvedLinkIds : [resolvedSalesRepId];
    const links = await SalesRepresentativeStore.find({
      salesRepresentativeId: { $in: linkQueryIds }
    }).lean();

    const storeIds = links.map(link => link.storeId);
    const stores = storeIds.length
      ? await Store.find({ id: { $in: storeIds } }).lean()
      : [];

    res.json({
      items: stores,
      total: stores.length
    });
  } catch (error) {
    console.error('Ошибка при получении магазинов ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении магазинов торгового представителя' });
  }
}

// Получение списка магазинов дистрибьютора
async function getDistributorStores(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { withSalesReps } = req.query; // Опциональный параметр для получения информации о ТП

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать свои магазины' });
    }

    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    const storeUsers = await User.find({
      role: { $in: STORE_ROLES },
      distributorId,
      isActive: true
    })
      .sort({ createdAt: -1 })
      .lean();

    const storeIds = Array.from(
      new Set(storeUsers.map(user => user.storeId).filter(Boolean))
    );

    const stores = storeIds.length
      ? await Store.find({ id: { $in: storeIds } }).lean()
      : [];

    // Если запрошена информация о торговых представителях
    if (withSalesReps === 'true') {
      const links = await SalesRepresentativeStore.find({
        storeId: { $in: storeIds },
        distributorId
      }).lean();

      // Группируем ТП по магазинам
      const salesRepsByStore = new Map();
      links.forEach(link => {
        if (!salesRepsByStore.has(link.storeId)) {
          salesRepsByStore.set(link.storeId, []);
        }
        salesRepsByStore.get(link.storeId).push(link.salesRepresentativeId);
      });

      // Получаем информацию о торговых представителях
      const salesRepIds = Array.from(
        new Set(links.map(link => link.salesRepresentativeId))
      );
      const salesReps = salesRepIds.length
        ? await User.find({
            id: { $in: salesRepIds },
            role: 'SALES_REPRESENTATIVE'
          }).lean()
        : [];

      const salesRepMap = new Map(salesReps.map(rep => [rep.id, rep]));

      // Добавляем информацию о ТП к каждому магазину
      const storesWithSalesReps = stores.map(store => {
        const salesRepIdsForStore = salesRepsByStore.get(store.id) || [];
        const salesRepsForStore = salesRepIdsForStore
          .map(id => salesRepMap.get(id))
          .filter(Boolean)
          .map(rep => ({
            id: rep.id,
            email: rep.email,
            firstName: rep.firstName
          }));

        return {
          ...store,
          salesRepresentatives: salesRepsForStore,
          salesRepresentativesCount: salesRepsForStore.length
        };
      });

      return res.json({
        items: storesWithSalesReps,
        total: storesWithSalesReps.length
      });
    }

    res.json({
      items: stores,
      total: stores.length
    });
  } catch (error) {
    console.error('Ошибка при получении магазинов дистрибьютора:', error);
    res.status(500).json({ error: 'Ошибка при получении магазинов дистрибьютора' });
  }
}

// Добавление магазина к дистрибьютору
async function addDistributorStore(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { storeId } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут добавлять магазины' });
    }

    if (!storeId) {
      return res.status(400).json({ error: 'ID магазина обязателен' });
    }

    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    const store = await Store.findOne({ id: storeId }).lean();
    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    const storeUsers = await User.find({
      storeId,
      role: { $in: STORE_ROLES }
    }).lean();

    if (!storeUsers.length) {
      return res.status(404).json({ error: 'Пользователь магазина не найден' });
    }

    const assignedToOther = storeUsers.find(
      user => user.distributorId && user.distributorId !== distributorId
    );
    if (assignedToOther) {
      return res.status(409).json({ error: 'Магазин уже закреплен за другим дистрибьютором' });
    }

    const alreadyAssigned = storeUsers.every(
      user => user.distributorId === distributorId
    );
    if (alreadyAssigned) {
      return res.status(409).json({ error: 'Магазин уже закреплен за вами' });
    }

    await User.updateMany(
      { storeId, role: { $in: STORE_ROLES } },
      { distributorId, updatedAt: new Date() }
    );

    res.status(200).json({
      message: 'Магазин успешно добавлен',
      store
    });
  } catch (error) {
    console.error('Ошибка при добавлении магазина:', error);
    res.status(500).json({ error: 'Ошибка при добавлении магазина' });
  }
}

// Удаление магазина от дистрибьютора
async function removeDistributorStore(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { storeId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут удалять магазины' });
    }

    if (!storeId) {
      return res.status(400).json({ error: 'ID магазина обязателен' });
    }

    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    const store = await Store.findOne({ id: storeId }).lean();
    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    const storeUsers = await User.find({
      storeId,
      role: { $in: STORE_ROLES }
    }).lean();

    if (!storeUsers.length) {
      return res.status(404).json({ error: 'Пользователь магазина не найден' });
    }

    const belongsToDistributor = storeUsers.some(
      user => user.distributorId === distributorId
    );
    if (!belongsToDistributor) {
      return res.status(403).json({ error: 'Магазин не закреплен за вами' });
    }

    await User.updateMany(
      { storeId, role: { $in: STORE_ROLES }, distributorId },
      { distributorId: null, updatedAt: new Date() }
    );

    res.json({
      message: 'Магазин успешно откреплен',
      store
    });
  } catch (error) {
    console.error('Ошибка при удалении магазина:', error);
    res.status(500).json({ error: 'Ошибка при удалении магазина' });
  }
}

module.exports = {
  createDistributor,
  getDistributorById,
  getDistributors,
  updateDistributor,
  deleteDistributor,
  getMyDistributor,
  sendConnectionRequest,
  getConnectionRequests,
  acceptConnectionRequest,
  rejectConnectionRequest,
  getSalesRepresentatives,
  addSalesRepresentative,
  removeSalesRepresentative,
  getSalesRepresentativeStores,
  addStoreToSalesRepresentative,
  addStoresToSalesRepresentative,
  removeStoreFromSalesRepresentative,
  getMySalesRepresentativeStores,
  getDistributorStores,
  addDistributorStore,
  removeDistributorStore
};

