const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { logDistributorActivity } = require('../utils/distributorActivityLogger');

const { Distributor, User, Store, Brand, BrandDistributorRequest, SalesRepresentative, SalesRepresentativeStore, SalesRepresentativeProduct, Product, Offer, Sale, Plan, DistributorProductPrice, DistributorActivityHistory } = models;

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
    const { country, city, categoryId, hasActiveStores, brandId } = req.query;

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

    // Если передан brandId, группируем дистрибьюторов на прикрепленные и неприкрепленные
    if (brandId) {
      // Получаем все принятые запросы для данного бренда
      const acceptedRequests = await BrandDistributorRequest.find({
        brandId,
        status: 'ACCEPTED'
      }).lean();

      const attachedDistributorIds = new Set(
        acceptedRequests.map(req => req.distributorId)
      );

      // Разделяем дистрибьюторов на две группы
      const attached = distributorsWithStores.filter(d =>
        attachedDistributorIds.has(d.id)
      );
      const notAttached = distributorsWithStores.filter(d =>
        !attachedDistributorIds.has(d.id)
      );

      return res.json({
        attached: {
          items: attached,
          total: attached.length
        },
        notAttached: {
          items: notAttached,
          total: notAttached.length
        }
      });
    }

    // Если brandId не передан, возвращаем результат в старом формате
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

    // Получаем старые данные для логирования
    const oldDistributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!oldDistributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    const update = { updatedAt: new Date() };
    const changes = [];
    if (name !== undefined) {
      update.name = name;
      if (oldDistributor.name !== name) {
        changes.push(`имя: "${oldDistributor.name}" → "${name}"`);
      }
    }
    if (address !== undefined) {
      update.address = address;
      if (oldDistributor.address !== address) {
        changes.push(`адрес: "${oldDistributor.address}" → "${address}"`);
      }
    }
    if (location !== undefined) {
      update.location = normalizedLocation;
      if (oldDistributor.location !== normalizedLocation) {
        changes.push('локация обновлена');
      }
    }
    if (description !== undefined) {
      update.description = description;
      if (oldDistributor.description !== description) {
        changes.push('описание обновлено');
      }
    }
    if (photos !== undefined) {
      update.photos = photos;
      changes.push(`фотографии обновлены (${photos.length} шт.)`);
    }

    const distributor = await Distributor.findOneAndUpdate({ id: distributorId }, update, {
      new: true
    }).lean();
    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    // Логируем действие, если это дистрибьютор обновляет себя
    const userDistributorId = req.user && req.user.distributorId;
    if (userDistributorId === distributorId && changes.length > 0) {
      await logDistributorActivity(
        distributorId,
        'UPDATE_DISTRIBUTOR',
        `Обновлены данные дистрибьютора: ${changes.join(', ')}`,
        { changes, name: name !== undefined ? name : oldDistributor.name, address: address !== undefined ? address : oldDistributor.address }
      );
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

async function updateMyDistributorName(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Имя обязательно и не должно быть пустым' });
    }

    const user = await models.User.findOne({ id: userId }).lean();
    if (!user || !user.distributorId) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    const oldDistributor = await Distributor.findOne({ id: user.distributorId }).lean();
    const distributor = await Distributor.findOneAndUpdate(
      { id: user.distributorId },
      { name: name.trim(), updatedAt: new Date() },
      { new: true }
    ).lean();

    if (!distributor) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    // Логируем действие
    await logDistributorActivity(
      user.distributorId,
      'UPDATE_NAME',
      `Обновлено имя дистрибьютора с "${oldDistributor?.name || 'неизвестно'}" на "${name.trim()}"`,
      { oldName: oldDistributor?.name, newName: name.trim() }
    );

    res.json(distributor);
  } catch (error) {
    console.error('Ошибка при обновлении имени дистрибьютора:', error);
    res.status(500).json({ error: 'Ошибка при обновлении имени дистрибьютора' });
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

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'ACCEPT_BRAND_REQUEST',
      `Принят запрос на подключение от бренда "${brand?.name || request.brandId}"`,
      { brandId: request.brandId, requestId }
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

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'REJECT_BRAND_REQUEST',
      `Отклонен запрос на подключение от бренда "${brand?.name || request.brandId}"${reason ? `. Причина: ${reason}` : ''}`,
      { brandId: request.brandId, requestId, reason: reason || null }
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

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'ADD_SALES_REPRESENTATIVE',
      `Добавлен торговый представитель "${salesRepresentativeUser.email || salesRepresentativeId}"`,
      { salesRepresentativeId, email: salesRepresentativeUser.email }
    );

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

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'REMOVE_SALES_REPRESENTATIVE',
      `Удален торговый представитель "${salesRepresentativeUser.email || salesRepresentativeId}"`,
      { salesRepresentativeId, email: salesRepresentativeUser.email }
    );

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

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'ADD_STORE_TO_SALES_REP',
      `Добавлен магазин "${store.name || storeId}" торговому представителю`,
      { salesRepresentativeId: resolved.linkId, storeId, storeName: store.name }
    );

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

    // Логируем действие
    const newStores = await Store.find({ id: { $in: newStoreIds } }).lean();
    await logDistributorActivity(
      distributorId,
      'ADD_STORES_TO_SALES_REP_BATCH',
      `Добавлено ${links.length} магазинов торговому представителю`,
      {
        salesRepresentativeId: resolved.linkId,
        storeIds: newStoreIds,
        storeNames: newStores.map(s => s.name),
        totalAdded: links.length,
        totalSkipped: existingStoreIds.size
      }
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

    // Логируем действие
    const store = await Store.findOne({ id: storeId }).lean();
    await logDistributorActivity(
      distributorId,
      'REMOVE_STORE_FROM_SALES_REP',
      `Удален магазин "${store?.name || storeId}" у торгового представителя`,
      { salesRepresentativeId: resolved.linkId, storeId, storeName: store?.name }
    );

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

    // Получаем информацию о владельцах магазинов (пользователи с ролью 'STORE')
    const storeOwners = storeIds.length
      ? await User.find({
          storeId: { $in: storeIds },
          role: 'STORE',
          isActive: true
        }).lean()
      : [];

    // Создаем карту владельцев по storeId
    const ownerMap = new Map();
    storeOwners.forEach(owner => {
      if (owner.storeId && !ownerMap.has(owner.storeId)) {
        // Формируем полное имя владельца
        const ownerName = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim() || owner.firstName || null;
        
        ownerMap.set(owner.storeId, {
          name: ownerName,
          firstName: owner.firstName || null,
          lastName: owner.lastName || null,
          phoneNumber: owner.phoneNumber || null
        });
      }
    });

    // Добавляем информацию о владельце к каждому магазину
    const storesWithOwners = stores.map(store => {
      const owner = ownerMap.get(store.id) || null;
      return {
        ...store,
        owner: owner
      };
    });

    res.json({
      items: storesWithOwners,
      total: storesWithOwners.length
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

    // Получаем информацию о владельцах магазинов (пользователи с ролью 'STORE')
    const storeOwners = await User.find({
      storeId: { $in: storeIds },
      role: 'STORE',
      isActive: true
    }).lean();

    // Создаем карту владельцев по storeId
    const ownerMap = new Map();
    storeOwners.forEach(owner => {
      if (owner.storeId && !ownerMap.has(owner.storeId)) {
        ownerMap.set(owner.storeId, {
          firstName: owner.firstName || null,
          email: owner.email || null,
          phoneNumber: owner.phoneNumber || null
        });
      }
    });

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

      // Добавляем информацию о ТП и владельце к каждому магазину
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

        const owner = ownerMap.get(store.id) || null;

        return {
          ...store,
          owner: owner,
          salesRepresentatives: salesRepsForStore,
          salesRepresentativesCount: salesRepsForStore.length
        };
      });

      return res.json({
        items: storesWithSalesReps,
        total: storesWithSalesReps.length
      });
    }

    // Добавляем информацию о владельце к каждому магазину
    const storesWithOwner = stores.map(store => {
      const owner = ownerMap.get(store.id) || null;
      return {
        ...store,
        owner: owner
      };
    });

    res.json({
      items: storesWithOwner,
      total: storesWithOwner.length
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

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'ADD_STORE',
      `Добавлен магазин "${store.name || storeId}" к дистрибьютору`,
      { storeId, storeName: store.name }
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

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'REMOVE_STORE',
      `Удален магазин "${store.name || storeId}" от дистрибьютора`,
      { storeId, storeName: store.name }
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

// Получение списка товаров торгового представителя (для дистрибьютора)
async function getSalesRepresentativeProducts(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать товары ТП' });
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

    const links = await SalesRepresentativeProduct.find({
      salesRepresentativeId: { $in: resolved.linkIds },
      distributorId
    }).lean();

    const productIds = links.map(link => link.productId);
    const products = productIds.length
      ? await Product.find({ id: { $in: productIds } }).lean()
      : [];

    res.json({
      items: products,
      total: products.length
    });
  } catch (error) {
    console.error('Ошибка при получении товаров ТП:', error);
    res.status(500).json({ error: 'Ошибка при получении товаров торгового представителя' });
  }
}

// Добавление товара торговому представителю
async function addProductToSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;
    const { productId } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут добавлять товары ТП' });
    }

    if (!salesRepresentativeId || !productId) {
      return res.status(400).json({ error: 'ID торгового представителя и ID товара обязательны' });
    }

    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    const product = await Product.findOne({ id: productId }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Проверяем, что товар принадлежит бренду, подключенному к дистрибьютору
    const brandDistributorConnection = await BrandDistributorRequest.findOne({
      brandId: product.brandId,
      distributorId,
      status: 'ACCEPTED'
    }).lean();

    if (!brandDistributorConnection) {
      return res.status(403).json({ error: 'Товар принадлежит бренду, не подключенному к этому дистрибьютору' });
    }

    const existingLink = await SalesRepresentativeProduct.findOne({
      salesRepresentativeId: { $in: resolved.linkIds },
      productId
    }).lean();

    if (existingLink) {
      return res.status(409).json({ error: 'Товар уже закреплен за этим ТП' });
    }

    const link = await SalesRepresentativeProduct.create({
      id: generateId(),
      salesRepresentativeId: resolved.linkId,
      productId,
      distributorId
    });

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'ADD_PRODUCT_TO_SALES_REP',
      `Добавлен товар "${product.name || productId}" торговому представителю`,
      { salesRepresentativeId: resolved.linkId, productId, productName: product.name, sku: product.sku }
    );

    res.status(201).json({
      message: 'Товар успешно добавлен торговому представителю',
      link: link.toObject()
    });
  } catch (error) {
    console.error('Ошибка при добавлении товара ТП:', error);
    res.status(500).json({ error: 'Ошибка при добавлении товара торговому представителю' });
  }
}

