# Инструкция по использованию API для управления складом

## Содержание
1. [Обзор](#обзор)
2. [Авторизация](#авторизация)
3. [Функционал для владельца магазина](#функционал-для-владельца-магазина)
4. [Функционал для продавца (QR-сканер)](#функционал-для-продавца-qr-сканер)
5. [Примеры использования](#примеры-использования)
6. [Обработка ошибок](#обработка-ошибок)

---

## Обзор

API склада разделен на два уровня доступа:

- **Владелец магазина (STORE)**: Полный доступ к складу
  - Просмотр всего инвентаря
  - Приход товаров на склад
  - Уход товаров со склада
  - Обновление количества товаров
  - Аналитика склада

- **Продавец магазина (STORE_SELLER)**: Ограниченный доступ (кассир)
  - Поиск товара по штрих-коду (QR-сканер)
  - Быстрый приход товара по штрих-коду

---

## Авторизация

Все эндпоинты требуют авторизации. Токен передается в заголовке:

```
Authorization: Bearer <accessToken>
```

Для получения токена используйте эндпоинт `POST /api/auth/login`.

---

## Функционал для владельца магазина

### 1. Получение всего инвентаря склада

**Эндпоинт:** `GET /api/warehouse/inventory`

**Требования:**
- Роль: `STORE` (владелец магазина)
- Авторизация обязательна

**Ответ:**
```json
{
  "items": [
    {
      "id": "offer_123",
      "productId": "product_456",
      "storeId": "store_789",
      "price": 100,
      "currency": "RUB",
      "isAvailable": true,
      "quantity": 50,
      "product": {
        "id": "product_456",
        "name": "Товар 1",
        "sku": "SKU-12345",
        "brandName": "Бренд 1",
        "categoryId": "category_1"
      }
    }
  ],
  "total": 1
}
```

**Пример запроса:**
```bash
curl -X GET http://localhost:3000/api/warehouse/inventory \
  -H "Authorization: Bearer <accessToken>"
```

---

### 2. Приход товара на склад

**Эндпоинт:** `POST /api/warehouse/stock/add`

**Требования:**
- Роль: `STORE` (владелец магазина)
- Авторизация обязательна

**Тело запроса:**
```json
{
  "productId": "product_456",
  "quantity": 10,
  "price": 100,
  "currency": "RUB"
}
```

**Параметры:**
- `productId` (string, обязательный) - ID товара
- `quantity` (number, обязательный) - Количество товара для добавления (должно быть > 0)
- `price` (number, опционально) - Цена товара (по умолчанию: 0)
- `currency` (string, опционально) - Валюта (по умолчанию: "RUB")

**Примечание:** Если оффер для этого товара не существует, он будет создан автоматически.

**Ответ:**
```json
{
  "message": "Товар успешно добавлен на склад",
  "product": {
    "id": "product_456",
    "name": "Товар 1",
    "sku": "SKU-12345",
    "brandName": "Бренд 1"
  },
  "offer": {
    "id": "offer_123",
    "quantity": 60,
    "price": 100,
    "currency": "RUB"
  }
}
```

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/warehouse/stock/add \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "product_456",
    "quantity": 10,
    "price": 100,
    "currency": "RUB"
  }'
```

---

### 3. Уход товара со склада

**Эндпоинт:** `POST /api/warehouse/stock/remove`

**Требования:**
- Роль: `STORE` (владелец магазина)
- Авторизация обязательна

**Тело запроса:**
```json
{
  "productId": "product_456",
  "quantity": 5
}
```

**Параметры:**
- `productId` (string, обязательный) - ID товара
- `quantity` (number, обязательный) - Количество товара для списания (должно быть > 0)

**Ответ:**
```json
{
  "message": "Товар успешно списан со склада",
  "product": {
    "id": "product_456",
    "name": "Товар 1",
    "sku": "SKU-12345",
    "brandName": "Бренд 1"
  },
  "offer": {
    "id": "offer_123",
    "quantity": 55,
    "price": 100,
    "currency": "RUB"
  }
}
```

**Ошибки:**
- `400 Bad Request` - Если количество для списания больше текущего количества на складе
- `404 Not Found` - Если товар не найден на складе

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/warehouse/stock/remove \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "product_456",
    "quantity": 5
  }'
```

---

### 4. Обновление количества товара

**Эндпоинт:** `PUT /api/warehouse/stock/update`

**Требования:**
- Роль: `STORE` (владелец магазина)
- Авторизация обязательна

**Тело запроса:**
```json
{
  "productId": "product_456",
  "quantity": 100,
  "price": 150,
  "currency": "RUB"
}
```

**Параметры:**
- `productId` (string, обязательный) - ID товара
- `quantity` (number, обязательный) - Новое количество товара (должно быть >= 0)
- `price` (number, опционально) - Новая цена товара
- `currency` (string, опционально) - Новая валюта

**Ответ:**
```json
{
  "message": "Количество товара успешно обновлено",
  "product": {
    "id": "product_456",
    "name": "Товар 1",
    "sku": "SKU-12345",
    "brandName": "Бренд 1"
  },
  "offer": {
    "id": "offer_123",
    "quantity": 100,
    "price": 150,
    "currency": "RUB"
  }
}
```

**Ошибки:**
- `404 Not Found` - Если товар не найден на складе

**Пример запроса:**
```bash
curl -X PUT http://localhost:3000/api/warehouse/stock/update \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "product_456",
    "quantity": 100,
    "price": 150,
    "currency": "RUB"
  }'
```

---

### 5. Аналитика склада

**Эндпоинт:** `GET /api/warehouse/analytics`

**Требования:**
- Роль: `STORE` (владелец магазина)
- Авторизация обязательна

**Query параметры:**
- `threshold` (number, опционально) - Порог для определения низкого остатка (по умолчанию: 5)

**Ответ:**
```json
{
  "summary": {
    "totalItems": 50,
    "totalQuantity": 1500,
    "lowStockCount": 3,
    "expiringCount": 2
  },
  "lowStockItems": [
    {
      "offerId": "offer_123",
      "productId": "product_456",
      "productName": "Товар 1",
      "sku": "SKU-12345",
      "currentQuantity": 3,
      "threshold": 5
    }
  ],
  "expiringItems": [
    {
      "offerId": "offer_789",
      "productId": "product_999",
      "productName": "Товар 2",
      "sku": "SKU-67890",
      "quantity": 20,
      "expiryDate": "2024-02-01T00:00:00.000Z",
      "daysLeft": 3
    }
  ]
}
```

**Пример запроса:**
```bash
curl -X GET "http://localhost:3000/api/warehouse/analytics?threshold=10" \
  -H "Authorization: Bearer <accessToken>"
```

---

## Функционал для продавца магазина (QR-сканер)

### 1. Поиск товара по штрих-коду

**Эндпоинт:** `GET /api/warehouse/barcode/:barcode`

**Требования:**
- Роль: `STORE_SELLER` (продавец магазина / кассир)
- Авторизация обязательна

**Параметры URL:**
- `barcode` (string, обязательный) - Штрих-код (SKU) товара

**Примечание:** Продавец автоматически работает с магазином, к которому он привязан при регистрации.

**Ответ:**
```json
{
  "product": {
    "id": "product_456",
    "name": "Товар 1",
    "sku": "SKU-12345",
    "brandName": "Бренд 1",
    "categoryId": "category_1"
  },
  "offer": {
    "id": "offer_123",
    "quantity": 50,
    "price": 100,
    "currency": "RUB"
  }
}
```

**Примечание:** Если оффер не найден для магазина, поле `offer` будет `null`.

**Пример запроса:**
```bash
curl -X GET "http://localhost:3000/api/warehouse/barcode/SKU-12345" \
  -H "Authorization: Bearer <accessToken>"
```

---

### 2. Быстрый приход товара по штрих-коду

**Эндпоинт:** `POST /api/warehouse/barcode/quick-add`

**Требования:**
- Роль: `STORE_SELLER` (продавец магазина / кассир)
- Авторизация обязательна

**Тело запроса:**
```json
{
  "barcode": "SKU-12345",
  "quantity": 10
}
```

**Параметры:**
- `barcode` (string, обязательный) - Штрих-код (SKU) товара
- `quantity` (number, обязательный) - Количество товара для добавления (должно быть > 0)

**Примечание:** Продавец автоматически работает с магазином, к которому он привязан при регистрации.

**Ответ:**
```json
{
  "message": "Товар успешно добавлен на склад",
  "product": {
    "id": "product_456",
    "name": "Товар 1",
    "sku": "SKU-12345",
    "brandName": "Бренд 1"
  },
  "offer": {
    "id": "offer_123",
    "quantity": 60,
    "price": 0,
    "currency": "RUB"
  }
}
```

**Примечание:** 
- Если оффер не существует, он будет создан автоматически с ценой 0 (цену можно установить позже).
- Если оффер уже существует, количество будет увеличено на указанное значение.

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/warehouse/barcode/quick-add \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "barcode": "SKU-12345",
    "quantity": 10
  }'
```

---

## Примеры использования

### Пример на JavaScript (React/Next.js)

```javascript
// warehouseService.js
const API_BASE_URL = 'http://localhost:3000/api';

class WarehouseService {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  // Получение инвентаря (для владельца магазина)
  async getInventory() {
    const response = await fetch(`${API_BASE_URL}/warehouse/inventory`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка получения инвентаря: ${response.statusText}`);
    }

    return await response.json();
  }

  // Приход товара (для владельца магазина)
  async addStock(productId, quantity, price = 0, currency = 'RUB') {
    const response = await fetch(`${API_BASE_URL}/warehouse/stock/add`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ productId, quantity, price, currency })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Ошибка добавления товара');
    }

    return await response.json();
  }

  // Поиск товара по штрих-коду (для продавца магазина)
  async findProductByBarcode(barcode) {
    const response = await fetch(`${API_BASE_URL}/warehouse/barcode/${barcode}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка поиска товара: ${response.statusText}`);
    }

    return await response.json();
  }

  // Быстрый приход товара (для продавца магазина)
  async quickAddStock(barcode, quantity) {
    const response = await fetch(`${API_BASE_URL}/warehouse/barcode/quick-add`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ barcode, quantity })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Ошибка добавления товара');
    }

    return await response.json();
  }

  // Аналитика склада (для владельца магазина)
  async getAnalytics(threshold = 5) {
    const response = await fetch(`${API_BASE_URL}/warehouse/analytics?threshold=${threshold}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка получения аналитики: ${response.statusText}`);
    }

    return await response.json();
  }
}

// Использование в компоненте
const WarehouseComponent = () => {
  const [inventory, setInventory] = useState([]);
  const accessToken = localStorage.getItem('accessToken');
  const warehouseService = new WarehouseService(accessToken);

  useEffect(() => {
    const loadInventory = async () => {
      try {
        const data = await warehouseService.getInventory();
        setInventory(data.items);
      } catch (error) {
        console.error('Ошибка загрузки инвентаря:', error);
      }
    };

    loadInventory();
  }, []);

  return (
    <div>
      <h1>Склад</h1>
      {/* Отображение инвентаря */}
    </div>
  );
};
```

### Пример QR-сканера для продавца

```javascript
// QRScannerComponent.js
const QRScannerComponent = () => {
  const [scannedBarcode, setScannedBarcode] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [product, setProduct] = useState(null);
  const accessToken = localStorage.getItem('accessToken');
  const warehouseService = new WarehouseService(accessToken);

  const handleScan = async (barcode) => {
    try {
      const data = await warehouseService.findProductByBarcode(barcode);
      setProduct(data);
      setScannedBarcode(barcode);
    } catch (error) {
      alert(`Товар не найден: ${error.message}`);
    }
  };

  const handleQuickAdd = async () => {
    if (!scannedBarcode || !quantity) {
      alert('Заполните все поля');
      return;
    }

    try {
      const result = await warehouseService.quickAddStock(scannedBarcode, quantity);
      alert(`Товар добавлен! Текущее количество: ${result.offer.quantity}`);
      setScannedBarcode('');
      setQuantity(1);
      setProduct(null);
    } catch (error) {
      alert(`Ошибка: ${error.message}`);
    }
  };

  return (
    <div>
      <h1>QR-сканер</h1>
      <input
        type="text"
        placeholder="Штрих-код"
        value={scannedBarcode}
        onChange={(e) => handleScan(e.target.value)}
      />
      {product && (
        <div>
          <h2>{product.product.name}</h2>
          <p>SKU: {product.product.sku}</p>
          <p>Текущее количество: {product.offer?.quantity || 0}</p>
          <input
            type="number"
            min="1"
            value={quantity}
            onChange={(e) => setQuantity(parseInt(e.target.value))}
          />
          <button onClick={handleQuickAdd}>Добавить на склад</button>
        </div>
      )}
    </div>
  );
};
```

---

## Обработка ошибок

### Коды ошибок:

- **400 Bad Request** - Отсутствуют обязательные поля или неверный формат данных
- **401 Unauthorized** - Токен доступа отсутствует или недействителен
- **403 Forbidden** - Доступ запрещен (неверная роль или нет доступа к магазину)
- **404 Not Found** - Магазин, товар или оффер не найден
- **500 Internal Server Error** - Внутренняя ошибка сервера

### Примеры ответов с ошибками:

**401 Unauthorized:**
```json
{
  "error": "Токен доступа отсутствует"
}
```

**403 Forbidden:**
```json
{
  "error": "Доступ запрещен. Требуются права владельца магазина"
}
```

**404 Not Found:**
```json
{
  "error": "Товар с таким штрих-кодом не найден"
}
```

**400 Bad Request:**
```json
{
  "error": "Недостаточно товара на складе"
}
```

---

## Важные замечания

1. **Разделение ролей:**
   - Владелец магазина (`STORE`) имеет полный доступ ко всем функциям склада
   - Продавец магазина (`STORE_SELLER`) - кассир, может только сканировать штрих-коды и быстро добавлять товары
   - Торговый представитель (`SALES_REPRESENTATIVE`) - работает от дистрибьютора, имеет свой функционал

2. **Работа с товарами (для владельца магазина):**
   - Все операции выполняются по `productId`, а не по `offerId`
   - Если оффер для товара не существует, он создается автоматически при добавлении товара на склад
   - При создании оффера автоматически проверяется связь бренда с дистрибьютором магазина

3. **Доступ продавца магазина:**
   - Продавец магазина привязан к одному конкретному магазину при регистрации
   - Все операции продавца автоматически выполняются в его магазине
   - Не нужно указывать `storeId` в запросах

4. **Быстрый приход товара:**
   - Если оффер не существует, он создается автоматически с ценой 0
   - Цену можно установить позже через API офферов или при следующем обновлении

5. **Штрих-код:**
   - Используется поле `sku` из модели `Product`
   - Штрих-код должен быть уникальным для каждого товара

---

## Поддержка

При возникновении проблем или вопросов обращайтесь к администратору системы.
