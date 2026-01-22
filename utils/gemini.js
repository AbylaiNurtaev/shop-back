const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

function requestGemini(prompt) {
  if (!GEMINI_API_KEY) {
    return Promise.reject(new Error('GEMINI_API_KEY не задан'));
  }

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini error ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Gemini пустой ответ'));
          }
          return resolve(text);
        } catch (error) {
          return reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractJson(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
}

async function getIntentFromGemini({ message, candidates, known }) {
  // Создаем список уникальных значений для помощи в извлечении
  const uniqueBrands = [...new Set(candidates.map(c => c.brandName).filter(Boolean))];
  const uniquePackages = [...new Set(candidates.map(c => c.packageInfo).filter(Boolean))];
  
  const prompt = [
    'Ты — помощник поиска товаров. Отвечай ТОЛЬКО валидным JSON.',
    '',
    'Доступные товары (карточки):',
    JSON.stringify(candidates, null, 2),
    '',
    'Уже известная информация о предпочтениях пользователя:',
    JSON.stringify(known, null, 2),
    '',
    'Доступные варианты в базе данных:',
    `- Бренды: ${uniqueBrands.join(', ')}`,
    `- Упаковки: ${uniquePackages.join(', ')}`,
    '',
    'Сообщение пользователя:',
    JSON.stringify(message),
    '',
    'Проанализируй сообщение пользователя и извлеки информацию о предпочтениях.',
    'Сопоставь ответ пользователя с доступными вариантами в базе данных.',
    '',
    'Извлеки:',
    '- brand: точное название бренда из доступных вариантов (если упомянут или можно определить)',
    '- packageInfo: точную информацию об упаковке/объеме из доступных вариантов (если упомянута)',
    '- type: тип товара (zero, light, обычная, diet и т.д., если упомянут)',
    '',
    'Верни ТОЛЬКО валидный JSON в формате:',
    '{',
    '  "action": "READY_TO_SEARCH",',
    '  "intent": {',
    '    "brand": "точное название бренда из доступных вариантов или null",',
    '    "type": "тип товара или null",',
    '    "packageInfo": "точная информация об упаковке из доступных вариантов или null"',
    '  }',
    '}',
    '',
    'Правила:',
    '- Сопоставляй ответы пользователя с доступными вариантами в базе данных',
    '- Если пользователь сказал "кола", но есть несколько брендов, используй известный бренд или null',
    '- Если пользователь сказал "0.5" или "поллитра", сопоставь с точным значением из packageInfo (например "0.5л", "0.5 л")',
    '- Если пользователь сказал "zero" или "ноль", установи type: "zero"',
    '- Если пользователь сказал "light" или "лайт", установи type: "light"',
    '- Если пользователь сказал "обычная" или "классическая", установи type: "обычная"',
    '- Всегда возвращай action: "READY_TO_SEARCH", даже если не все поля заполнены',
    '- Используй null для полей, которые нельзя определить из сообщения'
  ].join('\n');

  const text = await requestGemini(prompt);
  const parsed = extractJson(text);
  if (!parsed || !parsed.action) {
    throw new Error('Некорректный ответ Gemini');
  }
  return parsed;
}

/**
 * Генерирует умные уточняющие вопросы на основе различий между товарами
 * Цель: сузить выбор до одного товара
 */
async function generateClarificationQuestions({ candidates, known }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }

  if (!candidates || candidates.length === 0) {
    return {
      questions: [],
      quickReplies: []
    };
  }

  if (candidates.length === 1) {
    return {
      questions: [],
      quickReplies: []
    };
  }

  // Анализируем различия между товарами
  const differences = analyzeProductDifferences(candidates);
  
  const prompt = [
    'Ты — помощник по подбору товаров. Твоя задача — задать уточняющие вопросы, чтобы сузить выбор до ОДНОГО товара.',
    '',
    'Доступные товары:',
    JSON.stringify(candidates, null, 2),
    '',
    'Уже известная информация о предпочтениях пользователя:',
    JSON.stringify(known, null, 2),
    '',
    'Различия между товарами:',
    JSON.stringify(differences, null, 2),
    '',
    'Проанализируй товары и сгенерируй 1-2 уточняющих вопроса, которые помогут выбрать ОДИН товар.',
    'Вопросы должны быть конкретными и основанными на реальных различиях между товарами.',
    '',
    'Приоритет вопросов:',
    '1. Если есть различия в объеме/размере упаковки (0.5л, 1л, 2л, стеклянная и т.д.) - спроси об этом ПЕРВЫМ',
    '2. Если есть различия в типе (обычная/zero/light/diet) - спроси об этом',
    '3. Если есть различия в бренде - спроси об этом',
    '4. Если есть другие значимые различия (название, описание) - спроси об этом',
    '',
    'Верни ТОЛЬКО валидный JSON в следующем формате:',
    '{',
    '  "questions": ["Вопрос 1", "Вопрос 2"],',
    '  "quickReplies": ["Вариант 1", "Вариант 2", "Вариант 3"]',
    '}',
    '',
    'Правила:',
    '- questions: массив из 1-2 вопросов (максимум 2), задавай вопросы по одному за раз',
    '- quickReplies: массив вариантов ответов для быстрого выбора (3-5 вариантов)',
    '- Вопросы должны быть понятными, дружелюбными и конкретными',
    '- Варианты ответов должны быть краткими и отражать РЕАЛЬНЫЕ различия между товарами',
    '- Если все товары одного бренда, НЕ спрашивай про бренд',
    '- Если все товары одной упаковки, НЕ спрашивай про упаковку',
    '- Если все товары одного типа, НЕ спрашивай про тип',
    '- Фокусируйся на наиболее значимых различиях, которые помогут быстро сузить выбор',
    '- Примеры вопросов: "Какой объем вам нужен?", "Какой тип колы вы предпочитаете?", "Какой бренд?"',
    '- Примеры quickReplies: ["0.5л", "1л", "2л"] или ["Обычная", "Zero", "Light"]'
  ].join('\n');

  try {
    const text = await requestGemini(prompt);
    const parsed = extractJson(text);
    
    if (!parsed || !Array.isArray(parsed.questions)) {
      // Fallback на простые вопросы
      return generateFallbackQuestions(candidates, known);
    }

    return {
      questions: parsed.questions || [],
      quickReplies: parsed.quickReplies || []
    };
  } catch (error) {
    console.error('Ошибка при генерации вопросов через Gemini:', error);
    // Fallback на простые вопросы
    return generateFallbackQuestions(candidates, known);
  }
}

