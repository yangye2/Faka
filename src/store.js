const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'store.db');
const legacyDataFile = path.join(dataDir, 'store.json');
const DEFAULT_SITE_NAME = '简易自动发卡平台';
const DEFAULT_ORDER_PAY_EXPIRE_MINUTES = 30;
const SCHEMA_VERSION = 6;
const dbExistedBeforeOpen = fs.existsSync(dbFile);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(dbFile);
initDb();
maybeMigrateFromJson();

function initDb() {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      card_text TEXT NOT NULL,
      is_sold INTEGER NOT NULL DEFAULT 0,
      sold_at TEXT NOT NULL DEFAULT '',
      order_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      delivered_card TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      pay_order_id TEXT NOT NULL DEFAULT '',
      pay_state INTEGER NOT NULL DEFAULT 0,
      pay_data_type TEXT NOT NULL DEFAULT '',
      pay_url TEXT NOT NULL DEFAULT '',
      paid_at TEXT NOT NULL DEFAULT '',
      pay_msg TEXT NOT NULL DEFAULT '',
      pay_last_query_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      order_no TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cards_product_sold ON cards(product_id, is_sold);
    CREATE INDEX IF NOT EXISTS idx_orders_product_id ON orders(product_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created_id ON orders(id DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_logs_created_id ON payment_logs(id DESC);
  `);

  const stmt = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  stmt.run('site_name', DEFAULT_SITE_NAME);
  stmt.run('payment_config', JSON.stringify(createDefaultPaymentConfig()));
  stmt.run('order_pay_expire_minutes', String(DEFAULT_ORDER_PAY_EXPIRE_MINUTES));
  runDbMigrations();
}

function runDbMigrations() {
  let version = getUserVersion();
  if (version >= SCHEMA_VERSION) return;
  if (version < 1) {
    migrateToV1();
    setUserVersion(1);
    version = 1;
  }
  if (version < 2) {
    migrateToV2();
    setUserVersion(2);
    version = 2;
  }
  if (version < 3) {
    migrateToV3();
    setUserVersion(3);
    version = 3;
  }
  if (version < 4) {
    migrateToV4();
    setUserVersion(4);
    version = 4;
  }
  if (version < 5) {
    migrateToV5();
    setUserVersion(5);
    version = 5;
  }
  if (version < 6) {
    migrateToV6();
    setUserVersion(6);
    version = 6;
  }
}

function migrateToV1() {
  // v1: 补齐历史库支付相关字段，避免旧库启动时报列不存在
  ensureColumn('products', 'description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('products', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('cards', 'sold_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('cards', 'order_id', 'INTEGER');
  ensureColumn('orders', 'buyer_email', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('orders', 'pay_order_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('orders', 'pay_state', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('orders', 'pay_url', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('orders', 'paid_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('orders', 'pay_msg', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('orders', 'pay_last_query_at', "TEXT NOT NULL DEFAULT ''");
}

function migrateToV2() {
  // v2: 增加支付日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      order_no TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
}

function migrateToV3() {
  // v3: 统一补齐索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cards_product_sold ON cards(product_id, is_sold);
    CREATE INDEX IF NOT EXISTS idx_orders_product_id ON orders(product_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created_id ON orders(id DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_logs_created_id ON payment_logs(id DESC);
  `);
}

function migrateToV4() {
  // v4: 商品排序字段
  ensureColumn('products', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_sort_order ON products(sort_order ASC, id DESC);');
}

function migrateToV5() {
  // v5: 记录支付返回类型（payurl / qrcode / urlscheme）
  ensureColumn('orders', 'pay_data_type', "TEXT NOT NULL DEFAULT ''");
}

function migrateToV6() {
  // v6: 增加订单支付倒计时配置项
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(
    'order_pay_expire_minutes',
    String(DEFAULT_ORDER_PAY_EXPIRE_MINUTES)
  );
}

function getUserVersion() {
  const row = db.prepare('PRAGMA user_version').get();
  return Number((row && row.user_version) || 0);
}

function setUserVersion(version) {
  db.exec(`PRAGMA user_version = ${Number(version)}`);
}

function ensureColumn(table, column, definition) {
  if (hasColumn(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function hasColumn(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => String(r.name || '') === String(column));
}

function maybeMigrateFromJson() {
  if (!fs.existsSync(legacyDataFile)) return;
  if (hasAnyData()) return;

  let raw;
  try {
    raw = fs.readFileSync(legacyDataFile, 'utf8');
  } catch (_err) {
    return;
  }

  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch (_err) {
    return;
  }

  if (!legacy || typeof legacy !== 'object') return;

  withTransaction(() => {
    if (Array.isArray(legacy.products)) {
      const stmt = db.prepare(
        'INSERT INTO products(id, name, description, price_cents, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const p of legacy.products) {
        stmt.run(
          Number(p.id || 0),
          String(p.name || ''),
          String(p.description || ''),
          Number(p.price_cents || 0),
          p.is_active ? 1 : 0,
          String(p.created_at || now())
        );
      }
    }

    if (Array.isArray(legacy.cards)) {
      const stmt = db.prepare(
        'INSERT INTO cards(id, product_id, card_text, is_sold, sold_at, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const c of legacy.cards) {
        stmt.run(
          Number(c.id || 0),
          Number(c.product_id || 0),
          String(c.card_text || ''),
          c.is_sold ? 1 : 0,
          String(c.sold_at || ''),
          c.order_id === null || c.order_id === undefined ? null : Number(c.order_id),
          String(c.created_at || now())
        );
      }
    }

    if (Array.isArray(legacy.orders)) {
      const stmt = db.prepare(
        `INSERT INTO orders(
          id, order_no, product_id, product_name, buyer_email, amount_cents, status,
          delivered_card, created_at, pay_order_id, pay_state, pay_data_type, pay_url, paid_at, pay_msg, pay_last_query_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const o of legacy.orders) {
        const status = String(o.status || (o.delivered_card ? 'delivered' : 'pending_payment'));
        const payState = Number.isNaN(Number(o.pay_state))
          ? status === 'delivered'
            ? 2
            : 0
          : Number(o.pay_state);

        stmt.run(
          Number(o.id || 0),
          String(o.order_no || createOrderNo()),
          Number(o.product_id || 0),
          String(o.product_name || ''),
          String(o.buyer_email || ''),
          Number(o.amount_cents || 0),
          status,
          String(o.delivered_card || ''),
          String(o.created_at || now()),
          String(o.pay_order_id || ''),
          payState,
          String(o.pay_data_type || ''),
          String(o.pay_url || ''),
          String(o.paid_at || ''),
          String(o.pay_msg || ''),
          String(o.pay_last_query_at || '')
        );
      }
    }

    if (legacy.config && typeof legacy.config === 'object') {
      const siteName = String(legacy.config.site_name || '').trim();
      if (siteName) {
        setSetting('site_name', siteName);
      }

      if (legacy.config.payment && typeof legacy.config.payment === 'object') {
        const payment = {
          ...createDefaultPaymentConfig(),
          ...legacy.config.payment,
          enabled: !!legacy.config.payment.enabled,
        };
        setSetting('payment_config', JSON.stringify(payment));
      }
    }

    syncAutoincrement('products');
    syncAutoincrement('cards');
    syncAutoincrement('orders');
  });
}

function hasAnyData() {
  const row = db
    .prepare(
      'SELECT (SELECT COUNT(1) FROM products) AS productCount, (SELECT COUNT(1) FROM cards) AS cardCount, (SELECT COUNT(1) FROM orders) AS orderCount'
    )
    .get();
  return Number(row.productCount || 0) > 0 || Number(row.cardCount || 0) > 0 || Number(row.orderCount || 0) > 0;
}

function syncAutoincrement(table) {
  if (!['products', 'cards', 'orders'].includes(table)) return;
  const maxIdRow = db.prepare(`SELECT COALESCE(MAX(id), 0) AS maxId FROM ${table}`).get();
  const maxId = Number(maxIdRow.maxId || 0);
  db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(maxId, table);
}

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function createDefaultPaymentConfig() {
  return {
    enabled: false,
    mapi_url: 'https://pay.heisenlin.dpdns.org/mapi.php',
    api_url: 'https://pay.heisenlin.dpdns.org/api.php',
    pid: '',
    key: '',
    pay_type: 'alipay',
    device: 'pc',
    notify_url: '',
    return_url: '',
    subject_prefix: '卡密购买',
    sign_type: 'MD5',
  };
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  return String(row.value || '');
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    String(value)
  );
}

function ensureDatabaseReady() {
  return {
    dataDir,
    dbFile,
    exists: fs.existsSync(dbFile),
    createdOnBoot: !dbExistedBeforeOpen,
  };
}

function mapProductRow(row) {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    description: String(row.description || ''),
    price_cents: Number(row.price_cents || 0),
    sort_order: Number(row.sort_order || 0),
    is_active: Number(row.is_active || 0) === 1,
    created_at: String(row.created_at || ''),
    stock: Number(row.stock || 0),
  };
}

function mapCardRow(row) {
  return {
    id: Number(row.id),
    product_id: Number(row.product_id || 0),
    card_text: String(row.card_text || ''),
    is_sold: Number(row.is_sold || 0) === 1,
    sold_at: String(row.sold_at || ''),
    order_id: row.order_id === null || row.order_id === undefined ? null : Number(row.order_id),
    created_at: String(row.created_at || ''),
  };
}

function mapOrderRow(row) {
  return {
    id: Number(row.id),
    order_no: String(row.order_no || ''),
    product_id: Number(row.product_id || 0),
    product_name: String(row.product_name || ''),
    buyer_email: String(row.buyer_email || ''),
    amount_cents: Number(row.amount_cents || 0),
    status: String(row.status || 'pending_payment'),
    delivered_card: String(row.delivered_card || ''),
    created_at: String(row.created_at || ''),
    pay_order_id: String(row.pay_order_id || ''),
    pay_state: Number(row.pay_state || 0),
    pay_data_type: String(row.pay_data_type || ''),
    pay_url: String(row.pay_url || ''),
    paid_at: String(row.paid_at || ''),
    pay_msg: String(row.pay_msg || ''),
    pay_last_query_at: String(row.pay_last_query_at || ''),
  };
}

function mapPaymentLogRow(row) {
  return {
    id: Number(row.id),
    scene: String(row.scene || ''),
    level: String(row.level || 'info'),
    order_no: String(row.order_no || ''),
    payload: String(row.payload || ''),
    created_at: String(row.created_at || ''),
  };
}

function listActiveProductsWithStock() {
  const rows = db
    .prepare(
      `SELECT
        p.id, p.name, p.description, p.price_cents, p.is_active, p.created_at,
        p.sort_order,
        COALESCE(SUM(CASE WHEN c.is_sold = 0 THEN 1 ELSE 0 END), 0) AS stock
      FROM products p
      LEFT JOIN cards c ON c.product_id = p.id
      WHERE p.is_active = 1
      GROUP BY p.id
      ORDER BY p.sort_order ASC, p.id DESC`
    )
    .all();
  return rows.map(mapProductRow);
}

function listAllProductsWithStock() {
  const rows = db
    .prepare(
      `SELECT
        p.id, p.name, p.description, p.price_cents, p.is_active, p.created_at,
        p.sort_order,
        COALESCE(SUM(CASE WHEN c.is_sold = 0 THEN 1 ELSE 0 END), 0) AS stock
      FROM products p
      LEFT JOIN cards c ON c.product_id = p.id
      GROUP BY p.id
      ORDER BY p.sort_order ASC, p.id DESC`
    )
    .all();
  return rows.map(mapProductRow);
}

function createProduct({ name, description, price_cents, sort_order }) {
  const info = db
    .prepare('INSERT INTO products(name, description, price_cents, sort_order, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(name), String(description || ''), Number(price_cents), normalizeSortOrder(sort_order), 1, now());
  return Number(info.lastInsertRowid);
}

function updateProductSort(id, sort_order) {
  const productId = Number(id);
  const row = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!row) return false;
  db.prepare('UPDATE products SET sort_order = ? WHERE id = ?').run(normalizeSortOrder(sort_order), productId);
  return true;
}

function toggleProduct(id) {
  const row = db.prepare('SELECT is_active FROM products WHERE id = ?').get(Number(id));
  if (!row) return false;
  const next = Number(row.is_active || 0) === 1 ? 0 : 1;
  db.prepare('UPDATE products SET is_active = ? WHERE id = ?').run(next, Number(id));
  return true;
}

function deleteProduct(id) {
  const productId = Number(id);
  const hasOrder = db.prepare('SELECT 1 FROM orders WHERE product_id = ? LIMIT 1').get(productId);
  if (hasOrder) return { ok: false, reason: 'has_order' };

  withTransaction(() => {
    db.prepare('DELETE FROM cards WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM products WHERE id = ?').run(productId);
  });

  return { ok: true };
}

function importCards(productId, lines) {
  const pid = Number(productId);
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(pid);
  if (!product) {
    throw new Error('商品不存在');
  }

  let count = 0;
  withTransaction(() => {
    const stmt = db.prepare(
      'INSERT INTO cards(product_id, card_text, is_sold, sold_at, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    for (const line of lines) {
      const text = String(line || '').trim();
      if (!text) continue;
      stmt.run(pid, text, 0, '', null, now());
      count++;
    }
  });

  return count;
}

function createPendingOrder(productId, buyerEmail) {
  const pid = Number(productId);

  return withTransaction(() => {
    const product = db.prepare('SELECT id, name, price_cents FROM products WHERE id = ? AND is_active = 1').get(pid);
    if (!product) {
      throw new Error('商品不存在或已下架');
    }

    const stockRow = db.prepare('SELECT COUNT(1) AS stock FROM cards WHERE product_id = ? AND is_sold = 0').get(pid);
    if (Number(stockRow.stock || 0) <= 0) {
      throw new Error('库存不足');
    }

    const orderNo = createUniqueOrderNo();
    db.prepare(
      `INSERT INTO orders(
        order_no, product_id, product_name, buyer_email, amount_cents, status,
        delivered_card, created_at, pay_order_id, pay_state, pay_data_type, pay_url, paid_at, pay_msg, pay_last_query_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      orderNo,
      Number(product.id),
      String(product.name || ''),
      String(buyerEmail || ''),
      Number(product.price_cents || 0),
      'pending_payment',
      '',
      now(),
      '',
      0,
      '',
      '',
      '',
      '',
      ''
    );

    const order = getOrderByNo(orderNo);
    return { orderNo, order };
  });
}

function updateOrderPaymentCreated(orderNo, payload) {
  const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(String(orderNo));
  if (!row) return null;

  const order = mapOrderRow(row);
  const next = {
    pay_order_id: String(payload.payOrderId || order.pay_order_id || ''),
    pay_data_type: String(payload.payDataType || order.pay_data_type || ''),
    pay_url: String(payload.payUrl || order.pay_url || ''),
    pay_msg: String(payload.payMsg || ''),
    pay_state: order.pay_state,
    status: order.status,
    paid_at: order.paid_at,
  };

  if (order.status !== 'delivered') {
    const state = Number(payload.payState);
    if (Number.isInteger(state) && state >= 0) {
      next.pay_state = state;
      next.status = payStateToOrderStatus(state);
      if (state === 2 && !next.paid_at) {
        next.paid_at = now();
      }
    } else {
      next.status = 'paying';
      next.pay_state = 1;
    }
  }

  db.prepare('UPDATE orders SET pay_order_id=?, pay_data_type=?, pay_url=?, pay_msg=?, pay_state=?, status=?, paid_at=? WHERE order_no=?').run(
    next.pay_order_id,
    next.pay_data_type,
    next.pay_url,
    next.pay_msg,
    next.pay_state,
    next.status,
    next.paid_at,
    String(orderNo)
  );

  return getOrderByNo(orderNo);
}

function applyPayState(orderNo, payState, extra = {}) {
  const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(String(orderNo));
  if (!row) return null;

  const order = mapOrderRow(row);
  const next = { ...order };

  const n = Number(payState);
  if (Number.isInteger(n) && n >= 0) {
    next.pay_state = n;
  }

  if (extra.payOrderId) {
    next.pay_order_id = String(extra.payOrderId);
  }
  if (extra.payMsg) {
    next.pay_msg = String(extra.payMsg);
  }
  if (extra.payUrl) {
    next.pay_url = String(extra.payUrl);
  }

  next.pay_last_query_at = now();

  if (next.status !== 'delivered') {
    next.status = payStateToOrderStatus(next.pay_state);
  }

  if (next.pay_state === 2 && !next.paid_at) {
    next.paid_at = now();
  }

  db.prepare(
    'UPDATE orders SET pay_order_id=?, pay_state=?, pay_url=?, pay_msg=?, pay_last_query_at=?, status=?, paid_at=? WHERE order_no=?'
  ).run(
    next.pay_order_id,
    next.pay_state,
    next.pay_url,
    next.pay_msg,
    next.pay_last_query_at,
    next.status,
    next.paid_at,
    String(orderNo)
  );

  return getOrderByNo(orderNo);
}

function markOrderPaidAndDeliver(orderNo, extra = {}) {
  return withTransaction(() => {
    const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(String(orderNo));
    if (!row) return null;

    const order = mapOrderRow(row);
    const next = { ...order };

    next.pay_state = 2;
    next.status = next.status === 'delivered' ? 'delivered' : 'paid';
    next.pay_last_query_at = now();

    if (!next.paid_at) {
      next.paid_at = now();
    }
    if (extra.payOrderId) {
      next.pay_order_id = String(extra.payOrderId);
    }
    if (extra.payMsg) {
      next.pay_msg = String(extra.payMsg);
    }

    if (!next.delivered_card) {
      const cardRow = db
        .prepare('SELECT id, card_text FROM cards WHERE product_id = ? AND is_sold = 0 ORDER BY id ASC LIMIT 1')
        .get(next.product_id);

      if (cardRow) {
        const soldAt = now();
        db.prepare('UPDATE cards SET is_sold = 1, sold_at = ?, order_id = ? WHERE id = ?').run(
          soldAt,
          next.id,
          Number(cardRow.id)
        );
        next.delivered_card = String(cardRow.card_text || '');
        next.status = 'delivered';
      } else {
        next.status = 'out_of_stock';
        next.pay_msg = '支付成功但库存不足';
      }
    }

    db.prepare(
      `UPDATE orders
       SET pay_state=?, status=?, pay_last_query_at=?, paid_at=?, pay_order_id=?, pay_msg=?, delivered_card=?
       WHERE order_no=?`
    ).run(
      next.pay_state,
      next.status,
      next.pay_last_query_at,
      next.paid_at,
      next.pay_order_id,
      next.pay_msg,
      next.delivered_card,
      String(orderNo)
    );

    return getOrderByNo(orderNo);
  });
}

function getOrderByNo(orderNo) {
  const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(String(orderNo));
  return row ? mapOrderRow(row) : null;
}

function addPaymentLog(scene, orderNo, payload, level = 'info') {
  db.prepare('INSERT INTO payment_logs(scene, level, order_no, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(
    String(scene || ''),
    String(level || 'info'),
    String(orderNo || ''),
    String(payload || ''),
    now()
  );

  const over = db.prepare('SELECT COUNT(1) AS c FROM payment_logs').get();
  const count = Number(over.c || 0);
  if (count > 3000) {
    db.prepare(
      'DELETE FROM payment_logs WHERE id IN (SELECT id FROM payment_logs ORDER BY id ASC LIMIT ?)'
    ).run(count - 3000);
  }
}

function getDashboardStats() {
  const productCount = Number(db.prepare('SELECT COUNT(1) AS c FROM products').get().c || 0);
  const unsoldCount = Number(db.prepare('SELECT COUNT(1) AS c FROM cards WHERE is_sold = 0').get().c || 0);
  const orderCount = Number(db.prepare('SELECT COUNT(1) AS c FROM orders').get().c || 0);
  const deliveredCount = Number(db.prepare("SELECT COUNT(1) AS c FROM orders WHERE status = 'delivered'").get().c || 0);

  const amountRow = db
    .prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS totalAmountCents, COALESCE(SUM(CASE WHEN pay_state = 2 THEN amount_cents ELSE 0 END), 0) AS paidAmountCents FROM orders'
    )
    .get();

  const totalAmountCents = Number(amountRow.totalAmountCents || 0);
  const paidAmountCents = Number(amountRow.paidAmountCents || 0);

  return {
    productCount,
    unsoldCount,
    orderCount,
    deliveredCount,
    totalAmountCents,
    paidAmountCents,
    unpaidAmountCents: totalAmountCents - paidAmountCents,
  };
}

function listLatestOrders(limit = 10) {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(Number(limit));
  return rows.map(mapOrderRow);
}

function listProductsBasic() {
  const rows = db.prepare('SELECT id, name FROM products ORDER BY id DESC').all();
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name || '') }));
}

function listStockMapRows() {
  const rows = db
    .prepare(
      `SELECT
        p.id,
        p.name,
        COALESCE(COUNT(c.id), 0) AS total,
        COALESCE(SUM(CASE WHEN c.is_sold = 0 THEN 1 ELSE 0 END), 0) AS stock
      FROM products p
      LEFT JOIN cards c ON c.product_id = p.id
      GROUP BY p.id
      ORDER BY p.id DESC`
    )
    .all();

  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name || ''),
    total: Number(r.total || 0),
    stock: Number(r.stock || 0),
  }));
}

