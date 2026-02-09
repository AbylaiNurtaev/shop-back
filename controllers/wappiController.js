const axios = require('axios');
const { generateId } = require('../utils/uuid');
const { getIntentFromGemini, findProductsBySemanticSearch, generateClarificationQuestions, getWappiChatAIResponse } = require('../utils/gemini');
const { models } = require('../models/database');

const {
  CustomerSession,
  SearchConversation,
  SearchMessage,
  SearchIntent,
  SearchRequest,
  SearchResult,
  Product,
  Offer,
  Store,
  Category
} = models;

// Константы конфигурации WAPPI
const WAPPI_API_URL = process.env.WAPPI_API_URL || 'https://wappi.pro/api/sync/message/send';
const PROFILE_ID_WAPPI = process.env.PROFILE_ID_WAPPI;
const API_KEY_WAPPI = process.env.API_KEY_WAPPI;

// Константы для работы с conversations
// Чат живет 5 минут без активности, результаты поиска храним дольше
const CONVERSATION_TTL_MS = 5 * 60 * 1000; // 5 минут
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;

// Настройка Axios с таймаутами
const axiosInstance = axios.create({
  timeout: 30000, // 30 секунд таймаут
  headers: {
    'Content-Type': 'application/json'
  }
});

function nowPlus(ms) {
  return new Date(Date.now() + ms);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

// Пытаемся вытащить геолокацию из текста (явные координаты вида "lat, lng")
function extractGeoFromText(text) {
  if (!text || !text.trim()) return null;
  const raw = text.trim();

  // 1. Явные координаты вида "51.1605, 71.4703"
  const coordMatch = raw.match(/(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      return { lat, lng };
    }
  }

  return null;
}

// Нормализуем пользовательский запрос до "ядра" (убираем служебные слова: "найди", "хочу", "что из ... есть" и т.п.)
// Примеры:
//  - "Найди цветы"        -> "цветы"
//  - "Хочу цветы"         -> "цветы"
//  - "Какие цветы есть?"  -> "цветы"
//  - "Что из напитков есть?" -> "напитки"
function extractCoreSearchQuery(text) {
  let query = normalizeText(text);

  // Убираем типичные вводные глаголы в начале
  query = query.replace(/^(найди|найти|ищу|ищем|хочу|нужно|нужны|посоветуй|посоветуйте|подбери|подберите|подскажи|подскажите)\s+/i, '');

  // Убираем конструкции вида "что из X есть", "а что из X есть"
  query = query.replace(/^(а\s+)?что\s+из\s+/i, '');

  // Убираем конструкции вида "какие X есть", "какая X есть"
  query = query.replace(/^(а\s+)?какие\s+/i, '');
  query = query.replace(/^(а\s+)?какая\s+/i, '');

  // Убираем хвостовое "есть", "бывают" и т.п.
  query = query.replace(/\s+(есть|бывают|бывает|вообще есть)\??$/i, '');

  query = query.trim();

  // Если после всех преобразований строка опустела — возвращаем исходную нормализованную
  if (!query) {
    query = normalizeText(text);
  }

  return query;
}

// Retry функция для запросов к внешнему API (Wappi)
async function sendWithRetry(url, payload, headers, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axiosInstance.post(url, payload, { headers });
      return response;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      // Ждем перед повторной попыткой (экспоненциальная задержка)
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Функция для поиска товаров по тексту (использует существующую логику)
async function buildCandidatesByText(text, conversationContext = null) {
  if (!text || !text.trim()) return [];

  console.log(`🔍 AI семантический поиск для запроса: "${text}"`);
  const coreQuery = extractCoreSearchQuery(text);
  if (coreQuery !== normalizeText(text)) {
    console.log(`🔍 Нормализованный запрос для AI: "${coreQuery}"`);
  }
  if (conversationContext && conversationContext.length > 0) {
    console.log(`📝 Контекст разговора: ${conversationContext.length} предыдущих сообщений`);
  }

  try {
    // Получаем все оплаченные товары для AI поиска (увеличено для покрытия всех категорий)
    const allProducts = await Product.find({
      isPayed: true,
      paymentExpiresAt: { $gt: new Date() }
    }).limit(1000).lean();

    console.log(`[WAPPI] Всего оплаченных товаров в БД: ${allProducts.length}`);

    if (allProducts.length === 0) {
      console.log('[WAPPI] ⚠️ Нет доступных товаров для поиска (все товары не оплачены или срок оплаты истек)');
      // Пробуем найти хотя бы какие-то товары без фильтра по оплате (для отладки)
      const allProductsWithoutPayment = await Product.find({}).limit(50).lean();
      console.log(`[WAPPI] Всего товаров в БД (без фильтра оплаты): ${allProductsWithoutPayment.length}`);
      if (allProductsWithoutPayment.length > 0) {
        console.log(`[WAPPI] Примеры товаров:`, allProductsWithoutPayment.slice(0, 3).map(p => ({
          name: p.name,
          brandName: p.brandName,
          isPayed: p.isPayed,
          paymentExpiresAt: p.paymentExpiresAt
        })));
      }
      return [];
    }

    // Обогащаем товары названиями категорий, чтобы AI мог использовать категорию
    const categoryIds = Array.from(new Set(allProducts.map(p => p.categoryId).filter(Boolean)));
    let categoryById = new Map();
    if (categoryIds.length > 0) {
      const categories = await Category.find({ id: { $in: categoryIds } }).lean();
      categoryById = new Map(categories.map(cat => [cat.id, cat]));
    }

    const allProductsWithCategory = allProducts.map(product => ({
      ...product,
      categoryName: product.categoryId ? (categoryById.get(product.categoryId)?.name || null) : null
    }));

    // Используем только AI семантический поиск с контекстом
    let candidates = await findProductsBySemanticSearch({
      searchQuery: coreQuery,
      allProducts: allProductsWithCategory,
      limit: 30,
      conversationContext: conversationContext
    });

    console.log(`✅ AI семантический поиск нашел ${candidates.length} товаров`);

    // ВАЛИДАЦИЯ: Проверяем релевантность найденных товаров
    if (candidates.length > 0) {
      const normalizedQuery = coreQuery;
      const validatedCandidates = candidates.filter(product => {
        const productText = `${product.name || ''} ${product.description || ''} ${product.brandName || ''} ${product.categoryName || ''}`.toLowerCase();

        // Если запрос про цветы - проверяем, что товар действительно цветок
        if (normalizedQuery === 'цветы' || normalizedQuery === 'цветок' || normalizedQuery === 'букет' ||
          normalizedQuery.includes('цвет') || normalizedQuery.includes('роза') || normalizedQuery.includes('тюльпан') ||
          normalizedQuery.includes('лилия') || normalizedQuery.includes('хризантема') || normalizedQuery.includes('орхидея')) {
          // Товар должен содержать слова, связанные с цветами
          const flowerKeywords = ['роза', 'тюльпан', 'лилия', 'хризантема', 'орхидея', 'цветок', 'букет', 'цветы', 'rose', 'tulip', 'lily'];
          const isFlower = flowerKeywords.some(keyword => productText.includes(keyword));
          if (!isFlower) {
            console.log(`[WAPPI] ⚠️ Товар "${product.name}" не является цветком, отфильтрован (запрос: "${text}")`);
            return false;
          }
          // Дополнительная проверка: НЕ должен быть напитком
          const drinkKeywords = ['cola', 'coca', 'pepsi', 'напиток', 'газировка', 'лимонад', 'сок', 'вода', 'drink', 'beverage'];
          const isDrink = drinkKeywords.some(keyword => productText.includes(keyword));
          if (isDrink) {
            console.log(`[WAPPI] ⚠️ Товар "${product.name}" является напитком, а не цветком, отфильтрован (запрос: "${text}")`);
            return false;
          }
        }

        // Если запрос про напитки - проверяем, что товар действительно напиток
        if (normalizedQuery === 'напитки' || normalizedQuery === 'напиток' || normalizedQuery === 'газировка' ||
          normalizedQuery.includes('кола') || normalizedQuery.includes('пепси') || normalizedQuery.includes('лимонад') ||
          normalizedQuery.includes('сок') || normalizedQuery.includes('вода')) {
          const drinkKeywords = ['cola', 'coca', 'pepsi', 'напиток', 'газировка', 'лимонад', 'сок', 'вода', 'drink', 'beverage', 'fanta', 'sprite'];
          const isDrink = drinkKeywords.some(keyword => productText.includes(keyword));
          if (!isDrink) {
            console.log(`[WAPPI] ⚠️ Товар "${product.name}" не является напитком, отфильтрован (запрос: "${text}")`);
            return false;
          }
          // Дополнительная проверка: НЕ должен быть цветком
          const flowerKeywords = ['роза', 'тюльпан', 'лилия', 'хризантема', 'орхидея', 'цветок', 'букет', 'цветы'];
          const isFlower = flowerKeywords.some(keyword => productText.includes(keyword));
          if (isFlower) {
            console.log(`[WAPPI] ⚠️ Товар "${product.name}" является цветком, а не напитком, отфильтрован (запрос: "${text}")`);
            return false;
          }
        }

        return true;
      });

      if (validatedCandidates.length < candidates.length) {
        console.log(`[WAPPI] ⚠️ Отфильтровано ${candidates.length - validatedCandidates.length} нерелевантных товаров из ${candidates.length}`);
        candidates = validatedCandidates;
      }
    }

    if (candidates.length > 0) {
      console.log('Найденные товары после валидации:');
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

// Функция фильтрации кандидатов (из customerController)
function filterCandidatesByIntent(candidates, intent) {
  let filtered = [...candidates];

  // Фильтрация по бренду
  if (intent.brand) {
    const brandNormalized = normalizeText(intent.brand);
    filtered = filtered.filter(item => {
      if (!item.brandName) return false;
      const itemBrand = normalizeText(item.brandName);
      return itemBrand === brandNormalized || itemBrand.includes(brandNormalized) || brandNormalized.includes(itemBrand);
    });
  }

  // Фильтрация по упаковке
  if (intent.packageInfo !== null && intent.packageInfo !== undefined) {
    const packageNormalized = normalizeText(intent.packageInfo);
    filtered = filtered.filter(item => {
      if (!item.packageInfo) return false;
      const itemPackage = normalizeText(item.packageInfo);
      const extractNumbers = (str) => str.replace(/[^\d.,]/g, '').replace(',', '.');
      const itemNums = extractNumbers(itemPackage);
      const intentNums = extractNumbers(packageNormalized);

      if (itemNums && intentNums && itemNums === intentNums) {
        return true;
      }
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
      'classic': ['classic', 'классическая', 'классик', 'обычная', 'original', 'оригинал', '1'],
      'обычная': ['обычная', 'классическая', 'classic', 'original', 'оригинал']
    };

    const keywords = typeKeywords[typeLower] || [typeLower];

    filtered = filtered.filter(item => {
      const nameLower = normalizeText(item.name);
      const descLower = normalizeText(item.description || '');
      const brandLower = normalizeText(item.brandName || '');
      const fullText = `${nameLower} ${descLower} ${brandLower}`;

      if (typeLower === 'classic' || typeLower === 'обычная') {
        const hasZero = ['zero', 'ноль', '0', 'без сахара', 'безсахар'].some(k => fullText.includes(k));
        const hasLight = ['light', 'лайт', 'легкий'].some(k => fullText.includes(k));
        const hasDiet = ['diet', 'диет', 'диетический'].some(k => fullText.includes(k));

        if (!hasZero && !hasLight && !hasDiet) {
          return true;
        }
      }

      return keywords.some(keyword => fullText.includes(keyword));
    });
  }

  // Фильтрация по типу упаковки
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
        return fullText.includes('банка') ||
          fullText.includes('can') ||
          fullText.includes('жест') ||
          fullText.includes('металл') ||
          fullText.includes('жб') ||
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

// Функция performSearch (облегченная версия из customerController)
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

  const offersByProduct = new Map();

  // Функция для форматирования расстояния
  const formatDistance = (meters) => {
    if (!meters || Number.isNaN(meters)) return null;
    if (meters < 1000) {
      return `${Math.round(meters)} м`;
    }
    const km = (meters / 1000).toFixed(1);
    return `${km} км`;
  };

  for (const offer of offers) {
    const store = storeById.get(offer.storeId);
    if (!store) continue;

    let distanceMeters = null;
    let distanceFormatted = null;

    // Если есть геолокация пользователя и координаты магазина - считаем расстояние
    if (geo && geo.lat !== undefined && geo.lng !== undefined && store.locationCoords && store.locationCoords.lat !== undefined && store.locationCoords.lng !== undefined) {
      try {
        const { calculateDistance } = require('../utils/distance');
        distanceMeters = calculateDistance(geo.lat, geo.lng, store.locationCoords.lat, store.locationCoords.lng);
        distanceFormatted = formatDistance(distanceMeters);
      } catch (e) {
        console.warn('[WAPPI] Не удалось посчитать расстояние до магазина:', e.message);
      }
    }

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
        distanceMeters: distanceMeters !== null ? Math.round(distanceMeters) : null,
        distanceFormatted: distanceFormatted
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
          // Сначала по расстоянию (если есть), потом по цене
          const aDist = a.store.distanceMeters;
          const bDist = b.store.distanceMeters;
          if (aDist !== null && bDist !== null) {
            return aDist - bDist;
          }
          if (aDist !== null) return -1;
          if (bDist !== null) return 1;
          return (a.price || 0) - (b.price || 0);
        });

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
          brandId: product.brandId
        },
        offers: offersWithStores,
        totalOffers: offersWithStores.length,
        nearestStore: offersWithStores.length > 0 ? {
          name: offersWithStores[0].store.name,
          address: offersWithStores[0].store.address,
          location: offersWithStores[0].store.location
        } : null
      };
    });
}

// Получение или создание conversation для chatId
async function getOrCreateConversation(chatId) {
  // Используем chatId как sessionId для Wappi
  let conversation = await SearchConversation.findOne({ sessionId: chatId })
    .sort({ createdAt: -1 })
    .lean();

  if (!conversation || new Date(conversation.expiresAt) < new Date()) {
    // Создаем новую conversation
    const newConversation = await SearchConversation.create({
      id: generateId(),
      sessionId: chatId,
      state: 'NEW',
      intentId: null,
      requestId: null,
      resultId: null,
      expiresAt: nowPlus(CONVERSATION_TTL_MS)
    });
    conversation = newConversation.toObject();
  } else {
    // Обновляем expiresAt
    await SearchConversation.updateOne(
      { id: conversation.id },
      { expiresAt: nowPlus(CONVERSATION_TTL_MS) }
    );
  }

  return conversation;
}

// Форматирование результатов поиска для WhatsApp
function formatSearchResultsWithStores(item) {
  if (!item || item.offers.length === 0) {
    return 'К сожалению, в базе нет предложений по этому товару.';
  }

  const product = item.product;
  const productName = `${product.name}${product.brandName ? ' (' + product.brandName + ')' : ''}${product.packageInfo ? ' - ' + product.packageInfo : ''}`;

  // Группируем предложения по магазинам (по store.id)
  // Для каждого магазина берем только одно предложение (самое дешевое)
  const storesMap = new Map();

  item.offers.forEach(offer => {
    const storeId = offer.store.id;
    if (!storesMap.has(storeId)) {
      storesMap.set(storeId, offer);
    } else {
      // Если уже есть предложение от этого магазина, берем самое дешевое
      const existingOffer = storesMap.get(storeId);
      if (offer.price < existingOffer.price) {
        storesMap.set(storeId, offer);
      }
    }
  });

  // Преобразуем Map в массив и сортируем по цене
  const uniqueStores = Array.from(storesMap.values())
    .sort((a, b) => (a.price || 0) - (b.price || 0));

  let message = `✅ Найден товар: ${productName}\n\n`;
  message += `Найдено магазинов: ${uniqueStores.length}\n\n`;

  // Показываем первые 5 уникальных магазинов
  const storesToShow = uniqueStores.slice(0, 5);
  storesToShow.forEach((offer, index) => {
    message += `${index + 1}. ${offer.store.name}\n`;
    if (offer.store.address) {
      message += `   Адрес: ${offer.store.address}\n`;
    }
    message += `   Цена: ${offer.price} ${offer.currency || 'RUB'}\n`;
    if (offer.store.distanceFormatted) {
      message += `   Расстояние: ${offer.store.distanceFormatted}\n`;
    }
    if (offer.store.location) {
      message += `   Локация: ${offer.store.location}\n`;
    }
    message += '\n';
  });

  if (uniqueStores.length > 5) {
    message += `... и еще ${uniqueStores.length - 5} магазинов.`;
  }

  return message;
}

// Функция для отправки сообщения через Wappi API
async function sendWappiMessage(phoneNumber, messageText) {
  if (!PROFILE_ID_WAPPI || !API_KEY_WAPPI) {
    console.error('WAPPI credentials not configured');
    throw new Error('WAPPI credentials not configured');
  }

  // Проверяем, что сообщение не пустое
  if (!messageText || !messageText.trim()) {
    console.error('[WAPPI API] ❌ Попытка отправить пустое сообщение');
    throw new Error('Message text is empty');
  }

  let normalizedPhone = phoneNumber.replace('@c.us', '').replace(/\D/g, '');

  const wappiUrl = `${WAPPI_API_URL}?profile_id=${encodeURIComponent(PROFILE_ID_WAPPI)}`;

  const payload = {
    recipient: normalizedPhone,
    body: messageText.trim()
  };

  const headers = {
    accept: 'application/json',
    Authorization: API_KEY_WAPPI,
    'Content-Type': 'application/json'
  };

  try {
    const sendStartTime = Date.now();
    const wappiResponse = await sendWithRetry(wappiUrl, payload, headers);
    const sendDuration = Date.now() - sendStartTime;

    const maskedPhone = normalizedPhone.length > 7
      ? `${normalizedPhone.substring(0, 3)}****${normalizedPhone.substring(normalizedPhone.length - 2)}`
      : '****';

    console.log(`[WAPPI API] ✅ Сообщение успешно отправлено:`, {
      phone: maskedPhone,
      status: wappiResponse.status,
      duration: `${sendDuration}ms`,
      messageLength: messageText.length
    });
    return wappiResponse;
  } catch (error) {
    const errorMessage = error.response?.data || error.message;
    const errorStatus = error.response?.status || 'unknown';
    const maskedPhone = normalizedPhone.length > 7
      ? `${normalizedPhone.substring(0, 3)}****${normalizedPhone.substring(normalizedPhone.length - 2)}`
      : '****';

    console.error(`[WAPPI API] ❌ Ошибка при отправке сообщения:`, {
      phone: maskedPhone,
      status: errorStatus,
      error: errorMessage,
      messageLength: messageText.length
    });
    throw error;
  }
}

// Проверка, является ли сообщение поисковым запросом
function isSearchQuery(text) {
  if (!text || !text.trim()) return false;

  const normalized = normalizeText(text);
  const trimmed = normalized.trim();

  // Слишком короткие сообщения (меньше 2 символов) - не поисковые запросы
  if (trimmed.length < 2) return false;

  // Простые приветствия и короткие фразы - не поисковые запросы
  const greetings = ['привет', 'здравствуй', 'здравствуйте', 'hi', 'hello', 'да', 'нет', 'ок', 'окей', 'спасибо', 'благодарю', 'пока', 'до свидания'];
  if (greetings.includes(trimmed)) return false;

  // Если сообщение содержит только цифры или один символ - не поисковый запрос
  if (/^[\d\s\?\!\.\,]+$/.test(trimmed) && trimmed.length < 3) return false;

  // Если сообщение слишком длинное (больше 150 символов) - возможно, не поисковый запрос
  if (trimmed.length > 150) return false;

  // Если сообщение выглядит как вопрос о системе/помощи, но не о товаре - не поисковый запрос
  const systemQuestions = ['как пользоваться', 'что это', 'помощь', 'help', 'что умеешь', 'что можешь'];
  if (systemQuestions.some(q => trimmed.includes(q) && trimmed.length < 30)) return false;

  // Всё остальное считаем поисковым запросом (более гибкая логика)
  return true;
}

// Основная функция обработки сообщения (адаптированная из customerController)
async function processWappiMessage(chatId, text, requestId, options = {}) {
  const debug = options.debug || false;
  const locationFromMessage = options.location || null;

  const conversation = await getOrCreateConversation(chatId);
  const conversationId = conversation.id;

  // Сохраняем сообщение пользователя
  await SearchMessage.create({
    id: generateId(),
    conversationId,
    sender: 'CUSTOMER',
    text: text || '',
    attachmentIds: []
  });

  // Собираем контекст последних сообщений (и пользователя, и системы) для AI
  const recentMessages = await SearchMessage.find({
    conversationId
  })
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

  // Геолокация (для WAPPI определяем её один раз на чат и используем дальше)
  let geo = conversation.geo || null;
  let radiusMeters = conversation.radiusMeters || 1000;
  let geoRequested = conversation.geoRequested || false;
  let geoSource = conversation.geoSource || null;

  // Пробуем вытащить геолокацию из самого сообщения:
  // 1) если есть объект location из WhatsApp (Wappi)
  // 2) либо явные координаты в тексте
  let extractedGeo = null;
  if (locationFromMessage && typeof locationFromMessage.lat === 'number' && typeof locationFromMessage.lng === 'number') {
    extractedGeo = { lat: locationFromMessage.lat, lng: locationFromMessage.lng };
    console.log(`[WAPPI] [${requestId}] Геолокация получена из сообщения WhatsApp:`, extractedGeo);
  } else {
    extractedGeo = extractGeoFromText(text);
  }

  if (extractedGeo) {
    geo = extractedGeo;
    radiusMeters = radiusMeters || 1000;
    geoSource = locationFromMessage ? 'whatsapp' : 'manual';
    await SearchConversation.updateOne(
      { id: conversationId },
      { geo, radiusMeters, geoSource, geoRequested: true, updatedAt: new Date() }
    );
    console.log(`[WAPPI] [${requestId}] Обновлена геолокация для беседы (source=${geoSource}):`, geo);
  }

  // Если геолокации нет ИЛИ она не из нативного WhatsApp-местоположения — просим отправить geo
  if (!geo || geo.lat === undefined || geo.lng === undefined || geoSource !== 'whatsapp') {
    const askGeoText = 'Чтобы подобрать ближайшие магазины, отправьте геопозицию (поделиться местоположением в WhatsApp), а затем напишите, какой товар вы ищете.';

    await SearchConversation.updateOne(
      { id: conversationId },
      { geoRequested: true, updatedAt: new Date() }
    );

    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: askGeoText
    });

    const debugPayload = {
      replyText: askGeoText,
      needGeo: true,
      allProductsCount: 0,
      allProductsSample: [],
      matchedProductIds: [],
      matchedProducts: []
    };

    return debug ? debugPayload : askGeoText;
  }

  // Получаем все оплаченные товары
  const allProducts = await Product.find({
    isPayed: true,
    paymentExpiresAt: { $gt: new Date() }
  }).limit(1000).lean();

  console.log(`[WAPPI] [${requestId}] Всего оплаченных товаров для AI: ${allProducts.length}`);

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

    const debugPayload = {
      replyText: emptyMsg,
      allProductsCount: 0,
      allProductsSample: [],
      matchedProductIds: [],
      matchedProducts: []
    };

    return debug ? debugPayload : emptyMsg;
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

  console.log(`[WAPPI] [${requestId}] AI выбрал ${matchedProducts.length} товаров из ${productsWithCategory.length}`);
  if (matchedProducts.length > 0) {
    console.log(
      `[WAPPI] [${requestId}] Примеры выбранных товаров:`,
      matchedProducts.slice(0, 5).map(p => ({
        id: p.id,
        name: p.name,
        brandName: p.brandName,
        categoryName: p.categoryName
      }))
    );
  }

  // Если AI сузил выбор до ОДНОГО товара — сразу показываем магазины, без дополнительных подтверждений
  if (matchedProducts.length === 1) {
    try {
      const singleProduct = matchedProducts[0];
      console.log(`[WAPPI] [${requestId}] Один выбранный товар (${singleProduct.id}), подготавливаем ответ с магазинами`);

      const searchResultItems = await performSearch({
        text,
        geo,
        radiusMeters,
        intent: {
          filters: { candidateProductIds: [singleProduct.id] },
          brand: null,
          packageInfo: null
        }
      });

      if (Array.isArray(searchResultItems) && searchResultItems.length > 0) {
        replyText = formatSearchResultsWithStores(searchResultItems[0]);
        console.log(`[WAPPI] [${requestId}] Сформирован ответ с магазинами для товара ${singleProduct.id}`);
      } else {
        console.log(`[WAPPI] [${requestId}] Для товара ${singleProduct.id} не найдено доступных магазинов, оставляем текст AI`);
      }
    } catch (error) {
      console.error(`[WAPPI] [${requestId}] Ошибка при формировании ответа с магазинами:`, error);
    }
  }

  // Сохраняем ответ системы
  await SearchMessage.create({
    id: generateId(),
    conversationId,
    sender: 'SYSTEM',
    text: replyText
  });

  const debugPayload = {
    replyText,
    reasoning: aiResult.reasoning || null,
    allProductsCount: productsWithCategory.length,
    allProductsSample: productsWithCategory.slice(0, 10).map(p => ({
      id: p.id,
      name: p.name,
      brandName: p.brandName,
      categoryName: p.categoryName
    })),
    matchedProductIds: Array.isArray(aiResult.matchedProductIds) ? aiResult.matchedProductIds : [],
    matchedProducts: matchedProducts.map(p => ({
      id: p.id,
      name: p.name,
      brandName: p.brandName,
      categoryName: p.categoryName,
      packageInfo: p.packageInfo,
      sku: p.sku
    })),
    rawAI: aiResult
  };

  if (debug) {
    console.log(`[WAPPI] [${requestId}] DEBUG payload:`, JSON.stringify(debugPayload, null, 2));
    return debugPayload;
  }

  return replyText;
}

