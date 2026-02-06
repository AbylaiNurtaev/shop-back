const axios = require('axios');
const { generateId } = require('../utils/uuid');
const { getIntentFromGemini, findProductsBySemanticSearch, generateClarificationQuestions } = require('../utils/gemini');
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
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
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
async function buildCandidatesByText(text) {
  if (!text || !text.trim()) return [];

  console.log(`🔍 AI семантический поиск для запроса: "${text}"`);

  try {
    // Получаем все оплаченные товары для AI поиска
    const allProducts = await Product.find({
      isPayed: true,
      paymentExpiresAt: { $gt: new Date() }
    }).limit(500).lean();

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

// Функция performSearch (из customerController)
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

  for (const offer of offers) {
    const store = storeById.get(offer.storeId);
    if (!store) continue;

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
        locationCoords: store.locationCoords || null
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
        .sort((a, b) => (a.price || 0) - (b.price || 0));

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

  let message = `✅ Найден товар: ${productName}\n\n`;
  message += `Найдено предложений: ${item.totalOffers}\n\n`;

  // Показываем первые 5 магазинов
  const storesToShow = item.offers.slice(0, 5);
  storesToShow.forEach((offer, index) => {
    message += `${index + 1}. ${offer.store.name}\n`;
    if (offer.store.address) {
      message += `   Адрес: ${offer.store.address}\n`;
    }
    message += `   Цена: ${offer.price} ${offer.currency || 'RUB'}\n`;
    if (offer.store.location) {
      message += `   ${offer.store.location}\n`;
    }
    message += '\n';
  });

  if (item.offers.length > 5) {
    message += `... и еще ${item.offers.length - 5} предложений.`;
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
  const greetings = ['привет', 'здравствуй', 'здравствуйте', 'hi', 'hello', 'да', 'нет', 'ок', 'окей', 'спасибо', 'благодарю'];
  if (greetings.includes(trimmed)) return false;
  
  // Если сообщение содержит только цифры или один символ - не поисковый запрос
  if (/^[\d\s\?\!\.\,]+$/.test(trimmed) && trimmed.length < 3) return false;
  
  // Если сообщение слишком длинное (больше 100 символов) - возможно, не поисковый запрос
  if (trimmed.length > 100) return false;
  
  return true;
}

// Основная функция обработки сообщения (адаптированная из customerController)
async function processWappiMessage(chatId, text, requestId) {
  const conversation = await getOrCreateConversation(chatId);
  const conversationId = conversation.id;

  // Проверяем, является ли сообщение поисковым запросом
  if (!isSearchQuery(text)) {
    // Если это не поисковый запрос, отвечаем нейтрально
    const neutralResponses = [
      'Напишите, какой товар вы ищете? Например: "Кола", "Найди кроссовки Nike"',
      'Я могу помочь найти товар. Опишите, что вы ищете?',
      'Для поиска товара напишите название или описание. Например: "Coca-Cola" или "Найди кроссовки"'
    ];
    const randomResponse = neutralResponses[Math.floor(Math.random() * neutralResponses.length)];
    
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'CUSTOMER',
      text: text || '',
      attachmentIds: []
    });
    
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'SYSTEM',
      text: randomResponse
    });
    
    return randomResponse;
  }

  // Если предыдущий поиск завершен (DONE), сбрасываем состояние для нового поиска
  if (conversation.state === 'DONE') {
    console.log(`[WAPPI] Сбрасываем состояние conversation для нового поиска`);
    
    // Удаляем старый intent
    if (conversation.intentId) {
      await SearchIntent.deleteOne({ id: conversation.intentId });
    }
    
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
    
    // Обновляем conversationId для дальнейшей работы
    const conversationId = newConversation.id;
    
    // Создаем новый intent
    const intent = await SearchIntent.create({
      id: generateId(),
      conversationId,
      rawText: text || '',
      filters: {}
    });
    
    await SearchConversation.updateOne(
      { id: conversationId },
      { intentId: intent.id, updatedAt: new Date() }
    );
    
    // Создаем сообщение пользователя
    await SearchMessage.create({
      id: generateId(),
      conversationId,
      sender: 'CUSTOMER',
      text: text || '',
      attachmentIds: []
    });
    
    // Продолжаем с новым conversation и intent
    return await processSearchWithIntent(conversationId, intent, text, requestId);
  }

  // Создаем сообщение пользователя
  await SearchMessage.create({
    id: generateId(),
    conversationId,
    sender: 'CUSTOMER',
    text: text || '',
    attachmentIds: []
  });

  // Получаем или создаем intent
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
    await SearchConversation.updateOne(
      { id: conversationId },
      { intentId: intent.id, updatedAt: new Date() }
    );
  } else if (text) {
    intent.rawText = (intent.rawText ? intent.rawText + ' ' : '') + text;
  }

  return await processSearchWithIntent(conversationId, intent, text, requestId);
}