// Массовое добавление товаров торговому представителю
async function addProductsToSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId } = req.params;
    const { productIds } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут добавлять товары ТП' });
    }

    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'Массив productIds обязателен и не должен быть пустым' });
    }

    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    // Проверяем существование всех товаров
    const products = await Product.find({ id: { $in: productIds } }).lean();
    const foundProductIds = new Set(products.map(p => p.id));
    const notFoundProductIds = productIds.filter(id => !foundProductIds.has(id));

    if (notFoundProductIds.length > 0) {
      return res.status(404).json({
        error: 'Некоторые товары не найдены',
        notFoundProductIds
      });
    }

    // Проверяем, что все товары принадлежат брендам, подключенным к дистрибьютору
    const brandIds = Array.from(new Set(products.map(p => p.brandId)));
    const brandDistributorConnections = await BrandDistributorRequest.find({
      brandId: { $in: brandIds },
      distributorId,
      status: 'ACCEPTED'
    }).lean();

    const allowedBrandIds = new Set(brandDistributorConnections.map(conn => conn.brandId));
    const notAllowedProducts = products.filter(p => !allowedBrandIds.has(p.brandId));

    if (notAllowedProducts.length > 0) {
      return res.status(403).json({
        error: 'Некоторые товары принадлежат брендам, не подключенным к этому дистрибьютору',
        notAllowedProductIds: notAllowedProducts.map(p => p.id)
      });
    }

    // Проверяем существующие связи
    const existingLinks = await SalesRepresentativeProduct.find({
      salesRepresentativeId: { $in: resolved.linkIds },
      productId: { $in: productIds },
      distributorId
    }).lean();

    const existingProductIds = new Set(existingLinks.map(link => link.productId));
    const newProductIds = productIds.filter(id => !existingProductIds.has(id));

    if (newProductIds.length === 0) {
      return res.status(409).json({
        error: 'Все указанные товары уже закреплены за этим ТП',
        alreadyAssigned: Array.from(existingProductIds)
      });
    }

    // Создаем новые связи
    const links = await Promise.all(
      newProductIds.map(productId =>
        SalesRepresentativeProduct.create({
          id: generateId(),
          salesRepresentativeId: resolved.linkId,
          productId,
          distributorId
        })
      )
    );

    // Логируем действие
    const newProducts = await Product.find({ id: { $in: newProductIds } }).lean();
    await logDistributorActivity(
      distributorId,
      'ADD_PRODUCTS_TO_SALES_REP_BATCH',
      `Добавлено ${links.length} товаров торговому представителю`,
      {
        salesRepresentativeId: resolved.linkId,
        productIds: newProductIds,
        productNames: newProducts.map(p => p.name),
        totalAdded: links.length,
        totalSkipped: existingProductIds.size
      }
    );

    res.status(201).json({
      message: 'Товары успешно добавлены торговому представителю',
      added: links.map(link => link.toObject()),
      alreadyAssigned: Array.from(existingProductIds),
      totalAdded: links.length,
      totalSkipped: existingProductIds.size
    });
  } catch (error) {
    console.error('Ошибка при массовом добавлении товаров ТП:', error);
    res.status(500).json({ error: 'Ошибка при массовом добавлении товаров торговому представителю' });
  }
}

