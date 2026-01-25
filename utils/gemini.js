const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash-exp';
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
      temperature: 0,
      maxOutputTokens: config.maxOutputTokens || 300,
      topP: 0.95,
      topK: 40
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
    timeout: 10000
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

  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
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

  const prompt = `Ты эксперт по поиску товаров. Извлеки параметры из сообщения пользователя.

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

ПРАВИЛА РАСПОЗНАВАНИЯ:
1. "Кола", "колу", "cola", "coca" → brand: "Coca-Cola"
2. "Пепси", "pepsi" → brand: "Pepsi"
3. "Фанта", "fanta" → brand: "Fanta"
4. "Спрайт", "sprite" → brand: "Sprite"
5. "0.5", "поллитра" → ищи упаковку с "0.5"
6. "1", "литр" → ищи упаковку с "1"
7. "2", "два литра" → ищи упаковку с "2"
8. "зеро", "zero", "без сахара" → type: "zero"
9. "лайт", "light" → type: "light"
10. "класси", "обычн", "classic" → type: "classic"
11. "стекло", "стеклянн", "бутылка" → packageType: "glass"
12. "банка", "железо", "жестян", "металл" → packageType: "can"
13. "пласти", "pet" → packageType: "plastic"

ВАЖНО: 
- ОБЪЕДИНИ уже известные данные (known) с новыми данными из сообщения
- Если в known уже есть brand, но пользователь уточняет type - СОХРАНИ brand!
- Возвращай ВСЕ накопленные данные, не теряй то, что уже известно

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "action": "READY_TO_SEARCH",
  "intent": {
    "brand": "известный бренд ИЛИ новый из сообщения",
    "packageInfo": "известная упаковка ИЛИ новая из сообщения",
    "type": "известный тип ИЛИ новый из сообщения",
    "packageType": "известный packageType ИЛИ новый из сообщения"
  }
}

ПРИМЕРЫ С НАКОПЛЕНИЕМ:
Known: {"brand":"Coca-Cola","packageInfo":null,"type":null}
Сообщение: "0.5"
Ответ: {"action":"READY_TO_SEARCH","intent":{"brand":"Coca-Cola","packageInfo":"0.5л","type":null,"packageType":null}}

Known: {"brand":"Coca-Cola","packageInfo":"0.5л","type":null}
Сообщение: "classic"
Ответ: {"action":"READY_TO_SEARCH","intent":{"brand":"Coca-Cola","packageInfo":"0.5л","type":"classic","packageType":null}}

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

  const types = new Set();
  const packageTypes = new Set();

  candidates.forEach(p => {
    const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();

    // Определяем тип напитка
    if (text.includes('zero') || text.includes('ноль')) types.add('Zero');
    if (text.includes('light') || text.includes('лайт')) types.add('Light');
    if (text.includes('classic') || text.includes('классическая') ||
      (!text.includes('zero') && !text.includes('light'))) types.add('Classic');

    // Определяем тип упаковки
    if (text.includes('стекл') || text.includes('glass')) packageTypes.add('Стекло');
    if (text.includes('банка') || text.includes('can') || text.includes('жест') || text.includes('металл')) packageTypes.add('Металл');
    if (text.includes('пласти') || text.includes('pet')) packageTypes.add('Пластик');
  });

  console.log('=== ГЕНЕРАЦИЯ ВОПРОСОВ ===');
  console.log('Всего товаров:', candidates.length);
  console.log('Известно:', known);
  console.log('Бренды (' + brands.length + '):', brands);
  console.log('Упаковки (' + packages.length + '):', packages);
  console.log('Типы (' + types.size + '):', [...types]);
  console.log('Тара (' + packageTypes.size + '):', [...packageTypes]);
  console.log('Предыдущие вопросы:', previousQuestions);

  // ПРИОРИТЕТ 1: Если не известна упаковка (объем) и есть варианты
  if (!known.packageInfo && packages.length > 1) {
    const questionAsked = previousQuestions.some(q =>
      q.toLowerCase().includes('объем') ||
      q.toLowerCase().includes('литр') ||
      q.toLowerCase().includes('размер')
    );

    if (!questionAsked) {
      console.log('→ Задаем вопрос про ОБЪЕМ');
      return {
        questions: ['Какой объем вам нужен?'],
        quickReplies: packages.slice(0, 6)
      };
    }
  }

  // ПРИОРИТЕТ 2: Если не известен тип напитка и есть варианты
  if (!known.type && types.size > 1) {
    const questionAsked = previousQuestions.some(q =>
      q.toLowerCase().includes('тип') ||
      q.toLowerCase().includes('zero') ||
      q.toLowerCase().includes('сахар')
    );

    if (!questionAsked) {
      console.log('→ Задаем вопрос про ТИП');
      return {
        questions: [`Какого типа ${known.brand || 'напиток'} вы хотите?`],
        quickReplies: [...types].slice(0, 6)
      };
    }
  }

  // ПРИОРИТЕТ 3: Если не известен тип упаковки (стекло/металл) и есть варианты
  if (!known.packageType && packageTypes.size > 1) {
    const questionAsked = previousQuestions.some(q =>
      q.toLowerCase().includes('тара') ||
      q.toLowerCase().includes('стекло') ||
      q.toLowerCase().includes('банка') ||
      q.toLowerCase().includes('металл')
    );

    if (!questionAsked) {
      console.log('→ Задаем вопрос про ТАРУ');
      return {
        questions: ['В какой таре вам нужен товар?'],
        quickReplies: [...packageTypes].slice(0, 6)
      };
    }
  }

  // ПРИОРИТЕТ 4: Если не известен бренд и есть варианты
  if (!known.brand && brands.length > 1) {
    const questionAsked = previousQuestions.some(q =>
      q.toLowerCase().includes('бренд') ||
      q.toLowerCase().includes('марк')
    );

    if (!questionAsked) {
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

  const prompt = `Ты эксперт по анализу накладных и товарных документов. Проанализируй это изображение накладной и извлеки список всех товаров с их количеством.

