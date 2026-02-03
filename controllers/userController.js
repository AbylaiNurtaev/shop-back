const { generateId } = require('../utils/uuid');
const { generateAccessToken, generateRefreshToken, JWT_EXPIRES_IN } = require('../utils/jwt');
const { hashPassword } = require('../utils/password');
const { getCoordinatesFromLink } = require('../utils/distance');
const { models } = require('../models/database');

const { User, Store, Distributor, AuthCredential } = models;

function normalizeLocation(location) {
  if (typeof location === 'string') return location;
  if (location && typeof location === 'object' && typeof location.link === 'string') {
    return location.link;
  }
  return location;
}

async function createUser(req, res) {
  try {
    const {
      role,
      email,
      firstName,
      lastName,
      middleName,
      storeId,
      distributorId,
      isActive,
      store,
      distributor,
      password,
      demo
    } = req.body;

    if (!role || !email) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Пароль обязателен' });
    }

    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    const existingCredential = await AuthCredential.findOne({ login: email }).lean();
    if (existingCredential) {
      return res.status(409).json({ error: 'Учетные данные уже существуют' });
    }

    if (store && distributor) {
      return res.status(400).json({ error: 'Нельзя передать магазин и дистрибьютора одновременно' });
    }

    let resolvedStoreId = storeId || null;
    let resolvedDistributorId = distributorId || null;

    if (store) {
      // Берем firstName, lastName, middleName сначала с верхнего уровня, потом из store
      const storeFirstName = firstName || store.firstName;
      const storeLastName = lastName || store.lastName;
      const storeMiddleName = middleName || store.middleName;
      
      const { name, address, location, description, photos, images, phoneNumber } = store;
      const normalizedLocation = normalizeLocation(location);
      if (!name || !address || !normalizedLocation) {
        return res.status(400).json({ error: 'Отсутствуют обязательные поля магазина' });
      }
      if (!storeFirstName || !storeLastName) {
        return res.status(400).json({ error: 'Фамилия и Имя обязательны для заполнения при создании магазина' });
      }
      const coords = await getCoordinatesFromLink(normalizedLocation);
      const createdStore = await Store.create({
        id: generateId(),
        name,
        address,
        location: normalizedLocation,
        locationCoords: coords ? { lat: coords.lat, lng: coords.lon } : null,
        description: description || null,
        photos: photos || images || [],
        firstName: storeFirstName,
        lastName: storeLastName,
        middleName: storeMiddleName || null,
        phoneNumber: phoneNumber || null
      });
      resolvedStoreId = createdStore.id;
    }

    if (distributor) {
      const { name, address, location, description, photos, images } = distributor;
      const normalizedLocation = normalizeLocation(location);
      if (!name || !address || !normalizedLocation) {
        return res.status(400).json({ error: 'Отсутствуют обязательные поля дистрибьютора' });
      }
      const createdDistributor = await Distributor.create({
        id: generateId(),
        name,
        address,
        location: normalizedLocation,
        description: description || null,
        photos: photos || images || []
      });
      resolvedDistributorId = createdDistributor.id;
    }

    const normalizedRole = String(role).toUpperCase();
    if ((normalizedRole === 'STORE' || normalizedRole === 'STORE_USER') && !resolvedStoreId) {
      return res.status(400).json({ error: 'Для роли магазина требуется магазин' });
    }
    if (normalizedRole === 'DISTRIBUTOR' && !resolvedDistributorId) {
      return res.status(400).json({ error: 'Для роли дистрибьютора требуется дистрибьютор' });
    }

    const user = await User.create({
      id: generateId(),
      role: normalizedRole,
      email,
      firstName: firstName || null,
      lastName: lastName || null,
      storeId: resolvedStoreId,
      distributorId: resolvedDistributorId,
      isActive: isActive !== undefined ? isActive : true,
      currency: req.body.currency || 'KZT'
    });

    await AuthCredential.create({
      login: email,
      password: hashPassword(password)
    });

    const payload = { 
      login: email, 
      userId: user.id, 
      role: normalizedRole,
      ...(resolvedStoreId ? { storeId: resolvedStoreId } : {}),
      ...(resolvedDistributorId ? { distributorId: resolvedDistributorId } : {})
    };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.status(201).json({
      user: user.toObject(),
      accessToken,
      refreshToken,
      expiresIn: JWT_EXPIRES_IN
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании пользователя' });
  }
}

async function getUserById(req, res) {
  try {
    const { userId } = req.params;
    const user = await User.findOne({ id: userId }).lean();

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении пользователя' });
  }
}

async function getUsers(req, res) {
  try {
    const users = await User.find(
      {},
      'id role email firstName storeId distributorId currency'
    ).lean();

    res.json({
      items: users,
      total: users.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении списка пользователей' });
  }
}

async function updateUser(req, res) {
  try {
    const { userId } = req.params;
    const { firstName, isActive, currency } = req.body;

    const update = { updatedAt: new Date() };
    if (firstName !== undefined) update.firstName = firstName;
    if (isActive !== undefined) update.isActive = isActive;
    if (currency !== undefined) {
      const currencyCode = currency.trim().toUpperCase();
      if (currencyCode.length !== 3) {
        return res.status(400).json({ error: 'Код валюты должен состоять из 3 символов (например, KZT, USD, RUB)' });
      }
      update.currency = currencyCode;
    }

    const user = await User.findOneAndUpdate({ id: userId }, update, { new: true }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при обновлении пользователя' });
  }
}

async function deleteUser(req, res) {
  try {
    const { userId } = req.params;
    const result = await User.deleteOne({ id: userId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении пользователя' });
  }
}

// Получение настроек текущего пользователя
async function getMyUserSettings(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Возвращаем настройки пользователя
    const settings = {
      id: user.id,
      role: user.role,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      storeId: user.storeId,
      distributorId: user.distributorId,
      isActive: user.isActive,
      currency: user.currency || 'KZT',
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    res.json(settings);
  } catch (error) {
    console.error('Ошибка при получении настроек пользователя:', error);
    res.status(500).json({ error: 'Ошибка при получении настроек пользователя' });
  }
}

// Обновление настроек текущего пользователя
async function updateMyUserSettings(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const { firstName, lastName, currency } = req.body;

    const update = { updatedAt: new Date() };

    // Валидация и обновление полей
    if (firstName !== undefined) {
      if (typeof firstName !== 'string' || firstName.trim().length === 0) {
        return res.status(400).json({ error: 'Имя должно быть непустой строкой' });
      }
      update.firstName = firstName.trim();
    }

    if (lastName !== undefined) {
      if (typeof lastName !== 'string' || lastName.trim().length === 0) {
        return res.status(400).json({ error: 'Фамилия должна быть непустой строкой' });
      }
      update.lastName = lastName.trim();
    }

    if (currency !== undefined) {
      if (typeof currency !== 'string' || currency.trim().length === 0) {
        return res.status(400).json({ error: 'Валюта должна быть непустой строкой' });
      }
      // Валидация кода валюты (3 символа, например KZT, USD, RUB)
      const currencyCode = currency.trim().toUpperCase();
      if (currencyCode.length !== 3) {
        return res.status(400).json({ error: 'Код валюты должен состоять из 3 символов (например, KZT, USD, RUB)' });
      }
      update.currency = currencyCode;
    }

    const updatedUser = await User.findOneAndUpdate({ id: userId }, update, { new: true }).lean();
    if (!updatedUser) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const settings = {
      id: updatedUser.id,
      role: updatedUser.role,
      email: updatedUser.email,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      storeId: updatedUser.storeId,
      distributorId: updatedUser.distributorId,
      isActive: updatedUser.isActive,
      currency: updatedUser.currency || 'KZT',
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt
    };

    res.json(settings);
  } catch (error) {
    console.error('Ошибка при обновлении настроек пользователя:', error);
    res.status(500).json({ error: 'Ошибка при обновлении настроек пользователя' });
  }
}

module.exports = {
  createUser,
  getUserById,
  getUsers,
  updateUser,
  deleteUser,
  getMyUserSettings,
  updateMyUserSettings
};