// Удаление товара у торгового представителя
async function removeProductFromSalesRepresentative(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId, productId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут удалять товары ТП' });
    }

    if (!salesRepresentativeId || !productId) {
      return res.status(400).json({ error: 'ID торгового представителя и ID товара обязательны' });
    }

    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }

    const link = await SalesRepresentativeProduct.findOne({
      salesRepresentativeId: { $in: resolved.linkIds },
      productId,
      distributorId
    }).lean();

    if (!link) {
      return res.status(404).json({ error: 'Связь товара и ТП не найдена' });
    }

    await SalesRepresentativeProduct.deleteOne({ id: link.id });

    // Логируем действие
    const product = await Product.findOne({ id: productId }).lean();
    await logDistributorActivity(
      distributorId,
      'REMOVE_PRODUCT_FROM_SALES_REP',
      `Удален товар "${product?.name || productId}" у торгового представителя`,
      { salesRepresentativeId: resolved.linkId, productId, productName: product?.name, sku: product?.sku }
    );

    res.json({
      message: 'Товар успешно откреплен от торгового представителя'
    });
  } catch (error) {
    console.error('Ошибка при удалении товара ТП:', error);
    res.status(500).json({ error: 'Ошибка при удалении товара торгового представителя' });
  }
}

// Получение товаров от подключенных брендов (для дистрибьютора)
async function getDistributorProducts(req, res) {
  try {
    // Проверяем и отключаем товары с истекшей оплатой перед получением списка
    const { checkAndDisableExpiredPayments } = require('../utils/paymentExpiration');
    await checkAndDisableExpiredPayments();

    const distributorId = req.user && req.user.distributorId;
    const { brandId } = req.query;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать товары подключенных брендов' });
    }

    // Получаем все бренды, подключенные к дистрибьютору
    const brandDistributorConnections = await BrandDistributorRequest.find({
      distributorId,
      status: 'ACCEPTED'
    }).lean();

    const allowedBrandIds = brandDistributorConnections.map(conn => conn.brandId);

    if (allowedBrandIds.length === 0) {
      return res.json({
        items: [],
        total: 0,
        message: 'Нет подключенных брендов'
      });
    }

    // Фильтруем товары по разрешенным брендам
    let query = {
      brandId: { $in: allowedBrandIds },
      isPayed: true,
      paymentExpiresAt: { $gt: new Date() }
    };

    // Если указан конкретный brandId, проверяем, что он в списке разрешенных
    if (brandId) {
      if (!allowedBrandIds.includes(brandId)) {
        return res.status(403).json({
          error: 'Указанный бренд не подключен к вашему дистрибьютору'
        });
      }
      query.brandId = brandId;
    }

    const products = await Product.find(query).lean();

    // Получаем установленные себестоимости для этих товаров
    const productIds = products.map(p => p.id);
    const costPrices = productIds.length > 0
      ? await DistributorProductPrice.find({
        distributorId,
        productId: { $in: productIds }
      }).lean()
      : [];
    const costPriceByProductId = new Map(costPrices.map(cp => [cp.productId, cp]));

    // Обогащаем товары информацией о себестоимости
    const enrichedProducts = products.map(product => {
      const costPrice = costPriceByProductId.get(product.id);
      return {
        ...product,
        // Себестоимость, установленная дистрибьютором
        costPrice: costPrice ? costPrice.costPrice : null,
        costCurrency: costPrice ? costPrice.costCurrency : null,
        hasCostPrice: !!costPrice
      };
    });

    res.json({
      items: enrichedProducts,
      total: enrichedProducts.length
    });
  } catch (error) {
    console.error('Ошибка при получении товаров дистрибьютора:', error);
    res.status(500).json({ error: 'Ошибка при получении товаров дистрибьютора' });
  }
}

