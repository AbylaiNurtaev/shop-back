const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_MODEL_FLASH = 'gemini-2.0-flash';
const GEMINI_API_VERSION = 'v1beta';

// ============================================================================
// GEMINI API
// ============================================================================

function requestGemini(prompt, config = {}) {
  if (!GEMINI_API_KEY) {
    return Promise.reject(new Error('GEMINI_API_KEY не задан'));
  }

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: config.temperature !== undefined ? config.temperature : 0,
      maxOutputTokens: config.maxOutputTokens || 300,
      topP: 0.95,
      topK: 40
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/${GEMINI_API_VERSION}/models/${GEMINI_MODEL_FLASH}:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: config.timeout || 10000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Пустой ответ от Gemini'));
          }
          resolve(text.trim());
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini timeout'));
    });
    req.write(payload);
    req.end();
  });
}

function extractJson(text) {
  if (!text) return null;

  // 1) Сначала пробуем распарсить весь ответ целиком (вдруг это уже чистый JSON)
  const direct = text.trim();
  if (direct) {
    try {
      const parsed = JSON.parse(direct);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (e) {
      // игнорируем и пробуем вытащить JSON из текста ниже
    }
  }

  // 2) Убираем ```json/``` и markdown форматирование
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/^[^{]*/, '') // Убираем текст до первой {
    .replace(/[^}]*$/, ''); // Убираем текст после последней }

  // 3) Ищем самый большой JSON-объект (от первой { до последней })
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = cleaned.substring(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (e) {
      // Пробуем найти все JSON-объекты
    }
  }

  // 4) Ищем ВСЕ возможные JSON-объекты и пробуем распарсить каждый (от большего к меньшему)
  const matches = cleaned.match(/\{[\s\S]*?\}/g);
  if (!matches) return null;

  // Сортируем по длине (от большего к меньшему), чтобы попробовать сначала большие объекты
  const sortedMatches = matches.sort((a, b) => b.length - a.length);

  for (const candidate of sortedMatches) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // просто пробуем следующий кандидат
    }
  }

  return null;
}

// ============================================================================
// СЕМАНТИЧЕСКИЙ ПОИСК ТОВАРОВ ЧЕРЕЗ AI
// ============================================================================

