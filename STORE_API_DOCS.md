# Инструкция по использованию API для редактирования данных магазина

## Содержание
1. [Авторизация](#авторизация)
2. [Получение данных магазина](#получение-данных-магазина)
3. [Обновление данных магазина](#обновление-данных-магазина)
4. [Структура данных магазина](#структура-данных-магазина)
5. [Примеры использования](#примеры-использования)
6. [Обработка ошибок](#обработка-ошибок)

---

## Авторизация

### 1. Получение токена доступа

Для работы с API магазина необходимо получить токен доступа через эндпоинт авторизации.

**Эндпоинт:** `POST /api/auth/login`

**Формат запроса:**
- Учетные данные передаются в формате Base64 в поле `credentials`
- Формат: `email:password` → кодируется в Base64

**Пример запроса:**

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "credentials": "dXNlckBleGFtcGxlLmNvbTpwYXNzd29yZA=="
  }'
```

**Пример на JavaScript:**

```javascript
const email = 'user@example.com';
const password = 'password';
const credentials = btoa(`${email}:${password}`);

const response = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ credentials })
});

const data = await response.json();
const accessToken = data.accessToken;
```

**Ответ:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600,
  "user": {
    "id": "user_123",
    "role": "STORE",
    "email": "user@example.com"
  }
}
```

### 2. Использование токена

Все запросы к защищенным эндпоинтам требуют передачи токена в заголовке `Authorization`:

```
Authorization: Bearer <accessToken>
```

---

## Получение данных магазина

### 1. Получение ID своего магазина

Если вы знаете свой `userId` из ответа авторизации, можно получить информацию о пользователе, включая `storeId`:

**Эндпоинт:** `GET /api/users/:userId`

**Пример запроса:**

```bash
curl -X GET http://localhost:3000/api/users/user_123 \
  -H "Authorization: Bearer <accessToken>"
```

**Ответ:**
```json
{
  "id": "user_123",
  "role": "STORE",
  "email": "user@example.com",
  "firstName": "Иван",
  "storeId": "store_456",
  "distributorId": null,
  "isActive": true,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

### 2. Получение данных магазина по ID

**Эндпоинт:** `GET /api/stores/:storeId`

**Пример запроса:**

```bash
curl -X GET http://localhost:3000/api/stores/store_456 \
  -H "Authorization: Bearer <accessToken>"
```

**Ответ:**
```json
{
  "id": "store_456",
  "name": "Магазин на Ленина",
  "address": "ул. Ленина, д. 10",
  "location": "https://maps.google.com/?q=55.7558,37.6173",
  "locationCoords": {
    "lat": 55.7558,
    "lng": 37.6173
  },
  "description": "Описание магазина",
  "photos": [
    "https://example.com/photo1.jpg",
    "https://example.com/photo2.jpg"
  ],
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

---

## Обновление данных магазина

### Эндпоинт: `PUT /api/stores/:storeId`

Позволяет обновить данные магазина. Можно обновить все поля или только некоторые.

**Требования:**
- Авторизация обязательна (токен в заголовке `Authorization`)
- `storeId` в URL должен соответствовать ID магазина

**Поля, которые можно обновить:**
- `name` (string) - название магазина
- `address` (string) - адрес магазина
- `location` (string или object) - ссылка на карту или объект с полем `link`
- `description` (string, опционально) - описание магазина
- `photos` (array of strings, опционально) - массив URL фотографий

**Важно:**
- При обновлении `location` автоматически пересчитываются координаты (`locationCoords`)
- Можно передать только те поля, которые нужно обновить
- Поля, которые не переданы, останутся без изменений

**Пример запроса (обновление всех полей):**

```bash
curl -X PUT http://localhost:3000/api/stores/store_456 \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Новое название магазина",
    "address": "ул. Пушкина, д. 20",
    "location": "https://maps.google.com/?q=55.7500,37.6000",
    "description": "Обновленное описание магазина",
    "photos": [
      "https://example.com/new_photo1.jpg",
      "https://example.com/new_photo2.jpg"
    ]
  }'
```

**Пример запроса (частичное обновление):**

```bash
curl -X PUT http://localhost:3000/api/stores/store_456 \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Обновленное название",
    "description": "Новое описание"
  }'
```

**Пример на JavaScript:**

```javascript
const storeId = 'store_456';
const accessToken = 'your_access_token';

const response = await fetch(`http://localhost:3000/api/stores/${storeId}`, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Новое название магазина',
    address: 'ул. Пушкина, д. 20',
    location: 'https://maps.google.com/?q=55.7500,37.6000',
    description: 'Обновленное описание',
    photos: [
      'https://example.com/photo1.jpg',
      'https://example.com/photo2.jpg'
    ]
  })
});