function listCardsByProduct(productId, limit = 100) {
  const rows = db
    .prepare('SELECT id, product_id, card_text, is_sold, sold_at, order_id, created_at FROM cards WHERE product_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(productId), Number(limit));
  return rows.map(mapCardRow);
}

function listOrders(limit = 300) {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(Number(limit));
  return rows.map(mapOrderRow);
}

function listOrdersPaged(options = {}) {
  const total = Number(db.prepare('SELECT COUNT(1) AS c FROM orders').get().c || 0);
  const pageSize = clampInt(options.pageSize, 50, 20, 200);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(options.page, 1, 1, totalPages);
  const start = (page - 1) * pageSize;

  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, start).map(mapOrderRow);

  return {
    rows,
    total,
    page,
    pageSize,
    totalPages,
  };
}

function listPaymentLogsPaged(options = {}) {
  const logType = normalizePaymentLogType(options.logType);
  const whereClause =
    logType === 'callback' ? " WHERE scene LIKE 'notify_%'" : logType === 'request' ? " WHERE scene NOT LIKE 'notify_%'" : '';

  const totalSql = `SELECT COUNT(1) AS c FROM payment_logs${whereClause}`;
  const total = Number(db.prepare(totalSql).get().c || 0);
  const pageSize = clampInt(options.pageSize, 50, 20, 200);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(options.page, 1, 1, totalPages);
  const start = (page - 1) * pageSize;

  const rowsSql = `SELECT * FROM payment_logs${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`;
  const rows = db
    .prepare(rowsSql)
    .all(pageSize, start)
    .map(mapPaymentLogRow);

  return {
    rows,
    total,
    page,
    pageSize,
    totalPages,
    logType,
  };
}