// Установка себестоимости товара для дистрибьютора
async function setProductCostPrice(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { productId } = req.params;
    const { costPrice, costCurrency } = req.body;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут устанавливать себестоимость товаров' });
    }

    if (!productId) {
      return res.status(400).json({ error: 'ID товара обязателен' });
    }

    if (costPrice === undefined || costPrice === null || costPrice < 0) {
      return res.status(400).json({ error: 'Себестоимость должна быть указана и быть неотрицательной' });
    }

    // Проверяем, что товар принадлежит бренду, подключенному к дистрибьютору
    const product = await Product.findOne({ id: productId }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    const brandDistributorConnection = await BrandDistributorRequest.findOne({
      brandId: product.brandId,
      distributorId,
      status: 'ACCEPTED'
    }).lean();

    if (!brandDistributorConnection) {
      return res.status(403).json({
        error: 'Товар не может быть добавлен: бренд не подключен к вашему дистрибьютору'
      });
    }

    // Ищем или создаем запись о себестоимости
    let costPriceRecord = await DistributorProductPrice.findOne({
      distributorId,
      productId
    }).lean();

    const currency = costCurrency || 'RUB';

    if (costPriceRecord) {
      // Обновляем существующую запись
      costPriceRecord = await DistributorProductPrice.findOneAndUpdate(
        { id: costPriceRecord.id },
        {
          costPrice,
          costCurrency: currency,
          updatedAt: new Date()
        },
        { new: true }
      ).lean();
    } else {
      // Создаем новую запись
      costPriceRecord = await DistributorProductPrice.create({
        id: generateId(),
        distributorId,
        productId,
        costPrice,
        costCurrency: currency
      });
      costPriceRecord = costPriceRecord.toObject();
    }

    // Логируем действие
    await logDistributorActivity(
      distributorId,
      'SET_PRODUCT_COST_PRICE',
      `Установлена себестоимость товара "${product.name || productId}": ${costPrice} ${currency}`,
      { productId, productName: product.name, sku: product.sku, costPrice, costCurrency: currency }
    );

    res.json({
      message: 'Себестоимость товара успешно установлена',
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandName: product.brandName
      },
      costPrice: {
        id: costPriceRecord.id,
        costPrice: costPriceRecord.costPrice,
        costCurrency: costPriceRecord.costCurrency
      }
    });
  } catch (error) {
    console.error('Ошибка при установке себестоимости товара:', error);
    res.status(500).json({ error: 'Ошибка при установке себестоимости товара' });
  }
}

// Получение себестоимости товара для дистрибьютора
async function getProductCostPrice(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { productId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать себестоимость товаров' });
    }

    if (!productId) {
      return res.status(400).json({ error: 'ID товара обязателен' });
    }

    // Получаем товар
    const product = await Product.findOne({ id: productId }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Получаем себестоимость
    const costPriceRecord = await DistributorProductPrice.findOne({
      distributorId,
      productId
    }).lean();

    res.json({
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandName: product.brandName
      },
      costPrice: costPriceRecord
        ? {
          id: costPriceRecord.id,
          costPrice: costPriceRecord.costPrice,
          costCurrency: costPriceRecord.costCurrency
        }
        : null
    });
  } catch (error) {
    console.error('Ошибка при получении себестоимости товара:', error);
    res.status(500).json({ error: 'Ошибка при получении себестоимости товара' });
  }
}

// Удаление себестоимости товара для дистрибьютора
async function deleteProductCostPrice(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { productId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут удалять себестоимость товаров' });
    }

    if (!productId) {
      return res.status(400).json({ error: 'ID товара обязателен' });
    }

    const result = await DistributorProductPrice.deleteOne({
      distributorId,
      productId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Себестоимость товара не найдена' });
    }

    // Логируем действие
    const product = await Product.findOne({ id: productId }).lean();
    await logDistributorActivity(
      distributorId,
      'DELETE_PRODUCT_COST_PRICE',
      `Удалена себестоимость товара "${product?.name || productId}"`,
      { productId, productName: product?.name, sku: product?.sku }
    );

    res.json({
      message: 'Себестоимость товара успешно удалена'
    });
  } catch (error) {
    console.error('Ошибка при удалении себестоимости товара:', error);
    res.status(500).json({ error: 'Ошибка при удалении себестоимости товара' });
  }
}

// ========== АНАЛИТИКА ДИСТРИБЬЮТОРА ==========

// Общая статистика (количество магазинов, торговых представителей, товаров)
async function getDistributorAnalyticsSummary(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать аналитику' });
    }

    // Количество магазинов
    const storesCount = await User.countDocuments({
      distributorId,
      role: { $in: STORE_ROLES },
      isActive: true
    });

    // Количество торговых представителей
    const salesRepsCount = await User.countDocuments({
      distributorId,
      role: 'SALES_REPRESENTATIVE',
      isActive: true
    });

    // Всего товаров (из подключенных брендов)
    const brandDistributorConnections = await BrandDistributorRequest.find({
      distributorId,
      status: 'ACCEPTED'
    }).lean();

    const allowedBrandIds = brandDistributorConnections.map(conn => conn.brandId);
    const productsCount = allowedBrandIds.length > 0
      ? await Product.countDocuments({
        brandId: { $in: allowedBrandIds },
        isPayed: true,
        paymentExpiresAt: { $gt: new Date() }
      })
      : 0;

    res.json({
      storesCount,
      salesRepresentativesCount: salesRepsCount,
      totalProducts: productsCount
    });
  } catch (error) {
    console.error('Ошибка при получении общей статистики:', error);
    res.status(500).json({ error: 'Ошибка при получении общей статистики' });
  }
}