ВАЖНО:
- Прочитай весь текст на изображении
- Найди таблицу или список товаров
- Для каждого товара извлеки: название, количество (штук), артикул/SKU (если есть), бренд (если видно)
- Количество может быть указано в разных единицах (шт, уп, коробка и т.д.) - конвертируй в штуки если возможно
- Если количество указано как "уп" (упаковка), "коробка" и т.д., попробуй определить количество штук в упаковке или оставь как есть

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON):
{
  "items": [
    {
      "productName": "полное название товара",
      "quantity": число (количество штук),
      "sku": "артикул или null",
      "brand": "название бренда или null",
      "unit": "шт/уп/коробка и т.д.",
      "notes": "дополнительные заметки или null"
    }
  ],
  "invoiceNumber": "номер накладной или null",
  "date": "дата накладной или null",
  "supplier": "поставщик или null"
}

ПРИМЕРЫ:
- "Coca-Cola 0.5л x 24 шт" → {"productName": "Coca-Cola 0.5л", "quantity": 24, "unit": "шт"}
- "Пепси 1л, 10 уп по 6 шт" → {"productName": "Пепси 1л", "quantity": 60, "unit": "шт", "notes": "10 уп по 6 шт"}
- "Fanta 2л - 5 коробок" → {"productName": "Fanta 2л", "quantity": 5, "unit": "коробка"}

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
      maxOutputTokens: 2000
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

// Экспорт всех функций
module.exports = {
  getIntentFromGemini,
  transcribeAudio,
  generateClarificationQuestions,
  analyzeProductImage,
  analyzeInvoice
};

// Для совместимости с разными способами импорта
module.exports.getIntentFromGemini = getIntentFromGemini;
module.exports.transcribeAudio = transcribeAudio;
module.exports.generateClarificationQuestions = generateClarificationQuestions;
module.exports.analyzeProductImage = analyzeProductImage;
module.exports.analyzeInvoice = analyzeInvoice;