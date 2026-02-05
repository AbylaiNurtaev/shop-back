const { generateAccessToken, generateRefreshToken, JWT_EXPIRES_IN } = require('../utils/jwt');
const { hashPassword, verifyPassword, isHashed } = require('../utils/password');
const { models } = require('../models/database');
const { generateId } = require('../utils/uuid');
const { sendEmail } = require('../utils/email');
const axios = require('axios');

const { AuthCredential, User, VerificationCode, PhoneVerificationCode, Brand, Distributor, SalesRepresentative, Store, Category } = models;

// Константы конфигурации WAPPI
const WAPPI_API_URL = process.env.WAPPI_API_URL || 'https://wappi.pro/api/sync/message/send';
const PROFILE_ID = process.env.PROFILE_ID;
const API_KEY = process.env.API_KEY;

// Настройка Axios с таймаутами
const axiosInstance = axios.create({
  timeout: 30000, // 30 секунд таймаут
  headers: {
    'Content-Type': 'application/json'
  }
});

// Массив вариаций сообщений для избежания банов в WhatsApp
const messageVariations = [
  "Ваш код подтверждения:",
  "Код верификации:",
  "Код для подтверждения:",
  "Ваш проверочный код:",
  "Код авторизации:",
  "Подтвердите кодом:",
  "Ваш секретный код:",
  "Код активации:",
  "Введите код:",
  "Ваш персональный код:",
  "Код доступа:",
  "Используйте код:",
  "Проверочный код:",
  "Код безопасности:",
  "Ваш идентификационный код:",
  "Код аутентификации:",
  "Секретный код подтверждения:",
  "Ваш временный код:",
  "Код для входа:",
  "Подтверждающий код:",
  "Верификационный код:",
  "Ваш код входа:",
  "Код для идентификации:",
  "Временный код доступа:",
  "Ваш уникальный код:",
  "Код для верификации:",
  "Используйте этот код:",
  "Ваш защитный код:",
  "Код для подтверждения аккаунта:",
  "Персональный код доступа:",
  "Код проверки:",
  "Ваш код регистрации:",
  "Идентификационный код:",
  "Код для завершения:",
  "Ваш проверочный номер:",
  "Код активации аккаунта:",
  "Введите проверочный код:",
  "Ваш код аутентификации:",
  "Секретный код:",
  "Код для завершения регистрации:"
];

// Функция для получения случайного сообщения
function getRandomMessage() {
  const randomIndex = Math.floor(Math.random() * messageVariations.length);
  return messageVariations[randomIndex];
}