// Функция обработки поиска с intent
async function processSearchWithIntent(conversationId, intent, text, requestId) {
  // Получаем историю сообщений для контекста (последние 10 сообщений)
  const recentMessages = await SearchMessage.find({
    conversationId,
    sender: 'CUSTOMER'
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  // Формируем контекст разговора (только тексты сообщений пользователя)
  const conversationContext = recentMessages
    .reverse() // Возвращаем в хронологическом порядке
    .map(msg => msg.text)
    .filter(t => t && t.trim());

  // Обновляем intent на основе ответов пользователя
  if (text && text.trim()) {
    const currentAnswer = normalizeText(text);

    // Проверяем ответы на вопросы о типе
    const isTypeAnswer = currentAnswer.includes('classic') ||
      currentAnswer.includes('zero') ||
      currentAnswer.includes('light') ||
      currentAnswer.includes('классическая') ||
      currentAnswer.includes('классик') ||
      currentAnswer === '1' ||
      currentAnswer.includes('ноль');

    if (isTypeAnswer && !intent.type) {
      if (currentAnswer.includes('classic') || currentAnswer.includes('классическая') || currentAnswer.includes('классик') || currentAnswer === '1') {
        intent.type = 'classic';
      } else if (currentAnswer.includes('zero') || currentAnswer.includes('ноль')) {
        intent.type = 'zero';
      } else if (currentAnswer.includes('light') || currentAnswer.includes('лайт')) {
        intent.type = 'light';
      }
      await intent.save();
    }

    // Проверяем ответы о таре
    const isTaraAnswer = currentAnswer.includes('металл') ||
      currentAnswer.includes('стекло') ||
      currentAnswer.includes('банка') ||
      currentAnswer.includes('пластик') ||
      currentAnswer.includes('can') ||
      currentAnswer.includes('glass') ||
      currentAnswer.includes('plastic') ||
      currentAnswer.includes('жб');

    if (isTaraAnswer && !intent.packageType) {
      if (currentAnswer.includes('металл') || currentAnswer.includes('банка') || currentAnswer.includes('can') || currentAnswer.includes('жб')) {
        intent.packageType = 'can';
      } else if (currentAnswer.includes('стекло') || currentAnswer.includes('glass')) {
        intent.packageType = 'glass';
      } else if (currentAnswer.includes('пластик') || currentAnswer.includes('plastic')) {
        intent.packageType = 'plastic';
      }
      await intent.save();
    }
  }

  // Получаем кандидатов товаров
  let candidates = [];
  if (intent.filters && Array.isArray(intent.filters.candidateProductIds) && intent.filters.candidateProductIds.length > 0) {
    candidates = await Product.find({
      id: { $in: intent.filters.candidateProductIds },
      isPayed: true,
      paymentExpiresAt: { $gt: new Date() }
    }).lean();
  } else {
    // Передаем контекст разговора для лучшего понимания запроса
    console.log(`[WAPPI] 🔍 Поиск товаров по запросу: "${text}"`);
    candidates = await buildCandidatesByText(text, conversationContext);
    console.log(`[WAPPI] Найдено кандидатов до фильтрации по оплате: ${candidates.length}`);
    candidates = candidates.filter(p => p.isPayed && p.paymentExpiresAt && new Date(p.paymentExpiresAt) > new Date());
    console.log(`[WAPPI] Найдено кандидатов после фильтрации по оплате: ${candidates.length}`);
  }

  if (candidates.length === 0) {
    console.log(`[WAPPI] ❌ Товары не найдены для запроса: "${text}"`);
    await SearchConversation.updateOne(
      { id: conversationId },
      { state: 'NEEDS_CLARIFICATION', updatedAt: new Date() }
    );
    intent.filters = {};
    intent.brand = null;
    intent.packageInfo = null;
    intent.type = null;
    intent.packageType = null;
    await intent.save();

    const errorMessage = 'Не нашел такой товар. Попробуйте написать название по-другому или укажите бренд.';
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: errorMessage
    });
    return errorMessage;
  }

  // НЕ фильтруем кандидатов по intent, если это первый поиск
  // Фильтрация применяется только при уточняющих вопросах
  const isFirstSearch = !intent.brand && !intent.packageInfo && !intent.type && !intent.packageType;

  // Используем Gemini для извлечения intent ТОЛЬКО если это уточняющий запрос (не первый поиск)
  // При первом поиске AI уже нашел товары, не нужно дополнительно извлекать intent
  let geminiResult = null;
  if (!isFirstSearch && text && text.trim() && candidates.length > 0) {
    try {
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
        },
        conversationContext: conversationContext
      });

      if (geminiResult && geminiResult.action === 'READY_TO_SEARCH') {
        const aiIntent = geminiResult.intent || {};
        // Обновляем intent только если новые значения релевантны
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
        await intent.save();
      }
    } catch (error) {
      console.error('Ошибка при получении intent от Gemini:', error);
    }
  } else if (isFirstSearch) {
    console.log(`[WAPPI] Первый поиск, извлечение intent пропущено (AI уже нашел товары)`);
  }

  if (!isFirstSearch) {
    // Фильтруем только если есть уточняющие параметры от пользователя
    const previousCandidateIds = intent.filters && Array.isArray(intent.filters.candidateProductIds)
      ? intent.filters.candidateProductIds
      : candidates.map(c => c.id);

    const candidatesBeforeFilter = candidates.length;
    console.log(`[WAPPI] Кандидатов до фильтрации: ${candidatesBeforeFilter}`);

    candidates = filterCandidatesByIntent(candidates, {
      brand: intent.brand || null,
      packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null,
      type: intent.type || null,
      packageType: intent.packageType || null
    });

    console.log(`[WAPPI] Кандидатов после фильтрации: ${candidates.length}`);
    console.log(`[WAPPI] Intent для фильтрации:`, {
      brand: intent.brand,
      packageInfo: intent.packageInfo,
      type: intent.type,
      packageType: intent.packageType
    });

    // Если после фильтрации все товары отфильтровались, но были до фильтрации - используем исходные кандидаты
    if (candidates.length === 0 && candidatesBeforeFilter > 0) {
      console.log(`[WAPPI] ⚠️ Все товары отфильтровались, используем исходные кандидаты`);
      candidates = await Product.find({
        id: { $in: previousCandidateIds },
        isPayed: true,
        paymentExpiresAt: { $gt: new Date() }
      }).lean();
      console.log(`[WAPPI] Восстановлено кандидатов: ${candidates.length}`);
    }
  } else {
    console.log(`[WAPPI] Первый поиск, фильтрация по intent не применяется`);
  }

  intent.filters = {
    ...(intent.filters || {}),
    candidateProductIds: candidates.map(item => item.id)
  };
  await intent.save();

  // Если остался один товар - показываем магазины
  if (candidates.length === 1) {
    intent.filters = {
      ...(intent.filters || {}),
      candidateProductIds: [candidates[0].id]
    };
    await intent.save();

    // Выполняем поиск магазинов (без геолокации для Wappi)
    const items = await performSearch({ text, geo: null, radiusMeters: null, intent });

    if (items.length > 0 && items[0].offers.length > 0) {
      const responseText = formatSearchResultsWithStores(items[0]);

      await SearchMessage.create({
        id: generateId(),
        conversationId,
        sender: 'SYSTEM',
        text: responseText
      });

      await SearchConversation.updateOne(
        { id: conversationId },
        { state: 'DONE', updatedAt: new Date() }
      );

      // После показа результатов сбрасываем состояние для следующего поиска
      // Удаляем intent, чтобы следующий запрос начался заново
      if (intent && intent.id) {
        await SearchIntent.deleteOne({ id: intent.id });
      }
      await SearchConversation.updateOne(
        { id: conversationId },
        { intentId: null, state: 'DONE', updatedAt: new Date() }
      );

      return responseText;
    } else {
      const productName = `${candidates[0].name}${candidates[0].brandName ? ' (' + candidates[0].brandName + ')' : ''}${candidates[0].packageInfo ? ' - ' + candidates[0].packageInfo : ''}`;
      const responseText = `Найден товар: ${productName}\n\nК сожалению, в базе нет предложений по этому товару.`;

      await SearchMessage.create({
        id: generateId(),
        conversationId,
        sender: 'SYSTEM',
        text: responseText
      });

      await SearchConversation.updateOne(
        { id: conversationId },
        { state: 'DONE', updatedAt: new Date() }
      );

      // Сбрасываем состояние для следующего поиска
      if (intent && intent.id) {
        await SearchIntent.deleteOne({ id: intent.id });
      }
      await SearchConversation.updateOne(
        { id: conversationId },
        { intentId: null, state: 'DONE', updatedAt: new Date() }
      );

      return responseText;
    }
  }

  // Проверяем, что товары есть после всех фильтраций
  if (candidates.length === 0) {
    console.log(`[WAPPI] ❌ Нет кандидатов после фильтрации, возвращаем сообщение об ошибке`);
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: 'Не нашел такой товар. Попробуйте написать название по-другому или укажите бренд.'
    });
    return 'Не нашел такой товар. Попробуйте написать название по-другому или укажите бренд.';
  }

  // Если товаров больше одного - показываем их список (до 10 товаров)
  // Если товаров больше 10 - показываем первые 10 и просим уточнить

  console.log(`[WAPPI] ✅ Найдено ${candidates.length} кандидатов, показываем список`);

  if (candidates.length >= 2 && candidates.length <= 10) {
    // Показываем все найденные товары
    let responseText = `Найдено товаров: ${candidates.length}\n\n`;
    candidates.forEach((product, index) => {
      const productName = product.name || 'Без названия';
      const brandName = product.brandName ? ` (${product.brandName})` : '';
      const packageInfo = product.packageInfo ? ` - ${product.packageInfo}` : '';
      responseText += `${index + 1}. ${productName}${brandName}${packageInfo}\n`;
    });
    responseText += '\nУточните, какой именно товар вас интересует?\n';

    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: responseText
    });

    await SearchConversation.updateOne(
      { id: conversationId },
      { state: 'NEEDS_CLARIFICATION', updatedAt: new Date() }
    );

    return responseText;
  }

  // Если товаров больше 10 - показываем первые 10 и просим уточнить
  if (candidates.length > 10) {
    let responseText = `Найдено товаров: ${candidates.length}. Показаны первые 10:\n\n`;
    candidates.slice(0, 10).forEach((product, index) => {
      const productName = product.name || 'Без названия';
      const brandName = product.brandName ? ` (${product.brandName})` : '';
      const packageInfo = product.packageInfo ? ` - ${product.packageInfo}` : '';
      responseText += `${index + 1}. ${productName}${brandName}${packageInfo}\n`;
    });
    responseText += `\n... и еще ${candidates.length - 10} товаров.\nУточните запрос для более точного поиска.`;

    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: responseText
    });

    await SearchConversation.updateOne(
      { id: conversationId },
      { state: 'NEEDS_CLARIFICATION', updatedAt: new Date() }
    );

    return responseText;
  }

  // Если дошли сюда, значит товары есть, но их больше 10 или что-то пошло не так
  // В любом случае показываем товары, которые есть
  console.log(`[WAPPI] ⚠️ Попали в fallback блок, кандидатов: ${candidates.length}`);

  // Показываем товары, даже если их много
  let responseText = '';
  if (candidates.length > 0) {
    if (candidates.length <= 10) {
      responseText = `Найдено товаров: ${candidates.length}\n\n`;
      candidates.forEach((product, index) => {
        const productName = product.name || 'Без названия';
        const brandName = product.brandName ? ` (${product.brandName})` : '';
        const packageInfo = product.packageInfo ? ` - ${product.packageInfo}` : '';
        responseText += `${index + 1}. ${productName}${brandName}${packageInfo}\n`;
      });
      responseText += '\nУточните, какой именно товар вас интересует?';
    } else {
      responseText = `Найдено товаров: ${candidates.length}. Показаны первые 10:\n\n`;
      candidates.slice(0, 10).forEach((product, index) => {
        const productName = product.name || 'Без названия';
        const brandName = product.brandName ? ` (${product.brandName})` : '';
        const packageInfo = product.packageInfo ? ` - ${product.packageInfo}` : '';
        responseText += `${index + 1}. ${productName}${brandName}${packageInfo}\n`;
      });
      responseText += `\n... и еще ${candidates.length - 10} товаров.\nУточните запрос для более точного поиска.`;
    }
  } else {
    // Если товаров нет (не должно быть, но на всякий случай)
    responseText = 'Не нашел такой товар. Попробуйте написать название по-другому или укажите бренд.';
  }

  await SearchMessage.create({
    id: generateId(),
    conversationId,
    sender: 'SYSTEM',
    text: responseText
  });

  await SearchConversation.updateOne(
    { id: conversationId },
    { state: 'NEEDS_CLARIFICATION', updatedAt: new Date() }
  );

  return responseText;
}

