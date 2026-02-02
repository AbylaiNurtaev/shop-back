const mongoose = require('mongoose');

const DEFAULT_CATEGORIES = [
  {
    id: 'category_1',
    name: 'Напитки',
    description: 'Напитки всех видов'
  },
  {
    id: 'category_2',
    name: 'Снеки и снеки',
    description: 'Закуски, снеки и перекусы'
  },
  {
    id: 'category_3',
    name: 'Молочная продукция',
    description: 'Молоко, кефир, йогурты и другая молочная продукция'
  },
  {
    id: 'category_4',
    name: 'Хлеб и выпечка',
    description: 'Хлеб, булочки, выпечка'
  },
  {
    id: 'category_5',
    name: 'Бытовая химия',
    description: 'Средства для уборки и ухода за домом'
  }
];

const DEFAULT_CREDENTIALS = [
  { login: 'admin', password: 'admin' },
  { login: 'user', password: 'password' },
  { login: 'admin@gmail.com', password: '12345' }
];
const { hashPassword } = require('../utils/password');
const { generateId } = require('../utils/uuid');

const baseSchemaOptions = {
  versionKey: false,
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  toJSON: {
    transform: (doc, ret) => {
      delete ret._id;
    }
  },
  toObject: {
    transform: (doc, ret) => {
      delete ret._id;
    }
  }
};

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    role: { type: String, required: true },
    email: { type: String, required: true },
    firstName: { type: String, required: false },
    lastName: { type: String, required: false },
    storeId: { type: String, default: null },
    distributorId: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    currency: { type: String, default: 'KZT' }
  },
  baseSchemaOptions
);

const storeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    location: { type: String, required: true },
    locationCoords: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null }
    },
    description: { type: String, default: null },
    photos: { type: [String], default: [] },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    middleName: { type: String, default: null },
    phoneNumber: { type: String, default: null },
    city: { type: String, default: null }
  },
  baseSchemaOptions
);

const distributorSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    country: { type: String, required: true },
    city: { type: String, required: true },
    address: { type: String, required: true },
    location: { type: String, default: null },
    description: { type: String, default: null },
    photos: { type: [String], default: [] }
  },
  baseSchemaOptions
);

const salesRepresentativeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    firstName: { type: String, required: false },
    lastName: { type: String, required: false },
    middleName: { type: String, required: false },
    email: { type: String, required: true, unique: true },
    phoneNumber: { type: String, default: null },
    distributorId: { type: String, default: null, index: true }
  },
  baseSchemaOptions
);

const salesRepresentativeStoreSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    salesRepresentativeId: { type: String, required: true, index: true },
    storeId: { type: String, required: true, index: true },
    distributorId: { type: String, required: true, index: true }
  },
  baseSchemaOptions
);

salesRepresentativeStoreSchema.index(
  { salesRepresentativeId: 1, storeId: 1 },
  { unique: true }
);

const salesRepresentativeProductSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    salesRepresentativeId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    distributorId: { type: String, required: true, index: true }
  },
  baseSchemaOptions
);

salesRepresentativeProductSchema.index(
  { salesRepresentativeId: 1, productId: 1 },
  { unique: true }
);

const brandSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    country: { type: String, required: true },
    city: { type: String, default: null },
    categoryId: { type: String, required: true },
    logoUrl: { type: String, default: null },
    // Данные аккаунта бренда
    email: { type: String, required: true },
    contactName: { type: String, default: null },
    phone: { type: String, default: null },
    // Флаг одобрения бренда администратором
    isAccepted: { type: Boolean, default: false },
    // Причина отклонения (если заявка отклонена)
    rejectedReason: { type: String, default: null }
  },
  baseSchemaOptions
);

const categorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    parentCategoryId: { type: String, default: null, index: true }
  },
  baseSchemaOptions
);

const productSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    categoryId: { type: String, required: true },
    brandId: { type: String, required: true },
    brandName: { type: String, default: null },
    images: { type: [String], default: [] },
    sku: { type: String, required: true },
    packageInfo: { type: String, default: null },
    unitsPerPack: { type: Number, default: null },
    // Себестоимость товара от бренда (цена закупки)
    costPrice: { type: Number, default: null },
    costCurrency: { type: String, default: 'RUB' },
    // Поля для карточек товаров бренда
    storageLife: { type: String, required: true },
    productionDate: { type: Date, required: true },
    expirationDate: { type: Date, default: null },
    allergens: { type: String, default: null },
    ageRestrictions: { type: String, default: null },
    // Поля для оплаты показа товара
    isPayed: { type: Boolean, default: false, index: true },
    paymentDate: { type: Date, default: null },
    paymentExpiresAt: { type: Date, default: null, index: true }
  },
  baseSchemaOptions
);

const offerSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    productId: { type: String, required: true },
    storeId: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    isAvailable: { type: Boolean, default: true },
    quantity: { type: Number, default: 0 }
  },
  baseSchemaOptions
);

// Схема позиции в продаже (вложенный документ)
const saleItemSchema = new mongoose.Schema({
  productId: { type: String, required: true },
  sku: { type: String, required: true },
  productName: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  totalPrice: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true }
}, { _id: false });

// Схема продажи (чека)
const saleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    storeId: { type: String, required: true, index: true },
    sellerId: { type: String, required: true, index: true }, // userId продавца
    status: {
      type: String,
      required: true,
      enum: ['DRAFT', 'COMPLETED', 'CANCELLED'],
      default: 'DRAFT',
      index: true
    },
    items: [saleItemSchema], // Массив позиций в чеке
    totalAmount: { type: Number, required: true, default: 0, min: 0 },
    currency: { type: String, required: true, default: 'RUB' },
    // Способ оплаты (только для завершенных продаж)
    paymentMethod: {
      type: String,
      enum: ['CASH', 'CARD', 'HYBRID'],
      default: null
    },
    // Для гибридной оплаты: сумма наличными и картой
    cashAmount: { type: Number, default: null, min: 0 },
    cardAmount: { type: Number, default: null, min: 0 },
    completedAt: { type: Date, default: null }
  },
  baseSchemaOptions
);

// Индексы для оптимизации запросов
saleSchema.index({ storeId: 1, createdAt: -1 });
saleSchema.index({ storeId: 1, status: 1, createdAt: -1 });
saleSchema.index({ sellerId: 1, createdAt: -1 });

const customerSessionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    deviceId: { type: String, default: null },
    userAgent: { type: String, default: null },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  baseSchemaOptions
);

const searchConversationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true, index: true },
    state: { type: String, required: true },
    intentId: { type: String, default: null },
    requestId: { type: String, default: null },
    resultId: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  baseSchemaOptions
);

const searchMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    conversationId: { type: String, required: true, index: true },
    sender: { type: String, required: true },
    text: { type: String, default: '' },
    attachmentIds: { type: [String], default: [] }
  },
  baseSchemaOptions
);

const searchIntentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    conversationId: { type: String, required: true, index: true },
    rawText: { type: String, default: '' },
    brand: { type: String, default: null },
    type: { type: String, default: null },
    packageInfo: { type: String, default: null },
    filters: { type: Object, default: {} },
    confidence: { type: Number, default: null }
  },
  baseSchemaOptions
);

const searchRequestSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    conversationId: { type: String, required: true, index: true },
    intentId: { type: String, required: true },
    geo: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true }
    },
    radiusMeters: { type: Number, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  baseSchemaOptions
);

const searchResultSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    requestId: { type: String, required: true, index: true },
    items: { type: [Object], default: [] },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  baseSchemaOptions
);

const attachmentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    url: { type: String, required: true },
    metadata: { type: Object, default: {} },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  baseSchemaOptions
);

const voiceInputSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    messageId: { type: String, required: true, index: true },
    transcript: { type: String, default: '' },
    confidence: { type: Number, default: null },
    language: { type: String, default: null }
  },
  baseSchemaOptions
);

const auditEventSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    sessionId: { type: String, default: null, index: true },
    action: { type: String, required: true },
    metadata: { type: Object, default: {} }
  },
  baseSchemaOptions
);

const authCredentialSchema = new mongoose.Schema(
  {
    login: { type: String, required: true, unique: true },
    password: { type: String, required: true }
  },
  baseSchemaOptions
);

const verificationCodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    email: { type: String, required: true, index: true },
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    used: { type: Boolean, default: false }
  },
  baseSchemaOptions
);

const brandDistributorRequestSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    brandId: { type: String, required: true, index: true },
    distributorId: { type: String, required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'ACCEPTED', 'REJECTED'],
      default: 'PENDING'
    },
    rejectedReason: { type: String, default: null }
  },
  baseSchemaOptions
);

