const multer = require('multer');
const { generateId } = require('../utils/uuid');
const { uploadImage } = require('../utils/s3');
const { calculateDistance, getCoordinatesFromLink } = require('../utils/distance');
const { getIntentFromGemini, findProductsBySemanticSearch, transcribeAudio, generateClarificationQuestions, analyzeProductImage, getCustomerFAQResponse, getWappiChatAIResponse } = require('../utils/gemini');
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
  Category,
  ProductSearchLog,
  Brand
} = models;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Веб-чат с клиентом: беседа живет 5 минут без активности
const CONVERSATION_TTL_MS = 5 * 60 * 1000; // 5 минут
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
 * Извлекает количество товара из текста сообщения
 * Примеры: "20 шт", "15 штук", "10", "5 единиц"
 * @param {string} text - текст сообщения
 * @returns {number|null} - количество или null, если не найдено
 */
function extractQuantityFromText(text) {
  if (!text) return null;
  // Паттерны для поиска количества
  const patterns = [
    /(\d+)\s*(?:шт|штук|штука|штуки|единиц|единица|единицы|pieces?|pcs?)/i,
    /(?:количество|нужно|хочу|куплю|купить)\s*(\d+)/i,
    /(\d+)\s*$/ // просто число в конце сообщения
  ];

  /**
   * Внутренняя функция для извлечения количества из переданной строки
   * @param {string} source
   * @returns {number|null}
   */
  const tryExtract = (source) => {
    if (!source) return null;
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match && match[1]) {
        const quantity = parseInt(match[1], 10);
        if (!isNaN(quantity) && quantity > 0 && quantity <= 1000) {
          return quantity;
        }
      }
    }
    return null;
  };

  // 1) Сначала пытаемся найти количество ВНЕ скобок
  // Пример: "Coca-Cola Vanilla (1 шт) 20 шт" -> убираем "(1 шт)" и находим "20 шт"
  const textWithoutParens = text.replace(/\([^)]*\)/g, ' ');
  let quantity = tryExtract(textWithoutParens);

  // 2) Если ничего не нашли, пробуем по всей строке (на случай, если количество только в скобках)
  if (!quantity) {
    quantity = tryExtract(text);
  }

  if (quantity) {
    console.log(`[QUANTITY] Извлечено количество: ${quantity} из текста: "${text}"`);
    return quantity;
  }

  return null;
}

/**
 * Логирование поискового запроса через Gemini
 */
