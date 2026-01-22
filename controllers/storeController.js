const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { getCoordinatesFromLink } = require('../utils/distance');

const { Store } = models;

function normalizeLocation(location) {
  if (typeof location === 'string') return location;
  if (location && typeof location === 'object' && typeof location.link === 'string') {
    return location.link;
  }
  return location;
}

async function createStore(req, res) {
  try {
    const { name, address, location, description, photos } = req.body;
    const normalizedLocation = normalizeLocation(location);

    if (!name || !address || !normalizedLocation) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }

    const coords = await getCoordinatesFromLink(normalizedLocation);
    const store = await Store.create({
      id: generateId(),
      name,
      address,
      location: normalizedLocation,
      locationCoords: coords ? { lat: coords.lat, lng: coords.lon } : null,
      description: description || null,
      photos: photos || []
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
    const { name, address, location, description, photos } = req.body;
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

module.exports = {
  createStore,
  getStoreById,
  getStores,
  updateStore,
  deleteStore
};