function normalizePaymentLogType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'request') return 'request';
  if (text === 'callback') return 'callback';
  return 'all';
}

function deleteOrderByNo(orderNo) {
  const info = db.prepare('DELETE FROM orders WHERE order_no = ?').run(String(orderNo || ''));
  return Number(info.changes || 0) > 0;
}

function cleanupUnpaidOrdersOlderThan(minutes = 15) {
  const expireMinutes = Math.max(1, Number.parseInt(minutes, 10) || 15);
  const cutoffMs = Date.now() - expireMinutes * 60 * 1000;
  const rows = db
    .prepare('SELECT id, order_no, created_at, pay_state FROM orders WHERE pay_state != 2 ORDER BY id ASC')
    .all();

  const toDelete = [];
  for (const row of rows) {
    const createdAtMs = parseOrderCreatedAtMs(row.created_at);
    if (!Number.isFinite(createdAtMs)) continue;
    if (createdAtMs <= cutoffMs) {
      toDelete.push({ id: Number(row.id), orderNo: String(row.order_no || '') });
    }
  }

  if (!toDelete.length) {
    return { deletedCount: 0, deletedOrderNos: [] };
  }

  withTransaction(() => {
    const stmt = db.prepare('DELETE FROM orders WHERE id = ?');
    for (const item of toDelete) {
      stmt.run(item.id);
    }
  });

  return {
    deletedCount: toDelete.length,
    deletedOrderNos: toDelete.map((x) => x.orderNo).filter(Boolean),
  };
}