// Уникальный индекс для предотвращения дубликатов активных запросов
brandDistributorRequestSchema.index({ brandId: 1, distributorId: 1 }, {
  unique: true,
  partialFilterExpression: { status: { $in: ['PENDING', 'ACCEPTED'] } }
});

const categoryRequestSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    brandId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    parentCategoryId: { type: String, default: null, index: true },
    parentCategoryName: { type: String, default: null }, // Для случая, когда создается новая категория
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'ACCEPTED', 'REJECTED'],
      default: 'PENDING',
      index: true
    },
    rejectedReason: { type: String, default: null }
  },
  baseSchemaOptions
);

const planSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    salesRepresentativeId: { type: String, required: true, index: true },
    distributorId: { type: String, required: true, index: true },
    targetAmount: { type: Number, required: true, min: 0 }, // План по сумме
    targetQuantity: { type: Number, required: true, min: 0 }, // План по количеству штук
    period: { type: String, required: true }, // Период плана (например, "2024-01", "2024-Q1", "2024")
    description: { type: String, default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null }
  },
  baseSchemaOptions
);

planSchema.index({ salesRepresentativeId: 1, distributorId: 1, period: 1 });

// Схема плана по категории
const categoryPlanSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    salesRepresentativeId: { type: String, required: true, index: true },
    distributorId: { type: String, required: true, index: true },
    categoryId: { type: String, required: true, index: true },
    targetAmount: { type: Number, required: true, min: 0 }, // План по сумме
    targetQuantity: { type: Number, required: true, min: 0 }, // План по количеству штук
    period: { type: String, required: true }, // Период плана (например, "2024-01", "2024-Q1", "2024")
    description: { type: String, default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null }
  },
  baseSchemaOptions
);

categoryPlanSchema.index({ salesRepresentativeId: 1, distributorId: 1, categoryId: 1, period: 1 }, { unique: true });

// Схема себестоимости товара от дистрибьютора
const distributorProductPriceSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    distributorId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    costPrice: { type: Number, required: true, min: 0 },
    costCurrency: { type: String, required: true, default: 'RUB' }
  },
  baseSchemaOptions
);

// Уникальный индекс для предотвращения дубликатов
distributorProductPriceSchema.index({ distributorId: 1, productId: 1 }, { unique: true });

// Схема истории действий дистрибьютора
// Одна запись = один дистрибьютор, внутри массив действий
const distributorActivityActionSchema = new mongoose.Schema({
  actionType: { type: String, required: true }, // Тип действия (например, 'UPDATE_NAME', 'ADD_STORE', 'ADD_SALES_REP')
  description: { type: String, required: true }, // Описание действия
  metadata: { type: Object, default: {} }, // Дополнительные данные (id объектов, значения и т.д.)
  timestamp: { type: Date, default: Date.now } // Время действия
}, { _id: false });

const distributorActivityHistorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    distributorId: { type: String, required: true, unique: true, index: true },
    actions: [distributorActivityActionSchema] // Массив действий
  },
  baseSchemaOptions
);

// Схема для логирования поисковых запросов через Gemini
const productSearchLogSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    conversationId: { type: String, default: null, index: true },
    searchQuery: { type: String, required: true }, // Текст запроса пользователя
    productId: { type: String, default: null, index: true }, // ID найденного товара (если найден)
    productName: { type: String, default: null }, // Название товара
    brandId: { type: String, default: null, index: true }, // ID бренда
    brandName: { type: String, default: null }, // Название бренда
    intent: { type: Object, default: {} }, // Информация о намерении (brand, packageInfo, type и т.д.)
    foundProducts: { type: [String], default: [] }, // Массив ID найденных товаров
    searchResult: { type: String, enum: ['FOUND', 'NOT_FOUND', 'CLARIFICATION_NEEDED'], default: null } // Результат поиска
  },
  baseSchemaOptions
);

// Индексы для оптимизации запросов статистики
productSearchLogSchema.index({ brandId: 1, createdAt: -1 });
productSearchLogSchema.index({ productId: 1, createdAt: -1 });
productSearchLogSchema.index({ createdAt: -1 });