async function findProductsBySemanticSearch({ searchQuery, allProducts, limit = 30, conversationContext = null }) {
  if (!searchQuery || !searchQuery.trim() || !allProducts || allProducts.length === 0) {
    return [];
  }

  // Ограничиваем количество товаров для анализа AI (увеличено до 1000 для покрытия всех категорий)
  const productsForAI = allProducts.slice(0, 1000).map(p => ({
    id: p.id,
    name: p.name || '',
    brandName: p.brandName || '',
    categoryName: p.categoryName || '',
    packageInfo: p.packageInfo || '',
    description: p.description || '',
    sku: p.sku || ''
  }));

  // Формируем контекст разговора для лучшего понимания запроса
  let contextText = '';
  if (conversationContext && conversationContext.length > 0) {
    contextText = `\n\nКОНТЕКСТ РАЗГОВОРА (предыдущие сообщения пользователя):\n${conversationContext.slice(-5).join('\n')}\n\nВАЖНО: Учитывай контекст разговора. Если пользователь спрашивает "что из напитков есть?" или "а что из [категории] есть?" - это запрос на поиск ВСЕХ товаров из этой категории. Если пользователь пишет "кола" или "колу" после вопроса про напитки - это уточнение поиска.`;
  }

  const prompt = `Ты эксперт по поиску товаров в УНИВЕРСАЛЬНОМ МНОГОКАТЕГОРИЙНОМ каталоге. Каталог содержит товары из РАЗНЫХ категорий: напитки, продукты питания, товары для дома, косметика, одежда, обувь, цветы, подарки и т.д.

Пользователь ищет товар по запросу: "${searchQuery}"${contextText}

ДОСТУПНЫЕ ТОВАРЫ (из разных категорий):
${JSON.stringify(productsForAI, null, 2)}

КРИТИЧЕСКИ ВАЖНО - ПОНИМАНИЕ КОНТЕКСТА И КАТЕГОРИЙ:
1. АНАЛИЗИРУЙ ЗАПРОС ПО СМЫСЛУ, а не просто ищи точные совпадения слов
2. Если пользователь пишет "цветы" или "букет" - найди ТОЛЬКО товары, которые являются цветами (роза, тюльпан, лилия и т.д.). 
   ЗАПРЕЩЕНО возвращать напитки (Coca-Cola, Pepsi, Fanta), продукты, косметику и другие категории
   ПРИМЕР: Запрос "цветы" → верни ТОЛЬКО товары с "роза", "тюльпан", "лилия" в названии. НЕ возвращай "Coca-Cola" или другие напитки
3. Если пользователь пишет "напитки" или "газировка" - найди ТОЛЬКО напитки (Coca-Cola, Pepsi, Fanta, Sprite и т.д.). 
   ЗАПРЕЩЕНО возвращать цветы (роза, тюльпан), продукты и другие категории
   ПРИМЕР: Запрос "напитки" → верни ТОЛЬКО товары с "cola", "pepsi", "fanta" в названии. НЕ возвращай "роза" или другие цветы
4. Если пользователь пишет "кола" или "колу" - найди товары с "кола", "Coca-Cola", "Coca Cola", "Pepsi" в названии/бренде. Это напитки, НЕ цветы
5. Если пользователь пишет "кока кола" - найди товары с "Coca-Cola", "Coca Cola", "кока-кола" в названии/бренде
6. Если пользователь пишет "роза" - ищи товары с названием "роза", "розы", "розовый" в любом поле (название, описание, бренд). Это цветы, НЕ напитки
7. Если пользователь пишет "кроссовки" - ищи обувь, спортивную обувь, кеды
8. Если пользователь пишет "шампунь" - ищи средства для волос
9. НЕ ограничивайся только напитками - каталог содержит товары из ВСЕХ категорий
10. Понимай синонимы: "цветок" = "роза" = "тюльпан" = "букет" = "цветы", "обувь" = "кроссовки" = "ботинки" = "туфли", "напиток" = "газировка" = "лимонад" = "сок"
11. БУДЬ СТРОГИМ К КАТЕГОРИЯМ: если запрос про цветы - возвращай ТОЛЬКО цветы, если про напитки - ТОЛЬКО напитки
12. ПЕРЕД ВОЗВРАТОМ ТОВАРА проверь: соответствует ли он категории запроса? Если нет - НЕ возвращай его

ОБЩИЕ ПРАВИЛА ПОИСКА:
1. Учитывай синонимы и варианты написания
2. Учитывай транслитерацию (например: "cola" = "кола" = "колу" = "колы")
3. Учитывай СКЛОНЕНИЯ русских слов: "роза" = "розу" = "розы" = "розой"
4. Ищи по смыслу: если пользователь ищет "красная роза", найди товары где есть "роза" И "красный/красная"
5. Учитывай сокращения и аббревиатуры
6. Ищи по ВСЕМ полям товара: название, бренд, описание, упаковка, SKU
7. Если запрос короткий (1-2 слова), ищи частичные совпадения в любом поле товара
8. Будь УНИВЕРСАЛЬНЫМ - это может быть ЛЮБАЯ категория товаров

ПРИМЕРЫ ПРАВИЛЬНОГО ПОИСКА:
- Запрос "цветы" → найди ВСЕ товары, которые являются цветами (роза, тюльпан, лилия, букет и т.д.)
- Запрос "роза" → найди товары с "роза", "розы", "розовый" в названии/описании/бренде
- Запрос "колу" или "кола" → найди напитки с "кола", "Coca-Cola", "Coca Cola", "Pepsi", "Пепси" в названии/бренде
- Запрос "кока кола" → найди товары с "Coca-Cola", "Coca Cola", "кока-кола" в названии/бренде
- Запрос "газировка" → найди ВСЕ газированные напитки (Coca-Cola, Pepsi, Fanta, Sprite и т.д.)
- Запрос "напитки" → найди ВСЕ напитки из каталога
- Запрос "кроссовки Nike" → найди обувь бренда Nike
- Запрос "шампунь для волос" → найди средства для волос
- Запрос "молоко" → найди молочные продукты
- Запрос "что из напитков есть?" или "а что из напитков есть?" → найди ВСЕ напитки из каталога (Coca-Cola, Pepsi, Fanta, Sprite и т.д.)
- Запрос "что из цветов есть?" → найди ВСЕ цветы из каталога

КРИТИЧЕСКИ ВАЖНО - СТРОГАЯ РЕЛЕВАНТНОСТЬ К КАТЕГОРИЯМ:
- Если запрос это название категории ("цветы", "напитки", "газировка") - найди ВСЕ товары из этой категории
- Если запрос "цветы" - найди ТОЛЬКО цветы (роза, тюльпан, лилия). НЕ возвращай напитки, продукты и т.д.
- Если запрос "напитки" или "газировка" - найди ТОЛЬКО напитки. НЕ возвращай цветы, продукты и т.д.
- Если запрос это конкретный товар ("кола", "роза") - найди именно этот товар
- Ищи по ВСЕМ полям товара: название, описание, бренд, SKU
- Будь СТРОГИМ к категориям - если товар явно не из нужной категории, НЕ возвращай его

ЗАПРЕЩЕНО (КРИТИЧЕСКИ ВАЖНО):
- НЕ возвращай напитки (Coca-Cola, Pepsi, Fanta, Sprite), если запрос "цветы", "букет", "роза", "тюльпан"
- НЕ возвращай цветы (роза, тюльпан, лилия), если запрос "напитки", "газировка", "кола", "колу"
- НЕ возвращай товары из неправильной категории
- НЕ возвращай товары, которые явно не соответствуют запросу по категории

ПРИМЕРЫ НЕПРАВИЛЬНОГО ПОВЕДЕНИЯ (НЕ ДЕЛАЙ ТАК):
- Запрос "цветы" → НЕПРАВИЛЬНО: вернуть "Coca-Cola Vanilla" (это напиток, не цветок)
- Запрос "цветы" → НЕПРАВИЛЬНО: вернуть "Coca Cola в железной банке" (это напиток, не цветок)
- Запрос "напитки" → НЕПРАВИЛЬНО: вернуть "Роза красная" (это цветок, не напиток)

ПРИМЕРЫ ПРАВИЛЬНОГО ПОВЕДЕНИЯ (ДЕЛАЙ ТАК):
- Запрос "цветы" → ПРАВИЛЬНО: вернуть только товары с "роза", "тюльпан", "лилия" в названии
- Запрос "напитки" → ПРАВИЛЬНО: вернуть только товары с "cola", "pepsi", "fanta" в названии

ВАЖНО:
- Ищи по СМЫСЛУ запроса, но будь СТРОГИМ к категориям
- Анализируй структуру запроса: категория + бренд + характеристики + упаковка
- Если запрос содержит несколько параметров, ищи товары, соответствующие ВСЕМ параметрам
- Будь гибким к склонениям и синонимам, но СТРОГИМ к категориям
- ВЕРНИ ТОЛЬКО РЕЛЕВАНТНЫЕ товары из ПРАВИЛЬНОЙ категории (до 30 самых подходящих)

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "matchedProductIds": ["id1", "id2", "id3"],
  "reasoning": "краткое объяснение почему эти товары подходят"
}

ВЕРНИ ТОЛЬКО JSON!`;

  try {
    const response = await requestGemini(prompt, { maxOutputTokens: 2000, timeout: 15000 });
    const parsed = extractJson(response);

    if (!parsed || !Array.isArray(parsed.matchedProductIds)) {
      console.error('Некорректный ответ от AI для семантического поиска:', response);
      return [];
    }

    const matchedIds = new Set(parsed.matchedProductIds);

    // Логируем для отладки
    console.log(`AI вернул ${matchedIds.size} ID товаров для запроса "${searchQuery}"`);
    if (matchedIds.size > 0) {
      const sampleIds = Array.from(matchedIds).slice(0, 3);
      console.log(`Примеры ID от AI:`, sampleIds);
    }

    const matchedProducts = allProducts.filter(p => matchedIds.has(p.id));

    // Дополнительная проверка: если товары не найдены, проверяем формат ID
    if (matchedProducts.length === 0 && matchedIds.size > 0) {
      console.warn(`ВНИМАНИЕ: AI вернул ${matchedIds.size} ID, но товары не найдены в allProducts (${allProducts.length} товаров)`);
      const firstAiId = Array.from(matchedIds)[0];
      const firstProductId = allProducts[0]?.id;
      console.log(`Пример ID от AI: "${firstAiId}" (тип: ${typeof firstAiId})`);
      console.log(`Пример ID из БД: "${firstProductId}" (тип: ${typeof firstProductId})`);
      console.log(`Совпадение: ${firstAiId === firstProductId}`);
    }

    console.log(`Семантический поиск: найдено ${matchedProducts.length} товаров из ${allProducts.length} для запроса "${searchQuery}"`);
    if (parsed.reasoning) {
      console.log('Обоснование AI:', parsed.reasoning);
    }

    return matchedProducts.slice(0, limit);
  } catch (error) {
    console.error('Ошибка семантического поиска через AI:', error.message);
    return [];
  }
}

// ============================================================================
// WAPPI ЧАТ: ПОЛНЫЙ ОТВЕТ ОТ AI (ТЕКСТ + СПИСОК ТОВАРОВ)
// ============================================================================

