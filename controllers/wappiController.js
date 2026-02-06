const axios = require('axios');
const { findProductsBySemanticSearch } = require('../utils/gemini');
const { models } = require('../models/database');

const { Product, Offer, Store } = models;

// Константы конфигурации WAPPI
const WAPPI_API_URL = process.env.WAPPI_API_URL || 'https://wappi.pro/api/sync/message/send';
const PROFILE_ID_WAPPI = process.env.PROFILE_ID_WAPPI;
const API_KEY_WAPPI = process.env.API_KEY_WAPPI;

// Настройка Axios с таймаутами
const axiosInstance = axios.create({
  timeout: 30000, // 30 секунд таймаут
  headers: {
    'Content-Type': 'application/json'
  }
});

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

// Функция для получения предложений по товару
async function getProductOffers(productId) {
  try {
    const offers = await Offer.find({
      productId: productId,
      isAvailable: true
    }).lean();

    if (offers.length === 0) {
      return [];
    }

    const storeIds = [...new Set(offers.map(offer => offer.storeId))];
    const stores = storeIds.length > 0
      ? await Store.find({ id: { $in: storeIds } }).lean()
      : [];
    const storeById = new Map(stores.map(store => [store.id, store]));

    return offers.map(offer => {
      const store = storeById.get(offer.storeId);
      return {
        price: offer.price,
        currency: offer.currency || 'RUB',
        quantity: offer.quantity,
        store: store ? {
          name: store.name,
          address: store.address
        } : null
      };
    }).filter(offer => offer.store !== null);
  } catch (error) {
    console.error('Ошибка при получении предложений:', error);
    return [];
  }
}

// Функция для форматирования результатов поиска в текст для WhatsApp
function formatSearchResults(candidates, maxResults = 5) {
  if (candidates.length === 0) {
    return 'К сожалению, я не нашел товары по вашему запросу. Попробуйте изменить формулировку или укажите бренд.';
  }

  let message = `🔍 Найдено товаров: ${candidates.length}\n\n`;

  // Показываем только первые maxResults товаров
  const productsToShow = candidates.slice(0, maxResults);

  for (let i = 0; i < productsToShow.length; i++) {
    const product = productsToShow[i];
    const productName = product.name || 'Без названия';
    const brandName = product.brandName ? ` (${product.brandName})` : '';
    const packageInfo = product.packageInfo ? ` - ${product.packageInfo}` : '';
    
    // Добавляем описание, если оно короткое
    const description = product.description && product.description.length < 50 
      ? `\n   ${product.description}` 
      : '';

    message += `${i + 1}. ${productName}${brandName}${packageInfo}${description}\n\n`;
  }

  if (candidates.length > maxResults) {
    message += `... и еще ${candidates.length - maxResults} товаров.\n\nУточните запрос для более точного поиска (например, укажите бренд или размер).`;
  } else {
    message += 'Уточните запрос, если нужен конкретный товар.';
  }

  return message;
}

