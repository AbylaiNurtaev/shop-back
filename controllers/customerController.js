const multer = require('multer');
const { generateId } = require('../utils/uuid');
const { uploadImage } = require('../utils/s3');
const { calculateDistance, getCoordinatesFromLink } = require('../utils/distance');
const { getIntentFromGemini, transcribeAudio, generateClarificationQuestions, analyzeProductImage } = require('../utils/gemini');
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

/**
 * Транслитерация: русский -> латинский
 */
function transliterateToLatin(text) {
  const map = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd',
    'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i',
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n',
    'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
    'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch',
    'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '',
    'э': 'e', 'ю': 'yu', 'я': 'ya'
  };

  return text
    .toLowerCase()
    .split('')
    .map(char => map[char] || char)
    .join('');
}

/**
 * Транслитерация: латинский -> русский (основные варианты)
 */
function transliterateToCyrillic(text) {
  const map = {
    'a': 'а', 'b': 'б', 'v': 'в', 'g': 'г', 'd': 'д',
    'e': 'е', 'yo': 'ё', 'zh': 'ж', 'z': 'з', 'i': 'и',
    'y': 'й', 'k': 'к', 'l': 'л', 'm': 'м', 'n': 'н',
    'o': 'о', 'p': 'п', 'r': 'р', 's': 'с', 't': 'т',
    'u': 'у', 'f': 'ф', 'h': 'х', 'ts': 'ц', 'ch': 'ч',
    'sh': 'ш', 'sch': 'щ', 'yu': 'ю', 'ya': 'я'
  };

  // Простая замена для коротких слов
  let result = text.toLowerCase();
  Object.entries(map).sort((a, b) => b[0].length - a[0].length).forEach(([lat, cyr]) => {
    result = result.replace(new RegExp(lat, 'gi'), cyr);
  });
  return result;
}

/**
 * Создает фонетические варианты для популярных товаров
 * Например: "колу" -> "cola", "кока кола" -> "coca cola"
 */
function createPhoneticVariants(text) {
  const normalized = normalizeText(text);
  const variants = [];

  // Популярные фонетические совпадения
  const phoneticMap = {
    'кола': ['cola', 'coca', 'coca cola', 'кока кола'],
    'кока': ['coca', 'cola', 'coca cola', 'кока кола'],
    'cola': ['кола', 'кока', 'coca', 'coca cola', 'кока кола'],
    'coca': ['кока', 'кола', 'cola', 'coca cola', 'кока кола'],
    'пепси': ['pepsi'],
    'pepsi': ['пепси'],
    'фанта': ['fanta'],
    'fanta': ['фанта'],
    'спрайт': ['sprite'],
    'sprite': ['спрайт']
  };

  // Проверяем точные совпадения
  if (phoneticMap[normalized]) {
    variants.push(...phoneticMap[normalized]);
  }

  // Проверяем частичные совпадения
  Object.entries(phoneticMap).forEach(([key, values]) => {
    if (normalized.includes(key) || key.includes(normalized)) {
      variants.push(...values);
      variants.push(key);
    }
  });

  return [...new Set(variants)];
}

/**
 * Создает варианты поискового запроса с учетом транслитерации и фонетики
 */
function createSearchVariants(text) {
  const normalized = normalizeText(text);
  const variants = [normalized];

  // Добавляем фонетические варианты
  const phoneticVariants = createPhoneticVariants(text);
  variants.push(...phoneticVariants);

  // Если есть русские буквы - добавляем латинский вариант
  if (/[а-яё]/i.test(normalized)) {
    variants.push(transliterateToLatin(normalized));
  }

  // Если есть латинские буквы - добавляем русский вариант
  if (/[a-z]/i.test(normalized)) {
    variants.push(transliterateToCyrillic(normalized));
  }

  return [...new Set(variants)];
}

function extractBrandFromText(text, brands) {
  const normalized = normalizeText(text);
  return (brands || []).find(brand => normalized.includes(normalizeText(brand))) || null;
}

