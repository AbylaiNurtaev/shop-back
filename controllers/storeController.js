const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { getCoordinatesFromLink } = require('../utils/distance');

const { Store, User } = models;

function normalizeLocation(location) {
  if (typeof location === 'string') return location;
  if (location && typeof location === 'object' && typeof location.link === 'string') {
    return location.link;
  }
  return location;
}

async function createStore(req, res) {
  try {
    const { name, address, location, description, photos, firstName, lastName, middleName, phoneNumber } = req.body;
    const normalizedLocation = normalizeLocation(location);

    if (!name || !address || !normalizedLocation) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }

    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Фамилия и Имя обязательны для заполнения' });
    }

    const coords = await getCoordinatesFromLink(normalizedLocation);
    const store = await Store.create({
      id: generateId(),
      name,
      address,
      location: normalizedLocation,
      locationCoords: coords ? { lat: coords.lat, lng: coords.lon } : null,
      description: description || null,
      photos: photos || [],
      firstName: firstName || null,
      lastName: lastName || null,
      middleName: middleName || null,
      phoneNumber: phoneNumber || null
    });

    res.status(201).json(store.toObject());
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании магазина' });
  }
}

async function getStoreById(req, res) {
  try {
    const { storeId } = req.params;
    const store = await Store.findOne({ id: storeId }).lean();

    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    res.json(store);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении магазина' });
  }
}

async function getStores(req, res) {
  try {
    const stores = await Store.find({}).lean();
    res.json({
      items: stores,
      total: stores.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении списка магазинов' });
  }
}

async function updateStore(req, res) {
  try {
    const { storeId } = req.params;
    const { name, address, location, description, photos, firstName, lastName, middleName, phoneNumber } = req.body;
    const normalizedLocation = normalizeLocation(location);

    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (address !== undefined) update.address = address;
    if (location !== undefined) {
      update.location = normalizedLocation;
      const coords = await getCoordinatesFromLink(normalizedLocation);
      update.locationCoords = coords ? { lat: coords.lat, lng: coords.lon } : null;
    }
    if (description !== undefined) update.description = description;
    if (photos !== undefined) update.photos = photos;
    if (firstName !== undefined) update.firstName = firstName || null;
    if (lastName !== undefined) update.lastName = lastName || null;
    if (middleName !== undefined) update.middleName = middleName || null;
    if (phoneNumber !== undefined) update.phoneNumber = phoneNumber || null;

    const store = await Store.findOneAndUpdate({ id: storeId }, update, { new: true }).lean();
    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    res.json(store);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при обновлении магазина' });
  }
}

async function deleteStore(req, res) {
  try {
    const { storeId } = req.params;
    const result = await Store.deleteOne({ id: storeId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении магазина' });
  }
}

// Получение настроек магазина текущего пользователя
async function getMyStoreSettings(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, что у пользователя есть магазин
    if (!user.storeId) {
      return res.status(404).json({ error: 'Магазин не найден для данного пользователя' });
    }

    const store = await Store.findOne({ id: user.storeId }).lean();
    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    // Возвращаем настройки магазина
    const settings = {
      id: store.id,
      name: store.name,
      address: store.address,
      location: store.location,
      locationCoords: store.locationCoords,
      description: store.description,
      photos: store.photos,
      firstName: store.firstName,
      lastName: store.lastName,
      middleName: store.middleName,
      phoneNumber: store.phoneNumber,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt
    };

    res.json(settings);
  } catch (error) {
    console.error('Ошибка при получении настроек магазина:', error);
    res.status(500).json({ error: 'Ошибка при получении настроек магазина' });
  }
}

// Обновление настроек магазина текущего пользователя
async function updateMyStoreSettings(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, что у пользователя есть магазин
    if (!user.storeId) {
      return res.status(404).json({ error: 'Магазин не найден для данного пользователя' });
    }

    const store = await Store.findOne({ id: user.storeId }).lean();
    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    const {
      name,
      address,
      location,
      description,
      photos,
      firstName,
      lastName,
      middleName,
      phoneNumber
    } = req.body;

    const update = { updatedAt: new Date() };
    const normalizedLocation = location ? normalizeLocation(location) : null;

    // Валидация и обновление полей
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Название должно быть непустой строкой' });
      }
      update.name = name.trim();
    }

    if (address !== undefined) {
      if (typeof address !== 'string' || address.trim().length === 0) {
        return res.status(400).json({ error: 'Адрес должен быть непустой строкой' });
      }
      update.address = address.trim();
    }

    if (location !== undefined) {
      if (!normalizedLocation) {
        return res.status(400).json({ error: 'Некорректный формат location' });
      }
      update.location = normalizedLocation;
      const coords = await getCoordinatesFromLink(normalizedLocation);
      update.locationCoords = coords ? { lat: coords.lat, lng: coords.lon } : null;
    }

    if (description !== undefined) {
      update.description = description === null || description === '' ? null : description.trim();
    }

    if (photos !== undefined) {
      if (!Array.isArray(photos)) {
        return res.status(400).json({ error: 'Photos должен быть массивом' });
      }
      update.photos = photos;
    }

    if (firstName !== undefined) {
      if (firstName !== null && (typeof firstName !== 'string' || firstName.trim().length === 0)) {
        return res.status(400).json({ error: 'Имя должно быть непустой строкой или null' });
      }
      update.firstName = firstName === null || firstName === '' ? null : firstName.trim();
    }

    if (lastName !== undefined) {
      if (lastName !== null && (typeof lastName !== 'string' || lastName.trim().length === 0)) {
        return res.status(400).json({ error: 'Фамилия должна быть непустой строкой или null' });
      }
      update.lastName = lastName === null || lastName === '' ? null : lastName.trim();
    }

    if (middleName !== undefined) {
      if (middleName !== null && (typeof middleName !== 'string' || middleName.trim().length === 0)) {
        return res.status(400).json({ error: 'Отчество должно быть непустой строкой или null' });
      }
      update.middleName = middleName === null || middleName === '' ? null : middleName.trim();
    }

    if (phoneNumber !== undefined) {
      if (phoneNumber !== null && (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0)) {
        return res.status(400).json({ error: 'Номер телефона должен быть непустой строкой или null' });
      }
      update.phoneNumber = phoneNumber === null || phoneNumber === '' ? null : phoneNumber.trim();
    }

    // Проверяем, есть ли что обновлять
    if (Object.keys(update).length === 1) {
      // Только updatedAt
      return res.status(400).json({ error: 'Нет полей для обновления' });
    }

    const updatedStore = await Store.findOneAndUpdate(
      { id: store.id },
      update,
      { new: true }
    ).lean();

    if (!updatedStore) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    res.json(updatedStore);
  } catch (error) {
    console.error('Ошибка при обновлении настроек магазина:', error);
    res.status(500).json({ error: 'Ошибка при обновлении настроек магазина' });
  }
}

module.exports = {
  createStore,
  getStoreById,
  getStores,
  updateStore,
  deleteStore,
  getMyStoreSettings,
  updateMyStoreSettings
};