async function getWappiChatAIResponse({ message, products, conversationContext = [] }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    return {
      replyText: 'Напишите, какой товар вы ищете. Например: "Кола", "цветы", "кроссовки Nike".',
      matchedProductIds: [],
      reasoning: 'EMPTY_MESSAGE'
    };
  }

  if (!Array.isArray(products) || products.length === 0) {
    return {
      replyText: 'Сейчас в каталоге нет доступных товаров для поиска.',
      matchedProductIds: [],
      reasoning: 'NO_PRODUCTS'
    };
  }

  // Ограничиваем количество товаров для анализа (чтобы не раздувать промпт)
  const productsForAI = products.slice(0, 300).map(p => ({
    id: p.id,
    name: p.name || '',
    brandName: p.brandName || '',
    categoryName: p.categoryName || '',
    description: p.description || '',
    packageInfo: p.packageInfo || '',
    sku: p.sku || ''
  }));

  let contextText = '';
  if (conversationContext && conversationContext.length > 0) {
    contextText = `\n\nПРЕДЫДУЩИЙ ДИАЛОГ (от старых к новым, с пометкой кто говорит):\n${conversationContext.slice(-12).join('\n')}\n`;
  }

  const prompt = `Ты — AI-помощник интернет-магазина с МНОГОКАТЕГОРИЙНЫМ каталогом товаров.
Твоя задача: по сообщению пользователя выбрать РЕЛЕВАНТНЫЕ товары из переданного списка и сформировать ОДИН текст ответа для WhatsApp.

ВХОДНЫЕ ДАННЫЕ:
- Сообщение пользователя: "${message.trim()}"
${contextText ? contextText : ''}
- Доступные товары (array JSON, поле categoryName может быть пустым):
${JSON.stringify(productsForAI, null, 2)}

ОЧЕНЬ ВАЖНО:
1. Работай ТОЛЬКО с переданным списком товаров. Никаких выдуманных товаров, брендов или категорий.
2. Понимай как КОНКРЕТНЫЕ товары ("Coca-Cola 0.5", "роза красная"), так и ОБЩИЕ категории ("цветы", "напитки", "кроссовки", "сладости").
3. Если сообщение — про КАТЕГОРИЮ (например: "цветы", "напитки", "кроссовки", "мороженое"), найди ВСЕ подходящие товары этой категории и:
   - Сформируй список вариантов (до 10 шт)
   - В тексте ответа явно предложи выбор: спроси, какой вариант интересует, но уже ПОКАЗАВ список.
4. Если сообщение — про КОНКРЕТНЫЙ товар, выбери самые релевантные товары (1–5 шт) и опиши их.
5. Для определения категории используй:
   - categoryName
   - name
   - description
   - brandName
6. Категории могут быть ЛЮБЫМИ (цветы, напитки, бытовая химия, косметика, одежда, обувь, техника и т.д.). Не ограничивайся заранее заданным списком.
7. Не возвращай товары, которые ЯВНО не соответствуют запросу по смыслу.
8. ВНИМАТЕЛЬНО используй историю диалога выше: ты видишь и сообщения ПОЛЬЗОВАТЕЛЯ, и ответы СИСТЕМЫ.
9. Если ранее СИСТЕМА задала уточняющий вопрос про выбор товара, а сейчас ПОЛЬЗОВАТЕЛЬ отвечает кратко ("да", "беру", "подтверждаю", "хочу этот", "его", "ванила" и т.п.), считай что он ПОДТВЕРЖДАЕТ выбор.
10. При подтверждении выбора дай КОРОТКИЙ ФИНАЛЬНЫЙ ответ без новых вопросов (например: "Вы выбрали Coca-Cola Vanilla. Покажите это сообщение продавцу для оформления заказа."), не начинай новый цикл уточнений.

ОГРАНИЧЕНИЯ (ОТВЕЧАЙ ТОЛЬКО ПО ДЕЛУ):
- ТЫ ОТВЕЧАЕШЬ ТОЛЬКО ПО ТОВАРАМ И ПОИСКУ ТОВАРОВ.
- Если пользователь спрашивает о тебе самом, о разработчиках, о том, на чём ты написан, какая ты модель ИИ и т.п. — НЕ раскрывай эти данные.
- В таких случаях дай ОДИН короткий ответ вида: "Я могу помочь только с выбором товаров в этом магазине. Напишите, что вы хотите найти."
- Не веди светские беседы ("как дела", "кто твой разработчик", "какая ты модель"), всегда мягко своди разговор к поиску товара.

ПРИМЕРЫ ПОВЕДЕНИЯ:
- Запрос "цветы" → выбери товары, которые по смыслу являются цветами (роза, тюльпан, букет и т.п.) и предложи список СТРОГО в формате:
  "Нашёл такие цветы:\n1. Роза\n2. Тюльпан\nКакой именно вас интересует?"
- Запрос "напитки" → выбери напитки (cola, pepsi, соки и т.п.) и предложи список в формате:
  "У нас есть такие напитки:\n1. Coca-Cola\n2. Pepsi\nКакой именно вас интересует?"
- Запрос "роза" → выбери товары про розы и покажи их.
- Запрос "что из [категории] есть?" → веди себя как для запроса категории: покажи варианты из этой категории по одному на строку.

ФОРМАТ ВЫВОДА (СТРОГО JSON):
{
  "replyText": "строка — готовый текст сообщения для пользователя на русском, без Markdown и кавычек вокруг",
  "matchedProductIds": ["id1", "id2"],
  "reasoning": "кратко, почему выбраны именно эти товары",
  "matchedProductsPreview": [
    {
      "id": "id1",
      "name": "имя товара",
      "brandName": "бренд",
      "categoryName": "категория (если есть)"
    }
  ]
}

Требования:
- Всегда возвращай валидный JSON в указанном формате.
- Если подходящих товаров нет, сделай replyText в духе: "Я не нашёл товары по запросу \\"...\\". Попробуйте описать товар по-другому." и верни пустые matchedProductIds.
- Не добавляй никакого текста ВНЕ JSON.`;

  try {
    const response = await requestGemini(prompt, {
      maxOutputTokens: 800,
      temperature: 0.3,
      timeout: 20000
    });

    const parsed = extractJson(response);

    if (!parsed || typeof parsed.replyText !== 'string') {
      console.error('Некорректный ответ от AI для WAPPI-чата:', response);
      return {
        replyText: 'Не удалось обработать запрос. Попробуйте описать товар по-другому.',
        matchedProductIds: [],
        reasoning: 'INVALID_AI_RESPONSE',
        rawResponse: response
      };
    }

    if (!Array.isArray(parsed.matchedProductIds)) {
      parsed.matchedProductIds = [];
    }
    if (!Array.isArray(parsed.matchedProductsPreview)) {
      parsed.matchedProductsPreview = [];
    }

    return parsed;
  } catch (error) {
    console.error('Ошибка WAPPI-чата через AI:', error);
    return {
      replyText: 'Произошла ошибка при обработке запроса. Попробуйте позже.',
      matchedProductIds: [],
      reasoning: 'ERROR',
      error: error.message
    };
  }
}

// ============================================================================
// УНИВЕРСАЛЬНОЕ ОПРЕДЕЛЕНИЕ ТИПОВ ТОВАРОВ ЧЕРЕЗ AI
// ============================================================================

