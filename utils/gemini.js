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

async function findProductsBySemanticSearch({ searchQuery, allProducts, limit = 30 }) {
  if (!searchQuery || !searchQuery.trim() || !allProducts || allProducts.length === 0) {
    return [];
  }

  // Ограничиваем количество товаров для анализа AI (увеличено до 500 для лучшего покрытия)
  const productsForAI = allProducts.slice(0, 500).map(p => ({
    id: p.id,
    name: p.name || '',
    brandName: p.brandName || '',
    packageInfo: p.packageInfo || '',
    description: p.description || '',
    sku: p.sku || ''
  }));

  const prompt = `Ты эксперт по поиску товаров в универсальном каталоге. Пользователь ищет товар по запросу: "${searchQuery}"

ДОСТУПНЫЕ ТОВАРЫ:
${JSON.stringify(productsForAI, null, 2)}

ЗАДАЧА:
Найди товары, которые соответствуют запросу пользователя по СМЫСЛУ, а не только по точному совпадению слов.

ОБЩИЕ ПРАВИЛА ПОИСКА:
1. Учитывай синонимы и варианты написания (например: "банка" = "жестяная банка" = "металлическая банка" = "железная банка" = "ЖБ")
2. Учитывай транслитерацию (например: "cola" = "кола" = "колу" = "колы", "coca" = "кока" = "коки")
3. Учитывай СКЛОНЕНИЯ русских слов: "кола" = "колу" = "колы" = "колой", "пепси" = "пепси" = "пепси-колы"
4. Ищи по смыслу: если пользователь ищет "банка колы", найди товары где есть соответствующий бренд И тип упаковки "банка"
5. Учитывай сокращения и аббревиатуры (например: "ЖБ" может означать "жестяная банка")
6. Ищи по всем полям товара: название, бренд, описание, упаковка, SKU
7. Если запрос короткий (1-2 слова), ищи частичные совпадения в любом поле товара

ВАЖНО ДЛЯ ЗАПРОСОВ ТИПА "КОЛУ", "КОЛЫ":
- "колу" = это склонение слова "кола" (винительный падеж)
- Ищи товары с "Coca Cola", "Coca-Cola", "Кока-Кола", "Кола" в названии или бренде
- Ищи товары с "Pepsi", "Пепси" если это может быть связано с запросом
- Будь максимально гибким: даже частичное совпадение в бренде или названии - это результат

ВАЖНО:
- Ищи по СМЫСЛУ запроса, а не только по точным словам
- Анализируй структуру запроса: бренд + тип товара + характеристики + упаковка
- Если запрос содержит несколько параметров (например, "банка колы"), ищи товары, соответствующие ВСЕМ параметрам
- Будь гибким: если точного совпадения нет, ищи частичные совпадения по ключевым словам
- ВАЖНО: верни ВСЕ подходящие товары, даже если их много

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

  const prompt = `Ты эксперт по анализу товаров. Проанализируй список товаров и определи их варианты/типы.

ДОСТУПНЫЕ ТОВАРЫ:
${JSON.stringify(productsForAnalysis, null, 2)}

ЗАДАЧА:
1. Определи ВСЕ варианты/типы товаров (например: Classic, Zero, Light, Vanilla, Cherry для напитков; или другие варианты для других категорий товаров)
2. Определи типы упаковки/тары (Стекло, Металл, Пластик и т.д.)

ПРАВИЛА:
- Анализируй названия, описания и другие поля товаров
- Ищи различия между товарами одного бренда
- Определяй варианты по вкусам, типам, характеристикам
- Для упаковки определяй материал (стекло, металл, пластик)
- Будь универсальным - это может быть любая категория товаров, не только напитки

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "types": ["Type1", "Type2", "Type3"],
  "packageTypes": ["Стекло", "Металл", "Пластик"]
}

ВЕРНИ ТОЛЬКО JSON!`;

  try {
    const response = await requestGemini(prompt, { maxOutputTokens: 1000, timeout: 10000 });
    const parsed = extractJson(response);

    if (!parsed || !parsed.types || !parsed.packageTypes) {
      console.warn('AI не смог определить типы товаров, используем fallback');
      // Fallback на простой анализ
      return extractProductTypesFallback(candidates);
    }

    const types = new Set(parsed.types || []);
    const packageTypes = new Set(parsed.packageTypes || []);

    console.log(`AI определил типы товаров: ${[...types].join(', ')}`);
    console.log(`AI определил типы упаковки: ${[...packageTypes].join(', ')}`);

    return { types, packageTypes };
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

  candidates.forEach(p => {
    const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();

    // Определяем типы (универсальные ключевые слова)
    if (text.includes('zero') || text.includes('ноль')) types.add('Zero');
    if (text.includes('light') || text.includes('лайт')) types.add('Light');
    if (text.includes('vanilla') || text.includes('ванил')) types.add('Vanilla');
    if (text.includes('cherry') || text.includes('вишн')) types.add('Cherry');
    if (text.includes('classic') || text.includes('классическая')) types.add('Classic');

    // Определяем тип упаковки
    if (text.includes('стекл') || text.includes('glass')) packageTypes.add('Стекло');
    if (text.includes('банка') || text.includes('can') || text.includes('жест') || text.includes('металл') || text.includes('жб')) packageTypes.add('Металл');
    if (text.includes('пласти') || text.includes('pet')) packageTypes.add('Пластик');
  });

  return { types, packageTypes };
}

// ============================================================================
// ИЗВЛЕЧЕНИЕ НАМЕРЕНИЙ
// ============================================================================

async function getIntentFromGemini({ message, candidates, known }) {
  const uniqueBrands = [...new Set(candidates.map(c => c.brandName).filter(Boolean))];
  const uniquePackages = [...new Set(candidates.map(c => c.packageInfo).filter(Boolean))];

  const productsList = candidates.slice(0, 30).map(p => ({
    name: p.name,
    brand: p.brandName,
    package: p.packageInfo
  }));

  const prompt = `Ты эксперт по извлечению параметров поиска товаров из сообщений пользователей. Извлеки параметры из сообщения пользователя.

