# Документация API для оплаты товаров брендами

## Обзор

Система оплаты позволяет брендам оплачивать показ своих товаров в каталоге. Одна оплата действует 30 дней, после чего товар автоматически скрывается из каталога.

## Эндпоинты

### Оплата товара

**POST** `/api/products/:productId/pay`

Оплачивает показ товара в каталоге на 30 дней.

#### Авторизация
Требуется токен авторизации в заголовке:
```
Authorization: Bearer <token>
```

Пользователь должен быть брендом (role: 'BRAND') и владельцем товара.

#### Параметры пути
- `productId` (string, required) - ID товара для оплаты

#### Пример запроса
```javascript
const response = await fetch(`/api/products/${productId}/pay`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});

const data = await response.json();
```

#### Успешный ответ (200)
```json
{
  "message": "Товар успешно оплачен. Показ товара активен на 30 дней.",
  "product": {
    "id": "product_123",
    "name": "Название товара",
    "isPayed": true,
    "paymentDate": "2024-01-15T10:00:00.000Z",
    "paymentExpiresAt": "2024-02-14T10:00:00.000Z",
    ...
  }
}
```

#### Ошибки
- `403` - Пользователь не является брендом или не является владельцем товара
- `404` - Товар не найден
- `500` - Внутренняя ошибка сервера

## Логика отображения товаров

### Для брендов
Бренды видят **все свои товары**, включая:
- Неоплаченные товары (`isPayed: false`)
- Оплаченные товары (`isPayed: true`)
- Товары с истекшей оплатой

### Для всех остальных пользователей (дистрибьюторы, админы, клиенты)
Показываются **только оплаченные и не истекшие товары**:
- `isPayed: true`
- `paymentExpiresAt > текущая дата`

## Поля товара, связанные с оплатой

При получении товара в ответе API присутствуют следующие поля:

```typescript
{
  isPayed: boolean;           // Статус оплаты
  paymentDate: Date | null;   // Дата оплаты (если оплачен)
  paymentExpiresAt: Date | null; // Дата истечения оплаты (если оплачен)
}
```

## Примеры использования на фронтенде

### 1. Оплата товара

```javascript
async function payProduct(productId, token) {
  try {
    const response = await fetch(`/api/products/${productId}/pay`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Ошибка при оплате товара');
    }

    const data = await response.json();
    console.log('Товар оплачен:', data.message);
    return data.product;
  } catch (error) {
    console.error('Ошибка:', error.message);
    throw error;
  }
}
```

### 2. Проверка статуса оплаты товара

```javascript
function isProductActive(product) {
  if (!product.isPayed) return false;
  if (!product.paymentExpiresAt) return false;
  return new Date() < new Date(product.paymentExpiresAt);
}

// Использование
const product = await getProduct(productId);
if (isProductActive(product)) {
  console.log('Товар активен и показывается в каталоге');
} else {
  console.log('Товар не оплачен или срок оплаты истек');
}
```

### 3. Отображение статуса оплаты в UI

```javascript
function ProductPaymentStatus({ product }) {
  if (!product.isPayed) {
    return <Badge color="gray">Не оплачен</Badge>;
  }

  const expiresAt = new Date(product.paymentExpiresAt);
  const now = new Date();
  const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

  if (daysLeft <= 0) {
    return <Badge color="red">Оплата истекла</Badge>;
  }

  if (daysLeft <= 7) {
    return <Badge color="orange">Осталось {daysLeft} дн.</Badge>;
  }

  return <Badge color="green">Активен ({daysLeft} дн.)</Badge>;
}
```

### 4. Кнопка оплаты товара

```javascript
function PayProductButton({ product, onPaymentSuccess }) {
  const [loading, setLoading] = useState(false);
  const token = getAuthToken(); // Ваша функция получения токена

  const handlePay = async () => {
    if (!confirm('Оплатить показ товара на 30 дней?')) {
      return;
    }

    setLoading(true);
    try {
      const updatedProduct = await payProduct(product.id, token);
      onPaymentSuccess(updatedProduct);
      alert('Товар успешно оплачен!');
    } catch (error) {
      alert(`Ошибка: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button 
      onClick={handlePay} 
      disabled={loading || product.isPayed}
    >
      {loading ? 'Оплата...' : 'Оплатить показ (30 дней)'}
    </button>
  );
}
```

### 5. Фильтрация товаров по статусу оплаты (для брендов)

```javascript
function BrandProductsList({ products }) {
  const [filter, setFilter] = useState('all'); // 'all', 'payed', 'unpayed', 'expired'

  const filteredProducts = products.filter(product => {
    if (filter === 'all') return true;
    if (filter === 'payed') return product.isPayed && isProductActive(product);
    if (filter === 'unpayed') return !product.isPayed;
    if (filter === 'expired') {
      return product.isPayed && !isProductActive(product);
    }
    return true;
  });

  return (
    <div>
      <select value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">Все товары</option>
        <option value="payed">Оплаченные</option>
        <option value="unpayed">Неоплаченные</option>
        <option value="expired">Истекшие</option>
      </select>
      
      {filteredProducts.map(product => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
```

## Автоматическое отключение товаров

Товары с истекшей оплатой автоматически отключаются:
- При каждом запросе списка товаров
- При поиске товаров
- Каждый час через автоматическую задачу на сервере

После истечения срока оплаты поле `isPayed` автоматически устанавливается в `false`.

## Важные замечания

1. **Только бренды могут оплачивать товары** - другие роли получат ошибку 403
2. **Бренд может оплачивать только свои товары** - попытка оплатить чужой товар вернет ошибку 403
3. **Оплата действует 30 дней** - отсчет начинается с момента оплаты
4. **Товары автоматически скрываются** после истечения срока оплаты
5. **Бренды всегда видят все свои товары** независимо от статуса оплаты

## Типы TypeScript (для справки)

```typescript
interface Product {
  id: string;
  name: string;
  description: string | null;
  categoryId: string;
  brandId: string;
  brandName: string | null;
  images: string[];
  sku: string;
  packageInfo: string | null;
  storageLife: string;
  productionDate: Date;
  expirationDate: Date | null;
  allergens: string | null;
  ageRestrictions: string | null;
  // Поля оплаты
  isPayed: boolean;
  paymentDate: Date | null;
  paymentExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```