async function extractProductTypesWithAI(candidates) {
  if (!candidates || candidates.length === 0) {
    return { types: new Set(), packageTypes: new Set() };
  }

  // Ограничиваем количество товаров для анализа
  const productsForAnalysis = candidates.slice(0, 50).map(p => ({
    name: p.name || '',
    brandName: p.brandName || '',
    description: p.description || '',
    packageInfo: p.packageInfo || ''
  }));

  const prompt = `Ты эксперт по анализу товаров в УНИВЕРСАЛЬНОМ МНОГОКАТЕГОРИЙНОМ каталоге. Проанализируй список товаров и определи их категорию, варианты/типы и упаковку.

ДОСТУПНЫЕ ТОВАРЫ:
${JSON.stringify(productsForAnalysis, null, 2)}

ЗАДАЧА:
1. СНАЧАЛА определи КАТЕГОРИЮ товаров (напитки, цветы, продукты питания, косметика, одежда, обувь и т.д.)
2. Определи ВСЕ варианты/типы товаров в зависимости от категории:
   - Для напитков: Classic, Zero, Light, Vanilla, Cherry и т.д.
   - Для цветов: названия цветов (роза, тюльпан, лилия и т.д.), цвета (красная, белая, желтая)
   - Для продуктов: вкусы, типы, характеристики
   - Для одежды/обуви: размеры, цвета, модели
   - Для других категорий: соответствующие характеристики
3. Определи типы упаковки/тары (Стекло, Металл, Пластик и т.д.) - ТОЛЬКО если это применимо к категории

ПРАВИЛА:
- Анализируй названия, описания и другие поля товаров
- Ищи различия между товарами одного бренда
- Определяй варианты по вкусам, типам, характеристикам, цветам, размерам в зависимости от категории
- Для упаковки определяй материал (стекло, металл, пластик) - ТОЛЬКО если это релевантно
- Будь универсальным - это может быть ЛЮБАЯ категория товаров
- Если товары - цветы, то types должны быть названия цветов или цвета, а НЕ типы напитков
- Если товары - одежда, то types должны быть размеры или цвета, а НЕ типы напитков

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "category": "название категории (напитки, цветы, продукты, косметика и т.д.)",
  "types": ["Type1", "Type2", "Type3"],
  "packageTypes": ["Стекло", "Металл", "Пластик"] // или пустой массив, если не применимо
}

ПРИМЕРЫ:
Товары: [{"name": "Роза", "brandName": "Coca-Cola"}, {"name": "Тюльпан", "brandName": "Coca-Cola"}]
Ответ: {"category": "цветы", "types": ["Роза", "Тюльпан"], "packageTypes": []}

Товары: [{"name": "Coca-Cola Classic", "brandName": "Coca-Cola"}, {"name": "Coca-Cola Zero", "brandName": "Coca-Cola"}]
Ответ: {"category": "напитки", "types": ["Classic", "Zero"], "packageTypes": []}

ВЕРНИ ТОЛЬКО JSON!`;

  try {
    const response = await requestGemini(prompt, { maxOutputTokens: 1000, timeout: 10000 });
    const parsed = extractJson(response);

    if (!parsed || !parsed.types) {
      console.warn('AI не смог определить типы товаров, используем fallback');
      // Fallback на простой анализ
      return extractProductTypesFallback(candidates);
    }

    const category = parsed.category || 'неизвестно';
    const types = new Set(parsed.types || []);
    const packageTypes = new Set(parsed.packageTypes || []);

    console.log(`AI определил категорию: ${category}`);
    console.log(`AI определил типы товаров: ${[...types].join(', ')}`);
    console.log(`AI определил типы упаковки: ${[...packageTypes].join(', ')}`);

    return { category, types, packageTypes };
  } catch (error) {
    console.error('Ошибка при определении типов через AI:', error.message);
    // Fallback на простой анализ
    return extractProductTypesFallback(candidates);
  }
}

// Fallback функция для определения типов (простой анализ по ключевым словам)
function extractProductTypesFallback(candidates) {
  const types = new Set();
  const packageTypes = new Set();
  let category = 'неизвестно';

  // Определяем категорию по ключевым словам
  const allText = candidates.map(p => `${p.name || ''} ${p.description || ''}`.toLowerCase()).join(' ');

  if (allText.includes('роза') || allText.includes('тюльпан') || allText.includes('лилия') || allText.includes('цветок') || allText.includes('букет')) {
    category = 'цветы';
    // Для цветов добавляем названия цветов как типы
    candidates.forEach(p => {
      const name = (p.name || '').toLowerCase();
      if (name.includes('роза')) types.add('Роза');
      if (name.includes('тюльпан')) types.add('Тюльпан');
      if (name.includes('лилия')) types.add('Лилия');
    });
  } else if (allText.includes('напиток') || allText.includes('cola') || allText.includes('пепси') || allText.includes('лимонад')) {
    category = 'напитки';
    // Определяем типы напитков
    candidates.forEach(p => {
      const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
      if (text.includes('zero') || text.includes('ноль')) types.add('Zero');
      if (text.includes('light') || text.includes('лайт')) types.add('Light');
      if (text.includes('vanilla') || text.includes('ванил')) types.add('Vanilla');
      if (text.includes('cherry') || text.includes('вишн')) types.add('Cherry');
      if (text.includes('classic') || text.includes('классическая')) types.add('Classic');
    });
  } else {
    category = 'другое';
  }

  // Определяем тип упаковки (только для релевантных категорий)
  candidates.forEach(p => {
    const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
    if (text.includes('стекл') || text.includes('glass')) packageTypes.add('Стекло');
    if (text.includes('банка') || text.includes('can') || text.includes('жест') || text.includes('металл') || text.includes('жб')) packageTypes.add('Металл');
    if (text.includes('пласти') || text.includes('pet')) packageTypes.add('Пластик');
  });

  return { category, types, packageTypes };
}

// ============================================================================
// ИЗВЛЕЧЕНИЕ НАМЕРЕНИЙ
// ============================================================================