// Остатки по магазинам (детальная информация об остатках товаров в каждом магазине)
async function getDistributorStockByStores(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать остатки' });
    }

    // Получаем все магазины дистрибьютора
    const storeUsers = await User.find({
      distributorId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    const storeIds = Array.from(new Set(storeUsers.map(user => user.storeId).filter(Boolean)));

    if (storeIds.length === 0) {
      return res.json({
        items: [],
        total: 0
      });
    }

    // Получаем информацию о магазинах
    const stores = await Store.find({ id: { $in: storeIds } }).lean();
    const storeById = new Map(stores.map(s => [s.id, s]));

    // Получаем связи торговых представителей с магазинами
    const salesRepStoreLinks = await SalesRepresentativeStore.find({
      storeId: { $in: storeIds },
      distributorId
    }).lean();

    // Группируем ТП по магазинам
    const salesRepsByStore = new Map();
    salesRepStoreLinks.forEach(link => {
      if (!salesRepsByStore.has(link.storeId)) {
        salesRepsByStore.set(link.storeId, []);
      }
      salesRepsByStore.get(link.storeId).push(link.salesRepresentativeId);
    });

    // Получаем информацию о торговых представителях
    const salesRepIds = Array.from(
      new Set(salesRepStoreLinks.map(link => link.salesRepresentativeId))
    );

    // Получаем из модели SalesRepresentative
    const salesRepsFromModel = salesRepIds.length
      ? await SalesRepresentative.find({ id: { $in: salesRepIds } }).lean()
      : [];

    // Получаем email'ы для поиска в User
    const salesRepEmails = salesRepsFromModel.map(rep => rep.email);

    // Получаем пользователей по email и по id
    const salesRepUsers = salesRepIds.length || salesRepEmails.length
      ? await User.find({
        $or: [
          { id: { $in: salesRepIds }, role: 'SALES_REPRESENTATIVE' },
          { email: { $in: salesRepEmails }, role: 'SALES_REPRESENTATIVE' }
        ]
      }).lean()
      : [];

    // Создаем мапу: salesRepresentativeId -> данные пользователя
    const salesRepMap = new Map();

    // Сначала добавляем по id из SalesRepresentative
    salesRepsFromModel.forEach(rep => {
      const user = salesRepUsers.find(u => u.id === rep.id || u.email === rep.email);
      if (user) {
        // Добавляем по ID из SalesRepresentative (это ключ в связях)
        salesRepMap.set(rep.id, {
          id: user.id,
          email: user.email,
          firstName: user.firstName
        });
        // Также добавляем по ID пользователя на случай если в связях используется user.id
        if (user.id !== rep.id) {
          salesRepMap.set(user.id, {
            id: user.id,
            email: user.email,
            firstName: user.firstName
          });
        }
      } else {
        // Если пользователь не найден, используем данные из SalesRepresentative
        salesRepMap.set(rep.id, {
          id: rep.id,
          email: rep.email,
          firstName: rep.name
        });
      }
    });

    // Добавляем пользователей, которые могут быть найдены только по id (если salesRepresentativeId = user.id)
    salesRepUsers.forEach(user => {
      // Добавляем по user.id (на случай если в связях используется user.id напрямую)
      if (!salesRepMap.has(user.id)) {
        salesRepMap.set(user.id, {
          id: user.id,
          email: user.email,
          firstName: user.firstName
        });
      }
      // Также проверяем, может ли этот user.id быть salesRepresentativeId в связях
      if (salesRepIds.includes(user.id) && !salesRepMap.has(user.id)) {
        salesRepMap.set(user.id, {
          id: user.id,
          email: user.email,
          firstName: user.firstName
        });
      }
    });

    // Получаем все офферы для этих магазинов
    const offers = await Offer.find({ storeId: { $in: storeIds } }).lean();

    // Получаем информацию о товарах
    const productIds = [...new Set(offers.map(offer => offer.productId))];
    const products = productIds.length > 0
      ? await Product.find({ id: { $in: productIds } }).lean()
      : [];
    const productById = new Map(products.map(p => [p.id, p]));

    // Группируем по магазинам
    const stockByStore = new Map();

    storeIds.forEach(storeId => {
      const store = storeById.get(storeId);
      if (store) {
        // Получаем торговых представителей для этого магазина
        const salesRepIdsForStore = salesRepsByStore.get(storeId) || [];
        const salesRepsForStore = salesRepIdsForStore
          .map(id => salesRepMap.get(id))
          .filter(Boolean);

        stockByStore.set(storeId, {
          storeId: store.id,
          storeName: store.name,
          storeAddress: store.address,
          salesRepresentatives: salesRepsForStore,
          salesRepresentativesCount: salesRepsForStore.length,
          items: [],
          totalItems: 0,
          totalQuantity: 0,
          totalValue: 0
        });
      }
    });

    // Обрабатываем офферы
    offers.forEach(offer => {
      const storeStock = stockByStore.get(offer.storeId);
      if (!storeStock) return;

      const product = productById.get(offer.productId);
      if (!product) return;

      const item = {
        offerId: offer.id,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        brandName: product.brandName || null,
        quantity: offer.quantity || 0,
        price: offer.price || 0,
        currency: offer.currency || 'RUB',
        value: (offer.quantity || 0) * (offer.price || 0),
        isAvailable: offer.isAvailable
      };

      storeStock.items.push(item);
      storeStock.totalItems += 1;
      storeStock.totalQuantity += item.quantity;
      storeStock.totalValue += item.value;
    });

    // Сортируем по общему количеству товаров (убывание)
    const result = Array.from(stockByStore.values())
      .sort((a, b) => b.totalQuantity - a.totalQuantity)
      .map(store => ({
        ...store,
        items: store.items.sort((a, b) => b.quantity - a.quantity)
      }));

    res.json({
      items: result,
      total: result.length
    });
  } catch (error) {
    console.error('Ошибка при получении остатков по магазинам:', error);
    res.status(500).json({ error: 'Ошибка при получении остатков по магазинам' });
  }
}

