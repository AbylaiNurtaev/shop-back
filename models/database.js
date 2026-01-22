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
    storeId: { type: String, default: null },
    distributorId: { type: String, default: null },
    isActive: { type: Boolean, default: true }
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
    photos: { type: [String], default: [] }
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
    email: { type: String, required: true, unique: true },
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

const brandSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    country: { type: String, required: true },
    categoryId: { type: String, required: true },
    logoUrl: { type: String, default: null },
    // Данные аккаунта бренда
    email: { type: String, required: true },
    contactName: { type: String, default: null },
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

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Store = mongoose.models.Store || mongoose.model('Store', storeSchema);
const Distributor =
  mongoose.models.Distributor || mongoose.model('Distributor', distributorSchema);
const SalesRepresentative =
  mongoose.models.SalesRepresentative || mongoose.model('SalesRepresentative', salesRepresentativeSchema);
const SalesRepresentativeStore =
  mongoose.models.SalesRepresentativeStore || mongoose.model('SalesRepresentativeStore', salesRepresentativeStoreSchema);
const Brand = mongoose.models.Brand || mongoose.model('Brand', brandSchema);
const Category = mongoose.models.Category || mongoose.model('Category', categorySchema);
const Product = mongoose.models.Product || mongoose.model('Product', productSchema);
const Offer = mongoose.models.Offer || mongoose.model('Offer', offerSchema);
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
      isActive: true
    });
  }
}

async function connectToDatabase() {
  const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!mongoUrl) {
    throw new Error('Переменная окружения MONGO_URL не задана');
  }

  await mongoose.connect(mongoUrl);
  await seedDefaults();
}

module.exports = {
  connectToDatabase,
  models: {
    User,
    Store,
    Distributor,
    SalesRepresentative,
    SalesRepresentativeStore,
    Brand,
    Category,
    Product,
    Offer,
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
    CategoryRequest
  }
};