const updatedStore = await response.json();
console.log('Обновленный магазин:', updatedStore);
```

**Ответ:**
```json
{
  "id": "store_456",
  "name": "Новое название магазина",
  "address": "ул. Пушкина, д. 20",
  "location": "https://maps.google.com/?q=55.7500,37.6000",
  "locationCoords": {
    "lat": 55.7500,
    "lng": 37.6000
  },
  "description": "Обновленное описание",
  "photos": [
    "https://example.com/photo1.jpg",
    "https://example.com/photo2.jpg"
  ],
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-15T12:30:00.000Z"
}
```

---

## Структура данных магазина

### Обязательные поля:
- `id` (string) - уникальный идентификатор магазина
- `name` (string) - название магазина
- `address` (string) - адрес магазина
- `location` (string) - ссылка на карту (Google Maps, Yandex Maps и т.д.)

### Опциональные поля:
- `description` (string) - описание магазина
- `photos` (array of strings) - массив URL фотографий магазина
- `locationCoords` (object) - координаты магазина (автоматически вычисляются из `location`)
  - `lat` (number) - широта
  - `lng` (number) - долгота

### Автоматические поля:
- `createdAt` (ISO 8601 date string) - дата создания
- `updatedAt` (ISO 8601 date string) - дата последнего обновления

---

## Примеры использования

### Полный пример на JavaScript (React/Next.js)

```javascript
// storeService.js
const API_BASE_URL = 'http://localhost:3000/api';

class StoreService {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  // Получение данных магазина
  async getStore(storeId) {
    const response = await fetch(`${API_BASE_URL}/stores/${storeId}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка получения магазина: ${response.statusText}`);
    }