// Схема истории накладных
const invoiceHistorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    storeId: { type: String, required: true, index: true },
    storeOwnerId: { type: String, required: true, index: true }, // ID владельца магазина (userId)
    imageUrl: { type: String, required: true }, // URL сжатого изображения на S3
    imageKey: { type: String, required: true }, // Ключ файла на S3
    originalSize: { type: Number, default: null }, // Размер оригинального файла в байтах
    compressedSize: { type: Number, default: null }, // Размер сжатого файла в байтах
    mimeType: { type: String, required: true },
    // Данные, извлеченные из накладной ИИ
    invoiceData: {
      items: { type: [Object], default: [] },
      invoiceNumber: { type: String, default: null },
      date: { type: String, default: null },
      supplier: { type: String, default: null }
    },
    // Результаты анализа товаров
    analysisResults: {
      found: { type: [Object], default: [] },
      notFound: { type: [Object], default: [] },
      errors: { type: [Object], default: [] },
      summary: {
        total: { type: Number, default: 0 },
        found: { type: Number, default: 0 },
        notFound: { type: Number, default: 0 },
        errors: { type: Number, default: 0 }
      }
    },
    // Статус обработки накладной
    status: {
      type: String,
      enum: ['PROCESSED', 'CONFIRMED', 'CANCELLED'],
      default: 'PROCESSED'
    }
  },
  baseSchemaOptions
);

// Индексы для оптимизации запросов
invoiceHistorySchema.index({ storeId: 1, createdAt: -1 });
invoiceHistorySchema.index({ storeOwnerId: 1, createdAt: -1 });

// Схема действия в истории действий владельца магазина (вложенный документ)
const storeActivityActionSchema = new mongoose.Schema({
  actionType: { type: String, required: true }, // Тип действия (например, 'ADD_STOCK', 'REMOVE_STOCK', 'UPDATE_PRICE', 'UPDATE_QUANTITY', 'CONFIRM_INVOICE')
  description: { type: String, required: true }, // Описание действия
  metadata: { type: Object, default: {} }, // Дополнительные данные (productId, productName, quantity, price, oldValue, newValue и т.д.)
  timestamp: { type: Date, default: Date.now } // Время действия
}, { _id: false });

// Схема истории действий владельца магазина
// Одна запись = один магазин, внутри массив действий
const storeActivityHistorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    storeId: { type: String, required: true, unique: true, index: true },
    storeOwnerId: { type: String, required: true, index: true }, // ID владельца магазина (userId)
    actions: [storeActivityActionSchema] // Массив действий
  },
  baseSchemaOptions
);

// Индексы для оптимизации запросов
storeActivityHistorySchema.index({ storeId: 1 });
storeActivityHistorySchema.index({ storeOwnerId: 1 });

// Схема уведомлений
const notificationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true }, // ID пользователя, которому отправлено уведомление
    type: { type: String, required: true }, // Тип уведомления (например, 'BRAND_CONNECTION_REQUEST', 'DISTRIBUTOR_ACCEPTED_REQUEST')
    title: { type: String, required: true }, // Заголовок уведомления
    message: { type: String, required: true }, // Текст уведомления
    isRead: { type: Boolean, default: false, index: true }, // Флаг прочитанности
    metadata: { type: Object, default: {} } // Дополнительные данные (brandId, distributorId, requestId и т.д.)
  },
  baseSchemaOptions
);

// Индексы для оптимизации запросов
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

// Схема данных за один день в недельном отчете
const posDailyDataSchema = new mongoose.Schema({
  date: { type: Date, required: true }, // Дата дня
  // Суммы по способам оплаты
  cashAmount: { type: Number, default: 0, min: 0 }, // Наличные
  cardAmount: { type: Number, default: 0, min: 0 }, // Карта
  hybridAmount: { type: Number, default: 0, min: 0 }, // Гибрид (наличные + карта)
  // Общая сумма за день
  totalAmount: { type: Number, default: 0, min: 0 },
  // Количество продаж за день
  salesCount: { type: Number, default: 0, min: 0 },
  // Детализация продаж (опционально, для детального просмотра)
  sales: [{
    saleId: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    paymentMethod: { type: String, enum: ['CASH', 'CARD', 'HYBRID'], required: true },
    cashAmount: { type: Number, default: null },
    cardAmount: { type: Number, default: null },
    completedAt: { type: Date, required: true }
  }]
}, { _id: false });