async function logProductSearch({ conversationId, searchQuery, intent, candidates, selectedProduct, searchResult }) {
  try {
    const logData = {
      id: generateId(),
      conversationId: conversationId || null,
      searchQuery: searchQuery || '',
      productId: null,
      productName: null,
      brandId: null,
      brandName: null,
      intent: intent || {},
      foundProducts: [],
      searchResult: searchResult || null
    };

    // Если есть выбранный товар
    if (selectedProduct) {
      logData.productId = selectedProduct.id;
      logData.productName = selectedProduct.name;
      logData.brandId = selectedProduct.brandId || null;
      logData.brandName = selectedProduct.brandName || null;
      logData.foundProducts = [selectedProduct.id];
      logData.searchResult = 'FOUND';
    } else if (candidates && candidates.length > 0) {
      // Если есть кандидаты, берем информацию из них
      const firstCandidate = candidates[0];
      logData.foundProducts = candidates.map(c => c.id);
      logData.brandId = firstCandidate.brandId || null;
      logData.brandName = firstCandidate.brandName || null;

      // Если кандидатов много, значит нужны уточнения
      if (candidates.length === 1) {
        logData.productId = firstCandidate.id;
        logData.productName = firstCandidate.name;
        logData.searchResult = 'FOUND';
      } else {
        logData.searchResult = 'CLARIFICATION_NEEDED';
      }
    } else {
      logData.searchResult = 'NOT_FOUND';
    }

    // Если brandId не найден, но есть brandName в intent, пытаемся найти бренд
    if (!logData.brandId && intent && intent.brand) {
      try {
        const brand = await Brand.findOne({
          name: { $regex: new RegExp(intent.brand, 'i') }
        }).lean();
        if (brand) {
          logData.brandId = brand.id;
          logData.brandName = brand.name;
        }
      } catch (error) {
        // Игнорируем ошибку поиска бренда
      }
    }

    // Сохраняем лог
    await ProductSearchLog.create(logData);
  } catch (error) {
    // Не прерываем выполнение, если логирование не удалось
    console.error('Ошибка при логировании поиска:', error);
  }
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

  console.log(`🔍 AI семантический поиск для запроса: "${text}"`);

  try {
    // Получаем все оплаченные товары для AI поиска (увеличено для покрытия всех категорий)
    const allProducts = await Product.find({
      isPayed: true,
      paymentExpiresAt: { $gt: new Date() }
    }).limit(1000).lean();

    if (allProducts.length === 0) {
      console.log('Нет доступных товаров для поиска');
      return [];
    }

    // Используем только AI семантический поиск
    const candidates = await findProductsBySemanticSearch({
      searchQuery: text,
      allProducts: allProducts,
      limit: 30
    });

    console.log(`✅ AI семантический поиск нашел ${candidates.length} товаров`);
    if (candidates.length > 0) {
      console.log('Найденные товары:');
      candidates.forEach((product, index) => {
        console.log(`  ${index + 1}. "${product.name || 'без названия'}" (бренд: ${product.brandName || 'нет'}, ID: ${product.id})`);
      });
    }

    return candidates;
  } catch (error) {
    console.error('Ошибка при AI семантическом поиске:', error);
    return [];
  }
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
      const skuLower = normalizeText(item.sku || '');
      const fullText = `${nameLower} ${descLower} ${packageInfoLower} ${skuLower}`;

      if (packageTypeLower === 'glass' || packageTypeLower === 'стекло') {
        return fullText.includes('стекл') || fullText.includes('glass');
      }
      if (packageTypeLower === 'can' || packageTypeLower === 'металл' || packageTypeLower === 'банка') {
        // Ищем различные варианты обозначения жестяной/металлической банки
        return fullText.includes('банка') ||
          fullText.includes('can') ||
          fullText.includes('жест') ||
          fullText.includes('металл') ||
          fullText.includes('жб') || // ЖБ = жестяная банка
          fullText.includes('железн') ||
          fullText.includes('металлическ');
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

async function performSearch({ text, geo, radiusMeters, intent, requestedQuantity }) {
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

  // ОТКЛЮЧАЕМ ОГРАНИЧЕНИЯ ПО РАДИУСУ - показываем все результаты
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
    let distance = null;
    let distanceFormatted = null;

    // Вычисляем расстояние только если есть геолокация
    if (geo && geo.lat !== undefined && geo.lng !== undefined) {
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

      if (coords) {
        distance = calculateDistance(geo.lat, geo.lng, coords.lat, coords.lon);
        distanceFormatted = formatDistance(Math.round(distance));
      }
    }

    // ВСЕГДА добавляем предложение, даже если нет геолокации или оно вне радиуса
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
        distanceMeters: distance ? Math.round(distance) : null,
        distanceFormatted: distanceFormatted,
        isWithinRadius: null // Больше не используем ограничение по радиусу
      }
    };

    if (!offersByProduct.has(offer.productId)) {
      offersByProduct.set(offer.productId, []);
    }
    offersByProduct.get(offer.productId).push(mappedOffer);
  }

  const items = products
    .map(product => {
      const offersWithStores = (offersByProduct.get(product.id) || [])
        .sort((a, b) => {
          // Сортируем по расстоянию (если есть), ближайшие первыми
          if (a.store.distanceMeters !== null && b.store.distanceMeters !== null) {
            return a.store.distanceMeters - b.store.distanceMeters;
          }
          // Если у одного есть расстояние, а у другого нет - сначала с расстоянием
          if (a.store.distanceMeters !== null) return -1;
          if (b.store.distanceMeters !== null) return 1;
          // Если расстояний нет, сортируем по цене
          return (a.price || 0) - (b.price || 0);
        });

      // НОВАЯ ЛОГИКА: Если указано запрошенное количество, распределяем по магазинам
      let distributedOffers = offersWithStores;
      let fulfillmentInfo = null;

      if (requestedQuantity && requestedQuantity > 0) {
        console.log(`[QUANTITY_DISTRIBUTION] Запрошено ${requestedQuantity} шт. товара "${product.name}"`);

        let remainingQuantity = requestedQuantity;
        const selectedOffers = [];

        // Проходим по магазинам (уже отсортированы по расстоянию)
        for (const offer of offersWithStores) {
          if (remainingQuantity <= 0) break;

          const availableInStore = offer.quantity || 0;
          if (availableInStore > 0) {
            const quantityFromStore = Math.min(remainingQuantity, availableInStore);

            selectedOffers.push({
              ...offer,
              allocatedQuantity: quantityFromStore
            });

            console.log(`[QUANTITY_DISTRIBUTION] Магазин "${offer.store.name}": выделено ${quantityFromStore} из ${availableInStore} шт.`);

            remainingQuantity -= quantityFromStore;
          }
        }

        if (selectedOffers.length > 0) {
          distributedOffers = selectedOffers;
          fulfillmentInfo = {
            requestedQuantity: requestedQuantity,
            fulfilledQuantity: requestedQuantity - remainingQuantity,
            remainingQuantity: remainingQuantity,
            storesCount: selectedOffers.length,
            isFullyFulfilled: remainingQuantity === 0
          };

          console.log(`[QUANTITY_DISTRIBUTION] Итого: выполнено ${fulfillmentInfo.fulfilledQuantity} из ${requestedQuantity} шт. в ${selectedOffers.length} магазинах`);
        }
      }

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
        offers: distributedOffers,
        // Информация о выполнении заказа (если запрошено количество)
        fulfillmentInfo: fulfillmentInfo,
        // Статистика для удобства
        totalOffers: distributedOffers.length,
        nearestStore: distributedOffers.length > 0 ? {
          name: distributedOffers[0].store.name,
          distance: distributedOffers[0].store.distanceFormatted,
          distanceMeters: distributedOffers[0].store.distanceMeters,
          address: distributedOffers[0].store.address,
          location: distributedOffers[0].store.location
        } : null
      };
    })
    // Сортируем товары по расстоянию до ближайшего магазина (если есть геолокация)
    .sort((a, b) => {
      const aDist = a.nearestStore?.distanceMeters;
      const bDist = b.nearestStore?.distanceMeters;

      // Если у обоих есть расстояние - сортируем по нему
      if (aDist !== null && aDist !== undefined && bDist !== null && bDist !== undefined) {
        return aDist - bDist;
      }
      // Если у одного есть расстояние, а у другого нет - сначала с расстоянием
      if (aDist !== null && aDist !== undefined) return -1;
      if (bDist !== null && bDist !== undefined) return 1;
      // Если расстояний нет, сортируем по количеству предложений (больше предложений = лучше)
      return (b.totalOffers || 0) - (a.totalOffers || 0);
    })
    // Ограничиваем до 5 ближайших товаров
    .slice(0, 5);

  return items;
}