async function getIntentFromGemini({ message, candidates, known, conversationContext = null }) {
  const uniqueBrands = [...new Set(candidates.map(c => c.brandName).filter(Boolean))];
  const uniquePackages = [...new Set(candidates.map(c => c.packageInfo).filter(Boolean))];

  const productsList = candidates.slice(0, 30).map(p => ({
    name: p.name,
    brand: p.brandName,
    package: p.packageInfo
  }));

  // Формируем контекст разговора
  let contextText = '';
  if (conversationContext && conversationContext.length > 0) {
    contextText = `\n\nКОНТЕКСТ РАЗГОВОРА (предыдущие сообщения пользователя):\n${conversationContext.slice(-5).join('\n')}\n\nВАЖНО: Учитывай контекст! Если пользователь спрашивает "что из напитков есть?" - это запрос на поиск ВСЕХ напитков. Если потом пишет "кола" или "колу" - это уточнение поиска конкретного бренда.`;
  }

  const prompt = `Ты эксперт по извлечению параметров поиска товаров из сообщений пользователей в УНИВЕРСАЛЬНОМ МНОГОКАТЕГОРИЙНОМ каталоге. Каталог содержит товары из РАЗНЫХ категорий: напитки, продукты питания, товары для дома, косметика, одежда, обувь, цветы, подарки и т.д.

Извлеки параметры из сообщения пользователя.

ДОСТУПНЫЕ ТОВАРЫ (примеры из разных категорий):
${JSON.stringify(productsList.slice(0, 10), null, 2)}

ДОСТУПНЫЕ БРЕНДЫ:
${uniqueBrands.join(', ')}

ДОСТУПНЫЕ УПАКОВКИ:
${uniquePackages.join(', ')}

УЖЕ ИЗВЕСТНО ИЗ ПРЕДЫДУЩИХ СООБЩЕНИЙ:
${JSON.stringify(known, null, 2)}

НОВОЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
"${message}"${contextText}

ОБЩИЕ ПРАВИЛА РАСПОЗНАВАНИЯ (УНИВЕРСАЛЬНЫЕ ДЛЯ ВСЕХ КАТЕГОРИЙ):
1. БРЕНДЫ: Определяй бренды из доступных брендов. Учитывай синонимы и транслитерацию (например: "кола"/"cola"/"coca cola" → "Coca-Cola", "nike" → "Nike")
2. ОБЪЕМ/РАЗМЕР: Распознавай объемы и размеры (например: "0.5"/"поллитра"/"500мл" → "0.5л", "1"/"литр"/"1л" → "1л", "42 размер" → размер для одежды/обуви)
3. ТИП ТОВАРА: Распознавай варианты товара (например: "zero"/"ноль"/"без сахара" → "zero", "light"/"лайт" → "light", "classic"/"классическая" → "classic", "красная роза" → type может быть "красная")
4. ТИП УПАКОВКИ: 
   - "стекло"/"стеклянн"/"бутылка" → packageType: "glass"
   - "банка"/"железо"/"жестян"/"металл"/"ЖБ" → packageType: "can"
   - "пласти"/"pet" → packageType: "plastic"
5. Учитывай сокращения: "ЖБ" = "жестяная банка" = "can"
6. КАТЕГОРИИ: Понимай контекст - "роза" это цветок, "кроссовки" это обувь, "шампунь" это косметика
7. ЦВЕТА: Распознавай цвета в запросах ("красная", "белая", "черная" и т.д.)

ВАЖНО: 
- ОБЪЕДИНИ уже известные данные (known) с новыми данными из сообщения
- Если в known уже есть brand, но пользователь уточняет type - СОХРАНИ brand!
- Возвращай ВСЕ накопленные данные, не теряй то, что уже известно
- Анализируй сообщение целиком: может содержать несколько параметров одновременно
- Сопоставляй упоминания брендов с доступными брендами из списка
- Будь УНИВЕРСАЛЬНЫМ - это может быть ЛЮБАЯ категория товаров, не только напитки

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "action": "READY_TO_SEARCH",
  "intent": {
    "brand": "известный бренд ИЛИ новый из сообщения (из доступных брендов)",
    "packageInfo": "известная упаковка ИЛИ новая из сообщения",
    "type": "известный тип ИЛИ новый из сообщения",
    "packageType": "известный packageType ИЛИ новый из сообщения"
  }
}

ПРИМЕРЫ:
Known: {"brand":"Coca-Cola","packageInfo":null,"type":null}
Сообщение: "0.5"
Ответ: {"action":"READY_TO_SEARCH","intent":{"brand":"Coca-Cola","packageInfo":"0.5л","type":null,"packageType":null}}

Known: {brand: null, packageInfo: null, type: null, packageType: null}
Сообщение: "мне нужна банка колы"
Ответ: {"action":"READY_TO_SEARCH","intent":{"brand":"Coca-Cola","packageInfo":null,"type":null,"packageType":"can"}}

Known: {brand: null, packageInfo: null, type: null, packageType: null}
Сообщение: "красная роза"
Ответ: {"action":"READY_TO_SEARCH","intent":{"brand":null,"packageInfo":null,"type":"красная","packageType":null}}

ВЕРНИ ТОЛЬКО JSON!`;

  try {
    const response = await requestGemini(prompt, { maxOutputTokens: 200 });
    const parsed = extractJson(response);

    if (!parsed || !parsed.action) {
      console.error('Некорректный JSON от Gemini:', response);
      return {
        action: 'READY_TO_SEARCH',
        intent: {
          brand: known.brand || null,
          packageInfo: known.packageInfo || null,
          type: known.type || null,
          packageType: known.packageType || null
        }
      };
    }

    // Гарантируем, что не теряем уже известные данные
    const mergedIntent = {
      brand: parsed.intent.brand || known.brand || null,
      packageInfo: parsed.intent.packageInfo || known.packageInfo || null,
      type: parsed.intent.type || known.type || null,
      packageType: parsed.intent.packageType || known.packageType || null
    };

    console.log('Intent извлечен:', { message, known, extracted: parsed.intent, merged: mergedIntent });

    return {
      action: 'READY_TO_SEARCH',
      intent: mergedIntent
    };
  } catch (error) {
    console.error('Ошибка Gemini getIntent:', error.message);
    return {
      action: 'READY_TO_SEARCH',
      intent: {
        brand: known.brand || null,
        packageInfo: known.packageInfo || null,
        type: known.type || null,
        packageType: known.packageType || null
      }
    };
  }
}

// ============================================================================
// ГЕНЕРАЦИЯ ВОПРОСОВ (АКИНАТОР С ПРИОРИТЕТАМИ)
// ============================================================================