function getSiteName() {
  const name = String(getSetting('site_name', DEFAULT_SITE_NAME)).trim();
  return name || DEFAULT_SITE_NAME;
}

function setSiteName(siteName) {
  const nextName = String(siteName || '').trim();
  if (!nextName) {
    throw new Error('站点名称不能为空');
  }
  setSetting('site_name', nextName.slice(0, 60));
}

function getOrderPayExpireMinutes() {
  const raw = getSetting('order_pay_expire_minutes', String(DEFAULT_ORDER_PAY_EXPIRE_MINUTES));
  return clampInt(raw, DEFAULT_ORDER_PAY_EXPIRE_MINUTES, 1, 180);
}

function setOrderPayExpireMinutes(minutes) {
  const next = clampInt(minutes, DEFAULT_ORDER_PAY_EXPIRE_MINUTES, 1, 180);
  setSetting('order_pay_expire_minutes', String(next));
  return next;
}

function getPaymentConfig() {
  const raw = getSetting('payment_config', '{}');
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    parsed = {};
  }

  return {
    ...createDefaultPaymentConfig(),
    ...parsed,
    enabled: !!parsed.enabled,
  };
}

function setPaymentConfig(input) {
  const next = {
    ...createDefaultPaymentConfig(),
    ...getPaymentConfig(),
  };

  delete next.api_base_url;

  next.enabled = !!input.enabled;
  next.mapi_url = String(input.mapi_url || '').trim();
  next.api_url = String(input.api_url || '').trim();
  next.pid = String(input.pid || '').trim();
  next.key = String(input.key || '').trim();
  next.pay_type = String(input.pay_type || '').trim() || 'alipay';
  next.device = String(input.device || '').trim() || 'pc';
  next.notify_url = String(input.notify_url || '').trim();
  next.return_url = String(input.return_url || '').trim();
  next.subject_prefix = String(input.subject_prefix || '').trim() || '卡密购买';
  next.sign_type = 'MD5';

  if (next.enabled) {
    const required = ['mapi_url', 'api_url', 'pid', 'key', 'pay_type'];
    for (const key of required) {
      if (!next[key]) {
        throw new Error('启用支付时必须填写完整配置');
      }
    }
  }

  setSetting('payment_config', JSON.stringify(next));
}