// Оборот (по магазину, по бренду, по товару)
async function getDistributorTurnover(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { type, startDate, endDate } = req.query; // type: 'store', 'brand', 'product'

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать оборот' });
    }

    // Получаем все магазины дистрибьютора
    const storeUsers = await User.find({
      distributorId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    const storeIds = Array.from(new Set(storeUsers.map(user => user.storeId).filter(Boolean)));

    if (storeIds.length === 0) {
      return res.json({
        type: type || 'store',
        period: {
          startDate: startDate || null,
          endDate: endDate || null
        },
        items: [],
        total: 0,
        summary: {
          totalRevenue: 0,
          totalSales: 0,
          totalQuantity: 0
        }
      });
    }

    // Парсим даты
    let start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let end = endDate ? new Date(endDate) : new Date();
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    // Получаем завершенные продажи
    const allSales = await Sale.find({
      storeId: { $in: storeIds },
      status: 'COMPLETED'
    }).lean();

    // Фильтруем по дате: используем completedAt, если он есть, иначе createdAt
    const sales = allSales.filter(sale => {
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
      return saleDate >= start && saleDate <= end;
    });

    // Получаем информацию о товарах и брендах
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

    // Получаем информацию о магазинах
    const stores = await Store.find({ id: { $in: storeIds } }).lean();
    const storeById = new Map(stores.map(s => [s.id, s]));

    // Общая статистика
    let totalRevenue = 0;
    let totalSales = sales.length;
    let totalQuantity = 0;

    sales.forEach(sale => {
      totalRevenue += sale.totalAmount || 0;
      if (sale.items) {
        sale.items.forEach(item => {
          totalQuantity += item.quantity || 0;
        });
      }
    });

    // Агрегация по типу
    let items = [];

    if (type === 'brand') {
      // Оборот по брендам
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

      items = Array.from(brandStats.values())
        .sort((a, b) => b.totalRevenue - a.totalRevenue);

    } else if (type === 'product') {
      // Оборот по товарам
      const productStats = new Map();

      sales.forEach(sale => {
        if (sale.items) {
          sale.items.forEach(item => {
            const product = productById.get(item.productId);
            if (!product) return;

            if (!productStats.has(item.productId)) {
              productStats.set(item.productId, {
                productId: product.id,
                productName: product.name,
                sku: product.sku,
                brandName: product.brandName || null,
                totalRevenue: 0,
                totalSales: 0,
                totalQuantity: 0
              });
            }

            const stat = productStats.get(item.productId);
            stat.totalRevenue += item.totalPrice || 0;
            stat.totalSales += 1;
            stat.totalQuantity += item.quantity || 0;
          });
        }
      });

      items = Array.from(productStats.values())
        .sort((a, b) => b.totalRevenue - a.totalRevenue);

    } else {
      // Оборот по магазинам (по умолчанию)
      const storeStats = new Map();

      storeIds.forEach(storeId => {
        const store = storeById.get(storeId);
        if (store) {
          storeStats.set(storeId, {
            storeId: store.id,
            storeName: store.name,
            storeAddress: store.address,
            totalRevenue: 0,
            totalSales: 0,
            totalQuantity: 0
          });
        }
      });

      sales.forEach(sale => {
        const stat = storeStats.get(sale.storeId);
        if (stat) {
          stat.totalRevenue += sale.totalAmount || 0;
          stat.totalSales += 1;
          if (sale.items) {
            sale.items.forEach(item => {
              stat.totalQuantity += item.quantity || 0;
            });
          }
        }
      });

      items = Array.from(storeStats.values())
        .sort((a, b) => b.totalRevenue - a.totalRevenue);
    }

    res.json({
      type: type || 'store',
      period: {
        startDate: start.toISOString(),
        endDate: end.toISOString()
      },
      items,
      total: items.length,
      summary: {
        totalRevenue,
        totalSales,
        totalQuantity
      }
    });
  } catch (error) {
    console.error('Ошибка при получении оборота:', error);
    res.status(500).json({ error: 'Ошибка при получении оборота' });
  }
}