async function generateClarificationQuestions({ candidates, known, previousQuestions = [] }) {
  if (!candidates || candidates.length === 0) {
    console.log('❌ Нет кандидатов для вопросов');
    return { questions: [], quickReplies: [] };
  }

  // Если остался 1 товар - не задаем вопросы
  if (candidates.length === 1) {
    console.log('✅ Остался 1 товар, вопросы не нужны');
    return { questions: [], quickReplies: [] };
  }

  // Собираем статистику
  const brands = [...new Set(candidates.map(c => c.brandName).filter(Boolean))];
  const packages = [...new Set(candidates.map(c => c.packageInfo).filter(Boolean))];

  // Используем AI для универсального определения типов/вариантов товаров
  const { category, types, packageTypes } = await extractProductTypesWithAI(candidates);

  console.log('=== ГЕНЕРАЦИЯ ВОПРОСОВ ===');
  console.log('Всего товаров:', candidates.length);
  if (candidates.length > 0) {
    console.log('Найденные товары:');
    candidates.forEach((product, index) => {
      console.log(`  ${index + 1}. "${product.name || 'без названия'}" (бренд: ${product.brandName || 'нет'}, ID: ${product.id})`);
    });
  }
  console.log('Известно:', known);
  console.log('Бренды (' + brands.length + '):', brands);
  console.log('Упаковки (' + packages.length + '):', packages);
  console.log('Типы (' + types.size + '):', [...types]);
  console.log('Тара (' + packageTypes.size + '):', [...packageTypes]);
  console.log('Предыдущие вопросы:', previousQuestions);

  // Функция для проверки, был ли уже задан вопрос определенного типа
  const wasQuestionAsked = (keywords) => {
    return previousQuestions.some(q => {
      const qLower = q.toLowerCase();
      return keywords.some(keyword => qLower.includes(keyword));
    });
  };

  // ПРИОРИТЕТ 1: Если не известна упаковка (объем) и есть варианты (только для релевантных категорий)
  // Объем важен для напитков, продуктов, но не для цветов, одежды и т.д.
  if (!known.packageInfo && packages.length > 1) {
    // Задаем вопрос про объем только для категорий, где это релевантно
    const volumeRelevantCategories = ['напитки', 'продукты', 'неизвестно'];
    if (volumeRelevantCategories.includes(category) && !wasQuestionAsked(['объем', 'литр', 'размер', 'сколько'])) {
      console.log('→ Задаем вопрос про ОБЪЕМ');
      return {
        questions: ['Какой объем вам нужен?'],
        quickReplies: packages.slice(0, 6)
      };
    }
  }

  // ПРИОРИТЕТ 2: Если не известен тип товара и есть варианты (универсальный вопрос)
  if (!known.type && types.size > 1) {
    if (!wasQuestionAsked(['тип', 'zero', 'сахар', 'классическая', 'light', 'лайт', 'какой', 'какая', 'цветок', 'цвет'])) {
      console.log('→ Задаем вопрос про ТИП');

      // Формируем вопрос в зависимости от категории
      let questionText = 'Какой вариант вас интересует?';
      if (category === 'цветы') {
        questionText = 'Какой цветок вы хотите?';
      } else if (category === 'напитки') {
        questionText = `Какого типа ${known.brand || 'напиток'} вы хотите?`;
      } else if (category === 'одежда' || category === 'обувь') {
        questionText = 'Какой размер вас интересует?';
      } else {
        questionText = 'Какой вариант вас интересует?';
      }

      return {
        questions: [questionText],
        quickReplies: [...types].slice(0, 6)
      };
    }
  }

  // ПРИОРИТЕТ 3: Если не известен тип упаковки (стекло/металл) и есть варианты
  // ВАЖНО: Не задаем вопрос, если packageType уже известен (пользователь уже ответил)
  // Тара релевантна только для напитков и продуктов, не для цветов, одежды и т.д.
  if (!known.packageType && packageTypes.size > 1) {
    const taraRelevantCategories = ['напитки', 'продукты', 'неизвестно'];
    if (taraRelevantCategories.includes(category)) {
      // Проверяем, был ли уже задан вопрос о таре
      const taraQuestionAsked = wasQuestionAsked(['тара', 'стекло', 'банка', 'металл', 'железная', 'упаковка']);

      if (!taraQuestionAsked) {
        console.log('→ Задаем вопрос про ТАРУ');
        return {
          questions: ['В какой таре вам нужен товар?'],
          quickReplies: [...packageTypes].slice(0, 6)
        };
      } else {
        // Если вопрос уже был задан, но packageType все еще не известен,
        // значит пользователь еще не ответил или ответ не был распознан
        // В этом случае не задаем вопрос повторно, чтобы избежать зацикливания
        console.log('→ Вопрос про ТАРУ уже был задан, но packageType не известен. Пропускаем.');
      }
    }
  }

  // ПРИОРИТЕТ 4: Если не известен бренд и есть варианты
  if (!known.brand && brands.length > 1) {
    if (!wasQuestionAsked(['бренд', 'марк', 'какой', 'какая'])) {
      console.log('→ Задаем вопрос про БРЕНД');
      return {
        questions: ['Какой бренд вас интересует?'],
        quickReplies: brands.slice(0, 6)
      };
    }
  }

  // Если все вопросы уже заданы, но осталось 2-5 товаров - показываем их
  if (candidates.length <= 5) {
    console.log('→ Показываем список из', candidates.length, 'товаров');
    return {
      questions: ['Выберите товар:'],
      quickReplies: candidates.slice(0, 5).map(c =>
        `${c.brandName || ''} ${c.packageInfo || ''} ${c.name || ''}`.trim().slice(0, 50)
      )
    };
  }

  // Если товаров слишком много и вопросы закончились - просим уточнить
  console.log('⚠️ Не смогли сузить выбор, товаров:', candidates.length);
  console.log('⚠️ Все вопросы уже заданы, но товаров всё ещё много');

  return {
    questions: ['Уточните название или характеристики товара'],
    quickReplies: []
  };
}

// ============================================================================
// АНАЛИЗ ИЗОБРАЖЕНИЯ ТОВАРА
// ============================================================================

async function analyzeProductImage({ buffer, mimeType }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }
  if (!buffer || !mimeType) {
    throw new Error('Нет данных для анализа изображения');
  }

  const prompt = `Ты эксперт по распознаванию товаров на изображениях. Проанализируй это изображение и извлеки информацию о товаре.

ОПИШИ ТОВАР:
- Название товара (если видно на упаковке/этикетке)
- Бренд (Coca-Cola, Pepsi, Fanta, Sprite и т.д.)
- Тип упаковки (стеклянная бутылка, пластиковая бутылка, банка)
- Объем/размер упаковки (0.5л, 1л, 2л и т.д.)
- Тип напитка (Classic, Zero, Light, если применимо)
- Любые другие характеристики, которые видишь

ВАЖНО:
- Будь точным в распознавании брендов и названий
- Если видишь текст на упаковке - используй его
- Если не уверен в чем-то - укажи null

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "productName": "название товара или null",
  "brand": "бренд или null",
  "packageType": "glass/can/plastic или null",
  "packageInfo": "объем/размер или null",
  "type": "classic/zero/light или null",
  "description": "краткое описание того, что видно на изображении"
}

ВЕРНИ ТОЛЬКО JSON!`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: buffer.toString('base64')
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 500
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/${GEMINI_API_VERSION}/models/${GEMINI_MODEL_FLASH}:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 15000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Пустой ответ от Gemini'));
          }

          const extracted = extractJson(text);
          if (!extracted) {
            return reject(new Error('Не удалось извлечь JSON из ответа Gemini'));
          }

          resolve(extracted);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// ТРАНСКРИПЦИЯ АУДИО
// ============================================================================

async function transcribeAudio({ buffer, mimeType }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }
  if (!buffer || !mimeType) {
    throw new Error('Нет данных для транскрипции');
  }

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: 'Сделай транскрипцию этого аудио. Верни ТОЛЬКО текст, без пояснений.' },
        {
          inline_data: {
            mime_type: mimeType,
            data: buffer.toString('base64')
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 500
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 15000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Пустая транскрипция'));
          }
          resolve(text.trim());
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// АНАЛИЗ НАКЛАДНОЙ (ИЗВЛЕЧЕНИЕ ТОВАРОВ)
// ============================================================================

async function analyzeInvoice({ buffer, mimeType }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }
  if (!buffer || !mimeType) {
    throw new Error('Нет данных для анализа накладной');
  }

  const prompt = `Ты — специализированный OCR-агент. Твоя задача: извлечь данные из накладной и вернуть СТРОГО валидный JSON-объект.

ПРАВИЛА ОБРАБОТКИ:
1. Найди таблицу товаров. Для каждого товара извлеки: полное название, количество, артикул (SKU), бренд.
2. Конвертация: если указано "10 уп по 6 шт", запиши "quantity": 60 и "unit": "шт". Если количество штук в упаковке неизвестно, оставь количество как есть и укажи "unit": "уп" или "коробка".
3. Поля "invoiceNumber", "date" и "supplier" обязательны в JSON-объекте. Если данные не найдены, запиши null.

СТРУКТУРА JSON:
{
  "items": [
    {
      "productName": string,
      "quantity": number,
      "sku": string|null,
      "brand": string|null,
      "unit": string,
      "notes": string|null
    }
  ],
  "invoiceNumber": string|null,
  "date": string|null,
  "supplier": string|null
}

КРИТИЧЕСКИЕ ТРЕБОВАНИЯ:
- ЗАПРЕЩЕНО добавлять любой текст до или после JSON.
- ЗАПРЕЩЕНО использовать разметку \`\`\`json или любые другие пояснения.
- Ответ ДОЛЖЕН начинаться с символа { и заканчиваться символом }.
- Весь текст внутри JSON (названия товаров, бренды и т.д.) должен быть на языке оригинала из документа.`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: buffer.toString('base64')
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2000,
      responseMimeType: 'application/json'
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/${GEMINI_API_VERSION}/models/${GEMINI_MODEL_FLASH}:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 30000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Пустой ответ от Gemini'));
          }

          const extracted = extractJson(text);
          if (!extracted) {
            return reject(new Error('Не удалось извлечь JSON из ответа Gemini'));
          }

          // Валидация структуры ответа
          if (!extracted.items || !Array.isArray(extracted.items)) {
            return reject(new Error('Некорректная структура ответа: отсутствует массив items'));
          }

          resolve(extracted);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// ИИ-ПОМОЩНИК ДЛЯ ДИСТРИБЬЮТОРОВ
