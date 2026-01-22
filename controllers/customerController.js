const multer = require('multer');
const { generateId } = require('../utils/uuid');
const { uploadImage } = require('../utils/s3');
const { calculateDistance, getCoordinatesFromLink } = require('../utils/distance');
const { getIntentFromGemini, transcribeAudio, generateClarificationQuestions } = require('../utils/gemini');
const { models } = require('../models/database');

const {
  CustomerSession,
  SearchConversation,
  SearchMessage,
  SearchIntent,
  SearchRequest,
  SearchResult,
  Attachment,
  VoiceInput,
  Product,
  Offer,
  Store,
  Category
} = models;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/webm'
]);

function nowPlus(ms) {
  return new Date(Date.now() + ms);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function extractBrandFromText(text, brands) {
  const normalized = normalizeText(text);
  return (brands || []).find(brand => normalized.includes(normalizeText(brand))) || null;
}

async function buildCandidatesByText(text) {
  const searchTerm = normalizeText(text);
  if (!searchTerm) return [];
  return Product.find({
    $and: [
      {
        $or: [
          { name: { $regex: searchTerm, $options: 'i' } },
          { description: { $regex: searchTerm, $options: 'i' } },
          { brandName: { $regex: searchTerm, $options: 'i' } },
          { sku: { $regex: searchTerm, $options: 'i' } }
        ]
      },
      { isPayed: true },
      { paymentExpiresAt: { $gt: new Date() } }
    ]
  }).limit(50).lean();
}

function buildClarificationQuestions(products, currentIntent) {
  const brands = [...new Set(products.map(item => item.brandName).filter(Boolean))];
  const packages = [...new Set(products.map(item => item.packageInfo).filter(Boolean))];
  const questions = [];
  const quickReplies = [];

  // Приоритет 1: Упаковка
  if (currentIntent.packageInfo === null && packages.length > 1) {
    questions.push('Какой объем/тип упаковки вам нужен?');
    quickReplies.push(...packages.slice(0, 5));
  }
  
  // Приоритет 2: Бренд
  if (!currentIntent.brand && brands.length > 1) {
    if (questions.length === 0) {
      questions.push('Какой бренд вы предпочитаете?');
      quickReplies.push(...brands.slice(0, 5));
    }
  }

  return { questions, quickReplies };
}

function filterCandidatesByIntent(candidates, intent) {
  let filtered = [...candidates];
  if (intent.brand) {
    filtered = filtered.filter(item =>
      item.brandName && normalizeText(item.brandName).includes(normalizeText(intent.brand))
    );
  }
  if (intent.packageInfo !== null && intent.packageInfo !== undefined) {
    filtered = filtered.filter(item =>
      item.packageInfo && normalizeText(item.packageInfo).includes(normalizeText(intent.packageInfo))
    );
  }
  if (intent.type) {
    // Фильтруем по типу товара (zero, light, обычная и т.д.)
    const typeLower = normalizeText(intent.type);
    filtered = filtered.filter(item => {
      const nameLower = normalizeText(item.name);
      const descLower = normalizeText(item.description || '');
      return nameLower.includes(typeLower) || descLower.includes(typeLower);
    });
  }
  return filtered;
}

async function createSession(req, res) {
  try {
    const { deviceId, userAgent } = req.body || {};
    const session = await CustomerSession.create({
      id: generateId(),
      deviceId: deviceId || null,
      userAgent: userAgent || req.headers['user-agent'] || null,
      lastSeenAt: new Date(),
      expiresAt: nowPlus(SESSION_TTL_MS)
    });

    res.json({
      sessionId: session.id,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании сессии' });
  }
}

async function getSession(req, res) {
  try {
    const { sessionId } = req.params;
    const session = await CustomerSession.findOne({ id: sessionId }).lean();
    if (!session) {
      return res.status(404).json({ error: 'Сессия не найдена' });
    }
    res.json({
      sessionId: session.id,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении сессии' });
  }
}

async function createConversation(req, res) {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    const session = await CustomerSession.findOne({ id: sessionId }).lean();
    if (!session) {
      return res.status(404).json({ error: 'Сессия не найдена' });
    }

    const conversation = await SearchConversation.create({
      id: generateId(),
      sessionId,
      state: 'NEW',
      intentId: null,
      requestId: null,
      resultId: null,
      expiresAt: nowPlus(CONVERSATION_TTL_MS)
    });

    res.json({
      conversationId: conversation.id,
      state: conversation.state
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании чата' });
  }
}

async function getConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const conversation = await SearchConversation.findOne({ id: conversationId }).lean();
    if (!conversation) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    const messages = await SearchMessage.find({ conversationId })
      .sort({ createdAt: 1 })
      .lean();
    const intent = conversation.intentId
      ? await SearchIntent.findOne({ id: conversation.intentId }).lean()
      : null;
    const result = conversation.resultId
      ? await SearchResult.findOne({ id: conversation.resultId }).lean()
      : null;

    res.json({
      conversationId: conversation.id,
      state: conversation.state,
      messages,
      intent,
      result
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении чата' });
  }
}

async function performSearch({ text, geo, radiusMeters, intent }) {
  let products = [];
  const candidateIds = intent && intent.filters ? intent.filters.candidateProductIds : null;
  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    products = await Product.find({ id: { $in: candidateIds } }).lean();
  } else {
    const searchTerm = normalizeText(text);
    const query = {};
    if (searchTerm) {
      query.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { description: { $regex: searchTerm, $options: 'i' } },
        { brandName: { $regex: searchTerm, $options: 'i' } },
        { sku: { $regex: searchTerm, $options: 'i' } }
      ];
    }
    if (intent && intent.brand) {
      query.brandName = { $regex: normalizeText(intent.brand), $options: 'i' };
    }
    products = await Product.find(query).lean();
  }

  if (intent && intent.packageInfo !== null && intent.packageInfo !== undefined) {
    products = products.filter(product =>
      normalizeText(product.packageInfo) === normalizeText(intent.packageInfo)
    );
  }

  if (products.length === 0) {
    return [];
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

  const categoryIds = [...new Set(products.map(product => product.categoryId))];
  const categories = categoryIds.length > 0
    ? await Category.find({ id: { $in: categoryIds } }).lean()
    : [];
  const categoryById = new Map(categories.map(category => [category.id, category]));

  const radius = radiusMeters || 1000;
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

    const distance = calculateDistance(geo.lat, geo.lng, coords.lat, coords.lon);
    if (distance > radius) continue;

    const mappedOffer = {
      offerId: offer.id,
      price: offer.price,
      currency: offer.currency,
      isAvailable: offer.isAvailable,
      quantity: offer.quantity,
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

  return products
    .map(product => {
      const offersWithStores = (offersByProduct.get(product.id) || [])
        .sort((a, b) => a.store.distanceMeters - b.store.distanceMeters);
      if (offersWithStores.length === 0) return null;
      const category = categoryById.get(product.categoryId) || null;

      return {
        product: {
          id: product.id,
          name: product.name,
          description: product.description,
          images: product.images,
          category: category ? { id: category.id, name: category.name } : null,
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
}

async function postMessage(req, res) {
  try {
    const { conversationId } = req.params;
    const { text, attachments, geo, radiusMeters } = req.body || {};
    const conversation = await SearchConversation.findOne({ id: conversationId });
    if (!conversation) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    const message = await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'CUSTOMER',
      text: text || '',
      attachmentIds: Array.isArray(attachments) ? attachments : []
    });

    let intent = conversation.intentId
      ? await SearchIntent.findOne({ id: conversation.intentId })
      : null;
    if (!intent) {
      intent = await SearchIntent.create({
        id: generateId(),
        conversationId,
        rawText: text || '',
        filters: {}
      });
      conversation.intentId = intent.id;
    } else if (text) {
      intent.rawText = (intent.rawText ? intent.rawText + ' ' : '') + text;
    }

    conversation.updatedAt = new Date();

    // Если это первое сообщение и нет геолокации, просим её
    if (!geo || geo.lat === undefined || geo.lng === undefined) {
      // Но только если это действительно первое сообщение
      const messageCount = await SearchMessage.countDocuments({ conversationId, sender: 'CUSTOMER' });
      if (messageCount === 1) {
        conversation.state = 'NEEDS_CLARIFICATION';
        await conversation.save();
        return res.json({
          state: conversation.state,
          messageId: message.id,
          questions: ['Уточните ваше местоположение и радиус поиска']
        });
      }
    }

    // Получаем кандидатов товаров
    let candidates = [];
    if (intent.filters && Array.isArray(intent.filters.candidateProductIds) && intent.filters.candidateProductIds.length > 0) {
      // Используем сохраненных кандидатов из предыдущих шагов
      candidates = await Product.find({ 
        id: { $in: intent.filters.candidateProductIds },
        isPayed: true,
        paymentExpiresAt: { $gt: new Date() }
      }).lean();
    } else {
      // Первый поиск по тексту
      candidates = await buildCandidatesByText(text);
      // Фильтруем только оплаченные товары
      candidates = candidates.filter(p => p.isPayed && p.paymentExpiresAt && new Date(p.paymentExpiresAt) > new Date());
    }

    if (candidates.length === 0) {
      conversation.state = 'NEEDS_CLARIFICATION';
      await conversation.save();
      await intent.save();
      return res.json({
        state: conversation.state,
        messageId: message.id,
        questions: ['Не нашел товар. Уточните название или бренд.'],
        quickReplies: []
      });
    }

    // Пытаемся извлечь информацию из сообщения через Gemini
    let geminiResult = null;
    try {
      geminiResult = await getIntentFromGemini({
        message: text || '',
        candidates: candidates.map(item => ({
          id: item.id,
          name: item.name,
          brandName: item.brandName,
          packageInfo: item.packageInfo,
          description: item.description,
          sku: item.sku
        })),
        known: {
          brand: intent.brand || null,
          packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null,
          type: intent.type || null
        }
      });
    } catch (error) {
      console.error('Ошибка при получении intent от Gemini:', error);
      geminiResult = null;
    }

    // Обновляем intent на основе ответа Gemini
    if (geminiResult && geminiResult.action === 'READY_TO_SEARCH') {
      const aiIntent = geminiResult.intent || {};
      if (aiIntent.brand !== undefined && aiIntent.brand !== null) {
        intent.brand = aiIntent.brand;
      }
      if (aiIntent.type !== undefined && aiIntent.type !== null) {
        intent.type = aiIntent.type;
      }
      if (aiIntent.packageInfo !== undefined && aiIntent.packageInfo !== null) {
        intent.packageInfo = aiIntent.packageInfo;
      }
    }

    // Фильтруем кандидатов на основе текущего intent
    candidates = filterCandidatesByIntent(candidates, {
      brand: intent.brand || null,
      packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null,
      type: intent.type || null
    });

    // Сохраняем отфильтрованных кандидатов
    intent.filters = {
      ...(intent.filters || {}),
      candidateProductIds: candidates.map(item => item.id)
    };

    // Если кандидатов нет, просим уточнить
    if (candidates.length === 0) {
      conversation.state = 'NEEDS_CLARIFICATION';
      await intent.save();
      await conversation.save();
      
      // Сбрасываем фильтры и начинаем заново
      intent.filters = {};
      intent.brand = null;
      intent.packageInfo = null;
      intent.type = null;
      await intent.save();
      
      return res.json({
        state: conversation.state,
        messageId: message.id,
        questions: ['Не нашел подходящих товаров. Уточните запрос, пожалуйста.'],
        quickReplies: []
      });
    }

    // Если остался один товар - можно переходить к поиску (если есть геолокация)
    if (candidates.length === 1) {
      if (!geo || geo.lat === undefined || geo.lng === undefined) {
        conversation.state = 'NEEDS_CLARIFICATION';
        await intent.save();
        await conversation.save();
        return res.json({
          state: conversation.state,
          messageId: message.id,
          questions: ['Отлично! Найден товар. Уточните ваше местоположение для поиска магазинов.'],
          selectedProduct: {
            id: candidates[0].id,
            name: candidates[0].name,
            brandName: candidates[0].brandName,
            packageInfo: candidates[0].packageInfo
          }
        });
      }

      // Сохраняем intent и продолжаем к поиску
      await intent.save();
      
      const request = await SearchRequest.create({
        id: generateId(),
        conversationId,
        intentId: intent.id,
        geo: { lat: geo.lat, lng: geo.lng },
        radiusMeters: radiusMeters || 1000,
        expiresAt: nowPlus(RESULT_TTL_MS)
      });

      conversation.requestId = request.id;
      conversation.state = 'SEARCHING';
      await conversation.save();

      const items = await performSearch({ text, geo, radiusMeters, intent });
      const result = await SearchResult.create({
        id: generateId(),
        requestId: request.id,
        items,
        expiresAt: nowPlus(RESULT_TTL_MS)
      });

      conversation.resultId = result.id;
      conversation.state = 'DONE';
      await conversation.save();

      // Добавляем ответное сообщение от системы
      await SearchMessage.create({
        id: generateId(),
        conversationId,
        sender: 'SYSTEM',
        text: `Найден товар: ${candidates[0].name}${candidates[0].brandName ? ' (' + candidates[0].brandName + ')' : ''}${candidates[0].packageInfo ? ' - ' + candidates[0].packageInfo : ''}`
      });

      return res.json({
        state: conversation.state,
        messageId: message.id,
        requestId: request.id,
        resultId: result.id,
        items,
        selectedProduct: {
          id: candidates[0].id,
          name: candidates[0].name,
          brandName: candidates[0].brandName,
          packageInfo: candidates[0].packageInfo
        }
      });
    }

    // Если товаров больше одного - генерируем умные вопросы через Gemini
    // Цель: сузить выбор до одного товара
    let clarification = null;
    try {
      clarification = await generateClarificationQuestions({
        candidates: candidates.map(item => ({
          id: item.id,
          name: item.name,
          brandName: item.brandName,
          packageInfo: item.packageInfo,
          description: item.description,
          sku: item.sku
        })),
        known: {
          brand: intent.brand || null,
          packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null,
          type: intent.type || null
        }
      });
    } catch (error) {
      console.error('Ошибка при генерации вопросов:', error);
      // Fallback на простые вопросы
      clarification = buildClarificationQuestions(candidates, {
        brand: intent.brand || null,
        packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null
      });
    }

    conversation.state = 'NEEDS_CLARIFICATION';
    await intent.save();
    await conversation.save();
    
    // Добавляем ответное сообщение от системы с вопросами
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: clarification.questions.length > 0 
        ? clarification.questions.join(' ')
        : 'Уточните, какой именно товар вас интересует?'
    });
    
    return res.json({
      state: conversation.state,
      messageId: message.id,
      questions: clarification.questions.length > 0
        ? clarification.questions
        : ['Уточните, какой именно товар вас интересует?'],
      quickReplies: clarification.quickReplies || [],
      remainingProducts: candidates.length
    });
  } catch (error) {
    console.error('Ошибка при обработке сообщения:', error);
    res.status(500).json({ error: 'Ошибка при обработке сообщения' });
  }
}

async function createSearch(req, res) {
  try {
    const { conversationId, text, geo, radiusMeters } = req.body || {};
    if (!conversationId || !geo || geo.lat === undefined || geo.lng === undefined) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }
    const conversation = await SearchConversation.findOne({ id: conversationId });
    if (!conversation) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    const request = await SearchRequest.create({
      id: generateId(),
      conversationId,
      intentId: conversation.intentId || generateId(),
      geo: { lat: geo.lat, lng: geo.lng },
      radiusMeters: radiusMeters || 1000,
      expiresAt: nowPlus(RESULT_TTL_MS)
    });

    const items = await performSearch({ text, geo, radiusMeters });
    const result = await SearchResult.create({
      id: generateId(),
      requestId: request.id,
      items,
      expiresAt: nowPlus(RESULT_TTL_MS)
    });

    conversation.requestId = request.id;
    conversation.resultId = result.id;
    conversation.state = 'DONE';
    await conversation.save();

    res.json({
      requestId: request.id,
      resultId: result.id,
      items
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при поиске' });
  }
}

async function getSearch(req, res) {
  try {
    const { requestId } = req.params;
    const result = await SearchResult.findOne({ requestId }).lean();
    if (!result) {
      return res.status(404).json({ error: 'Результаты не найдены' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении результатов' });
  }
}

async function uploadAttachment(req, res) {
  try {
    const { sessionId, conversationId } = req.body || {};
    if (!sessionId || !conversationId) {
      return res.status(400).json({ error: 'sessionId и conversationId обязательны' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Файл не передан' });
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype) && !ALLOWED_AUDIO_TYPES.has(file.mimetype)) {
      return res.status(400).json({ error: 'Недопустимый тип файла' });
    }

    const { url, key } = await uploadImage({
      buffer: file.buffer,
      contentType: file.mimetype,
      folder: 'customer'
    });

    const attachment = await Attachment.create({
      id: generateId(),
      sessionId,
      conversationId,
      type: ALLOWED_IMAGE_TYPES.has(file.mimetype) ? 'image' : 'audio',
      url,
      metadata: { key, size: file.size, contentType: file.mimetype },
      expiresAt: nowPlus(ATTACHMENT_TTL_MS)
    });

    res.status(201).json({
      attachmentId: attachment.id,
      url,
      type: attachment.type
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при загрузке файла' });
  }
}

async function uploadVoice(req, res) {
  try {
    const { sessionId, conversationId } = req.body || {};
    if (!sessionId || !conversationId) {
      return res.status(400).json({ error: 'sessionId и conversationId обязательны' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Файл не передан' });
    }
    if (!ALLOWED_AUDIO_TYPES.has(file.mimetype)) {
      return res.status(400).json({ error: 'Недопустимый тип аудио' });
    }

    const { url, key } = await uploadImage({
      buffer: file.buffer,
      contentType: file.mimetype,
      folder: 'customer-audio'
    });

    const attachment = await Attachment.create({
      id: generateId(),
      sessionId,
      conversationId,
      type: 'audio',
      url,
      metadata: { key, size: file.size, contentType: file.mimetype },
      expiresAt: nowPlus(ATTACHMENT_TTL_MS)
    });

    const transcript = await transcribeAudio({
      buffer: file.buffer,
      mimeType: file.mimetype
    });

    const voice = await VoiceInput.create({
      id: generateId(),
      messageId: attachment.id,
      transcript,
      confidence: null,
      language: null
    });

    res.status(201).json({
      attachmentId: attachment.id,
      url,
      transcript: voice.transcript,
      confidence: voice.confidence,
      language: voice.language
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при обработке голоса' });
  }
}

async function getHistory(req, res) {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    const conversations = await SearchConversation.find({ sessionId })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ items: conversations, total: conversations.length });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении истории' });
  }
}

async function exportHistory(req, res) {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    const conversations = await SearchConversation.find({ sessionId }).lean();
    const conversationIds = conversations.map(item => item.id);
    const messages = await SearchMessage.find({ conversationId: { $in: conversationIds } })
      .sort({ createdAt: 1 })
      .lean();
    res.json({ conversations, messages });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при экспорте истории' });
  }
}

async function deleteHistory(req, res) {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    const conversations = await SearchConversation.find({ sessionId }).lean();
    const conversationIds = conversations.map(item => item.id);
    await SearchMessage.deleteMany({ conversationId: { $in: conversationIds } });
    await SearchConversation.deleteMany({ sessionId });
    await Attachment.deleteMany({ sessionId });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении истории' });
  }
}

module.exports = {
  upload,
  createSession,
  getSession,
  createConversation,
  getConversation,
  postMessage,
  createSearch,
  getSearch,
  uploadAttachment,
  uploadVoice,
  getHistory,
  exportHistory,
  deleteHistory
};