// Функция для отправки сообщения через Wappi API
async function sendWappiMessage(phoneNumber, messageText) {
  if (!PROFILE_ID_WAPPI || !API_KEY_WAPPI) {
    console.error('WAPPI credentials not configured');
    throw new Error('WAPPI credentials not configured');
  }

  // Нормализуем номер телефона (убираем @c.us если есть и оставляем только цифры)
  // Формат chatId: "79001234567@c.us" или просто "79001234567"
  let normalizedPhone = phoneNumber.replace('@c.us', '').replace(/\D/g, '');
  
  // Если номер начинается не с цифры (например, если есть префикс), оставляем как есть
  // Wappi ожидает номер в формате только цифр

  // Формируем URL для Wappi API
  const wappiUrl = `${WAPPI_API_URL}?profile_id=${encodeURIComponent(PROFILE_ID_WAPPI)}`;

  // Тело запроса к Wappi
  const payload = {
    recipient: normalizedPhone,
    body: messageText
  };

  // Заголовки для Wappi
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

// Основная функция обработки webhook от Wappi
async function handleWappiWebhook(req, res) {
  const startTime = Date.now();
  const requestId = `wappi-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';

  // Логируем входящий запрос
  console.log(`[WAPPI WEBHOOK] [${requestId}] 📥 Входящий запрос:`, {
    method: req.method,
    path: req.path,
    ip: clientIp,
    userAgent: req.headers['user-agent'] || 'unknown',
    timestamp: new Date().toISOString(),
    bodySize: JSON.stringify(req.body || {}).length
  });

  try {
    // Извлекаем данные из запроса
    const { instance_id, message } = req.body || {};

    // Логируем полученные данные (без чувствительной информации)
    console.log(`[WAPPI WEBHOOK] [${requestId}] 📋 Данные запроса:`, {
      instance_id: instance_id || 'не указан',
      hasMessage: !!message,
      messageKeys: message ? Object.keys(message) : []
    });

    if (!message) {
      console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Отсутствует поле message в запросе от Wappi`);
      res.status(200).json({ received: true, error: 'Missing message field' });
      return;
    }

    const { chatId, body, fromMe } = message;

    // Игнорируем сообщения, отправленные нами самими
    if (fromMe === true) {
      console.log(`[WAPPI WEBHOOK] [${requestId}] ⏭️  Игнорируем сообщение, отправленное нами самими (fromMe: true)`);
      res.status(200).json({ received: true, ignored: true, reason: 'fromMe' });
      return;
    }

    if (!body || !body.trim()) {
      console.log(`[WAPPI WEBHOOK] [${requestId}] ⚠️  Получено пустое сообщение от Wappi`);
      res.status(200).json({ received: true, ignored: true, reason: 'empty body' });
      return;
    }

    if (!chatId) {
      console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Отсутствует chatId в сообщении от Wappi`);
      res.status(200).json({ received: true, error: 'Missing chatId' });
      return;
    }

    // Маскируем чувствительные данные для логов
    const maskedChatId = chatId.length > 7 
      ? `${chatId.substring(0, 3)}****${chatId.substring(chatId.length - 2)}` 
      : '****';
    const bodyPreview = body.length > 100 
      ? `${body.substring(0, 100)}...` 
      : body;

    console.log(`[WAPPI WEBHOOK] [${requestId}] ✅ Валидный запрос:`, {
      instance_id: instance_id || 'не указан',
      chatId: maskedChatId,
      bodyLength: body.length,
      bodyPreview: bodyPreview,
      fromMe: fromMe || false
    });

    // Сразу отвечаем 200 OK, чтобы Wappi не ждал
    res.status(200).json({ received: true, requestId });

    // Выполняем поиск товаров асинхронно
    (async () => {
      const processingStartTime = Date.now();
      try {
        console.log(`[WAPPI WEBHOOK] [${requestId}] 🔍 Начинаем обработку запроса...`);

        // Шаг Б: Поиск товаров по тексту
        const searchStartTime = Date.now();
        console.log(`[WAPPI WEBHOOK] [${requestId}] 🔎 Запуск поиска товаров по запросу: "${bodyPreview}"`);
        const candidates = await buildCandidatesByText(body);
        const searchDuration = Date.now() - searchStartTime;
        console.log(`[WAPPI WEBHOOK] [${requestId}] ✅ Поиск завершен за ${searchDuration}ms, найдено товаров: ${candidates.length}`);

        // Шаг В: Форматируем результат
        const formatStartTime = Date.now();
        const responseText = formatSearchResults(candidates);
        const formatDuration = Date.now() - formatStartTime;
        console.log(`[WAPPI WEBHOOK] [${requestId}] 📝 Результат отформатирован за ${formatDuration}ms, длина сообщения: ${responseText.length} символов`);

        // Шаг Г: Отправляем результат через Wappi API
        const sendStartTime = Date.now();
        console.log(`[WAPPI WEBHOOK] [${requestId}] 📤 Отправка ответа пользователю через Wappi API...`);
        await sendWappiMessage(chatId, responseText);
        const sendDuration = Date.now() - sendStartTime;
        
        const totalProcessingTime = Date.now() - processingStartTime;
        const totalRequestTime = Date.now() - startTime;

        console.log(`[WAPPI WEBHOOK] [${requestId}] ✅ Успешно обработан запрос:`, {
          searchDuration: `${searchDuration}ms`,
          formatDuration: `${formatDuration}ms`,
          sendDuration: `${sendDuration}ms`,
          totalProcessingTime: `${totalProcessingTime}ms`,
          totalRequestTime: `${totalRequestTime}ms`,
          candidatesFound: candidates.length,
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
        
        // Пытаемся отправить сообщение об ошибке
        try {
          console.log(`[WAPPI WEBHOOK] [${requestId}] 📤 Попытка отправить сообщение об ошибке пользователю...`);
          await sendWappiMessage(chatId, 'Произошла ошибка при поиске товаров. Попробуйте позже.');
          console.log(`[WAPPI WEBHOOK] [${requestId}] ✅ Сообщение об ошибке отправлено`);
        } catch (sendError) {
          console.error(`[WAPPI WEBHOOK] [${requestId}] ❌ Не удалось отправить сообщение об ошибке:`, {
            error: sendError.message,
            stack: sendError.stack
          });
        }
      }
    })();

  } catch (error) {
    const totalRequestTime = Date.now() - startTime;
    console.error(`[WAPPI WEBHOOK] [${requestId}] 💥 Критическая ошибка при обработке webhook от Wappi:`, {
      error: error.message,
      stack: error.stack,
      totalRequestTime: `${totalRequestTime}ms`
    });
    
    // Все равно отвечаем 200, чтобы Wappi не повторял запрос
    if (!res.headersSent) {
      res.status(200).json({ received: true, error: 'Internal error', requestId });
    }
  }
}

module.exports = {
  handleWappiWebhook
};
