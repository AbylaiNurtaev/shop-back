const { verifyToken } = require('../utils/jwt');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Токен доступа отсутствует' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Недействительный токен' });
  }

  req.user = decoded;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Доступ запрещен. Требуются права администратора' });
  }

  next();
}

function requireStoreOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  const normalizedRole = String(req.user.role || '').toUpperCase();
  if (normalizedRole !== 'STORE' && normalizedRole !== 'STORE_USER') {
    return res.status(403).json({ error: 'Доступ запрещен. Требуются права владельца магазина' });
  }

  next();
}

function requireSalesRep(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  if (req.user.role !== 'SALES_REPRESENTATIVE') {
    return res.status(403).json({ error: 'Доступ запрещен. Требуются права торгового представителя' });
  }

  next();
}

function requireStoreSeller(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  if (req.user.role !== 'STORE_SELLER') {
    return res.status(403).json({ error: 'Доступ запрещен. Требуются права продавца магазина' });
  }

  next();
}

module.exports = { authenticateToken, requireAdmin, requireStoreOwner, requireSalesRep, requireStoreSeller };