async function postMessage(req, res) {
  try {
    const { conversationId } = req.params;
    const { text, attachments, geo, radiusMeters } = req.body || {};
    const conversation = await SearchConversation.findOne({ id: conversationId });
    if (!conversation) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    // Извлекаем количество из текста сообщения или используем ранее сохраненное
    let requestedQuantity = extractQuantityFromText(text);

    // Если количество не найдено в текущем сообщении, проверяем сохраненное в intent
    if (!requestedQuantity && conversation.intentId) {
      const existingIntent = await SearchIntent.findOne({ id: conversation.intentId }).lean();
      if (existingIntent && existingIntent.filters && existingIntent.filters.requestedQuantity) {
        requestedQuantity = existingIntent.filters.requestedQuantity;
        console.log(`[CUSTOMER_MESSAGE] Используем ранее сохраненное количество: ${requestedQuantity} шт.`);
      }
    }

    if (requestedQuantity) {
      console.log(`[CUSTOMER_MESSAGE] Пользователь запросил ${requestedQuantity} шт. товара`);
    }

    // Сохраняем сообщение пользователя
    const message = await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'CUSTOMER',
      text: text || '',
      attachmentIds: Array.isArray(attachments) ? attachments : []
    });

    // Собираем контекст последних сообщений для AI
    const recentMessages = await SearchMessage.find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const conversationContext = recentMessages
      .reverse()
      .map(msg => {
        const role = msg.sender === 'CUSTOMER' ? 'ПОЛЬЗОВАТЕЛЬ' : 'СИСТЕМА';
        return `${role}: ${msg.text}`;
      })
      .filter(t => t && t.trim());

    let intent = conversation.intentId
      ? await SearchIntent.findOne({ id: conversation.intentId })
      : null;

    // Если разговор завершен (DONE) и пришел новый текстовый запрос - начинаем новый поиск
    if (intent && conversation.state === 'DONE' && text && text.trim()) {
      console.log('[NEW SEARCH] Сброс intent для нового поиска после DONE');
      intent = await SearchIntent.create({
        id: generateId(),
        conversationId,
        rawText: text || '',
        filters: {}
      });
      conversation.intentId = intent.id;
      conversation.state = 'NEW';
      conversation.requestId = null;
      conversation.resultId = null;
    } else if (!intent) {
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

    // Если нет геолокации, просим её
    if (!geo || geo.lat === undefined || geo.lng === undefined) {
      const messageCount = await SearchMessage.countDocuments({ conversationId, sender: 'CUSTOMER' });
      if (messageCount === 1) {
        conversation.state = 'NEEDS_CLARIFICATION';
        await conversation.save();

        const askGeoText = 'Уточните ваше местоположение и радиус поиска';
        await SearchMessage.create({
          id: generateId(),
          conversationId,
          sender: 'SYSTEM',
          text: askGeoText
        });

        return res.json({
          state: conversation.state,
          messageId: message.id,
          questions: [askGeoText]
        });
      }
      // Если не первое сообщение и нет гео, продолжаем работу без гео
    }

    // Получаем все оплаченные товары
    const allProducts = await Product.find({
      isPayed: true,
      paymentExpiresAt: { $gt: new Date() }
    }).limit(1000).lean();

    console.log(`[CUSTOMER] Всего оплаченных товаров для AI: ${allProducts.length}`);

    // Обогащаем товары категориями
    const categoryIds = Array.from(new Set(allProducts.map(p => p.categoryId).filter(Boolean)));
    let categoryById = new Map();
    if (categoryIds.length > 0) {
      const categories = await Category.find({ id: { $in: categoryIds } }).lean();
      categoryById = new Map(categories.map(cat => [cat.id, cat]));
    }

    const productsWithCategory = allProducts.map(product => ({
      ...product,
      categoryName: product.categoryId ? (categoryById.get(product.categoryId)?.name || null) : null
    }));

    if (productsWithCategory.length === 0) {
      const emptyMsg = 'Сейчас в каталоге нет доступных товаров для поиска.';
      await SearchMessage.create({
        id: generateId(),
        conversationId,
        sender: 'SYSTEM',
        text: emptyMsg
      });

      conversation.state = 'NEEDS_CLARIFICATION';
      await conversation.save();

      return res.json({
        state: conversation.state,
        messageId: message.id,
        questions: [emptyMsg]
      });
    }

    // Отправляем сообщение + каталог напрямую в Gemini
    const aiResult = await getWappiChatAIResponse({
      message: text,
      products: productsWithCategory,
      conversationContext
    });

    let replyText = aiResult && typeof aiResult.replyText === 'string'
      ? aiResult.replyText
      : 'Не удалось обработать запрос. Попробуйте описать товар по-другому.';

    // На основе matchedProductIds собираем подробную информацию о найденных товарах
    let matchedProducts = [];
    if (Array.isArray(aiResult.matchedProductIds) && aiResult.matchedProductIds.length > 0) {
      const matchedIds = new Set(aiResult.matchedProductIds);
      matchedProducts = productsWithCategory.filter(p => matchedIds.has(p.id));
    }

    console.log(`[CUSTOMER] AI выбрал ${matchedProducts.length} товаров из ${productsWithCategory.length}`);
    if (matchedProducts.length > 0) {
      console.log(
        `[CUSTOMER] Примеры выбранных товаров:`,
        matchedProducts.slice(0, 5).map(p => ({
          id: p.id,
          name: p.name,
          brandName: p.brandName,
          categoryName: p.categoryName
        }))
      );
    }

    // Если AI сузил выбор до ОДНОГО товара и есть геолокация — сразу показываем магазины
    if (matchedProducts.length === 1 && geo && geo.lat !== undefined && geo.lng !== undefined) {
      try {
        const singleProduct = matchedProducts[0];
        console.log(`[CUSTOMER] Один выбранный товар (${singleProduct.id}), подготавливаем ответ с магазинами`);

        // Сохраняем выбранный товар в intent
        intent.filters = {
          ...(intent.filters || {}),
          candidateProductIds: [singleProduct.id],
          requestedQuantity: requestedQuantity || null
        };
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

        const items = await performSearch({
          text,
          geo,
          radiusMeters,
          intent: {
            filters: { candidateProductIds: [singleProduct.id] },
            brand: null,
            packageInfo: null
          },
          requestedQuantity: requestedQuantity
        });

        const result = await SearchResult.create({
          id: generateId(),
          requestId: request.id,
          items,
          expiresAt: nowPlus(RESULT_TTL_MS)
        });

        conversation.resultId = result.id;
        conversation.state = 'DONE';
        await conversation.save();

        // Формируем сообщение с магазинами
        if (Array.isArray(items) && items.length > 0 && items[0].offers && items[0].offers.length > 0) {
          const item = items[0];
          const productName = `${singleProduct.name}${singleProduct.brandName ? ' (' + singleProduct.brandName + ')' : ''}${singleProduct.packageInfo ? ' - ' + singleProduct.packageInfo : ''}`;
          const totalOffers = item.offers.length;
          const nearest = item.nearestStore;
          const fulfillment = item.fulfillmentInfo;

          replyText = `Найден товар:
${productName}
`;

          // Если пользователь запросил количество, показываем информацию о распределении
          if (fulfillment && requestedQuantity) {
            if (fulfillment.isFullyFulfilled) {
              replyText += `
✅ Запрошенное количество (${requestedQuantity} шт.) доступно в ${fulfillment.storesCount} магазин${fulfillment.storesCount === 1 ? 'е' : fulfillment.storesCount < 5 ? 'ах' : 'ах'}:
`;

              // Показываем распределение по магазинам
              item.offers.forEach((offer, index) => {
                if (offer.allocatedQuantity) {
                  replyText += `
${index + 1}. "${offer.store.name}"${offer.store.distanceFormatted ? ` (${offer.store.distanceFormatted})` : ''}: ${offer.allocatedQuantity} шт. по ${offer.price} ${offer.currency}`;
                }
              });
            } else {
              replyText += `
⚠️ Запрошенное количество (${requestedQuantity} шт.) частично доступно. Найдено ${fulfillment.fulfilledQuantity} шт. в ${fulfillment.storesCount} магазин${fulfillment.storesCount === 1 ? 'е' : fulfillment.storesCount < 5 ? 'ах' : 'ах'}:
`;

              // Показываем распределение по магазинам
              item.offers.forEach((offer, index) => {
                if (offer.allocatedQuantity) {
                  replyText += `
${index + 1}. "${offer.store.name}"${offer.store.distanceFormatted ? ` (${offer.store.distanceFormatted})` : ''}: ${offer.allocatedQuantity} шт. по ${offer.price} ${offer.currency}`;
                }
              });

              replyText += `

Не хватает: ${fulfillment.remainingQuantity} шт.`;
            }
          } else {
            // Если количество не запрошено, показываем стандартную информацию
            if (nearest && nearest.distance && typeof nearest.distanceMeters === 'number') {
              if (nearest.distanceMeters > 1000) {
                replyText += `
Рядом с вами (в радиусе 1 км) магазины с этим товаром не найдены. Самый ближайший магазин "${nearest.name}" находится на расстоянии ${nearest.distance}.`;
              } else {
                replyText += `
Найдено предложений: ${totalOffers}. Ближайший магазин "${nearest.name}" находится на расстоянии ${nearest.distance}.`;
              }
            } else {
              replyText += `
Найдено предложений: ${totalOffers}.`;
            }
          }

          console.log(`[CUSTOMER] Сформирован ответ с магазинами для товара ${singleProduct.id}`);
        } else {
          replyText = `Товар "${singleProduct.name}" найден, но не доступен в ближайших магазинах в радиусе ${(radiusMeters || 1000) / 1000} км. Попробуйте увеличить радиус поиска.`;
          console.log(`[CUSTOMER] Для товара ${singleProduct.id} не найдено доступных магазинов`);
        }

        // Логируем успешный поиск
        await logProductSearch({
          conversationId,
          searchQuery: text || intent.rawText || '',
          intent: {
            brand: null,
            packageInfo: null,
            type: null,
            packageType: null
          },
          candidates: [singleProduct],
          selectedProduct: {
            id: singleProduct.id,
            name: singleProduct.name,
            brandId: singleProduct.brandId || null,
            brandName: singleProduct.brandName || null
          },
          searchResult: 'FOUND'
        });

        // Сохраняем ответ системы
        await SearchMessage.create({
          id: generateId(),
          conversationId,
          sender: 'SYSTEM',
          text: replyText
        });

        return res.json({
          state: conversation.state,
          messageId: message.id,
          requestId: request.id,
          resultId: result.id,
          items: items.length > 0 ? items : [],
          selectedProduct: {
            id: singleProduct.id,
            name: singleProduct.name,
            brandName: singleProduct.brandName,
            packageInfo: singleProduct.packageInfo
          }
        });
      } catch (error) {
        console.error(`[CUSTOMER] Ошибка при формировании ответа с магазинами:`, error);
        // Продолжаем с обычным ответом от AI
      }
    } else if (matchedProducts.length === 1 && (!geo || geo.lat === undefined || geo.lng === undefined)) {
      // Один товар найден, но нет геолокации
      const singleProduct = matchedProducts[0];
      intent.filters = {
        ...(intent.filters || {}),
        candidateProductIds: [singleProduct.id],
        requestedQuantity: requestedQuantity || null
      };
      await intent.save();

      const quantityText = requestedQuantity ? ` в количестве ${requestedQuantity} шт` : '';
      replyText = `Отлично! Найден товар: ${singleProduct.name}${singleProduct.brandName ? ' (' + singleProduct.brandName + ')' : ''}${quantityText}.
Уточните ваше местоположение для поиска магазинов.`;
    }

    // Сохраняем ответ системы
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: replyText
    });

    // Сохраняем запрошенное количество в intent (если есть)
    if (requestedQuantity) {
      intent.filters = {
        ...(intent.filters || {}),
        requestedQuantity: requestedQuantity
      };
    }

    conversation.state = matchedProducts.length === 1 ? 'NEEDS_CLARIFICATION' : 'NEEDS_CLARIFICATION';
    await conversation.save();
    await intent.save();

    // Формируем quickReplies (кнопки) для выбора товара
    let quickReplies = [];
    if (matchedProducts.length > 1 && matchedProducts.length <= 10) {
      // Если найдено от 2 до 10 товаров, показываем их как кнопки
      quickReplies = matchedProducts.map(p => {
        let label = p.name;
        if (p.packageInfo) {
          label += ` (${p.packageInfo})`;
        }
        // Добавляем запрошенное количество в название кнопки
        if (requestedQuantity) {
          label += ` ${requestedQuantity} шт`;
        }
        return label;
      });
    }

    return res.json({
      state: conversation.state,
      messageId: message.id,
      questions: [replyText],
      quickReplies: quickReplies,
      matchedProducts: matchedProducts.map(p => ({
        id: p.id,
        name: p.name,
        brandName: p.brandName,
        categoryName: p.categoryName,
        packageInfo: p.packageInfo
      }))
    });
  } catch (error) {
    console.error('Ошибка при обработке сообщения:', error);
    res.status(500).json({ error: 'Ошибка при обработке сообщения' });
  }
}