// Схема недельного отчета кассы
const posWeeklyReportSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    storeId: { type: String, required: true, index: true },
    // Начало недели (понедельник)
    weekStartDate: { type: Date, required: true, index: true },
    // Конец недели (воскресенье)
    weekEndDate: { type: Date, required: true },
    // Данные по дням недели (7 дней)
    days: [posDailyDataSchema],
    // Итоговые суммы за неделю
    weeklyTotal: {
      cashAmount: { type: Number, default: 0, min: 0 },
      cardAmount: { type: Number, default: 0, min: 0 },
      hybridAmount: { type: Number, default: 0, min: 0 },
      totalAmount: { type: Number, default: 0, min: 0 },
      salesCount: { type: Number, default: 0, min: 0 }
    },
    currency: { type: String, required: true, default: 'RUB' }
  },
  baseSchemaOptions
);

// Уникальный индекс: один магазин - одна запись на неделю
posWeeklyReportSchema.index({ storeId: 1, weekStartDate: 1 }, { unique: true });
// Индекс для быстрого поиска по магазину
posWeeklyReportSchema.index({ storeId: 1, weekStartDate: -1 });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Store = mongoose.models.Store || mongoose.model('Store', storeSchema);
const Distributor =
  mongoose.models.Distributor || mongoose.model('Distributor', distributorSchema);
const SalesRepresentative =
  mongoose.models.SalesRepresentative || mongoose.model('SalesRepresentative', salesRepresentativeSchema);
const SalesRepresentativeStore =
  mongoose.models.SalesRepresentativeStore || mongoose.model('SalesRepresentativeStore', salesRepresentativeStoreSchema);
const SalesRepresentativeProduct =
  mongoose.models.SalesRepresentativeProduct || mongoose.model('SalesRepresentativeProduct', salesRepresentativeProductSchema);
const Brand = mongoose.models.Brand || mongoose.model('Brand', brandSchema);
const Category = mongoose.models.Category || mongoose.model('Category', categorySchema);
const Product = mongoose.models.Product || mongoose.model('Product', productSchema);
const Offer = mongoose.models.Offer || mongoose.model('Offer', offerSchema);
const Sale = mongoose.models.Sale || mongoose.model('Sale', saleSchema);
const CustomerSession =
  mongoose.models.CustomerSession || mongoose.model('CustomerSession', customerSessionSchema);
const SearchConversation =
  mongoose.models.SearchConversation || mongoose.model('SearchConversation', searchConversationSchema);
const SearchMessage =
  mongoose.models.SearchMessage || mongoose.model('SearchMessage', searchMessageSchema);
const SearchIntent =
  mongoose.models.SearchIntent || mongoose.model('SearchIntent', searchIntentSchema);
const SearchRequest =
  mongoose.models.SearchRequest || mongoose.model('SearchRequest', searchRequestSchema);
const SearchResult =
  mongoose.models.SearchResult || mongoose.model('SearchResult', searchResultSchema);
const Attachment =
  mongoose.models.Attachment || mongoose.model('Attachment', attachmentSchema);
const VoiceInput =
  mongoose.models.VoiceInput || mongoose.model('VoiceInput', voiceInputSchema);
const AuditEvent =
  mongoose.models.AuditEvent || mongoose.model('AuditEvent', auditEventSchema);
const AuthCredential =
  mongoose.models.AuthCredential || mongoose.model('AuthCredential', authCredentialSchema);
const VerificationCode =
  mongoose.models.VerificationCode || mongoose.model('VerificationCode', verificationCodeSchema);
const BrandDistributorRequest =
  mongoose.models.BrandDistributorRequest || mongoose.model('BrandDistributorRequest', brandDistributorRequestSchema);
const CategoryRequest =
  mongoose.models.CategoryRequest || mongoose.model('CategoryRequest', categoryRequestSchema);
const Plan =
  mongoose.models.Plan || mongoose.model('Plan', planSchema);
const CategoryPlan =
  mongoose.models.CategoryPlan || mongoose.model('CategoryPlan', categoryPlanSchema);
const DistributorProductPrice =
  mongoose.models.DistributorProductPrice || mongoose.model('DistributorProductPrice', distributorProductPriceSchema);