// Функция для генерации 6-значного кода
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Функция для валидации номера телефона по коду страны
function validatePhoneNumber(phone) {
  // Оставляем только цифры (на случай, если передадут пробелы или +)
  const digitsOnly = phone.replace(/\D/g, '');

  // Казахстан / Россия
  if (digitsOnly.startsWith('7')) {
    const ruKzRegex = /^7\d{10}$/;
    return ruKzRegex.test(digitsOnly);
  }

  // США (упрощенный вариант: 1 + ещё 10 цифр)
  if (digitsOnly.startsWith('1')) {
    const usRegex = /^1\d{10}$/;
    return usRegex.test(digitsOnly);
  }

  // Все остальные коды стран не поддерживаем (на данный момент)
  return false;
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

async function login(req, res) {
  try {
    const { credentials: encodedCredentials } = req.body;

    if (!encodedCredentials) {
      return res.status(400).json({ error: 'Отсутствуют учетные данные' });
    }

    // Декодируем base64
    const decoded = Buffer.from(encodedCredentials, 'base64').toString('utf-8');
    const [login, password] = decoded.split(':');

    if (!login || !password) {
      return res.status(400).json({ error: 'Неверный формат учетных данных' });
    }

    // Проверяем учетные данные
    const credential = await AuthCredential.findOne({ login }).lean();
    if (!credential) {
      return res.status(401).json({ error: 'Неверные учетные данные' });
    }

    if (isHashed(credential.password)) {
      const isValid = verifyPassword(password, credential.password);
      if (!isValid) {
        return res.status(401).json({ error: 'Неверные учетные данные' });
      }
    } else {
      if (credential.password !== password) {
        return res.status(401).json({ error: 'Неверные учетные данные' });
      }
      await AuthCredential.updateOne(
        { login },
        { password: hashPassword(password) }
      );
    }

    const user = await User.findOne({ email: login }).lean();
    if (!user) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }

    // Если это пользователь бренда, пытаемся найти связанный бренд по email,
    // чтобы вернуть brandId и brandName на фронт
    let brandInfo = null;
    if (user.role === 'BRAND') {
      const brand = await Brand.findOne({ email: user.email }).lean();
      if (brand) {
        brandInfo = {
          brandId: brand.id,
          brandName: brand.name
        };
      }
    }

    // Если это пользователь дистрибьютора, пытаемся найти связанного дистрибьютора по email,
    // чтобы вернуть distributorId и distributorName на фронт
    let distributorInfo = null;
    if (user.role === 'DISTRIBUTOR') {
      const distributor = await Distributor.findOne({ email: user.email }).lean();
      if (distributor) {
        distributorInfo = {
          distributorId: distributor.id,
          distributorName: distributor.name
        };
      }
    }

    // Если это пользователь торгового представителя, пытаемся найти связанного торгового представителя по email,
    // чтобы вернуть salesRepresentativeId и salesRepresentativeName на фронт
    let salesRepresentativeInfo = null;
    if (user.role === 'SALES_REPRESENTATIVE') {
      const salesRepresentative = await SalesRepresentative.findOne({ email: user.email }).lean();
      if (salesRepresentative) {
        salesRepresentativeInfo = {
          salesRepresentativeId: salesRepresentative.id,
          salesRepresentativeName: salesRepresentative.name
        };
      }
    }

    // Если это продавец магазина, пытаемся найти связанный магазин по storeId,
    // чтобы вернуть storeId и storeName на фронт
    let storeInfo = null;
    if ((user.role === 'STORE' || user.role === 'STORE_USER') && user.storeId) {
      const store = await Store.findOne({ id: user.storeId }).lean();
      if (store) {
        storeInfo = {
          storeId: store.id,
          storeName: store.name
        };
      }
    }

    // Генерируем токены
    const payload = {
      login,
      userId: user.id,
      role: user.role,
      ...(brandInfo ? { brandId: brandInfo.brandId } : {}),
      ...(distributorInfo ? { distributorId: distributorInfo.distributorId } : {}),
      ...(salesRepresentativeInfo ? { salesRepresentativeId: salesRepresentativeInfo.salesRepresentativeId } : {}),
      ...(storeInfo ? { storeId: storeInfo.storeId } : {})
    };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({
      accessToken,
      refreshToken,
      expiresIn: JWT_EXPIRES_IN,
      user: {
        id: user.id,
        role: user.role,
        email: user.email,
        ...(brandInfo ? { brandId: brandInfo.brandId, brandName: brandInfo.brandName } : {}),
        ...(distributorInfo ? { distributorId: distributorInfo.distributorId, distributorName: distributorInfo.distributorName } : {}),
        ...(salesRepresentativeInfo ? { salesRepresentativeId: salesRepresentativeInfo.salesRepresentativeId, salesRepresentativeName: salesRepresentativeInfo.salesRepresentativeName } : {}),
        ...(storeInfo ? { storeId: storeInfo.storeId, storeName: storeInfo.storeName } : {})
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при авторизации' });
  }
}

// Регистрация администратора
async function registerAdmin(req, res) {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    const existingCredential = await AuthCredential.findOne({ login: email }).lean();
    if (existingCredential) {
      return res.status(409).json({ error: 'Учетные данные уже существуют' });
    }

    const { generateId } = require('../utils/uuid');

    const user = await User.create({
      id: generateId(),
      role: 'ADMIN',
      email,
      firstName: firstName || 'Admin',
      lastName: lastName || 'Admin',
      storeId: null,
      distributorId: null,
      isActive: true
    });

    await AuthCredential.create({
      login: email,
      password: hashPassword(password)
    });

    const payload = { login: email, userId: user.id, role: user.role };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.status(201).json({
      user: user.toObject(),
      accessToken,
      refreshToken,
      expiresIn: JWT_EXPIRES_IN
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при регистрации администратора' });
  }
}

// Отправка кода верификации на email
async function sendVerificationCode(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email обязателен' });
    }

    // Проверяем формат email (базовая проверка)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Некорректный формат email' });
    }

    // Если такой email уже зарегистрирован, сразу возвращаем ответ
    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      return res.status(409).json({
        error: 'Пользователь с таким email уже существует',
        code: 'EMAIL_ALREADY_EXISTS'
      });
    }

    // Генерируем 6-значный код
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Удаляем старые коды для этого email
    await VerificationCode.deleteMany({ email });

    // Создаем новый код (действителен 10 минут)
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);

    await VerificationCode.create({
      id: generateId(),
      email,
      code,
      expiresAt,
      used: false
    });

    // Отправляем код на email
    try {
      await sendEmail({
        to: email,
        subject: 'Код верификации',
        text: `Ваш код верификации: ${code}\n\nКод действителен в течение 10 минут.`
      });
    } catch (emailError) {
      console.error('Ошибка при отправке email:', emailError);

      // Проверяем, является ли это ошибкой лимита MailerSend
      if (emailError.message && emailError.message.includes('trial account unique recipients limit')) {
        return res.status(503).json({
          error: 'Достигнут лимит отправки email на бесплатном тарифе MailerSend. Пожалуйста, используйте верификацию по телефону через WhatsApp.',
          code: 'EMAIL_LIMIT_REACHED',
          alternative: 'phone_verification',
          message: 'Используйте эндпоинт /api/auth/verification/phone/send для отправки кода на WhatsApp'
        });
      }

      return res.status(500).json({
        error: 'Не удалось отправить код верификации на email',
        details: emailError.message
      });
    }

    res.json({
      message: 'Код верификации отправлен на email',
      expiresIn: 600 // 10 минут в секундах
    });
  } catch (error) {
    console.error('Ошибка при отправке кода верификации:', error);
    res.status(500).json({ error: 'Ошибка при отправке кода верификации' });
  }
}