ДОСТУПНЫЕ ТОВАРЫ (примеры):
${JSON.stringify(productsList.slice(0, 10), null, 2)}

ДОСТУПНЫЕ БРЕНДЫ:
${uniqueBrands.join(', ')}

ДОСТУПНЫЕ УПАКОВКИ:
${uniquePackages.join(', ')}

УЖЕ ИЗВЕСТНО ИЗ ПРЕДЫДУЩИХ СООБЩЕНИЙ:
${JSON.stringify(known, null, 2)}

НОВОЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
"${message}"

ОБЩИЕ ПРАВИЛА РАСПОЗНАВАНИЯ:
1. БРЕНДЫ: Определяй бренды из доступных брендов. Учитывай синонимы и транслитерацию (например: "кола"/"cola"/"coca cola" → "Coca-Cola")
2. ОБЪЕМ/РАЗМЕР: Распознавай объемы и размеры (например: "0.5"/"поллитра"/"500мл" → "0.5л", "1"/"литр"/"1л" → "1л")
3. ТИП ТОВАРА: Распознавай варианты товара (например: "zero"/"ноль"/"без сахара" → "zero", "light"/"лайт" → "light", "classic"/"классическая" → "classic")
4. ТИП УПАКОВКИ: 
   - "стекло"/"стеклянн"/"бутылка" → packageType: "glass"
   - "банка"/"железо"/"жестян"/"металл"/"ЖБ" → packageType: "can"
   - "пласти"/"pet" → packageType: "plastic"
5. Учитывай сокращения: "ЖБ" = "жестяная банка" = "can"

ВАЖНО: 
- ОБЪЕДИНИ уже известные данные (known) с новыми данными из сообщения
- Если в known уже есть brand, но пользователь уточняет type - СОХРАНИ brand!
- Возвращай ВСЕ накопленные данные, не теряй то, что уже известно
- Анализируй сообщение целиком: может содержать несколько параметров одновременно
- Сопоставляй упоминания брендов с доступными брендами из списка

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

Known: {"brand":"Coca-Cola","packageInfo":"0.5л","type":null}
Сообщение: "classic"
Ответ: {"action":"READY_TO_SEARCH","intent":{"brand":"Coca-Cola","packageInfo":"0.5л","type":"classic","packageType":null}}

Known: {brand: null, packageInfo: null, type: null, packageType: null}
Сообщение: "мне нужна банка колы"
Ответ: {"action":"READY_TO_SEARCH","intent":{"brand":"Coca-Cola","packageInfo":null,"type":null,"packageType":"can"}}

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
  const { types, packageTypes } = await extractProductTypesWithAI(candidates);

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

  // ПРИОРИТЕТ 1: Если не известна упаковка (объем) и есть варианты
  if (!known.packageInfo && packages.length > 1) {
    if (!wasQuestionAsked(['объем', 'литр', 'размер', 'сколько'])) {
      console.log('→ Задаем вопрос про ОБЪЕМ');
      return {
        questions: ['Какой объем вам нужен?'],
        quickReplies: packages.slice(0, 6)
      };
    }
  }

  // ПРИОРИТЕТ 2: Если не известен тип напитка и есть варианты
  if (!known.type && types.size > 1) {
    if (!wasQuestionAsked(['тип', 'zero', 'сахар', 'классическая', 'light', 'лайт'])) {
      console.log('→ Задаем вопрос про ТИП');
      return {
        questions: [`Какого типа ${known.brand || 'напиток'} вы хотите?`],
        quickReplies: [...types].slice(0, 6)
      };
    }
  }

  // ПРИОРИТЕТ 3: Если не известен тип упаковки (стекло/металл) и есть варианты
  // ВАЖНО: Не задаем вопрос, если packageType уже известен (пользователь уже ответил)
  if (!known.packageType && packageTypes.size > 1) {
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
  validateProductImage
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