/**
 * Анализирует различия между товарами
 */
function analyzeProductDifferences(candidates) {
  const differences = {
    brands: new Set(),
    packageInfos: new Set(),
    names: new Set(),
    descriptions: new Set(),
    types: new Set()
  };

  // Ключевые слова для типов товаров
  const typeKeywords = {
    zero: ['zero', 'ноль', '0', 'без сахара'],
    light: ['light', 'лайт', 'легкий'],
    diet: ['diet', 'диет', 'диетический'],
    classic: ['классическая', 'обычная', 'classic', 'original']
  };

  candidates.forEach(product => {
    if (product.brandName) differences.brands.add(product.brandName);
    if (product.packageInfo) differences.packageInfos.add(product.packageInfo);
    if (product.name) {
      differences.names.add(product.name);
      // Определяем тип товара по названию
      const nameLower = String(product.name).toLowerCase();
      Object.keys(typeKeywords).forEach(type => {
        if (typeKeywords[type].some(keyword => nameLower.includes(keyword))) {
          differences.types.add(type);
        }
      });
    }
    if (product.description) {
      differences.descriptions.add(product.description);
      // Определяем тип товара по описанию
      const descLower = String(product.description).toLowerCase();
      Object.keys(typeKeywords).forEach(type => {
        if (typeKeywords[type].some(keyword => descLower.includes(keyword))) {
          differences.types.add(type);
        }
      });
    }
  });

  return {
    uniqueBrands: Array.from(differences.brands),
    uniquePackageInfos: Array.from(differences.packageInfos),
    uniqueNames: Array.from(differences.names),
    uniqueTypes: Array.from(differences.types),
    totalProducts: candidates.length,
    hasMultipleBrands: differences.brands.size > 1,
    hasMultiplePackages: differences.packageInfos.size > 1,
    hasMultipleTypes: differences.types.size > 1
  };
}

/**
 * Генерирует простые вопросы в случае ошибки Gemini
 */
function generateFallbackQuestions(candidates, known) {
  const questions = [];
  const quickReplies = [];
  
  const differences = analyzeProductDifferences(candidates);
  
  // Приоритет 1: Если не знаем упаковку и есть несколько вариантов
  if (known.packageInfo === null && differences.hasMultiplePackages) {
    questions.push('Какой объем/тип упаковки вам нужен?');
    quickReplies.push(...differences.uniquePackageInfos.slice(0, 5));
  }
  
  // Приоритет 2: Если не знаем тип и есть несколько типов
  if (!known.type && differences.hasMultipleTypes) {
    if (questions.length === 0) {
      questions.push('Какой тип товара вы предпочитаете?');
      const typeLabels = {
        zero: 'Zero (без сахара)',
        light: 'Light (легкий)',
        diet: 'Diet (диетический)',
        classic: 'Классическая'
      };
      quickReplies.push(...differences.uniqueTypes.map(t => typeLabels[t] || t).slice(0, 5));
    }
  }
  
  // Приоритет 3: Если не знаем бренд и есть несколько брендов
  if (!known.brand && differences.hasMultipleBrands) {
    if (questions.length === 0) {
      questions.push('Какой бренд вы предпочитаете?');
      quickReplies.push(...differences.uniqueBrands.slice(0, 5));
    }
  }
  
  // Если все еще нет вопросов, задаем общий
  if (questions.length === 0 && candidates.length > 1) {
    questions.push('Уточните, какой именно товар вас интересует?');
  }
  
  return {
    questions,
    quickReplies: quickReplies.slice(0, 5)
  };
}

async function transcribeAudio({ buffer, mimeType }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан');
  }
  if (!buffer || !mimeType) {
    throw new Error('Отсутствуют данные для транскрипции');
  }

  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          { text: 'Сделай транскрипцию аудио. Верни только текст без пояснений.' },
          {
            inline_data: {
              mime_type: mimeType,
              data: buffer.toString('base64')
            }
          }
        ]
      }
    ],
    generationConfig: { temperature: 0.1 }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini error ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Gemini пустой ответ'));
          }
          return resolve(text.trim());
        } catch (error) {
          return reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { 
  getIntentFromGemini, 
  transcribeAudio,
  generateClarificationQuestions
};