async function buildCandidatesByText(text) {
  if (!text || !text.trim()) return [];

  const searchVariants = createSearchVariants(text);
  if (searchVariants.length === 0) return [];

  // Создаем запрос с учетом всех вариантов транслитерации
  // Используем $or для поиска по любому из вариантов
  const searchRegex = searchVariants.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  // Оптимизированный запрос - ищем по всем полям одновременно
  const query = {
    $and: [
      {
        $or: [
          { name: { $regex: searchRegex, $options: 'i' } },
          { description: { $regex: searchRegex, $options: 'i' } },
          { brandName: { $regex: searchRegex, $options: 'i' } },
          { sku: { $regex: searchRegex, $options: 'i' } }
        ]
      },
      { isPayed: true },
      { paymentExpiresAt: { $gt: new Date() } }
    ]
  };

  // Ограничиваем количество результатов для ускорения
  return Product.find(query).limit(30).lean();
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

  // Фильтрация по бренду (точное совпадение или включение)
  if (intent.brand) {
    const brandNormalized = normalizeText(intent.brand);
    filtered = filtered.filter(item => {
      if (!item.brandName) return false;
      const itemBrand = normalizeText(item.brandName);
      // Точное совпадение или включение
      return itemBrand === brandNormalized || itemBrand.includes(brandNormalized) || brandNormalized.includes(itemBrand);
    });
  }

  // Фильтрация по упаковке (более гибкая)
  if (intent.packageInfo !== null && intent.packageInfo !== undefined) {
    const packageNormalized = normalizeText(intent.packageInfo);
    filtered = filtered.filter(item => {
      if (!item.packageInfo) return false;
      const itemPackage = normalizeText(item.packageInfo);
      // Ищем совпадения по числам (0.5, 0,5, поллитра и т.д.)
      const extractNumbers = (str) => str.replace(/[^\d.,]/g, '').replace(',', '.');
      const itemNums = extractNumbers(itemPackage);
      const intentNums = extractNumbers(packageNormalized);

      // Если есть числа, сравниваем их
      if (itemNums && intentNums && itemNums === intentNums) {
        return true;
      }
      // Иначе обычное сравнение
      return itemPackage === packageNormalized ||
        itemPackage.includes(packageNormalized) ||
        packageNormalized.includes(itemPackage);
    });
  }

  // Фильтрация по типу товара
  if (intent.type) {
    const typeLower = normalizeText(intent.type);
    const typeKeywords = {
      'zero': ['zero', 'ноль', '0', 'без сахара', 'безсахар'],
      'light': ['light', 'лайт', 'легкий'],
      'diet': ['diet', 'диет', 'диетический'],
      'classic': ['classic', 'классическая', 'классик', 'обычная', 'original', 'оригинал'],
      'обычная': ['обычная', 'классическая', 'classic', 'original', 'оригинал']
    };

    const keywords = typeKeywords[typeLower] || [typeLower];

    filtered = filtered.filter(item => {
      const nameLower = normalizeText(item.name);
      const descLower = normalizeText(item.description || '');
      const brandLower = normalizeText(item.brandName || '');
      const fullText = `${nameLower} ${descLower} ${brandLower}`;

      // Для "classic" - если в товаре нет явных указаний на zero/light/diet, считаем его classic
      if (typeLower === 'classic' || typeLower === 'обычная') {
        const hasZero = ['zero', 'ноль', '0', 'без сахара', 'безсахар'].some(k => fullText.includes(k));
        const hasLight = ['light', 'лайт', 'легкий'].some(k => fullText.includes(k));
        const hasDiet = ['diet', 'диет', 'диетический'].some(k => fullText.includes(k));

        // Если нет указаний на zero/light/diet - это classic
        if (!hasZero && !hasLight && !hasDiet) {
          return true;
        }
      }

      // Обычная проверка по ключевым словам
      return keywords.some(keyword => fullText.includes(keyword));
    });
  }

  // Фильтрация по типу упаковки (стекло/металл/пластик)
  if (intent.packageType) {
    const packageTypeLower = normalizeText(intent.packageType);
    filtered = filtered.filter(item => {
      const nameLower = normalizeText(item.name || '');
      const descLower = normalizeText(item.description || '');
      const packageInfoLower = normalizeText(item.packageInfo || '');
      const fullText = `${nameLower} ${descLower} ${packageInfoLower}`;

      if (packageTypeLower === 'glass' || packageTypeLower === 'стекло') {
        return fullText.includes('стекл') || fullText.includes('glass');
      }
      if (packageTypeLower === 'can' || packageTypeLower === 'металл' || packageTypeLower === 'банка') {
        return fullText.includes('банка') || fullText.includes('can') || fullText.includes('жест') || fullText.includes('металл');
      }
      if (packageTypeLower === 'plastic' || packageTypeLower === 'пластик') {
        return fullText.includes('пласти') || fullText.includes('pet');
      }
      return false;
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

  // Функция для форматирования расстояния
  const formatDistance = (meters) => {
    if (meters < 1000) {
      return `${Math.round(meters)} м`;
    }
    const km = (meters / 1000).toFixed(1);
    return `${km} км`;
  };

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
    const isWithinRadius = distance <= radius;

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
        locationCoords: store.locationCoords || null,
        distanceMeters: Math.round(distance),
        distanceFormatted: formatDistance(Math.round(distance)),
        isWithinRadius: isWithinRadius
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
        .sort((a, b) => {
          // Сначала показываем предложения в радиусе, потом вне радиуса
          if (a.store.isWithinRadius !== b.store.isWithinRadius) {
            return a.store.isWithinRadius ? -1 : 1;
          }
          // Внутри каждой группы сортируем по расстоянию
          return a.store.distanceMeters - b.store.distanceMeters;
        });

      const category = categoryById.get(product.categoryId) || null;
      const offersInRadius = offersWithStores.filter(o => o.store.isWithinRadius);

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
        offers: offersWithStores,
        // Статистика для удобства
        totalOffers: offersWithStores.length,
        offersInRadius: offersInRadius.length,
        nearestStore: offersWithStores.length > 0 ? {
          name: offersWithStores[0].store.name,
          distance: offersWithStores[0].store.distanceFormatted,
          distanceMeters: offersWithStores[0].store.distanceMeters,
          address: offersWithStores[0].store.address,
          location: offersWithStores[0].store.location,
          isWithinRadius: offersWithStores[0].store.isWithinRadius
        } : null
      };
    });
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

    // Проверяем, есть ли уже выбранный товар и пришла ли геолокация
    if (intent && intent.filters && Array.isArray(intent.filters.candidateProductIds) && intent.filters.candidateProductIds.length === 1) {
      // Есть выбранный товар - проверяем геолокацию
      if (geo && geo.lat !== undefined && geo.lng !== undefined) {
        // Выполняем поиск для уже выбранного товара
        const selectedProduct = await Product.findOne({ id: intent.filters.candidateProductIds[0] }).lean();
        if (selectedProduct) {
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

          const items = await performSearch({ text: intent.rawText || text, geo, radiusMeters, intent });
          const result = await SearchResult.create({
            id: generateId(),
            requestId: request.id,
            items,
            expiresAt: nowPlus(RESULT_TTL_MS)
          });

          conversation.resultId = result.id;
          conversation.state = 'DONE';
          await conversation.save();

          // Формируем сообщение о найденном товаре
          const productName = `${selectedProduct.name}${selectedProduct.brandName ? ' (' + selectedProduct.brandName + ')' : ''}${selectedProduct.packageInfo ? ' - ' + selectedProduct.packageInfo : ''}`;
          let systemMessage = `Найден товар: ${productName}`;

          if (items.length === 0) {
            systemMessage += '\nК сожалению, в ближайших магазинах нет предложений по этому товару. Попробуйте увеличить радиус поиска или уточнить запрос.';
          } else {
            const item = items[0]; // Берем первый товар (должен быть один)
            const totalOffers = item.offers?.length || 0;
            const offersInRadius = item.offersInRadius || 0;

            if (totalOffers === 0) {
              systemMessage += '\nК сожалению, в базе нет предложений по этому товару.';
            } else if (offersInRadius === 0) {
              const nearest = item.nearestStore;
              if (nearest) {
                systemMessage += `\nНайдено предложений: ${totalOffers}, но все они находятся вне радиуса поиска. Ближайший магазин "${nearest.name}" находится на расстоянии ${nearest.distance}.`;
              } else {
                systemMessage += `\nНайдено предложений: ${totalOffers}, но все они находятся вне радиуса поиска.`;
              }
            } else {
              systemMessage += `\nНайдено предложений: ${totalOffers} (${offersInRadius} в радиусе ${radiusMeters || 1000}м).`;
            }
          }

          // Добавляем ответное сообщение от системы
          await SearchMessage.create({
            id: generateId(),
            conversationId,
            sender: 'SYSTEM',
            text: systemMessage
          });

          return res.json({
            state: conversation.state,
            messageId: message.id,
            requestId: request.id,
            resultId: result.id,
            items: items.length > 0 ? items : [],
            selectedProduct: {
              id: selectedProduct.id,
              name: selectedProduct.name,
              brandName: selectedProduct.brandName,
              packageInfo: selectedProduct.packageInfo
            }
          });
        }
      }
    }

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

      // Сбрасываем фильтры, чтобы начать поиск заново
      intent.filters = {};
      intent.brand = null;
      intent.packageInfo = null;
      intent.type = null;
      intent.packageType = null;
      await intent.save();

      return res.json({
        state: conversation.state,
        messageId: message.id,
        questions: ['Не нашел такой товар. Попробуйте написать название по-другому или укажите бренд.'],
        quickReplies: []
      });
    }

    // Пытаемся извлечь информацию из сообщения через Gemini
    // Используем только если есть кандидаты и текст не пустой
    let geminiResult = null;
    if (text && text.trim() && candidates.length > 0) {
      try {
        // Ограничиваем количество кандидатов для ускорения
        const candidatesForGemini = candidates.slice(0, 15).map(item => ({
          id: item.id,
          name: item.name,
          brandName: item.brandName,
          packageInfo: item.packageInfo,
          description: item.description,
          sku: item.sku
        }));

        geminiResult = await getIntentFromGemini({
          message: text.trim(),
          candidates: candidatesForGemini,
          known: {
            brand: intent.brand || null,
            packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null,
            type: intent.type || null,
            packageType: intent.packageType || null
          }
        });
      } catch (error) {
        console.error('Ошибка при получении intent от Gemini:', error);
        geminiResult = null;
      }
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
      if (aiIntent.packageType !== undefined && aiIntent.packageType !== null) {
        intent.packageType = aiIntent.packageType;
      }
      // Сохраняем intent сразу после обновления
      await intent.save();
    }

    // Сохраняем предыдущих кандидатов перед фильтрацией (для fallback)
    const previousCandidateIds = intent.filters && Array.isArray(intent.filters.candidateProductIds)
      ? intent.filters.candidateProductIds
      : candidates.map(c => c.id);

    // Фильтруем кандидатов на основе текущего intent
    candidates = filterCandidatesByIntent(candidates, {
      brand: intent.brand || null,
      packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null,
      type: intent.type || null,
      packageType: intent.packageType || null
    });

    // Сохраняем отфильтрованных кандидатов
    intent.filters = {
      ...(intent.filters || {}),
      candidateProductIds: candidates.map(item => item.id)
    };

    // Если кандидатов нет после фильтрации, пробуем более мягкую фильтрацию
    if (candidates.length === 0) {
      // Пробуем фильтровать без последнего добавленного параметра
      let fallbackCandidates = [];

      if (previousCandidateIds && previousCandidateIds.length > 0) {
        // Берем предыдущих кандидатов
        fallbackCandidates = await Product.find({
          id: { $in: previousCandidateIds },
          isPayed: true,
          paymentExpiresAt: { $gt: new Date() }
        }).lean();
      } else {
        // Берем исходных кандидатов из текста
        fallbackCandidates = await buildCandidatesByText(text);
        fallbackCandidates = fallbackCandidates.filter(p => p.isPayed && p.paymentExpiresAt && new Date(p.paymentExpiresAt) > new Date());
      }

      // Фильтруем без последнего параметра (type или packageType)
      const fallbackIntent = { ...intent };
      if (intent.type) {
        // Убираем type и пробуем снова
        fallbackIntent.type = null;
        candidates = filterCandidatesByIntent(fallbackCandidates, {
          brand: fallbackIntent.brand || null,
          packageInfo: fallbackIntent.packageInfo !== undefined ? fallbackIntent.packageInfo : null,
          type: null,
          packageType: fallbackIntent.packageType || null
        });

        // Если все еще нет кандидатов, сбрасываем все фильтры
        if (candidates.length === 0) {
          conversation.state = 'NEEDS_CLARIFICATION';
          intent.filters = {};
          intent.brand = null;
          intent.packageInfo = null;
          intent.type = null;
          intent.packageType = null;
          await intent.save();
          await conversation.save();

          return res.json({
            state: conversation.state,
            messageId: message.id,
            questions: ['Не нашел подходящих товаров. Попробуйте уточнить запрос по-другому.'],
            quickReplies: []
          });
        } else {
          // Откатываем type, так как фильтр слишком строгий
          intent.type = null;
          await intent.save();
        }
      } else {
        // Если нет кандидатов и не было type, просто сбрасываем
        conversation.state = 'NEEDS_CLARIFICATION';
        intent.filters = {};
        intent.brand = null;
        intent.packageInfo = null;
        intent.type = null;
        intent.packageType = null;
        await intent.save();
        await conversation.save();

        return res.json({
          state: conversation.state,
          messageId: message.id,
          questions: ['Не нашел подходящих товаров. Уточните запрос, пожалуйста.'],
          quickReplies: []
        });
      }
    }

    // Если остался один товар - можно переходить к поиску (если есть геолокация)
    if (candidates.length === 1) {
      // Сохраняем intent с выбранным товаром
      intent.filters = {
        ...(intent.filters || {}),
        candidateProductIds: [candidates[0].id]
      };
      await intent.save();

      if (!geo || geo.lat === undefined || geo.lng === undefined) {
        conversation.state = 'NEEDS_CLARIFICATION';
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

      // Формируем сообщение о найденном товаре
      const productName = `${candidates[0].name}${candidates[0].brandName ? ' (' + candidates[0].brandName + ')' : ''}${candidates[0].packageInfo ? ' - ' + candidates[0].packageInfo : ''}`;
      let systemMessage = `Найден товар: ${productName}`;

      if (items.length === 0) {
        systemMessage += '\nК сожалению, в ближайших магазинах нет предложений по этому товару. Попробуйте увеличить радиус поиска или уточнить запрос.';
      } else {
        const item = items[0]; // Берем первый товар (должен быть один)
        const totalOffers = item.offers?.length || 0;
        const offersInRadius = item.offersInRadius || 0;

        if (totalOffers === 0) {
          systemMessage += '\nК сожалению, в базе нет предложений по этому товару.';
        } else if (offersInRadius === 0) {
          const nearest = item.nearestStore;
          if (nearest) {
            systemMessage += `\nНайдено предложений: ${totalOffers}, но все они находятся вне радиуса поиска. Ближайший магазин "${nearest.name}" находится на расстоянии ${nearest.distance}.`;
          } else {
            systemMessage += `\nНайдено предложений: ${totalOffers}, но все они находятся вне радиуса поиска.`;
          }
        } else {
          systemMessage += `\nНайдено предложений: ${totalOffers} (${offersInRadius} в радиусе ${radiusMeters || 1000}м).`;
        }
      }

      // Добавляем ответное сообщение от системы
      await SearchMessage.create({
        id: generateId(),
        conversationId,
        sender: 'SYSTEM',
        text: systemMessage
      });

      return res.json({
        state: conversation.state,
        messageId: message.id,
        requestId: request.id,
        resultId: result.id,
        items: items.length > 0 ? items : [], // Всегда возвращаем массив, даже если пустой
        selectedProduct: {
          id: candidates[0].id,
          name: candidates[0].name,
          brandName: candidates[0].brandName,
          packageInfo: candidates[0].packageInfo
        }
      });
    }

    // Если товаров больше одного - генерируем умные вопросы через Gemini
    // Цель: сузить выбор до одного товара (работает как Акинатор)

    // Получаем предыдущие вопросы из истории сообщений системы
    const previousSystemMessages = await SearchMessage.find({
      conversationId,
      sender: 'SYSTEM'
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const previousQuestions = previousSystemMessages
      .map(msg => msg.text)
      .filter(text => text && text.trim().length > 0);

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
          type: intent.type || null,
          packageType: intent.packageType || null
        },
        previousQuestions: previousQuestions
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

    // Формируем вопрос (только один, как Акинатор)
    const question = clarification.questions.length > 0
      ? clarification.questions[0]
      : 'Уточните, какой именно товар вас интересует?';

    // Добавляем ответное сообщение от системы с вопросом
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: question
    });

    return res.json({
      state: conversation.state,
      messageId: message.id,
      questions: [question],
      quickReplies: clarification.quickReplies || []
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

async function searchByImage(req, res) {
  try {
    let { conversationId, geo, radiusMeters } = req.body || {};
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'Изображение не передано' });
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return res.status(400).json({ error: 'Недопустимый тип файла. Поддерживаются только изображения.' });
    }

    // Парсим geo, если это строка JSON
    if (typeof geo === 'string') {
      try {
        geo = JSON.parse(geo);
      } catch (e) {
        geo = null;
      }
    }

    // Парсим radiusMeters, если это строка
    if (radiusMeters && typeof radiusMeters === 'string') {
      radiusMeters = parseInt(radiusMeters, 10) || 1000;
    }

    // Анализируем изображение с помощью Gemini
    let imageAnalysis = null;
    try {
      imageAnalysis = await analyzeProductImage({
        buffer: file.buffer,
        mimeType: file.mimetype
      });
    } catch (error) {
      console.error('Ошибка при анализе изображения:', error);
      return res.status(500).json({
        error: 'Не удалось проанализировать изображение',
        details: error.message
      });
    }

    if (!imageAnalysis) {
      return res.status(500).json({ error: 'Не удалось извлечь информацию из изображения' });
    }

    console.log('Анализ изображения:', imageAnalysis);

    // Функция для нормализации объема (330 ml -> 0.33, 330мл -> 0.33, 0.5л -> 0.5)
    // Определяем функцию перед использованием
    const normalizeVolume = (volumeStr) => {
      if (!volumeStr) return null;
      const normalized = normalizeText(volumeStr);

      // Извлекаем числа
      const extractNumbers = (str) => {
        const match = str.match(/(\d+[.,]?\d*)/);
        if (!match) return null;
        return parseFloat(match[1].replace(',', '.'));
      };

      const num = extractNumbers(normalized);
      if (!num) return null;

      // Если указано в мл и больше 100, конвертируем в литры
      if (normalized.includes('ml') || normalized.includes('мл')) {
        if (num >= 100) {
          return (num / 1000).toFixed(2);
        }
        return (num / 1000).toFixed(3);
      }

      // Если указано в литрах, возвращаем как есть
      if (normalized.includes('l') || normalized.includes('л') || normalized.includes('литр')) {
        return num.toFixed(2);
      }

      // Если число меньше 10, считаем литрами
      if (num < 10) {
        return num.toFixed(2);
      }

      // Если число больше 10, считаем миллилитрами и конвертируем
      return (num / 1000).toFixed(2);
    };

    // Нормализуем объем из анализа
    const normalizedVolume = normalizeVolume(imageAnalysis.packageInfo);
    console.log('Нормализованный объем:', normalizedVolume, 'из', imageAnalysis.packageInfo);

    // Создаем поисковый запрос на основе анализа изображения
    const searchTerms = [];
    if (imageAnalysis.productName) searchTerms.push(imageAnalysis.productName);
    if (imageAnalysis.brand) searchTerms.push(imageAnalysis.brand);
    // Не добавляем description, так как он может содержать лишнюю информацию

    const searchText = searchTerms.join(' ');
    console.log('Поисковый запрос:', searchText);

    // Ищем товары в базе данных
    let candidates = [];
    if (searchText.trim()) {
      candidates = await buildCandidatesByText(searchText);
      candidates = candidates.filter(p => p.isPayed && p.paymentExpiresAt && new Date(p.paymentExpiresAt) > new Date());
      console.log('Найдено кандидатов после текстового поиска:', candidates.length);
    }

    // Если кандидатов нет, пробуем поиск только по бренду и ключевым словам
    if (candidates.length === 0 && imageAnalysis.brand) {
      console.log('Пробуем поиск только по бренду:', imageAnalysis.brand);

      // Нормализуем бренд для поиска
      const brandNormalized = normalizeBrand(imageAnalysis.brand);

      // Создаем варианты поиска
      const searchVariants = [imageAnalysis.brand, brandNormalized];

      // Добавляем ключевые слова
      if (brandNormalized.includes('кола') || brandNormalized.includes('coca')) {
        searchVariants.push('кола', 'coca cola', 'coca-cola', 'кока кола');
      }
      if (brandNormalized.includes('пепси') || brandNormalized.includes('pepsi')) {
        searchVariants.push('пепси', 'pepsi');
      }
      if (brandNormalized.includes('фанта') || brandNormalized.includes('fanta')) {
        searchVariants.push('фанта', 'fanta');
      }
      if (brandNormalized.includes('спрайт') || brandNormalized.includes('sprite')) {
        searchVariants.push('спрайт', 'sprite');
      }

      // Ищем по всем вариантам
      for (const variant of searchVariants) {
        const found = await buildCandidatesByText(variant);
        candidates.push(...found);
      }

      // Убираем дубликаты
      const uniqueIds = new Set();
      candidates = candidates.filter(p => {
        if (uniqueIds.has(p.id)) return false;
        if (!p.isPayed || !p.paymentExpiresAt || new Date(p.paymentExpiresAt) <= new Date()) return false;
        uniqueIds.add(p.id);
        return true;
      });

      console.log('Найдено кандидатов по бренду:', candidates.length);
    }

    // Функция для нормализации бренда (убирает дефисы, пробелы, приводит к общему виду)
    const normalizeBrand = (brand) => {
      if (!brand) return '';
      return normalizeText(brand)
        .replace(/[-\s]/g, '') // Убираем дефисы и пробелы
        .replace(/cola/g, 'кола')
        .replace(/coca/g, 'кока')
        .replace(/pepsi/g, 'пепси')
        .replace(/fanta/g, 'фанта')
        .replace(/sprite/g, 'спрайт');
    };

    // Если нашли бренд, фильтруем по нему (но не слишком строго)
    if (candidates.length > 0 && imageAnalysis.brand) {
      const brandNormalized = normalizeBrand(imageAnalysis.brand);
      const beforeFilter = candidates.length;

      // Если после фильтрации не осталось кандидатов, пробуем более мягкую фильтрацию
      let filtered = candidates.filter(item => {
        if (!item.brandName) return false;
        const itemBrand = normalizeBrand(item.brandName);

        // Точное совпадение после нормализации
        if (itemBrand === brandNormalized) return true;

        // Взаимное включение
        if (itemBrand.includes(brandNormalized) || brandNormalized.includes(itemBrand)) return true;

        // Проверяем ключевые слова (кола, пепси и т.д.)
        const keyWords = ['кола', 'пепси', 'фанта', 'спрайт'];
        const brandHasKeyword = keyWords.some(kw => brandNormalized.includes(kw));
        const itemHasKeyword = keyWords.some(kw => itemBrand.includes(kw));

        if (brandHasKeyword && itemHasKeyword) {
          // Если оба содержат одно и то же ключевое слово
          const brandKeyword = keyWords.find(kw => brandNormalized.includes(kw));
          const itemKeyword = keyWords.find(kw => itemBrand.includes(kw));
          if (brandKeyword === itemKeyword) return true;
        }

        return false;
      });

      // Если после строгой фильтрации не осталось, используем более мягкую
      if (filtered.length === 0 && beforeFilter > 0) {
        console.log('Применяем мягкую фильтрацию по бренду');
        filtered = candidates.filter(item => {
          if (!item.brandName) return true; // Оставляем товары без бренда
          const itemBrand = normalizeBrand(item.brandName);
          const brandNormalized = normalizeBrand(imageAnalysis.brand);

          // Проверяем ключевые слова
          const keyWords = ['кола', 'пепси', 'фанта', 'спрайт'];
          const brandKeyword = keyWords.find(kw => brandNormalized.includes(kw));
          const itemKeyword = keyWords.find(kw => itemBrand.includes(kw));

          if (brandKeyword && itemKeyword && brandKeyword === itemKeyword) {
            return true;
          }

          // Частичное совпадение
          return itemBrand.includes(brandNormalized) || brandNormalized.includes(itemBrand);
        });
      }

      candidates = filtered;
      console.log(`Фильтрация по бренду: ${beforeFilter} -> ${candidates.length}`);
    }

    // Сохраняем кандидатов до фильтрации по упаковке
    const candidatesBeforePackageFilter = [...candidates];

    // Фильтруем по типу упаковки, если указан (но не слишком строго)
    if (candidates.length > 0 && imageAnalysis.packageType) {
      const packageTypeLower = normalizeText(imageAnalysis.packageType);
      const beforeFilter = candidates.length;
      candidates = candidates.filter(item => {
        const nameLower = normalizeText(item.name || '');
        const descLower = normalizeText(item.description || '');
        const packageInfoLower = normalizeText(item.packageInfo || '');
        const fullText = `${nameLower} ${descLower} ${packageInfoLower}`;

        if (packageTypeLower === 'glass' || packageTypeLower === 'стекло') {
          return fullText.includes('стекл') || fullText.includes('glass');
        }
        if (packageTypeLower === 'can' || packageTypeLower === 'банка') {
          return fullText.includes('банка') || fullText.includes('can') || fullText.includes('жест') || fullText.includes('металл') || fullText.includes('жестя');
        }
        if (packageTypeLower === 'plastic' || packageTypeLower === 'пластик') {
          return fullText.includes('пласти') || fullText.includes('pet');
        }
        return true;
      });
      console.log(`Фильтрация по типу упаковки: ${beforeFilter} -> ${candidates.length}`);

      // Если после фильтрации по типу упаковки не осталось кандидатов, откатываем фильтр
      if (candidates.length === 0 && candidatesBeforePackageFilter.length > 0) {
        console.log('Откатываем фильтр по типу упаковки, так как не осталось кандидатов');
        candidates = candidatesBeforePackageFilter;
      }
    }

    // Фильтруем по объему, если указан (с нормализацией)
    if (candidates.length > 0 && normalizedVolume) {
      const beforeFilter = candidates.length;
      candidates = candidates.filter(item => {
        if (!item.packageInfo) return false;
        const itemPackage = normalizeText(item.packageInfo);
        const itemVolume = normalizeVolume(item.packageInfo);

        if (!itemVolume) {
          // Если не удалось нормализовать объем товара, проверяем текстовое совпадение
          return itemPackage.includes(normalizedVolume) || normalizedVolume.includes(itemPackage);
        }

        // Сравниваем нормализованные объемы с допуском
        const diff = Math.abs(parseFloat(itemVolume) - parseFloat(normalizedVolume));
        return diff < 0.1; // Допуск 0.1 литра
      });
      console.log(`Фильтрация по объему: ${beforeFilter} -> ${candidates.length}`);

      // Если после фильтрации по объему не осталось кандидатов, откатываем фильтр
      if (candidates.length === 0 && beforeFilter > 0) {
        console.log('Откатываем фильтр по объему, так как не осталось кандидатов');
        candidates = await buildCandidatesByText(searchText || imageAnalysis.brand || '');
        candidates = candidates.filter(p => p.isPayed && p.paymentExpiresAt && new Date(p.paymentExpiresAt) > new Date());

        // Применяем только фильтр по бренду (мягкий)
        if (imageAnalysis.brand) {
          const brandNormalized = normalizeBrand(imageAnalysis.brand);
          candidates = candidates.filter(item => {
            if (!item.brandName) return true; // Оставляем товары без бренда
            const itemBrand = normalizeBrand(item.brandName);

            // Проверяем ключевые слова
            const keyWords = ['кола', 'пепси', 'фанта', 'спрайт'];
            const brandKeyword = keyWords.find(kw => brandNormalized.includes(kw));
            const itemKeyword = keyWords.find(kw => itemBrand.includes(kw));

            if (brandKeyword && itemKeyword && brandKeyword === itemKeyword) {
              return true;
            }

            // Частичное совпадение
            return itemBrand.includes(brandNormalized) || brandNormalized.includes(itemBrand);
          });
        }
      }
    }

    console.log('Итоговое количество кандидатов:', candidates.length);

    if (candidates.length === 0) {
      return res.json({
        success: false,
        message: 'Товар не найден в базе данных',
        imageAnalysis: imageAnalysis,
        candidates: [],
        debug: {
          searchText,
          normalizedVolume,
          totalSearched: await Product.countDocuments({ isPayed: true, paymentExpiresAt: { $gt: new Date() } })
        }
      });
    }

    // Функция для получения информации о магазинах для кандидатов
    const getStoresForCandidates = async (productCandidates, userGeo, searchRadius) => {
      const productIds = productCandidates.map(c => c.id);
      const offers = await Offer.find({
        productId: { $in: productIds },
        isAvailable: true
      }).lean();

      if (offers.length === 0) {
        return new Map(); // Возвращаем пустую карту
      }

      const storeIds = [...new Set(offers.map(offer => offer.storeId))];
      const stores = storeIds.length > 0
        ? await Store.find({ id: { $in: storeIds } }).lean()
        : [];
      const storeById = new Map(stores.map(store => [store.id, store]));

      const formatDistance = (meters) => {
        if (meters < 1000) {
          return `${Math.round(meters)} м`;
        }
        const km = (meters / 1000).toFixed(1);
        return `${km} км`;
      };

      const candidatesWithStores = new Map();

      for (const candidate of productCandidates) {
        const productOffers = offers.filter(o => o.productId === candidate.id);
        const offersWithStores = [];

        for (const offer of productOffers) {
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

          let distance = null;
          let distanceFormatted = null;
          let isWithinRadius = null;

          if (userGeo && coords) {
            distance = calculateDistance(userGeo.lat, userGeo.lng, coords.lat, coords.lon);
            distanceFormatted = formatDistance(Math.round(distance));
            isWithinRadius = searchRadius ? distance <= searchRadius : true;
          }

          offersWithStores.push({
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
              locationCoords: store.locationCoords || null,
              distanceMeters: distance ? Math.round(distance) : null,
              distanceFormatted: distanceFormatted,
              isWithinRadius: isWithinRadius
            }
          });
        }

        // Сортируем предложения
        offersWithStores.sort((a, b) => {
          if (userGeo) {
            // Если есть геолокация, сортируем по расстоянию
            if (a.store.isWithinRadius !== b.store.isWithinRadius) {
              return a.store.isWithinRadius ? -1 : 1;
            }
            if (a.store.distanceMeters !== null && b.store.distanceMeters !== null) {
              return a.store.distanceMeters - b.store.distanceMeters;
            }
          }
          // Если нет геолокации, сортируем по цене
          return (a.price || 0) - (b.price || 0);
        });

        const offersInRadius = offersWithStores.filter(o => o.store.isWithinRadius === true);

        candidatesWithStores.set(candidate.id, {
          offers: offersWithStores,
          totalOffers: offersWithStores.length,
          offersInRadius: offersInRadius.length,
          nearestStore: offersWithStores.length > 0 ? {
            name: offersWithStores[0].store.name,
            distance: offersWithStores[0].store.distanceFormatted,
            distanceMeters: offersWithStores[0].store.distanceMeters,
            address: offersWithStores[0].store.address,
            location: offersWithStores[0].store.location,
            isWithinRadius: offersWithStores[0].store.isWithinRadius
          } : null
        });
      }

      return candidatesWithStores;
    };

    // Получаем информацию о магазинах для кандидатов
    const candidatesStoresInfo = await getStoresForCandidates(candidates, geo, radiusMeters);

    // Если есть геолокация, выполняем поиск магазинов (для обратной совместимости)
    let items = [];
    if (geo && geo.lat !== undefined && geo.lng !== undefined) {
      // Создаем intent для поиска
      const intent = {
        filters: {
          candidateProductIds: candidates.map(c => c.id)
        },
        brand: imageAnalysis.brand || null,
        packageInfo: imageAnalysis.packageInfo || null,
        type: imageAnalysis.type || null,
        packageType: imageAnalysis.packageType || null
      };

      items = await performSearch({
        text: searchText,
        geo,
        radiusMeters,
        intent
      });
    }

    // Формируем кандидатов с информацией о магазинах
    const candidatesWithStores = candidates.map(c => {
      const storeInfo = candidatesStoresInfo.get(c.id) || {
        offers: [],
        totalOffers: 0,
        offersInRadius: 0,
        nearestStore: null
      };

      return {
        id: c.id,
        name: c.name,
        brandName: c.brandName,
        packageInfo: c.packageInfo,
        description: c.description,
        images: c.images,
        offers: storeInfo.offers,
        totalOffers: storeInfo.totalOffers,
        offersInRadius: storeInfo.offersInRadius,
        nearestStore: storeInfo.nearestStore
      };
    });

    // Возвращаем результаты
    return res.json({
      success: true,
      imageAnalysis: imageAnalysis,
      candidates: candidatesWithStores,
      items: items,
      totalCandidates: candidates.length,
      totalOffers: candidatesWithStores.reduce((sum, c) => sum + (c.offers?.length || 0), 0)
    });

  } catch (error) {
    console.error('Ошибка при поиске по изображению:', error);
    res.status(500).json({ error: 'Ошибка при поиске по изображению' });
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
  searchByImage,
  getHistory,
  exportHistory,
  deleteHistory
};