// KPI торговых представителей
async function getDistributorSalesRepKPI(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { period, startDate, endDate } = req.query; // period: 'month', 'quarter', 'year' или custom dates

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать KPI торговых представителей' });
    }

    // Получаем всех торговых представителей дистрибьютора
    const salesReps = await User.find({
      distributorId,
      role: 'SALES_REPRESENTATIVE',
      isActive: true
    }).lean();

    if (salesReps.length === 0) {
      return res.json({
        items: [],
        total: 0
      });
    }

    // Получаем магазины, закрепленные за торговыми представителями
    const salesRepIds = salesReps.map(rep => rep.id);
    const links = await SalesRepresentativeStore.find({
      distributorId,
      salesRepresentativeId: { $in: salesRepIds }
    }).lean();

    // Группируем магазины по торговым представителям
    const storesBySalesRep = new Map();
    links.forEach(link => {
      if (!storesBySalesRep.has(link.salesRepresentativeId)) {
        storesBySalesRep.set(link.salesRepresentativeId, []);
      }
      storesBySalesRep.get(link.salesRepresentativeId).push(link.storeId);
    });

    // Определяем период для анализа
    let start, end;
    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else if (period === 'month') {
      start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end = new Date();
    } else if (period === 'quarter') {
      const quarter = Math.floor(new Date().getMonth() / 3);
      start = new Date(new Date().getFullYear(), quarter * 3, 1);
      start.setHours(0, 0, 0, 0);
      end = new Date();
    } else if (period === 'year') {
      start = new Date(new Date().getFullYear(), 0, 1);
      start.setHours(0, 0, 0, 0);
      end = new Date();
    } else {
      // По умолчанию - текущий месяц
      start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end = new Date();
    }
    end.setHours(23, 59, 59, 999);

    // Получаем планы для торговых представителей
    const plans = await Plan.find({
      distributorId,
      salesRepresentativeId: { $in: salesRepIds }
    }).lean();

    // Группируем планы по торговым представителям
    const plansBySalesRep = new Map();
    plans.forEach(plan => {
      if (!plansBySalesRep.has(plan.salesRepresentativeId)) {
        plansBySalesRep.set(plan.salesRepresentativeId, []);
      }
      plansBySalesRep.get(plan.salesRepresentativeId).push(plan);
    });

    // Получаем продажи для магазинов торговых представителей
    const allStoreIds = Array.from(new Set(links.map(link => link.storeId)));
    const allSales = allStoreIds.length > 0
      ? await Sale.find({
        storeId: { $in: allStoreIds },
        status: 'COMPLETED'
      }).lean()
      : [];

    // Фильтруем по дате: используем completedAt, если он есть, иначе createdAt
    const sales = allSales.filter(sale => {
      const saleDate = sale.completedAt ? new Date(sale.completedAt) : new Date(sale.createdAt);
      return saleDate >= start && saleDate <= end;
    });

    // Группируем продажи по магазинам
    const salesByStore = new Map();
    sales.forEach(sale => {
      if (!salesByStore.has(sale.storeId)) {
        salesByStore.set(sale.storeId, []);
      }
      salesByStore.get(sale.storeId).push(sale);
    });

    // Вычисляем KPI для каждого торгового представителя
    const kpiItems = salesReps.map(salesRep => {
      const storeIds = storesBySalesRep.get(salesRep.id) || [];
      const repPlans = plansBySalesRep.get(salesRep.id) || [];

      // Собираем все продажи из магазинов торгового представителя
      let totalRevenue = 0;
      let totalSales = 0;
      let totalQuantity = 0;

      storeIds.forEach(storeId => {
        const storeSales = salesByStore.get(storeId) || [];
        storeSales.forEach(sale => {
          totalRevenue += sale.totalAmount || 0;
          totalSales += 1;
          if (sale.items) {
            sale.items.forEach(item => {
              totalQuantity += item.quantity || 0;
            });
          }
        });
      });

      // Находим актуальный план (если есть)
      const currentPlan = repPlans.find(plan => {
        const planStart = plan.startDate ? new Date(plan.startDate) : null;
        const planEnd = plan.endDate ? new Date(plan.endDate) : null;
        if (planStart && planEnd) {
          return start >= planStart && end <= planEnd;
        }
        return false;
      }) || repPlans[0] || null;

      // Вычисляем процент выполнения плана
      let planCompletionPercent = null;
      if (currentPlan && currentPlan.targetAmount > 0) {
        planCompletionPercent = Math.round((totalRevenue / currentPlan.targetAmount) * 100 * 100) / 100;
      }

      return {
        salesRepresentativeId: salesRep.id,
        salesRepresentativeName: salesRep.firstName || salesRep.email,
        email: salesRep.email,
        storesCount: storeIds.length,
        totalRevenue,
        totalSales,
        totalQuantity,
        plan: currentPlan ? {
          id: currentPlan.id,
          targetAmount: currentPlan.targetAmount,
          targetQuantity: currentPlan.targetQuantity,
          period: currentPlan.period
        } : null,
        planCompletionPercent: planCompletionPercent !== null ? Math.round(planCompletionPercent * 100) / 100 : null
      };
    });

    // Сортируем по выручке (убывание)
    kpiItems.sort((a, b) => b.totalRevenue - a.totalRevenue);

    res.json({
      period: {
        startDate: start.toISOString(),
        endDate: end.toISOString()
      },
      items: kpiItems,
      total: kpiItems.length
    });
  } catch (error) {
    console.error('Ошибка при получении KPI торговых представителей:', error);
    res.status(500).json({ error: 'Ошибка при получении KPI торговых представителей' });
  }
}