// Основная функция обработки webhook от Wappi
async function handleWappiWebhook(req, res) {
  const startTime = Date.now();
  const requestId = `wappi-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const isTestMode = req.query.test === 'true' || req.query.test === '1' || req.headers['x-test-mode'] === 'true';

  console.log(`[WAPPI WEBHOOK] [${requestId}] 📥 Входящий запрос:`, {
    method: req.method,
    path: req.path,
    ip: clientIp,
    userAgent: req.headers['user-agent'] || 'unknown',
    timestamp: new Date().toISOString(),
    bodySize: JSON.stringify(req.body || {}).length,
    testMode: isTestMode
  });

  try {
    const rawBody = req.body || {};
    const maskedBody = JSON.parse(JSON.stringify(rawBody));

    if (maskedBody.messages && Array.isArray(maskedBody.messages)) {
      maskedBody.messages = maskedBody.messages.map(msg => {
        const maskedMsg = { ...msg };
        if (maskedMsg.chatId) {
          const chatId = maskedMsg.chatId;
          maskedMsg.chatId = chatId.length > 7
            ? `${chatId.substring(0, 3)}****${chatId.substring(chatId.length - 2)}`
            : '****';
        }
        if (maskedMsg.from) {
          const from = maskedMsg.from;
          maskedMsg.from = from.length > 7
            ? `${from.substring(0, 3)}****${from.substring(from.length - 2)}`
            : '****';
        }
        return maskedMsg;
      });
    }

    console.log(`[WAPPI WEBHOOK] [${requestId}] 📋 Полное тело запроса (маскированное):`, JSON.stringify(maskedBody, null, 2));

    const messages = rawBody.messages || rawBody.message || (Array.isArray(rawBody) ? rawBody : []);
    const message = Array.isArray(messages) && messages.length > 0 ? messages[0] : messages;

    if (!message || typeof message !== 'object') {
      console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Отсутствует или некорректное поле messages/message`);
      res.status(200).json({ received: true, error: 'Missing or invalid messages field' });
      return;
    }

    const chatId = message.chatId || message.from;
    const body = message.body || '';
    const fromMe = message.is_me || message.fromMe || false;
    const profile_id = message.profile_id;

    if (fromMe === true || message.is_me === true) {
      console.log(`[WAPPI WEBHOOK] [${requestId}] ⏭️  Игнорируем сообщение, отправленное нами самими`);
      res.status(200).json({ received: true, ignored: true, reason: 'fromMe' });
      return;
    }

    // Пытаемся вытащить геолокацию из сообщения Wappi (чистая гео WhatsApp)
    let location = null;
    if (message.location && typeof message.location === 'object') {
      const loc = message.location;
      const lat = loc.lat ?? loc.latitude;
      const lng = loc.lng ?? loc.longitude ?? loc.lon;
      if (typeof lat === 'number' && typeof lng === 'number') {
        location = { lat, lng };
      }
    }
    if (!location) {
      const lat = message.lat ?? message.latitude;
      const lng = message.lng ?? message.longitude ?? message.lon;
      if (typeof lat === 'number' && typeof lng === 'number') {
        location = { lat, lng };
      }
    }

    if (!body && !location) {
      console.log(`[WAPPI WEBHOOK] [${requestId}] ⚠️  Получено сообщение без текста и без геолокации`);
      res.status(200).json({ received: true, ignored: true, reason: 'empty body and no location' });
      return;
    }

    if (!chatId) {
      console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Отсутствует chatId`);
      res.status(200).json({ received: true, error: 'Missing chatId' });
      return;
    }

    const maskedChatId = chatId.length > 7
      ? `${chatId.substring(0, 3)}****${chatId.substring(chatId.length - 2)}`
      : '****';
    const bodyPreview = body.length > 100
      ? `${body.substring(0, 100)}...`
      : body;

    console.log(`[WAPPI WEBHOOK] [${requestId}] ✅ Валидный запрос:`, {
      profile_id: profile_id || 'не указан',
      chatId: maskedChatId,
      bodyLength: body.length,
      bodyPreview: bodyPreview,
      fromMe: fromMe || false,
      testMode: isTestMode
    });

    // Если тестовый режим - обрабатываем синхронно и возвращаем результат (с доп. данными для отладки)
    if (isTestMode) {
      const processingStartTime = Date.now();
      try {
        console.log(`[WAPPI WEBHOOK] [${requestId}] 🧪 ТЕСТОВЫЙ РЕЖИМ - синхронная обработка (с DEBUG)...`);

        const result = await processWappiMessage(chatId, body, requestId, { debug: true, location });

        let responseText = typeof result === 'string' ? result : (result.replyText || '');
        if (!responseText || !responseText.trim()) {
          console.warn(`[WAPPI WEBHOOK] [${requestId}] ⚠️  Получен пустой ответ, используем дефолтное сообщение`);
          responseText = 'Обрабатываю ваш запрос. Пожалуйста, подождите...';
        }

        const totalProcessingTime = Date.now() - processingStartTime;
        const totalRequestTime = Date.now() - startTime;

        console.log(`[WAPPI WEBHOOK] [${requestId}] ✅ Тестовый запрос обработан:`, {
          totalProcessingTime: `${totalProcessingTime}ms`,
          totalRequestTime: `${totalRequestTime}ms`,
          responseLength: responseText.length
        });

        return res.status(200).json({
          received: true,
          requestId,
          testMode: true,
          // В тестовом режиме возвращаем ПОЛНЫЙ объект результата, включая список товаров
          response: result,
          processingTime: totalProcessingTime,
          totalTime: totalRequestTime
        });

      } catch (error) {
        const totalProcessingTime = Date.now() - processingStartTime;
        const totalRequestTime = Date.now() - startTime;

        console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Ошибка в тестовом режиме:`, {
          error: error.message,
          stack: error.stack,
          totalProcessingTime: `${totalProcessingTime}ms`,
          totalRequestTime: `${totalRequestTime}ms`
        });

        return res.status(200).json({
          received: true,
          requestId,
          testMode: true,
          error: error.message,
          response: 'Произошла ошибка при поиске товаров. Попробуйте позже.',
          processingTime: totalProcessingTime,
          totalTime: totalRequestTime
        });
      }
    }

    // Обычный режим - возвращаем сразу и обрабатываем асинхронно
    res.status(200).json({ received: true, requestId });

    // Обрабатываем сообщение асинхронно
    (async () => {
      const processingStartTime = Date.now();
      try {
        console.log(`[WAPPI WEBHOOK] [${requestId}] 🔍 Начинаем обработку запроса...`);

        // Сразу отправляем пользователю сообщение о том, что запрос обрабатывается
        const processingMessage = 'Обрабатываю ваш запрос, пожалуйста подождите...';
        try {
          await sendWappiMessage(chatId, processingMessage);
        } catch (e) {
          console.warn(`[WAPPI WEBHOOK] [${requestId}] ⚠️ Не удалось отправить сообщение о начале обработки:`, e.message);
        }

        const result = await processWappiMessage(chatId, body, requestId, { debug: false, location });

        let responseText = typeof result === 'string' ? result : (result.replyText || '');

        // Проверяем, что ответ не пустой
        if (!responseText || !responseText.trim()) {
          console.warn(`[WAPPI WEBHOOK] [${requestId}] ⚠️  Получен пустой ответ, используем дефолтное сообщение`);
          responseText = 'Не удалось обработать запрос. Попробуйте описать товар по-другому.';
        }

        console.log(`[WAPPI WEBHOOK] [${requestId}] 📤 Отправка ответа пользователю через Wappi API...`);
        console.log(`[WAPPI WEBHOOK] [${requestId}] 📝 Текст ответа (${responseText.length} символов):`, responseText.substring(0, 200));
        await sendWappiMessage(chatId, responseText);

        const totalProcessingTime = Date.now() - processingStartTime;
        const totalRequestTime = Date.now() - startTime;

        console.log(`[WAPPI WEBHOOK] [${requestId}] ✅ Успешно обработан запрос:`, {
          totalProcessingTime: `${totalProcessingTime}ms`,
          totalRequestTime: `${totalRequestTime}ms`,
          responseLength: responseText.length
        });

      } catch (error) {
        const totalProcessingTime = Date.now() - processingStartTime;
        const totalRequestTime = Date.now() - startTime;

        console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Ошибка при обработке запроса:`, {
          error: error.message,
          stack: error.stack,
          totalProcessingTime: `${totalProcessingTime}ms`,
          totalRequestTime: `${totalRequestTime}ms`
        });

        try {
          await sendWappiMessage(chatId, 'Произошла ошибка при поиске товаров. Попробуйте позже.');
        } catch (sendError) {
          console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Не удалось отправить сообщение об ошибке:`, sendError);
        }
      }
    })();

  } catch (error) {
    const totalRequestTime = Date.now() - startTime;
    console.error(`[WAPPI WEBHOOK] [${requestId}] 💥 Критическая ошибка:`, {
      error: error.message,
      stack: error.stack,
      totalRequestTime: `${totalRequestTime}ms`
    });

    if (!res.headersSent) {
      res.status(200).json({ received: true, error: 'Internal error', requestId });
    }
  }
}

module.exports = {
  handleWappiWebhook
};
