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
      storeId,
      distributorId,
      isActive,
      store,
      distributor,
      password
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
      const { name, address, location, description, photos, images } = store;
      const normalizedLocation = normalizeLocation(location);
      if (!name || !address || !normalizedLocation) {
        return res.status(400).json({ error: 'Отсутствуют обязательные поля магазина' });
      }
      const coords = await getCoordinatesFromLink(normalizedLocation);
      const createdStore = await Store.create({
        id: generateId(),
        name,
        address,
        location: normalizedLocation,
        locationCoords: coords ? { lat: coords.lat, lng: coords.lon } : null,
        description: description || null,
        photos: photos || images || []
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
      role,
      email,
      firstName: firstName || null,
      storeId: resolvedStoreId,
      distributorId: resolvedDistributorId,
      isActive: isActive !== undefined ? isActive : true
    });

    await AuthCredential.create({
      login: email,
      password: hashPassword(password)
    });

    const payload = { login: email, userId: user.id };
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
      'id role email firstName storeId distributorId'
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
    const { firstName, isActive } = req.body;

    const update = { updatedAt: new Date() };
    if (firstName !== undefined) update.firstName = firstName;
    if (isActive !== undefined) update.isActive = isActive;

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

module.exports = {
  createUser,
  getUserById,
  getUsers,
  updateUser,
  deleteUser
};
