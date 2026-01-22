const { generateAccessToken, generateRefreshToken, JWT_EXPIRES_IN } = require('../utils/jwt');
const { hashPassword, verifyPassword, isHashed } = require('../utils/password');
const { models } = require('../models/database');
const { generateId } = require('../utils/uuid');
const { sendEmail } = require('../utils/email');

const { AuthCredential, User, VerificationCode, Brand, Distributor, SalesRepresentative } = models;

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

    // Генерируем токены
    const payload = {
      login,
      userId: user.id,
      role: user.role,
      ...(brandInfo ? { brandId: brandInfo.brandId } : {}),
      ...(distributorInfo ? { distributorId: distributorInfo.distributorId } : {}),
      ...(salesRepresentativeInfo ? { salesRepresentativeId: salesRepresentativeInfo.salesRepresentativeId } : {})
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
        ...(salesRepresentativeInfo ? { salesRepresentativeId: salesRepresentativeInfo.salesRepresentativeId, salesRepresentativeName: salesRepresentativeInfo.salesRepresentativeName } : {})
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
      return res.status(500).json({ error: 'Не удалось отправить код верификации' });
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
    const { companyName, country, city, email: emailParam, password } = req.body;
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
        photos: []
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
    const { name, email: emailParam, password } = req.body;
    email = emailParam;

    // Валидация обязательных полей
    if (!name || !email || !password) {
      return res.status(400).json({
        error: 'Отсутствуют обязательные поля: name, email, password'
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

    // Создаем пользователя торгового представителя
    try {
      await User.create({
        id: userId,
        role: 'SALES_REPRESENTATIVE',
        email,
        firstName: name,
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

    // Создаем торгового представителя (используем тот же id, что и у User для удобства)
    const salesRepresentativeId = userId;
    createdSalesRepresentativeId = salesRepresentativeId;

    try {
      const salesRepresentative = await SalesRepresentative.create({
        id: salesRepresentativeId,
        name,
        email,
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

module.exports = { login, registerAdmin, sendVerificationCode, verifyCode, registerDistributor, registerSalesRepresentative };