// Функция обработки поиска с intent
async function processSearchWithIntent(conversationId, intent, text, requestId) {

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
    candidates = await buildCandidatesByText(text);
    candidates = candidates.filter(p => p.isPayed && p.paymentExpiresAt && new Date(p.paymentExpiresAt) > new Date());
  }

  if (candidates.length === 0) {
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

    return 'Не нашел такой товар. Попробуйте написать название по-другому или укажите бренд.';
  }

  // Используем Gemini для извлечения intent
  let geminiResult = null;
  if (text && text.trim() && candidates.length > 0) {
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
        }
      });

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
        await intent.save();
      }
    } catch (error) {
      console.error('Ошибка при получении intent от Gemini:', error);
    }
  }

  // Фильтруем кандидатов
  const previousCandidateIds = intent.filters && Array.isArray(intent.filters.candidateProductIds)
    ? intent.filters.candidateProductIds
    : candidates.map(c => c.id);

  candidates = filterCandidatesByIntent(candidates, {
    brand: intent.brand || null,
    packageInfo: intent.packageInfo !== undefined ? intent.packageInfo : null,
    type: intent.type || null,
    packageType: intent.packageType || null
  });

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

  // Если товаров больше одного - задаем уточняющие вопросы
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
    clarification = { questions: ['Уточните, какой именно товар вас интересует?'], quickReplies: [] };
  }

  await SearchConversation.updateOne(
    { id: conversationId },
    { state: 'NEEDS_CLARIFICATION', updatedAt: new Date() }
  );

  // Формируем сообщение с вопросом и списком товаров
  let responseText = '';

  // Добавляем вопрос
  const question = clarification.questions.length > 0
    ? clarification.questions[0]
    : 'Уточните, какой именно товар вас интересует?';

  responseText = question;

  // Добавляем список найденных товаров (если их не слишком много)
  if (candidates.length > 1 && candidates.length <= 10) {
    responseText += '\n\nНайдено товаров:\n';
    candidates.forEach((product, index) => {
      const productName = product.name || 'Без названия';
      const brandName = product.brandName ? ` (${product.brandName})` : '';
      const packageInfo = product.packageInfo ? ` - ${product.packageInfo}` : '';
      responseText += `${index + 1}. ${productName}${brandName}${packageInfo}\n`;
    });
    responseText += '\nОтветьте на вопрос выше, чтобы уточнить выбор.';
  } else if (candidates.length > 10) {
    responseText += `\n\nНайдено товаров: ${candidates.length}. Уточните запрос для более точного поиска.`;
  }

  // Убеждаемся, что responseText не пустой
  if (!responseText || !responseText.trim()) {
    responseText = 'Уточните, какой именно товар вас интересует?';
  }

  await SearchMessage.create({
    id: generateId(),
    conversationId,
    sender: 'SYSTEM',
    text: responseText
  });

  return responseText;
}

// Основная функция обработки webhook от Wappi
async function handleWappiWebhook(req, res) {
  const startTime = Date.now();
  const requestId = `wappi-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';

  console.log(`[WAPPI WEBHOOK] [${requestId}] 📥 Входящий запрос:`, {
    method: req.method,
    path: req.path,
    ip: clientIp,
    userAgent: req.headers['user-agent'] || 'unknown',
    timestamp: new Date().toISOString(),
    bodySize: JSON.stringify(req.body || {}).length
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
    const body = message.body;
    const fromMe = message.is_me || message.fromMe || false;
    const profile_id = message.profile_id;

    if (fromMe === true || message.is_me === true) {
      console.log(`[WAPPI WEBHOOK] [${requestId}] ⏭️  Игнорируем сообщение, отправленное нами самими`);
      res.status(200).json({ received: true, ignored: true, reason: 'fromMe' });
      return;
    }

    if (!body || !body.trim()) {
      console.log(`[WAPPI WEBHOOK] [${requestId}] ⚠️  Получено пустое сообщение`);
      res.status(200).json({ received: true, ignored: true, reason: 'empty body' });
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
      fromMe: fromMe || false
    });

    res.status(200).json({ received: true, requestId });

    // Обрабатываем сообщение асинхронно
    (async () => {
      const processingStartTime = Date.now();
      try {
        console.log(`[WAPPI WEBHOOK] [${requestId}] 🔍 Начинаем обработку запроса...`);

        let responseText = await processWappiMessage(chatId, body, requestId);

        // Проверяем, что ответ не пустой
        if (!responseText || !responseText.trim()) {
          console.warn(`[WAPPI WEBHOOK] [${requestId}] ⚠️  Получен пустой ответ, используем дефолтное сообщение`);
          responseText = 'Обрабатываю ваш запрос. Пожалуйста, подождите...';
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