// ============================================================================

const DISTRIBUTOR_AI_PROMPT = `Ты — AI-помощник дистрибьютора в B2B-системе управления продуктами, магазинами и торговыми представителями.

Контекст системы:
- В системе есть роли: Бренд, Дистрибьютор, Торговый представитель, Магазин, Покупатель.
- Ты работаешь ИСКЛЮЧИТЕЛЬНО для роли Дистрибьютора.
- Бренды создают и управляют эталонными карточками товаров (SKU).
- Дистрибьютор формирует свой ассортимент на основе SKU брендов.
- Магазины добавляют товары ТОЛЬКО из ассортимента дистрибьютора.
- Торговые представители (ТП) принадлежат одному дистрибьютору и закрепляются за магазинами.
- ТП не владеют товарами и не являются источником ассортимента.
- Остатки, наличие, сроки годности и аналитика — ключевые данные системы.
- KPI торговых представителей основаны на наличии товара, отсутствии дефицита, актуальности данных и рисках по срокам годности.
- Геолокация магазинов используется для поиска товаров покупателями, но покупатели не являются твоей целевой аудиторией.

Твоя задача:
- Помогать дистрибьютору принимать решения.
- Объяснять данные, аналитику, KPI и процессы системы.
- Давать рекомендации по управлению ассортиментом, магазинами и торговыми представителями.
- Отвечать ТОЛЬКО на вопросы, связанные с данной системой и ролью дистрибьютора.

Ограничения:
- Ты НЕ отвечаешь на вопросы, не связанные с системой (общие знания, программирование, политика, личные вопросы и т.п.).
- Ты НЕ обсуждаешь покупателей, если вопрос не связан с аналитикой дистрибьютора.
- Ты НЕ придумываешь данные, если их нет.
- Если вопрос выходит за рамки системы, ты вежливо отказываешься и объясняешь, что можешь помогать только по вопросам дистрибьютора и данной платформы.

Формат ответов:
- Кратко и по делу.
- Без воды.
- На языке бизнеса и операций.
- Если есть риск или проблема — указывай её прямо.
- Если данных недостаточно — говори об этом явно.

Если пользователь задаёт вопрос, не относящийся к управлению дистрибьютором, ассортиментом, магазинами, торговыми представителями, аналитикой или KPI — ответь отказом в следующем формате:

"Я могу помогать только с вопросами, связанными с управлением дистрибьютором, товарами, магазинами и торговыми представителями в этой системе."

Никогда не выходи за рамки этого контекста.`;

async function getDistributorAIAssistantResponse({ message, context = '' }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Сообщение не может быть пустым');
  }

  const fullPrompt = `${DISTRIBUTOR_AI_PROMPT}

${context ? `КОНТЕКСТ ДИСТРИБЬЮТОРА:\n${context}\n\n` : ''}ВОПРОС ПОЛЬЗОВАТЕЛЯ:
"${message.trim()}"

ОТВЕТЬ НА ВОПРОС ПОЛЬЗОВАТЕЛЯ:`;

  try {
    const response = await requestGemini(fullPrompt, {
      maxOutputTokens: 2000,
      temperature: 0.7,
      timeout: 30000 // 30 секунд для более длинных ответов
    });
    return response.trim();
  } catch (error) {
    console.error('Ошибка при получении ответа от ИИ-помощника:', error);
    throw error;
  }
}

// ============================================================================
// ПРОГНОЗ СПРОСА (AI)
// ============================================================================

async function getDemandForecastFromAI({ prompt, context = '' }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('Промпт не может быть пустым');
  }

  // Добавляем явное указание вернуть только JSON в конце промпта
  const fullPrompt = `${context ? `КОНТЕКСТ:\n${context}\n\n` : ''}${prompt.trim()}\n\nВАЖНО: Верни ТОЛЬКО валидный JSON без дополнительных комментариев, объяснений или форматирования. Начни ответ сразу с символа { и закончи символом }.`;

  try {
    const response = await requestGemini(fullPrompt, {
      maxOutputTokens: 4000, // Увеличенный лимит для прогнозов
      temperature: 0.3, // Низкая температура для более точных прогнозов
      timeout: 60000 // 60 секунд для сложных расчетов
    });

    const trimmedResponse = response.trim();

    // Логируем ответ для отладки (первые 500 символов)
    if (trimmedResponse.length > 0) {
      console.log('Ответ AI (первые 500 символов):', trimmedResponse.substring(0, 500));
    }

    return trimmedResponse;
  } catch (error) {
    console.error('Ошибка при получении прогноза от AI:', error);
    throw error;
  }
}

// ============================================================================
// ВАЛИДАЦИЯ ИЗОБРАЖЕНИЯ ТОВАРА ДЛЯ БРЕНДОВ
// ============================================================================

async function validateProductImage({ buffer, mimeType, productInfo }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }
  if (!buffer || !mimeType) {
    throw new Error('Нет данных для анализа изображения');
  }
  if (!productInfo) {
    throw new Error('Не указана информация о товаре');
  }

  const prompt = `Ты эксперт по валидации изображений товаров для каталога. Проанализируй это изображение и проверь наличие лишних элементов.

ТРЕБОВАНИЯ К ИЗОБРАЖЕНИЮ:
На изображении НЕ должно быть лишних элементов:
- Рамок вокруг товара (черные, белые, цветные границы по краям) - ОПИШИ КОНКРЕТНО: какая рамка, где находится

ВАЖНО:
- Будь не слишком строгим - небольшие тени или простой однотонный фон это нормально
- Основная задача - найти явные проблемы: рамки, другие товары, водяные знаки
- Если товар хорошо виден и нет явных лишних элементов - изображение валидно

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "isValid": true/false,
  "hasExtraElements": true/false,
  "issues": ["список конкретных проблем, если есть"],
  "recommendations": ["рекомендации по улучшению, если есть"]
}

ПРИМЕРЫ ПРОБЛЕМ (будь конкретным, но не слишком строгим):
- "На изображении есть черная рамка шириной около 2-3 пикселей по всему периметру"
- "В правом нижнем углу изображения есть водяной знак с текстом 'Магазин XYZ'"

ВЕРНИ ТОЛЬКО JSON!`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: buffer.toString('base64')
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1000
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/${GEMINI_API_VERSION}/models/${GEMINI_MODEL_FLASH}:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 20000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Пустой ответ от Gemini'));
          }

          const extracted = extractJson(text);
          if (!extracted) {
            return reject(new Error('Не удалось извлечь JSON из ответа Gemini'));
          }

          resolve(extracted);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// FAQ ЧАТ ДЛЯ КЛИЕНТОВ