async function createSearch(req, res) {
  try {
    const { conversationId, text, geo, radiusMeters, requestedQuantity } = req.body || {};
    if (!conversationId || !geo || geo.lat === undefined || geo.lng === undefined) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }
    const conversation = await SearchConversation.findOne({ id: conversationId });
    if (!conversation) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    // Извлекаем количество из текста, если не передано явно
    const quantity = requestedQuantity || extractQuantityFromText(text);

    const request = await SearchRequest.create({
      id: generateId(),
      conversationId,
      intentId: conversation.intentId || generateId(),
      geo: { lat: geo.lat, lng: geo.lng },
      radiusMeters: radiusMeters || 1000,
      expiresAt: nowPlus(RESULT_TTL_MS)
    });

    const items = await performSearch({ text, geo, radiusMeters, requestedQuantity: quantity });
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
    let { conversationId, geo, radiusMeters, requestedQuantity } = req.body || {};
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

    // Парсим requestedQuantity, если это строка
    if (requestedQuantity && typeof requestedQuantity === 'string') {
      requestedQuantity = parseInt(requestedQuantity, 10) || null;
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
      // Логируем, что товар не найден по изображению
      await logProductSearch({
        conversationId: conversationId || null,
        searchQuery: `[Поиск по изображению] ${imageAnalysis.brand || ''} ${imageAnalysis.productName || ''}`.trim(),
        intent: {
          brand: imageAnalysis.brand || null,
          packageInfo: imageAnalysis.packageInfo || null,
          type: imageAnalysis.type || null,
          packageType: imageAnalysis.packageType || null
        },
        candidates: [],
        searchResult: 'NOT_FOUND'
      });

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
        intent,
        requestedQuantity: requestedQuantity
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

    // Логируем поиск по изображению
    const topCandidate = candidates[0];
    await logProductSearch({
      conversationId: conversationId || null,
      searchQuery: `[Поиск по изображению] ${imageAnalysis.brand || ''} ${imageAnalysis.productName || ''}`.trim(),
      intent: {
        brand: imageAnalysis.brand || null,
        packageInfo: imageAnalysis.packageInfo || null,
        type: imageAnalysis.type || null,
        packageType: imageAnalysis.packageType || null
      },
      candidates: candidates,
      selectedProduct: candidates.length === 1 ? {
        id: topCandidate.id,
        name: topCandidate.name,
        brandId: topCandidate.brandId || null,
        brandName: topCandidate.brandName || null
      } : null,
      searchResult: candidates.length === 1 ? 'FOUND' : 'CLARIFICATION_NEEDED'
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

/**
 * Обработка FAQ запроса от пользователя
 * POST /api/customers/faq
 */
async function handleCustomerFAQ(req, res) {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    // Получаем роль пользователя из токена (если есть)
    const userRole = req.user && req.user.role ? req.user.role : null;

    // Получаем ответ от FAQ чата
    const response = await getCustomerFAQResponse({
      message: message.trim(),
      userRole: userRole
    });

    res.json({
      success: true,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при обработке FAQ запроса:', error);
    res.status(500).json({
      error: 'Ошибка при обработке запроса',
      message: error.message
    });
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
  deleteHistory,
  handleCustomerFAQ
};