// Получение продаж конкретного товара по магазинам выбранного торгового представителя (для дистрибьютора)
async function getSalesRepresentativeProductSales(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;
    const { salesRepresentativeId, productId } = req.params;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать продажи торговых представителей' });
    }

    if (!salesRepresentativeId) {
      return res.status(400).json({ error: 'ID торгового представителя обязателен' });
    }

    if (!productId) {
      return res.status(400).json({ error: 'ID товара обязателен' });
    }

    // Проверяем, что торговый представитель принадлежит дистрибьютору
    const resolved = await resolveSalesRepresentative(distributorId, salesRepresentativeId);
    if (!resolved.linkId) {
      return res.status(404).json({ error: 'Торговый представитель не найден' });
    }
    if (!resolved.isAllowed) {
      return res.status(403).json({ error: 'Торговый представитель не принадлежит дистрибьютору' });
    }

    // Получаем магазины торгового представителя
    const linkQueryIds = resolved.linkIds.length ? resolved.linkIds : [resolved.linkId];
    const links = await SalesRepresentativeStore.find({
      salesRepresentativeId: { $in: linkQueryIds },
      distributorId
    }).lean();

    const storeIds = Array.from(new Set(links.map(link => link.storeId)));

    if (storeIds.length === 0) {
      return res.json({
        salesRepresentativeId,
        salesRepresentative: {
          id: resolved.user ? resolved.user.id : resolved.salesRepresentative.id,
          email: resolved.user ? resolved.user.email : resolved.salesRepresentative.email,
          firstName: resolved.user ? resolved.user.firstName : resolved.salesRepresentative.name
        },
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

    // Получаем информацию о магазинах
    const stores = await Store.find({ id: { $in: storeIds } }).lean();
    const storesById = new Map(stores.map(store => [store.id, store]));

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
      storeId: { $in: storeIds },
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
    stores.forEach(store => {
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
    const storesWithSales = Array.from(storeSalesMap.values())
      .filter(store => store.totalSales > 0) // Только магазины с продажами
      .sort((a, b) => b.totalRevenue - a.totalRevenue); // Сортируем по выручке

    // Общая статистика
    const summary = {
      totalSales: sales.length,
      totalRevenue: Math.round(
        storesWithSales.reduce((sum, store) => sum + store.totalRevenue, 0) * 100
      ) / 100,
      totalQuantity: storesWithSales.reduce((sum, store) => sum + store.totalQuantity, 0)
    };

    res.json({
      salesRepresentativeId,
      salesRepresentative: {
        id: resolved.user ? resolved.user.id : resolved.salesRepresentative.id,
        email: resolved.user ? resolved.user.email : resolved.salesRepresentative.email,
        firstName: resolved.user ? resolved.user.firstName : resolved.salesRepresentative.name
      },
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
      stores: storesWithSales,
      total: storesWithSales.length,
      summary
    });
  } catch (error) {
    console.error('Ошибка при получении продаж товара торгового представителя:', error);
    res.status(500).json({ error: 'Ошибка при получении продаж товара торгового представителя' });
  }
}

// Вспомогательная функция для получения контекста магазинов дистрибьютора
async function getDistributorStoresContext(req) {
  const distributorId = req.user && req.user.distributorId;

  if (!distributorId) {
    return {
      storeIds: [],
      storesById: new Map(),
      stores: [],
      isFound: false
    };
  }

  const distributor = await Distributor.findOne({ id: distributorId }).lean();
  if (!distributor) {
    return {
      storeIds: [],
      storesById: new Map(),
      stores: [],
      isFound: false
    };
  }

  const storeUsers = await User.find({
    role: { $in: STORE_ROLES },
    distributorId,
    isActive: true
  }).lean();

  const storeIds = Array.from(
    new Set(storeUsers.map(user => user.storeId).filter(Boolean))
  );

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

// Вспомогательная функция для загрузки предложений и товаров
async function loadDistributorOffersWithProducts(storeIds) {
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

// Получение товаров, которые плохо продаются (для дистрибьютора)
async function getDistributorPoorlySellingProducts(req, res) {
  try {
    const context = await getDistributorStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
    }

    if (!context.storeIds.length) {
      return res.json({ items: [], total: 0 });
    }

    // Парсим параметры
    const minQuantity = parseNumber(req.query.minQuantity, 10); // Минимальный остаток для попадания в список
    const periodDays = parseNumber(req.query.periodDays, 30); // Период для анализа продаж (дней)
    const maxSales = parseNumber(req.query.maxSales, 5); // Максимальное количество продаж за период

    const storeIds = context.storeIds;
    const { offers, productById } = await loadDistributorOffersWithProducts(storeIds);

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

// Получение продаж конкретного товара по магазинам (для дистрибьютора)
async function getDistributorProductSalesByStores(req, res) {
  try {
    const { productId } = req.params;

    if (!productId) {
      return res.status(400).json({ error: 'ID товара обязателен' });
    }

    const context = await getDistributorStoresContext(req);
    if (!context.isFound) {
      return res.status(404).json({ error: 'Дистрибьютор не найден' });
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

    // Получаем все завершенные продажи из магазинов дистрибьютора
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

// Вспомогательная функция для парсинга чисел
function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = {
  createDistributor,
  getDistributorById,
  getDistributors,
  updateDistributor,
  deleteDistributor,
  getMyDistributor,
  updateMyDistributorName,
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
  removeDistributorStore,
  getSalesRepresentativeProducts,
  addProductToSalesRepresentative,
  addProductsToSalesRepresentative,
  removeProductFromSalesRepresentative,
  getDistributorProducts,
  setProductCostPrice,
  getProductCostPrice,
  deleteProductCostPrice,
  getDistributorAnalyticsSummary,
  getDistributorStockByStores,
  getDistributorTurnover,
  getDistributorSalesRepKPI,
  getSalesRepresentativeProductSales,
  getDistributorActivityHistory,
  getDistributorPoorlySellingProducts,
  getDistributorProductSalesByStores
};

// Получение истории действий дистрибьютора
async function getDistributorActivityHistory(req, res) {
  try {
    const distributorId = req.user && req.user.distributorId;

    if (!distributorId) {
      return res.status(403).json({ error: 'Только дистрибьюторы могут просматривать историю действий' });
    }

    const { limit = 100, offset = 0, actionType } = req.query;

    // Получаем историю действий
    const history = await DistributorActivityHistory.findOne({ distributorId }).lean();

    if (!history || !history.actions || history.actions.length === 0) {
      return res.json({
        distributorId,
        items: [],
        total: 0,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      });
    }

    // Фильтруем по типу действия, если указан
    let actions = history.actions;
    if (actionType) {
      actions = actions.filter(action => action.actionType === actionType);
    }

    // Сортируем по времени (новые сначала)
    actions.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeB - timeA;
    });

    // Применяем пагинацию
    const total = actions.length;
    const startIndex = parseInt(offset, 10);
    const endIndex = startIndex + parseInt(limit, 10);
    const paginatedActions = actions.slice(startIndex, endIndex);

    res.json({
      distributorId,
      items: paginatedActions,
      total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      hasMore: endIndex < total
    });
  } catch (error) {
    console.error('Ошибка при получении истории действий дистрибьютора:', error);
    res.status(500).json({ error: 'Ошибка при получении истории действий дистрибьютора' });
  }
}