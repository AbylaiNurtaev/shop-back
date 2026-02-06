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
    const wappiResponse = await sendWithRetry(wappiUrl, payload, headers);
    console.log('Сообщение успешно отправлено через Wappi:', {
      phone: normalizedPhone.substring(0, 3) + '****',
      status: wappiResponse.status
    });
    return wappiResponse;
  } catch (error) {
    const errorMessage = error.response?.data || error.message;
    console.error('Ошибка при отправке сообщения через Wappi API:', errorMessage);
    throw error;
  }
}

// Основная функция обработки webhook от Wappi
async function handleWappiWebhook(req, res) {
  try {
    // Сразу отвечаем 200 OK, чтобы Wappi не ждал
    res.status(200).json({ received: true });

    // Извлекаем данные из запроса
    const { instance_id, message } = req.body || {};

    if (!message) {
      console.error('Отсутствует поле message в запросе от Wappi');
      return;
    }

    const { chatId, body, fromMe } = message;

    // Игнорируем сообщения, отправленные нами самими
    if (fromMe === true) {
      console.log('Игнорируем сообщение, отправленное нами самими');
      return;
    }

    if (!body || !body.trim()) {
      console.log('Получено пустое сообщение от Wappi');
      return;
    }

    if (!chatId) {
      console.error('Отсутствует chatId в сообщении от Wappi');
      return;
    }

    console.log('Получен запрос от Wappi:', {
      instance_id,
      chatId: chatId.substring(0, 3) + '****',
      body: body.substring(0, 50) + '...',
      fromMe
    });

    // Выполняем поиск товаров асинхронно
    (async () => {
      try {
        // Шаг Б: Поиск товаров по тексту
        const candidates = await buildCandidatesByText(body);

        // Шаг В: Форматируем результат
        const responseText = formatSearchResults(candidates);

        // Шаг Г: Отправляем результат через Wappi API
        await sendWappiMessage(chatId, responseText);

        console.log('Успешно обработан запрос от Wappi');
      } catch (error) {
        console.error('Ошибка при обработке запроса от Wappi:', error);
        
        // Пытаемся отправить сообщение об ошибке
        try {
          await sendWappiMessage(chatId, 'Произошла ошибка при поиске товаров. Попробуйте позже.');
        } catch (sendError) {
          console.error('Не удалось отправить сообщение об ошибке:', sendError);
        }
      }
    })();

  } catch (error) {
    console.error('Критическая ошибка при обработке webhook от Wappi:', error);
    // Все равно отвечаем 200, чтобы Wappi не повторял запрос
    if (!res.headersSent) {
      res.status(200).json({ received: true, error: 'Internal error' });
    }
  }
}

module.exports = {
  handleWappiWebhook
};