// ============================================================================

const SYSTEM_FAQ_PROMPT = `Ты — AI-помощник для всех пользователей B2B-системы управления дистрибьюцией товаров.

КОНТЕКСТ СИСТЕМЫ:
Это комплексная платформа для управления цепочкой поставок от брендов до покупателей. В системе есть несколько ролей, каждая со своим функционалом.

РОЛИ И ИХ ФУНКЦИОНАЛ:

1. BRAND (Бренд):
   - Создает и управляет эталонными карточками товаров (SKU)
   - Оплачивает показ товаров в каталоге на выбранный период: 6, 9 или 12 месяцев (оплата происходит на фронтенде, backend активирует товары)
   - Просматривает статистику поиска своих товаров
   - Валидирует изображения товаров перед загрузкой
   - Видит все свои товары (оплаченные и неоплаченные)

2. DISTRIBUTOR (Дистрибьютор):
   - Формирует свой ассортимент на основе SKU брендов
   - Управляет магазинами (добавление, редактирование)
   - Управляет торговыми представителями (назначение, закрепление за магазинами)
   - Просматривает аналитику: остатки по магазинам, оборот (по магазинам/брендам/товарам), KPI торговых представителей
   - Имеет доступ к ИИ-помощнику для принятия решений
   - Устанавливает планы продаж для торговых представителей

3. SALES_REPRESENTATIVE (Торговый представитель):
   - Работает от дистрибьютора
   - Закреплен за определенными магазинами
   - Имеет планы продаж (целевая выручка и количество)
   - KPI основаны на наличии товара, отсутствии дефицита, актуальности данных, рисках по срокам годности

4. STORE (Владелец магазина):
   - Полный доступ к управлению складом (инвентарь, приход/уход товаров)
   - Управление офферами (предложениями товаров в магазине)
   - Просмотр аналитики склада
   - Редактирование данных магазина (название, адрес, описание, фото)

5. STORE_SELLER (Продавец магазина / Кассир):
   - Работа с POS-системой (касса)
   - Создание и управление чеками продаж
   - Добавление товаров в чек по артикулу (SKU)
   - Завершение продаж с автоматическим списанием товаров со склада
   - Просмотр истории продаж и статистики
   - Быстрый приход товаров по штрих-коду (QR-сканер)
   - Поиск товара по штрих-коду

6. CUSTOMER (Клиент / Покупатель):
   - Поиск товаров в магазинах поблизости
   - Текстовый поиск (семантический - понимает запросы по смыслу)
   - Голосовой поиск (отправка голосового сообщения)
   - Поиск по изображению (загрузка фото товара)
   - Поиск с геолокацией (находит магазины рядом)
   - Уточняющие вопросы для сужения поиска (объем, тип, бренд, упаковка)

7. ADMIN (Администратор):
   - Управление системой
   - Одобрение/отклонение заявок брендов

ОБЩИЕ ПРИНЦИПЫ СИСТЕМЫ:
- Бренды создают SKU, дистрибьюторы формируют ассортимент, магазины добавляют товары из ассортимента дистрибьютора
- Торговые представители не владеют товарами и не являются источником ассортимента
- Остатки, наличие, сроки годности и аналитика — ключевые данные системы
- Геолокация магазинов используется для поиска товаров покупателями

ТВОЯ ЗАДАЧА:
- Отвечать на вопросы пользователей о функционале системы в зависимости от их роли
- Объяснять как использовать функции, доступные для конкретной роли
- Помогать разобраться с интерфейсом и процессами
- Отвечать на вопросы о внутренней работе системы (процессы, роли, функционал)
- НЕ раскрывать личные данные конкретных пользователей, магазинов, дистрибьюторов, брендов
- НЕ придумывать конкретные данные (цены, названия, адреса)
- НЕ отвечать на вопросы, не связанные с системой (общие знания, программирование, политика и т.п.)

ОГРАНИЧЕНИЯ:
- Ты НЕ раскрываешь личные данные: имена, email, адреса, телефоны конкретных пользователей/магазинов/дистрибьюторов
- Ты НЕ придумываешь конкретные данные о товарах, магазинах, ценах, если их нет
- Ты НЕ отвечаешь на вопросы, не связанные с системой
- Если вопрос выходит за рамки системы, вежливо отказывайся

ФОРМАТ ОТВЕТОВ:
- Кратко и по делу
- Адаптируй ответ под роль пользователя (если роль указана)
- Объясняй функции и процессы понятным языком
- Приводи примеры использования, если это уместно
- Если данных недостаточно - говори об этом явно

Если пользователь задаёт вопрос, не относящийся к системе — ответь:
"Я могу помогать только с вопросами, связанными с функционалом и использованием этой системы управления дистрибьюцией. Задайте вопрос о функциях, процессах или работе с интерфейсом."

Никогда не выходи за рамки этого контекста.`;

async function getCustomerFAQResponse({ message, userRole = null }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Сообщение не может быть пустым');
  }

  const roleContext = userRole
    ? `\n\nПОЛЬЗОВАТЕЛЬ ЗАДАЕТ ВОПРОС ОТ РОЛИ: ${userRole}\nОтвечай с учетом функционала, доступного для этой роли.`
    : '';

  const fullPrompt = `${SYSTEM_FAQ_PROMPT}${roleContext}

ВОПРОС ПОЛЬЗОВАТЕЛЯ:
"${message.trim()}"

ОТВЕТЬ НА ВОПРОС ПОЛЬЗОВАТЕЛЯ:`;

  try {
    const response = await requestGemini(fullPrompt, {
      maxOutputTokens: 1500,
      temperature: 0.7,
      timeout: 30000
    });
    return response.trim();
  } catch (error) {
    console.error('Ошибка при получении ответа от FAQ чата:', error);
    throw error;
  }
}

// Экспорт всех функций
module.exports = {
  getIntentFromGemini,
  findProductsBySemanticSearch,
  transcribeAudio,
  generateClarificationQuestions,
  analyzeProductImage,
  analyzeInvoice,
  getDistributorAIAssistantResponse,
  getDemandForecastFromAI,
  validateProductImage,
  getCustomerFAQResponse,
  getWappiChatAIResponse
};

// Для совместимости с разными способами импорта
module.exports.getIntentFromGemini = getIntentFromGemini;
module.exports.findProductsBySemanticSearch = findProductsBySemanticSearch;
module.exports.transcribeAudio = transcribeAudio;
module.exports.generateClarificationQuestions = generateClarificationQuestions;
module.exports.analyzeProductImage = analyzeProductImage;
module.exports.analyzeInvoice = analyzeInvoice;
module.exports.getDistributorAIAssistantResponse = getDistributorAIAssistantResponse;
module.exports.getDemandForecastFromAI = getDemandForecastFromAI;
module.exports.validateProductImage = validateProductImage;
module.exports.getCustomerFAQResponse = getCustomerFAQResponse;
module.exports.getWappiChatAIResponse = getWappiChatAIResponse;