function createUniqueOrderNo() {
  for (let i = 0; i < 10; i++) {
    const no = createOrderNo();
    const exists = db.prepare('SELECT 1 FROM orders WHERE order_no = ? LIMIT 1').get(no);
    if (!exists) return no;
  }
  throw new Error('订单号生成失败，请重试');
}

function createOrderNo() {
  const nowDate = new Date();
  const ymd =
    nowDate.getFullYear().toString() +
    pad2(nowDate.getMonth() + 1) +
    pad2(nowDate.getDate()) +
    pad2(nowDate.getHours()) +
    pad2(nowDate.getMinutes()) +
    pad2(nowDate.getSeconds());
  const rand = Math.floor(Math.random() * 90000) + 10000;
  return `FK${ymd}${rand}`;
}

function payStateToOrderStatus(state) {
  switch (Number(state)) {
    case 0:
      return 'pending_payment';
    case 1:
      return 'paying';
    case 2:
      return 'paid';
    case 3:
      return 'pay_failed';
    case 4:
    case 5:
    case 6:
      return 'pay_closed';
    default:
      return 'paying';
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function normalizeSortOrder(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) return 0;
  return Math.max(0, Math.min(999999, n));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseOrderCreatedAtMs(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;

  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;

  const normalized = text
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/\//g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const matched = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/
  );
  if (!matched) return NaN;

  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const hour = Number(matched[4]);
  const minute = Number(matched[5]);
  const second = Number(matched[6] || 0);

  return new Date(year, month, day, hour, minute, second).getTime();
}

module.exports = {
  listActiveProductsWithStock,
  listAllProductsWithStock,
  createProduct,
  updateProductSort,
  toggleProduct,
  deleteProduct,
  importCards,
  createPendingOrder,
  updateOrderPaymentCreated,
  applyPayState,
  markOrderPaidAndDeliver,
  getOrderByNo,
  addPaymentLog,
  getDashboardStats,
  listLatestOrders,
  listProductsBasic,
  listStockMapRows,
  listCardsByProduct,
  listOrders,
  listOrdersPaged,
  listPaymentLogsPaged,
  deleteOrderByNo,
  cleanupUnpaidOrdersOlderThan,
  ensureDatabaseReady,
  getSiteName,
  setSiteName,
  getOrderPayExpireMinutes,
  setOrderPayExpireMinutes,
  getPaymentConfig,
  setPaymentConfig,
};