    return await response.json();
  }

  // Обновление данных магазина
  async updateStore(storeId, data) {
    const response = await fetch(`${API_BASE_URL}/stores/${storeId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Ошибка обновления магазина');
    }

    return await response.json();
  }

  // Получение информации о пользователе (для получения storeId)
  async getUser(userId) {
    const response = await fetch(`${API_BASE_URL}/users/${userId}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка получения пользователя: ${response.statusText}`);
    }

    return await response.json();
  }
}

// Использование в компоненте
const MyStoreComponent = () => {
  const [store, setStore] = useState(null);
  const [loading, setLoading] = useState(true);
  const accessToken = localStorage.getItem('accessToken');
  const userId = localStorage.getItem('userId');
  const storeService = new StoreService(accessToken);

  useEffect(() => {
    const loadStore = async () => {
      try {
        // Сначала получаем информацию о пользователе, чтобы узнать storeId
        const user = await storeService.getUser(userId);
        
        if (user.storeId) {
          // Получаем данные магазина
          const storeData = await storeService.getStore(user.storeId);
          setStore(storeData);
        }
      } catch (error) {
        console.error('Ошибка загрузки магазина:', error);
      } finally {
        setLoading(false);
      }
    };

    loadStore();
  }, []);

  const handleUpdate = async (updatedData) => {
    try {
      const updatedStore = await storeService.updateStore(store.id, updatedData);
      setStore(updatedStore);
      alert('Данные магазина успешно обновлены!');
    } catch (error) {
      console.error('Ошибка обновления:', error);
      alert(`Ошибка: ${error.message}`);
    }
  };

  if (loading) return <div>Загрузка...</div>;
  if (!store) return <div>Магазин не найден</div>;

  return (
    <div>
      <h1>{store.name}</h1>
      <p>{store.address}</p>
      <button onClick={() => handleUpdate({ name: 'Новое название' })}>
        Обновить название
      </button>
    </div>
  );
};
```

### Пример на Python

```python
import requests
import base64

class StoreAPI:
    def __init__(self, base_url, access_token):
        self.base_url = base_url
        self.headers = {
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/json'
        }
    
    def get_store(self, store_id):
        response = requests.get(
            f'{self.base_url}/api/stores/{store_id}',
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()
    
    def update_store(self, store_id, data):
        response = requests.put(
            f'{self.base_url}/api/stores/{store_id}',
            headers=self.headers,
            json=data
        )
        response.raise_for_status()
        return response.json()

# Использование
base_url = 'http://localhost:3000'
access_token = 'your_access_token'

api = StoreAPI(base_url, access_token)

# Получение магазина
store = api.get_store('store_456')
print(f"Магазин: {store['name']}")

# Обновление магазина
updated_store = api.update_store('store_456', {
    'name': 'Новое название',
    'description': 'Новое описание'
})
print(f"Обновленный магазин: {updated_store['name']}")
```

---

## Обработка ошибок

### Коды ошибок:

- **400 Bad Request** - Отсутствуют обязательные поля или неверный формат данных
- **401 Unauthorized** - Токен доступа отсутствует или недействителен
- **403 Forbidden** - Доступ запрещен
- **404 Not Found** - Магазин не найден
- **500 Internal Server Error** - Внутренняя ошибка сервера

### Примеры ответов с ошибками:

**401 Unauthorized:**
```json
{
  "error": "Токен доступа отсутствует"
}
```

**404 Not Found:**
```json
{
  "error": "Магазин не найден"
}
```

**400 Bad Request:**
```json
{
  "error": "Отсутствуют обязательные поля"
}
```

### Обработка ошибок в коде:

```javascript
try {
  const response = await fetch(`http://localhost:3000/api/stores/${storeId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updateData)
  });

  if (!response.ok) {
    const error = await response.json();
    
    switch (response.status) {
      case 401:
        console.error('Требуется авторизация');
        // Перенаправить на страницу входа
        break;
      case 404:
        console.error('Магазин не найден');
        break;
      case 400:
        console.error('Неверные данные:', error.error);
        break;
      default:
        console.error('Ошибка сервера:', error.error);
    }
    
    throw new Error(error.error);
  }

  const updatedStore = await response.json();
  return updatedStore;
} catch (error) {
  console.error('Ошибка обновления магазина:', error);
  throw error;
}
```

---

## Важные замечания

1. **Безопасность токена:** Храните токен доступа в безопасном месте (например, в `localStorage` для веб-приложений или в защищенном хранилище для мобильных приложений)

2. **Срок действия токена:** Токен доступа имеет ограниченный срок действия (по умолчанию 3600 секунд). При истечении токена необходимо повторно авторизоваться

3. **Формат location:** Поле `location` может быть:
   - Строкой с URL карты: `"https://maps.google.com/?q=55.7558,37.6173"`
   - Объектом с полем `link`: `{ "link": "https://maps.google.com/?q=55.7558,37.6173" }`

4. **Автоматический расчет координат:** При обновлении поля `location` система автоматически извлекает координаты из ссылки и сохраняет их в `locationCoords`

5. **Частичное обновление:** Можно обновить только нужные поля, не передавая остальные

---

## Дополнительные эндпоинты

### Получение списка всех магазинов

**Эндпоинт:** `GET /api/stores`

**Пример:**
```bash
curl -X GET http://localhost:3000/api/stores \
  -H "Authorization: Bearer <accessToken>"
```

**Ответ:**
```json
{
  "items": [
    {
      "id": "store_1",
      "name": "Магазин 1",
      ...
    },
    {
      "id": "store_2",
      "name": "Магазин 2",
      ...
    }
  ],
  "total": 2
}
```

---

## Поддержка

При возникновении проблем или вопросов обращайтесь к администратору системы.