// Проверка кода верификации
async function verifyCode(req, res) {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email и код обязательны' });
    }

    // Ищем код верификации
    const verification = await VerificationCode.findOne({
      email,
      code,
      used: false
    }).lean();

    if (!verification) {
      return res.status(400).json({ error: 'Неверный код верификации' });
    }

    // Проверяем, не истек ли срок действия
    if (new Date() > verification.expiresAt) {
      await VerificationCode.deleteOne({ id: verification.id });
      return res.status(400).json({ error: 'Код верификации истек' });
    }

    // Помечаем код как использованный
    await VerificationCode.updateOne(
      { id: verification.id },
      { used: true }
    );

    res.json({
      message: 'Код верификации подтвержден',
      verified: true
    });
  } catch (error) {
    console.error('Ошибка при проверке кода верификации:', error);
    res.status(500).json({ error: 'Ошибка при проверке кода верификации' });
  }
}

// Регистрация дистрибьютора
async function registerDistributor(req, res) {
  let createdUserId = null;
  let createdDistributorId = null;
  let email = null;

  try {
    const { companyName, country, city, email: emailParam, password, demo, categoryIds } = req.body;
    email = emailParam;

    // Валидация обязательных полей
    if (!companyName || !country || !city || !email || !password) {
      return res.status(400).json({
        error: 'Отсутствуют обязательные поля: companyName, country, city, email, password'
      });
    }

    // Проверяем формат email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Некорректный формат email' });
    }

    // Проверяем код верификации только если не демо-режим
    if (!demo) {
      // Проверяем, что для этого email был отправлен код верификации
      // (подтверждает, что email был проверен через /auth/verification/send)
      const verification = await VerificationCode.findOne({
        email
      }).sort({ expiresAt: -1 }).lean();

      if (!verification) {
        return res.status(400).json({
          error: 'Email не подтвержден. Сначала отправьте код верификации на email'
        });
      }

      // Проверяем, что код еще не истек (подтверждает, что email был проверен недавно)
      if (new Date() > verification.expiresAt) {
        return res.status(400).json({
          error: 'Срок действия подтверждения email истек. Пожалуйста, отправьте код верификации заново'
        });
      }
    }

    // Проверяем, что email ещё не занят
    const existingUser = await User.findOne({ email }).lean();
    const existingDistributor = await Distributor.findOne({ email }).lean();

    if (existingUser || existingDistributor) {
      return res.status(409).json({
        error: existingDistributor
          ? 'Дистрибьютор с таким email уже зарегистрирован'
          : 'Пользователь с таким email уже существует',
        code: 'EMAIL_ALREADY_EXISTS'
      });
    }

    // Проверяем наличие "висячих" учетных данных
    const existingCredential = await AuthCredential.findOne({ login: email }).lean();
    if (existingCredential) {
      await AuthCredential.deleteOne({ login: email });
    }

    // Валидация категорий, если они переданы
    let validatedCategoryIds = [];
    if (categoryIds !== undefined) {
      if (!Array.isArray(categoryIds)) {
        return res.status(400).json({ error: 'categoryIds должен быть массивом' });
      }

      // Проверяем, что все категории существуют
      if (categoryIds.length > 0) {
        const validCategories = await Category.find({ id: { $in: categoryIds } }).lean();
        const validCategoryIds = validCategories.map(cat => cat.id);
        const invalidCategoryIds = categoryIds.filter(id => !validCategoryIds.includes(id));

        if (invalidCategoryIds.length > 0) {
          return res.status(400).json({
            error: `Следующие категории не найдены: ${invalidCategoryIds.join(', ')}`
          });
        }

        validatedCategoryIds = categoryIds;
      }
    }

    const userId = generateId();
    createdUserId = userId;

    // Создаем пользователя дистрибьютора
    try {
      await User.create({
        id: userId,
        role: 'DISTRIBUTOR',
        email,
        firstName: companyName,
        lastName: '',
        storeId: null,
        distributorId: null,
        isActive: true
      });
    } catch (userError) {
      if (userError.code === 11000 || userError.message.includes('duplicate')) {
        return res.status(409).json({
          error: 'Пользователь с таким email уже существует',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      throw userError;
    }

    // Создаем учетные данные
    try {
      await AuthCredential.create({
        login: email,
        password: hashPassword(password)
      });
    } catch (credError) {
      if (credError.code === 11000 || credError.message.includes('duplicate')) {
        await User.deleteOne({ id: userId });
        return res.status(409).json({
          error: 'Учетные данные уже существуют',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      await User.deleteOne({ id: userId });
      throw credError;
    }

    // Создаем дистрибьютора
    const distributorId = generateId();
    createdDistributorId = distributorId;

    try {
      const distributor = await Distributor.create({
        id: distributorId,
        name: companyName,
        email,
        country,
        city,
        address: `${city}, ${country}`, // Временный адрес, можно будет обновить позже
        description: null,
        photos: [],
        categoryIds: validatedCategoryIds
      });

      // Обновляем пользователя с distributorId
      await User.updateOne({ id: userId }, { distributorId });

      // Удаляем использованные коды верификации для этого email
      await VerificationCode.deleteMany({ email });

      // Генерируем токены
      const payload = {
        login: email,
        userId: userId,
        role: 'DISTRIBUTOR',
        distributorId: distributorId
      };
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(payload);

      res.status(201).json({
        distributor: distributor.toObject(),
        accessToken,
        refreshToken,
        expiresIn: JWT_EXPIRES_IN,
        user: {
          id: userId,
          role: 'DISTRIBUTOR',
          email,
          distributorId: distributorId
        }
      });
    } catch (distributorError) {
      await User.deleteOne({ id: userId });
      await AuthCredential.deleteOne({ login: email });

      if (distributorError.code === 11000 || distributorError.message.includes('duplicate')) {
        return res.status(409).json({
          error: 'Дистрибьютор с таким email уже существует',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      throw distributorError;
    }
  } catch (error) {
    console.error('Ошибка при регистрации дистрибьютора:', error);

    // Откатываем изменения, если что-то пошло не так
    if (createdUserId) {
      await User.deleteOne({ id: createdUserId }).catch(() => { });
    }
    if (email) {
      await AuthCredential.deleteOne({ login: email }).catch(() => { });
    }
    if (createdDistributorId) {
      await Distributor.deleteOne({ id: createdDistributorId }).catch(() => { });
    }

    res.status(500).json({ error: 'Ошибка при регистрации дистрибьютора' });
  }
}

// Регистрация торгового представителя
async function registerSalesRepresentative(req, res) {
  let createdUserId = null;
  let createdSalesRepresentativeId = null;
  let email = null;

  try {
    const { firstName, lastName, middleName, email: emailParam, password, phoneNumber } = req.body;
    email = emailParam;

    // Валидация обязательных полей
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        error: 'Отсутствуют обязательные поля: firstName, lastName, email, password'
      });
    }

    // Проверяем формат email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Некорректный формат email' });
    }

    // Проверяем, что email ещё не занят
    const existingUser = await User.findOne({ email }).lean();
    const existingSalesRepresentative = await SalesRepresentative.findOne({ email }).lean();

    if (existingUser || existingSalesRepresentative) {
      return res.status(409).json({
        error: existingSalesRepresentative
          ? 'Торговый представитель с таким email уже зарегистрирован'
          : 'Пользователь с таким email уже существует',
        code: 'EMAIL_ALREADY_EXISTS'
      });
    }

    // Проверяем наличие "висячих" учетных данных
    const existingCredential = await AuthCredential.findOne({ login: email }).lean();
    if (existingCredential) {
      await AuthCredential.deleteOne({ login: email });
    }

    const userId = generateId();
    createdUserId = userId;

    // Формируем полное имя для обратной совместимости
    const fullName = [lastName, firstName, middleName].filter(Boolean).join(' ').trim() || firstName;

    // Создаем пользователя торгового представителя
    try {
      await User.create({
        id: userId,
        role: 'SALES_REPRESENTATIVE',
        email,
        firstName,
        lastName: lastName || '',
        storeId: null,
        distributorId: null,
        isActive: true
      });
    } catch (userError) {
      if (userError.code === 11000 || userError.message.includes('duplicate')) {
        return res.status(409).json({
          error: 'Пользователь с таким email уже существует',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      throw userError;
    }

    // Создаем учетные данные
    try {
      await AuthCredential.create({
        login: email,
        password: hashPassword(password)
      });
    } catch (credError) {
      if (credError.code === 11000 || credError.message.includes('duplicate')) {
        await User.deleteOne({ id: userId });
        return res.status(409).json({
          error: 'Учетные данные уже существуют',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      await User.deleteOne({ id: userId });
      throw credError;
    }

    // Создаем торгового представителя (используем тот же id, что и у User для удобства)
    const salesRepresentativeId = userId;
    createdSalesRepresentativeId = salesRepresentativeId;

    try {
      const salesRepresentative = await SalesRepresentative.create({
        id: salesRepresentativeId,
        name: fullName,
        firstName,
        lastName,
        middleName: middleName || null,
        email,
        phoneNumber: phoneNumber || null,
        distributorId: null
      });

      // Генерируем токены
      const payload = {
        login: email,
        userId: userId,
        role: 'SALES_REPRESENTATIVE',
        salesRepresentativeId: salesRepresentativeId
      };
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(payload);

      res.status(201).json({
        salesRepresentative: salesRepresentative.toObject(),
        accessToken,
        refreshToken,
        expiresIn: JWT_EXPIRES_IN,
        user: {
          id: userId,
          role: 'SALES_REPRESENTATIVE',
          email,
          salesRepresentativeId: salesRepresentativeId
        }
      });
    } catch (salesRepError) {
      await User.deleteOne({ id: userId });
      await AuthCredential.deleteOne({ login: email });

      if (salesRepError.code === 11000 || salesRepError.message.includes('duplicate')) {
        return res.status(409).json({
          error: 'Торговый представитель с таким email уже существует',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      throw salesRepError;
    }
  } catch (error) {
    console.error('Ошибка при регистрации торгового представителя:', error);

    // Откатываем изменения, если что-то пошло не так
    if (createdUserId) {
      await User.deleteOne({ id: createdUserId }).catch(() => { });
    }
    if (email) {
      await AuthCredential.deleteOne({ login: email }).catch(() => { });
    }
    if (createdSalesRepresentativeId) {
      await SalesRepresentative.deleteOne({ id: createdSalesRepresentativeId }).catch(() => { });
    }

    res.status(500).json({ error: 'Ошибка при регистрации торгового представителя' });
  }
}

// Регистрация продавца магазина
async function registerStoreSeller(req, res) {
  let createdUserId = null;
  let email = null;

  try {
    const { email: emailParam, password, firstName, lastName, middleName, phoneNumber, storeId } = req.body;
    email = emailParam;

    // Валидация обязательных полей
    if (!firstName || !lastName || !email || !password || !storeId) {
      return res.status(400).json({
        error: 'Отсутствуют обязательные поля: firstName, lastName, email, password, storeId'
      });
    }

    // Проверяем формат email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Некорректный формат email' });
    }

    // Проверяем существование магазина
    const store = await Store.findOne({ id: storeId }).lean();
    if (!store) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    // Проверяем, что email ещё не занят
    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      return res.status(409).json({
        error: 'Пользователь с таким email уже существует',
        code: 'EMAIL_ALREADY_EXISTS'
      });
    }

    // Проверяем наличие "висячих" учетных данных
    const existingCredential = await AuthCredential.findOne({ login: email }).lean();
    if (existingCredential) {
      await AuthCredential.deleteOne({ login: email });
    }

    const userId = generateId();
    createdUserId = userId;

    // Создаем пользователя продавца магазина (кассира)
    try {
      await User.create({
        id: userId,
        role: 'STORE_SELLER',
        email,
        firstName,
        lastName,
        middleName: middleName || null,
        phoneNumber: phoneNumber || null,
        storeId: storeId,
        distributorId: null,
        isActive: true
      });
    } catch (userError) {
      if (userError.code === 11000 || userError.message.includes('duplicate')) {
        return res.status(409).json({
          error: 'Пользователь с таким email уже существует',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      throw userError;
    }

    // Создаем учетные данные
    try {
      await AuthCredential.create({
        login: email,
        password: hashPassword(password)
      });
    } catch (credError) {
      if (credError.code === 11000 || credError.message.includes('duplicate')) {
        await User.deleteOne({ id: userId });
        return res.status(409).json({
          error: 'Учетные данные уже существуют',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      await User.deleteOne({ id: userId });
      throw credError;
    }

    // Генерируем токены
    const payload = {
      login: email,
      userId: userId,
      role: 'STORE_SELLER',
      storeId: storeId
    };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.status(201).json({
      user: {
        id: userId,
        role: 'STORE_SELLER',
        email,
        firstName,
        lastName,
        middleName: middleName || null,
        phoneNumber: phoneNumber || null,
        storeId: storeId,
        storeName: store.name
      },
      accessToken,
      refreshToken,
      expiresIn: JWT_EXPIRES_IN
    });
  } catch (error) {
    console.error('Ошибка при регистрации продавца магазина:', error);

    // Откатываем изменения, если что-то пошло не так
    if (createdUserId) {
      await User.deleteOne({ id: createdUserId }).catch(() => { });
    }
    if (email) {
      await AuthCredential.deleteOne({ login: email }).catch(() => { });
    }

    res.status(500).json({ error: 'Ошибка при регистрации продавца магазина' });
  }
}

// Отправка кода верификации на телефон через WhatsApp (WAPPI)
async function sendPhoneVerificationCode(req, res) {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Номер телефона обязателен' });
    }

    // Валидация номера телефона
    if (!validatePhoneNumber(phoneNumber)) {
      return res.status(400).json({
        error: 'Некорректный формат номера телефона. Поддерживаются: RU/KZ 7XXXXXXXXXX или US 1XXXXXXXXXX (11 цифр)'
      });
    }

    // Проверяем наличие PROFILE_ID и API_KEY
    if (!PROFILE_ID || !API_KEY) {
      console.error('WAPPI credentials not configured');
      return res.status(500).json({ error: 'Сервис верификации не настроен' });
    }

    // Нормализуем номер телефона (оставляем только цифры)
    const normalizedPhone = phoneNumber.replace(/\D/g, '');

    // Генерируем 6-значный код
    const code = generateVerificationCode();

    // Удаляем старые коды для этого номера
    await PhoneVerificationCode.deleteMany({ phoneNumber: normalizedPhone });

    // Создаем новый код (действителен 10 минут)
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);

    await PhoneVerificationCode.create({
      id: generateId(),
      phoneNumber: normalizedPhone,
      code,
      expiresAt,
      used: false
    });

    // Формируем текст сообщения (случайная вариация для избежания банов)
    const randomMessage = getRandomMessage();
    const messageText = `${randomMessage} ${code}`;

    // Формируем URL для Wappi API (как в примере - profile_id в query параметре)
    const wappiUrl = `${WAPPI_API_URL}?profile_id=${encodeURIComponent(PROFILE_ID)}`;

    // Тело запроса к Wappi
    const payload = {
      recipient: normalizedPhone,
      body: messageText
    };

    // Заголовки для Wappi
    const headers = {
      accept: 'application/json',
      Authorization: API_KEY,
      'Content-Type': 'application/json'
    };

    // Логирование для отладки (без чувствительных данных)
    console.log('WAPPI Request:', {
      url: wappiUrl,
      profile_id: PROFILE_ID ? `${PROFILE_ID.substring(0, 5)}...` : 'missing',
      recipient: normalizedPhone.substring(0, 3) + '****',
      hasApiKey: !!API_KEY
    });

    try {
      const wappiResponse = await sendWithRetry(wappiUrl, payload, headers);

      // Проверка успешности отправки
      if (wappiResponse.status === 200 || wappiResponse.status === 201) {
        return res.json({
          message: 'Код верификации отправлен на WhatsApp',
          expiresIn: 600 // 10 минут в секундах
        });
      } else {
        console.error('Unexpected response status from Wappi API:', wappiResponse.status);
        return res.status(500).json({
          error: 'Не удалось отправить код верификации',
          details: wappiResponse.data
        });
      }
    } catch (wappiError) {
      const errorMessage = wappiError.response?.data || wappiError.message;
      const errorStatus = wappiError.response?.status || 500;

      console.error('Failed to send message via Wappi API:', errorMessage);

      return res.status(errorStatus).json({
        error: 'Не удалось отправить код верификации через WhatsApp',
        details: errorMessage
      });
    }
  } catch (error) {
    console.error('Ошибка при отправке кода верификации на телефон:', error);
    res.status(500).json({ error: 'Ошибка при отправке кода верификации' });
  }
}

// Проверка кода верификации по телефону
async function verifyPhoneCode(req, res) {
  try {
    const { phoneNumber, code } = req.body;

    if (!phoneNumber || !code) {
      return res.status(400).json({ error: 'Номер телефона и код обязательны' });
    }

    // Нормализуем номер телефона
    const normalizedPhone = phoneNumber.replace(/\D/g, '');

    // Ищем код верификации
    const verification = await PhoneVerificationCode.findOne({
      phoneNumber: normalizedPhone,
      code,
      used: false
    }).lean();

    if (!verification) {
      return res.status(400).json({ error: 'Неверный код верификации' });
    }

    // Проверяем, не истек ли срок действия
    if (new Date() > verification.expiresAt) {
      await PhoneVerificationCode.deleteOne({ id: verification.id });
      return res.status(400).json({ error: 'Код верификации истек' });
    }

    // Помечаем код как использованный
    await PhoneVerificationCode.updateOne(
      { id: verification.id },
      { used: true }
    );

    res.json({
      message: 'Код верификации подтвержден',
      verified: true
    });
  } catch (error) {
    console.error('Ошибка при проверке кода верификации по телефону:', error);
    res.status(500).json({ error: 'Ошибка при проверке кода верификации' });
  }
}

module.exports = {
  login,
  registerAdmin,
  sendVerificationCode,
  verifyCode,
  registerDistributor,
  registerSalesRepresentative,
  registerStoreSeller,
  sendPhoneVerificationCode,
  verifyPhoneCode
};