const DistributorActivityHistory =
  mongoose.models.DistributorActivityHistory || mongoose.model('DistributorActivityHistory', distributorActivityHistorySchema);
const ProductSearchLog =
  mongoose.models.ProductSearchLog || mongoose.model('ProductSearchLog', productSearchLogSchema);
const InvoiceHistory =
  mongoose.models.InvoiceHistory || mongoose.model('InvoiceHistory', invoiceHistorySchema);
const StoreActivityHistory =
  mongoose.models.StoreActivityHistory || mongoose.model('StoreActivityHistory', storeActivityHistorySchema);
const Notification =
  mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
const POSWeeklyReport =
  mongoose.models.POSWeeklyReport || mongoose.model('POSWeeklyReport', posWeeklyReportSchema);

async function seedDefaults() {
  const categoryCount = await Category.countDocuments();
  if (categoryCount === 0) {
    await Category.insertMany(DEFAULT_CATEGORIES);
  }

  // Гарантируем наличие дефолтных учетных записей (в т.ч. тестового админа)
  // Не перезаписываем пароли, если логин уже существует
  // eslint-disable-next-line no-restricted-syntax
  for (const credential of DEFAULT_CREDENTIALS) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await AuthCredential.findOne({ login: credential.login }).lean();
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await AuthCredential.create({
        login: credential.login,
        password: hashPassword(credential.password)
      });
    }
  }

  // Создаем тестового админа, если его еще нет
  const adminEmail = 'admin@gmail.com';
  const existingAdmin = await User.findOne({ email: adminEmail }).lean();
  if (!existingAdmin) {
    await User.create({
      id: generateId(),
      role: 'ADMIN',
      email: adminEmail,
      firstName: 'Admin',
      lastName: 'Admin',
      storeId: null,
      distributorId: null,
      isActive: true,
      currency: 'KZT'
    });
  }
}

async function connectToDatabase() {
  const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!mongoUrl) {
    throw new Error('Переменная окружения MONGO_URL не задана');
  }

  // Настройки подключения с увеличенными таймаутами
  // family: 4 принудительно использует IPv4, что решает проблемы с таймаутами
  const mongooseOptions = {
    serverSelectionTimeoutMS: 10000, // 10 секунд на выбор сервера
    family: 4, // Принудительно используем IPv4 (отключает IPv6)
    socketTimeoutMS: 45000, // 45 секунд таймаут сокета
    connectTimeoutMS: 10000, // 10 секунд на подключение
    retryWrites: true, // Повторять записи при ошибках
    retryReads: true, // Повторять чтения при ошибках
  };

  // Обработка событий подключения
  mongoose.connection.on('error', (err) => {
    console.error('Ошибка MongoDB:', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB отключен. Попытка переподключения...');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('MongoDB переподключен');
  });

  mongoose.connection.on('connected', () => {
    console.log('MongoDB подключен успешно');
  });

  // Функция переподключения с retry логикой
  let retryCount = 0;
  const maxRetries = 5;
  const retryDelay = 5000; // 5 секунд

  while (retryCount < maxRetries) {
    try {
      await mongoose.connect(mongoUrl, mongooseOptions);
      await seedDefaults();
      return; // Успешное подключение
    } catch (error) {
      retryCount++;
      console.error(`Попытка подключения ${retryCount}/${maxRetries} не удалась:`, error.message);

      if (retryCount >= maxRetries) {
        throw new Error(`Не удалось подключиться к MongoDB после ${maxRetries} попыток: ${error.message}`);
      }

      // Ждем перед следующей попыткой
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

module.exports = {
  connectToDatabase,
  models: {
    User,
    Store,
    Distributor,
    SalesRepresentative,
    SalesRepresentativeStore,
    SalesRepresentativeProduct,
    Brand,
    Category,
    Product,
    Offer,
    Sale,
    CustomerSession,
    SearchConversation,
    SearchMessage,
    SearchIntent,
    SearchRequest,
    SearchResult,
    Attachment,
    VoiceInput,
    AuditEvent,
    AuthCredential,
    VerificationCode,
    BrandDistributorRequest,
    CategoryRequest,
    Plan,
    CategoryPlan,
    DistributorProductPrice,
    DistributorActivityHistory,
    ProductSearchLog,
    InvoiceHistory,
    StoreActivityHistory,
    Notification,
    POSWeeklyReport
  }
};
