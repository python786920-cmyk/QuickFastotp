/**
 * ULTRA PRO TELEGRAM OTP BOT (Node.js + MySQL + TechyIndia)
 * Single File – Render.com Ready
 *
 * Features:
 * - /start + Unicode UI
 * - Reply Keyboard: [Balance] [Buy OTP] [Activation]
 * - Only 2 Real Services: TapRummy, RummyPerfect
 * - TechyIndia API Integration (getBalance, getNumber, getStatus, setStatus, getPrices)
 * - Auto OTP check every 1 second (up to 10 min)
 * - Auto-cancel after 10 minutes (status=8 + refund)
 * - Manual Cancel button (status=8 + refund)
 * - MySQL on shared hosting
 * - Simple web Admin panel (HTTP) for Add Balance (by user_id)
 * - Can run on Render.com as a Node Web Service (long polling)
 *
 * ========== MINIMUM SQL STRUCTURE ==========
 *
 * CREATE TABLE users (
 *   id INT AUTO_INCREMENT PRIMARY KEY,
 *   user_id BIGINT UNIQUE,
 *   username VARCHAR(64),
 *   first_name VARCHAR(128),
 *   balance DECIMAL(10,2) DEFAULT 0,
 *   total_spent DECIMAL(10,2) DEFAULT 0,
 *   created_at DATETIME,
 *   updated_at DATETIME
 * );
 *
 * CREATE TABLE orders (
 *   id INT AUTO_INCREMENT PRIMARY KEY,
 *   user_id BIGINT,
 *   chat_id BIGINT,
 *   message_id INT,
 *   activation_id VARCHAR(64),
 *   service_name VARCHAR(64),
 *   service_code VARCHAR(32),
 *   country VARCHAR(8),
 *   price DECIMAL(10,2),
 *   phone VARCHAR(32),
 *   status ENUM('waiting','received','cancelled','expired') DEFAULT 'waiting',
 *   last_code VARCHAR(32),
 *   created_at DATETIME,
 *   updated_at DATETIME,
 *   auto_cancel_at DATETIME
 * );
 *
 * ===========================================
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const axios = require('axios');
const bodyParser = require('body-parser');

// ============ CONFIG ============

// Render / local ENV
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8383854450:AAG3G0b8IKKXXFmyxZoPB42h1GMxgJtf35c';
const TECHYINDIA_API_KEY = process.env.TECHYINDIA_API_KEY || '61758cd4a6dc0fedfc718f7cc29f525b';

// MySQL (shared hosting)
const DB_HOST = process.env.DB_HOST || '54.38.84.16';
const DB_USER = process.env.DB_USER || 'cztldhwx_UpayOtpFast';
const DB_PASS = process.env.DB_PASS || 'Aptap786920';
const DB_NAME = process.env.DB_NAME || 'cztldhwx_UpayOtpFast';

// Admin panel secret key (simple protection)
const ADMIN_PANEL_KEY = process.env.ADMIN_PANEL_KEY || 'Aptap786920';

// Country (TechyIndia → India code 22)
const TECHYINDIA_COUNTRY = '22';

// Services (sirf 2 real services)
const SERVICES = {
  TapRummy: {
    label: 'TAP RUMMY',
    // TechyIndia service code (from list: Tap Rummy (op. 1) → "mua m")
    apiCode: 'mua m',
  },
  RummyPerfect: {
    label: 'RUMMY PERFECT',
    // TechyIndia service code (from list: Rummy perfect (op. 1) → "crtu")
    apiCode: 'crtu',
  },
};

// Auto-cancel time (in seconds)
const AUTO_CANCEL_SECONDS = 10 * 60; // 10 minutes
const STATUS_POLL_INTERVAL_MS = 1000; // 1 second

// ============ MYSQL POOL ============

let pool;

async function initDb() {
  pool = await mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    connectionLimit: 5,
  });
  console.log('MySQL pool created');
}

// Helper: run query
async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// ============ TELEGRAM BOT ============

// Long-polling bot (Render.com compatible, simple)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Active activation watchers (in-memory)
const activeActivations = new Map(); // activationId -> { interval, startedAt, userId, orderId, chatId, messageId, price }

// Helper: create / get user
async function getOrCreateUser(msg) {
  const user_id = msg.from.id;
  const username = msg.from.username || null;
  const first_name = msg.from.first_name || '';

  const rows = await query('SELECT * FROM users WHERE user_id = ?', [user_id]);
  if (rows.length > 0) {
    // update basic info
    await query(
      'UPDATE users SET username = ?, first_name = ?, updated_at = NOW() WHERE user_id = ?',
      [username, first_name, user_id]
    );
    return rows[0];
  } else {
    await query(
      'INSERT INTO users (user_id, username, first_name, balance, total_spent, created_at, updated_at) VALUES (?, ?, ?, 0, 0, NOW(), NOW())',
      [user_id, username, first_name]
    );
    const rows2 = await query('SELECT * FROM users WHERE user_id = ?', [user_id]);
    return rows2[0];
  }
}

// Helper: get user by user_id
async function getUserById(user_id) {
  const rows = await query('SELECT * FROM users WHERE user_id = ?', [user_id]);
  return rows[0] || null;
}

// Helper: change balance
async function changeBalance(user_id, amount) {
  await query(
    'UPDATE users SET balance = balance + ?, updated_at = NOW() WHERE user_id = ?',
    [amount, user_id]
  );
}

// Helper: set balance (admin panel)
async function setBalance(user_id, newBalance) {
  await query(
    'UPDATE users SET balance = ?, updated_at = NOW() WHERE user_id = ?',
    [newBalance, user_id]
  );
}

// Helper: get TechyIndia balance (optional)
async function getTechyIndiaBalance() {
  const url = 'https://www.techyindia.org/otpapi/handler';
  const params = {
    api_key: TECHYINDIA_API_KEY,
    action: 'getBalance',
  };
  const res = await axios.get(url, { params });
  return res.data; // example: "ACCESS_BALANCE:  198.35"
}

// Helper: get price (via getPrices for one service)
async function getServicePrice(apiCode) {
  const url = 'https://www.techyindia.org/otpapi/handler';
  const params = {
    api_key: TECHYINDIA_API_KEY,
    action: 'getPrices',
    service: apiCode,
    country: TECHYINDIA_COUNTRY,
  };
  const res = await axios.get(url, { params });

  // Response is JSON
  const data = res.data;
  // Expect format: { "India": { "mua m": { "cost":Cost, "count":Quantity } } }
  try {
    const countryObj = data['India'];
    if (!countryObj) return null;
    const svc = countryObj[apiCode];
    if (!svc) return null;
    return parseFloat(svc.cost);
  } catch (e) {
    console.log('getServicePrice parse error', e);
    return null;
  }
}

// Helper: call getNumber
async function getNumber(apiCode) {
  const url = 'https://www.techyindia.org/otpapi/handler';
  const params = {
    api_key: TECHYINDIA_API_KEY,
    action: 'getNumber',
    service: apiCode,
    country: TECHYINDIA_COUNTRY,
  };
  const res = await axios.get(url, { params });
  const text = res.data;

  if (typeof text !== 'string') return { error: 'BAD_RESPONSE', raw: text };

  if (text.startsWith('ACCESS_NUMBER')) {
    // format: ACCESS_NUMBER:  activationId:  phoneNumber
    const parts = text.split(':').map((p) => p.trim());
    // ["ACCESS_NUMBER", "activationId", "phoneNumber"]
    if (parts.length >= 3) {
      return {
        activationId: parts[1],
        phoneNumber: parts[2],
      };
    }
  }

  // some error code
  return { error: text };
}

// Helper: call getStatus
async function getStatus(activationId) {
  const url = 'https://www.techyindia.org/otpapi/handler';
  const params = {
    api_key: TECHYINDIA_API_KEY,
    action: 'getStatus',
    id: activationId,
  };
  const res = await axios.get(url, { params });
  return res.data; // string like "STATUS_WAIT_CODE" or "STATUS_OK: 123456"
}

// Helper: call setStatus
async function setStatus(activationId, statusCode) {
  const url = 'https://www.techyindia.org/otpapi/handler';
  const params = {
    api_key: TECHYINDIA_API_KEY,
    action: 'setStatus',
    id: activationId,
    status: statusCode,
  };
  const res = await axios.get(url, { params });
  return res.data; // "ACCESS_CANCEL", "ACCESS_ACTIVATION", ...
}

// ============ TELEGRAM UI HELPERS ============

function mainReplyKeyboard() {
  return {
    keyboard: [
      ['💰 Balance', '📲 Buy OTP'],
      ['📋 Activation'],
    ],
    resize_keyboard: true,
  };
}

// Welcome / start screen
async function sendWelcome(msg, userRow) {
  const chatId = msg.chat.id;
  const name = userRow.first_name || 'User';
  const balance = parseFloat(userRow.balance || 0).toFixed(2);

  const text =
    '🌐 Wᴇʟᴄᴏᴍᴇ Tᴏ Oᴛᴘ Mᴀʀᴋᴇᴛ 🚀\n' +
    'Bᴜʏ Vᴇʀɪғɪᴄᴀᴛɪᴏɴ Nᴜᴍʙᴇʀs Iɴsᴛᴀɴᴛ\n\n' +
    `👤 Nᴀᴍᴇ: ${name}\n` +
    `🆔 ID: ${userRow.user_id}\n` +
    `💰 Bᴀʟᴀɴᴄᴇ: ₹${balance}`;

  await bot.sendMessage(chatId, text, {
    reply_markup: mainReplyKeyboard(),
  });
}

// Show balance
async function handleBalanceCommand(msg) {
  const chatId = msg.chat.id;
  const userRow = await getOrCreateUser(msg);
  const balance = parseFloat(userRow.balance || 0).toFixed(2);

  const text =
    '💰 YOUR BALANCE\n\n' +
    `Current Balance: ₹${balance}\n\n` +
    'ℹ️ Note: Add balance to buy OTP';

  // Admin panel button (URL)
  // NOTE: change "your-domain.onrender.com" to your real domain
  const adminUrl = `https://your-domain.onrender.com/admin?key=${ADMIN_PANEL_KEY}&user_id=${userRow.user_id}`;

  await bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '💳 Add Balance (Admin)',
            url: adminUrl,
          },
        ],
      ],
    },
  });
}

// Buy OTP entry
async function handleBuyOtpCommand(msg) {
  const chatId = msg.chat.id;

  const text =
    '🔥 Pʟᴇᴀsᴇ Sᴇʟᴇᴄᴛ Sᴇʀᴠɪᴄᴇ\n' +
    'Tᴏ Cᴏɴғɪʀᴍ Yᴏᴜʀ Oʀᴅᴇʀ 👇';

  await bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '💠 Check Service List',
            callback_data: 'service_list_page:1',
          },
        ],
      ],
    },
  });
}

// Service list (only 2 services)
async function handleServiceList(chatId, page) {
  // For now only 1 page (page 1)
  const text =
    '📱 AVAILABLE SERVICES (Page 1/1)\n\n' +
    '➤ TAP RUMMY\n' +
    '   /find_TapRummy\n\n' +
    '➤ RUMMY PERFECT\n' +
    '   /find_RummyPerfect';

  const inline_keyboard = [
    [
      { text: 'TAP RUMMY', callback_data: 'select_service:TapRummy' },
      { text: 'RUMMY PERFECT', callback_data: 'select_service:RummyPerfect' },
    ],
    [
      { text: '⬅️ Back', callback_data: 'ignore' },
      { text: 'Next ➡️', callback_data: 'ignore' }, // disabled
    ],
  ];

  await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard },
  });
}

// ============ ACTIVATION WATCHER (AUTO GET STATUS) ============

function startActivationWatcher({
  activationId,
  userId,
  orderId,
  chatId,
  messageId,
  price,
}) {
  if (activeActivations.has(activationId)) {
    // already running
    return;
  }

  const startedAt = Date.now();
  let secondsPassed = 0;

  const interval = setInterval(async () => {
    secondsPassed += 1;

    try {
      // Time limit check
      if (secondsPassed >= AUTO_CANCEL_SECONDS) {
        // Auto-cancel
        console.log(`Auto-cancel activation ${activationId}`);
        const apiRes = await setStatus(activationId, 8);
        console.log('setStatus auto-cancel =>', apiRes);

        // Refund if still waiting
        await query(
          'UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ? AND status = ?',
          ['expired', orderId, 'waiting']
        );
        await changeBalance(userId, price); // refund

        const userRow = await getUserById(userId);
        const newBalance = parseFloat(userRow.balance || 0).toFixed(2);

        const text =
          '⏰ AUTO-CANCELLED\n\n' +
          'Order timed out after 10 minutes\n\n' +
          `✅ Balance refunded: ₹${price.toFixed(2)}\n` +
          `💰 New Balance: ₹${newBalance}`;

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
        });

        clearInterval(interval);
        activeActivations.delete(activationId);
        return;
      }

      // Each second → getStatus
      const statusText = await getStatus(activationId);
      console.log('getStatus =>', statusText);

      if (typeof statusText !== 'string') return;

      if (statusText.startsWith('STATUS_WAIT_CODE')) {
        // waiting, do nothing
        return;
      }

      if (statusText.startsWith('STATUS_WAIT_RETRY')) {
        // format: STATUS_WAIT_RETRY:  lastCode
        const parts = statusText.split(':').map((p) => p.trim());
        const lastCode = parts[1] || '';
        await query(
          'UPDATE orders SET last_code = ?, updated_at = NOW() WHERE id = ?',
          [lastCode, orderId]
        );
        // You can optionally notify user intermediate code; for now, we keep silent.
        return;
      }

      if (statusText.startsWith('STATUS_OK')) {
        // format: STATUS_OK: '123456'
        let code = statusText.split(':')[1] || '';
        code = code.replace(/['"]/g, '').trim();

        await query(
          'UPDATE orders SET status = ?, last_code = ?, updated_at = NOW() WHERE id = ?',
          ['received', code, orderId]
        );

        const text =
          '💥 Oᴛᴘ Rᴇᴄᴇɪᴠᴇᴅ 💥\n\n' +
          `🔐 Cᴏᴅᴇ: ${code}\n\n` +
          '✅ Order Completed';

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
        });

        clearInterval(interval);
        activeActivations.delete(activationId);
        return;
      }

      if (statusText.startsWith('STATUS_CANCEL')) {
        await query(
          'UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?',
          ['cancelled', orderId]
        );
        clearInterval(interval);
        activeActivations.delete(activationId);
        return;
      }
    } catch (err) {
      console.error('Watcher error', err.message);
      // keep trying; don't stop on single error
    }
  }, STATUS_POLL_INTERVAL_MS);

  activeActivations.set(activationId, {
    interval,
    startedAt,
    userId,
    orderId,
    chatId,
    messageId,
    price,
  });
}

// ============ CALLBACK HANDLERS ============

bot.on('callback_query', async (cb) => {
  const data = cb.data;
  const msg = cb.message;
  const chatId = msg.chat.id;
  const fromId = cb.from.id;

  try {
    // Ignore placeholder
    if (data === 'ignore') {
      await bot.answerCallbackQuery(cb.id, { text: 'Not available' });
      return;
    }

    // Service list
    if (data.startsWith('service_list_page')) {
      await bot.answerCallbackQuery(cb.id);
      const parts = data.split(':');
      const page = parseInt(parts[1] || '1', 10);
      await handleServiceList(chatId, page);
      return;
    }

    // Select service
    if (data.startsWith('select_service:')) {
      await bot.answerCallbackQuery(cb.id);
      const serviceKey = data.split(':')[1]; // TapRummy / RummyPerfect
      const svc = SERVICES[serviceKey];
      if (!svc) {
        await bot.sendMessage(chatId, '❌ Service not found.');
        return;
      }

      // Show product + price button (price from API)
      await bot.sendMessage(chatId, '⚙️ Fetching price...');
      const price = await getServicePrice(svc.apiCode);
      if (!price) {
        await bot.sendMessage(
          chatId,
          '❌ Unable to fetch price. Please try again later.'
        );
        return;
      }

      const text =
        '✨ Pʀᴏᴅᴜᴄᴛ:\n' +
        `${svc.label}\n\n` +
        '🌍 Country: India\n\n' +
        'Sᴇʟᴇᴄᴛ Sᴇʀᴠᴇʀ Aᴄᴄᴏʀᴅɪɴɢ Tᴏ Pʀɪᴄᴇ👇';

      const inline_keyboard = [
        [
          {
            text: `SERVER 1 ➤ ₹${price}`,
            callback_data: `select_server:${serviceKey}:${price}`,
          },
        ],
      ];

      await bot.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard },
      });
      return;
    }

    // Select server
    if (data.startsWith('select_server:')) {
      await bot.answerCallbackQuery(cb.id);
      const parts = data.split(':'); // [ 'select_server', serviceKey, price ]
      const serviceKey = parts[1];
      const price = parseFloat(parts[2]);
      const svc = SERVICES[serviceKey];
      if (!svc) {
        await bot.sendMessage(chatId, '❌ Service not found.');
        return;
      }

      // Check user balance
      const userRow = await getUserById(fromId);
      if (!userRow) {
        await bot.sendMessage(chatId, '❌ User not found. Please send /start again.');
        return;
      }
      const balance = parseFloat(userRow.balance || 0);
      if (balance < price) {
        await bot.sendMessage(
          chatId,
          '❌ Insufficient balance.\nPlease contact admin to add balance.'
        );
        return;
      }

      // Processing animation (simple version – single message)
      const processingMsg = await bot.sendMessage(
        chatId,
        '⚙️ Processing Your Order...\n\n▰▰▰▰▱▱▱▱▱ 60%'
      );

      // Call getNumber
      const result = await getNumber(svc.apiCode);
      if (result.error) {
        await bot.editMessageText(
          '❌ NO NUMBER FOUND\nPʟᴇᴀsᴇ Tʀʏ Aɢᴀɪɴ ❌',
          {
            chat_id: chatId,
            message_id: processingMsg.message_id,
          }
        );
        return;
      }

      const activationId = result.activationId;
      const phoneNumber = result.phoneNumber;

      // Deduct balance & create order
      await query(
        'UPDATE users SET balance = balance - ?, total_spent = total_spent + ?, updated_at = NOW() WHERE user_id = ?',
        [price, price, fromId]
      );
      const [res] = await pool.query(
        'INSERT INTO orders (user_id, chat_id, message_id, activation_id, service_name, service_code, country, price, phone, status, created_at, updated_at, auto_cancel_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))',
        [
          fromId,
          chatId,
          processingMsg.message_id,
          activationId,
          svc.label,
          svc.apiCode,
          TECHYINDIA_COUNTRY,
          price,
          phoneNumber,
          'waiting',
          AUTO_CANCEL_SECONDS,
        ]
      );
      const orderId = res.insertId;

      // Show number screen
      const userNew = await getUserById(fromId);
      const newBalance = parseFloat(userNew.balance || 0).toFixed(2);

      const text =
        `💠 Aᴘᴘʟɪᴄᴀᴛɪᴏɴ: ${svc.label}\n\n` +
        `📞 Nᴜᴍʙᴇʀ: +${phoneNumber}\n(ᴛᴀᴘ ᴛᴏ ᴄᴏᴘʏ)\n\n` +
        '📝 Oᴛᴘ Sᴛᴀᴛᴜs: Wᴀɪᴛɪɴɢ 🙏\n\n' +
        `⏰ Auto-cancel in: 10:00\n` +
        `💰 Current Balance: ₹${newBalance}`;

      const inline_keyboard = [
        [
          {
            text: '✅ Get OTP',
            callback_data: `getotp:${activationId}:${orderId}`,
          },
          {
            text: '❌ Cancel',
            callback_data: `cancel:${activationId}:${orderId}`,
          },
        ],
      ];

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        reply_markup: { inline_keyboard },
      });

      // Start auto watcher
      startActivationWatcher({
        activationId,
        userId: fromId,
        orderId,
        chatId,
        messageId: processingMsg.message_id,
        price,
      });

      return;
    }

    // Manual Get OTP
    if (data.startsWith('getotp:')) {
      await bot.answerCallbackQuery(cb.id);
      const parts = data.split(':'); // getotp:activationId:orderId
      const activationId = parts[1];
      const orderId = parseInt(parts[2]);

      const statusText = await getStatus(activationId);
      console.log('Manual getStatus =>', statusText);

      if (typeof statusText !== 'string') {
        await bot.sendMessage(chatId, '❌ Error while checking status.');
        return;
      }

      if (statusText.startsWith('STATUS_WAIT_CODE')) {
        await bot.sendMessage(chatId, '⏳ Still waiting for OTP…');
        return;
      }

      if (statusText.startsWith('STATUS_WAIT_RETRY')) {
        const lastCode = (statusText.split(':')[1] || '').trim();
        await bot.sendMessage(
          chatId,
          `⌛ OTP received but waiting for another…\nLast code: ${lastCode}`
        );
        return;
      }

      if (statusText.startsWith('STATUS_OK')) {
        let code = statusText.split(':')[1] || '';
        code = code.replace(/['"]/g, '').trim();

        await query(
          'UPDATE orders SET status = ?, last_code = ?, updated_at = NOW() WHERE id = ?',
          ['received', code, orderId]
        );

        const text =
          '💥 Oᴛᴘ Rᴇᴄᴇɪᴠᴇᴅ 💥\n\n' +
          `🔐 Cᴏᴅᴇ: ${code}\n\n` +
          '✅ Order Completed';

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msg.message_id,
        });

        // stop watcher if running
        const watcher = activeActivations.get(activationId);
        if (watcher) {
          clearInterval(watcher.interval);
          activeActivations.delete(activationId);
        }
        return;
      }

      if (statusText.startsWith('STATUS_CANCEL')) {
        await bot.sendMessage(chatId, '❌ Activation already cancelled.');
        return;
      }

      await bot.sendMessage(chatId, `ℹ️ Status: ${statusText}`);
      return;
    }

    // Manual Cancel
    if (data.startsWith('cancel:')) {
      await bot.answerCallbackQuery(cb.id);
      const parts = data.split(':'); // cancel:activationId:orderId
      const activationId = parts[1];
      const orderId = parseInt(parts[2]);

      const orderRows = await query('SELECT * FROM orders WHERE id = ?', [orderId]);
      const order = orderRows[0];
      if (!order) {
        await bot.sendMessage(chatId, '❌ Order not found.');
        return;
      }
      if (order.status !== 'waiting') {
        await bot.sendMessage(chatId, '❌ Order already processed.');
        return;
      }

      // TechyIndia – cancel (status=8)
      const apiRes = await setStatus(activationId, 8);
      console.log('Manual setStatus cancel =>', apiRes);

      // EARLY_CANCEL_DENIED protection – ideally after 2 min, but user wants manual
      // yaha simple: agar EARLY_CANCEL_DENIED aaya to user ko bata denge
      if (typeof apiRes === 'string' && apiRes === 'EARLY_CANCEL_DENIED') {
        await bot.sendMessage(chatId, '⏳ You can cancel number only after 2 minutes.');
        return;
      }

      // Mark cancelled & refund
      await query(
        'UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?',
        ['cancelled', orderId]
      );
      await changeBalance(order.user_id, order.price);

      const userRow = await getUserById(order.user_id);
      const newBalance = parseFloat(userRow.balance || 0).toFixed(2);

      const text =
        '📝 Oᴛᴘ Sᴛᴀᴛᴜs:\nCancelled ❌\n\n' +
        `✅ Balance refunded: ₹${parseFloat(order.price).toFixed(2)}\n` +
        `💰 New Balance: ₹${newBalance}`;

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msg.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: '🔁 Buy Again', callback_data: 'service_list_page:1' }]],
        },
      });

      // stop watcher
      const watcher = activeActivations.get(activationId);
      if (watcher) {
        clearInterval(watcher.interval);
        activeActivations.delete(activationId);
      }

      return;
    }

    // Default: ignore
    await bot.answerCallbackQuery(cb.id, { text: 'Unknown action' });
  } catch (err) {
    console.error('Callback error', err);
    try {
      await bot.answerCallbackQuery(cb.id, { text: 'Error occurred.' });
    } catch (e) {}
  }
});

// ============ MESSAGE HANDLERS ============

bot.onText(/\/start/, async (msg) => {
  try {
    const userRow = await getOrCreateUser(msg);
    await sendWelcome(msg, userRow);
  } catch (err) {
    console.error('/start error', err);
    await bot.sendMessage(msg.chat.id, '❌ Error. Please try again later.');
  }
});

bot.onText(/\/find_TapRummy/, async (msg) => {
  // Shortcut text command → same as callback
  const fakeCb = {
    data: 'select_service:TapRummy',
    message: msg,
    from: msg.from,
    id: 'manual',
  };
  await bot.emit('callback_query', fakeCb);
});

bot.onText(/\/find_RummyPerfect/, async (msg) => {
  const fakeCb = {
    data: 'select_service:RummyPerfect',
    message: msg,
    from: msg.from,
    id: 'manual',
  };
  await bot.emit('callback_query', fakeCb);
});

// Simple text buttons
bot.on('message', async (msg) => {
  // Already handled /start above
  if (!msg.text) return;
  const text = msg.text.trim();

  try {
    if (text === '💰 Balance' || text.toLowerCase() === 'balance') {
      await handleBalanceCommand(msg);
      return;
    }

    if (text === '📲 Buy OTP' || text.toLowerCase() === 'buy otp') {
      await handleBuyOtpCommand(msg);
      return;
    }

    if (text === '📋 Activation' || text.toLowerCase() === 'activation') {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      const statsRows = await query(
        "SELECT status, COUNT(*) as cnt FROM orders WHERE user_id = ? GROUP BY status",
        [userId]
      );

      let active = 0,
        completed = 0,
        cancelled = 0,
        expired = 0;
      for (const r of statsRows) {
        if (r.status === 'waiting') active = r.cnt;
        if (r.status === 'received') completed = r.cnt;
        if (r.status === 'cancelled') cancelled = r.cnt;
        if (r.status === 'expired') expired = r.cnt;
      }

      const textResp =
        '📋 YOUR ACTIVATIONS\n\n' +
        `🟢 Active: ${active}\n` +
        `✅ Completed: ${completed}\n` +
        `❌ Cancelled: ${cancelled}\n` +
        `⏰ Expired: ${expired}`;

      await bot.sendMessage(chatId, textResp, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🟢 Active Orders', callback_data: 'view_active_orders' }],
            [{ text: '✅ Completed Orders', callback_data: 'view_completed_orders' }],
            [{ text: '❌ Cancelled Orders', callback_data: 'view_cancelled_orders' }],
          ],
        },
      });
      return;
    }
  } catch (err) {
    console.error('message handler error', err);
  }
});

// Simple activation list via callback (only active)
bot.on('callback_query', async (cb) => {
  const data = cb.data;
  const msg = cb.message;
  const chatId = msg.chat.id;
  const userId = cb.from.id;

  try {
    if (data === 'view_active_orders') {
      await cbAnswerSafe(cb.id);
      const rows = await query(
        'SELECT * FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 10',
        [userId, 'waiting']
      );
      if (rows.length === 0) {
        await bot.sendMessage(chatId, 'No active orders.');
        return;
      }
      for (const o of rows) {
        const autoCancelAt = o.auto_cancel_at
          ? `Time Left approx: (auto-cancel at ${o.auto_cancel_at.toISOString().slice(11, 19)})`
          : '';
        const text =
          '🟢 ACTIVE ORDER\n\n' +
          `Service: ${o.service_name}\n` +
          `Number: +${o.phone}\n` +
          `Status: Waiting for OTP\n` +
          `${autoCancelAt}\n\n` +
          `Order ID: #${o.id}`;

        await bot.sendMessage(chatId, text, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✅ Get OTP',
                  callback_data: `getotp:${o.activation_id}:${o.id}`,
                },
                {
                  text: '❌ Cancel',
                  callback_data: `cancel:${o.activation_id}:${o.id}`,
                },
              ],
            ],
          },
        });
      }
      return;
    }

    if (data === 'view_completed_orders') {
      await cbAnswerSafe(cb.id);
      const rows = await query(
        'SELECT * FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 10',
        [userId, 'received']
      );
      if (rows.length === 0) {
        await bot.sendMessage(chatId, 'No completed orders.');
        return;
      }
      for (const o of rows) {
        const text =
          '✅ COMPLETED ORDER\n\n' +
          `Service: ${o.service_name}\n` +
          `Number: +${o.phone}\n` +
          `Code: ${o.last_code}\n\n` +
          `Order ID: #${o.id}`;
        await bot.sendMessage(chatId, text);
      }
      return;
    }

    if (data === 'view_cancelled_orders') {
      await cbAnswerSafe(cb.id);
      const rows = await query(
        'SELECT * FROM orders WHERE user_id = ? AND status IN (?, ?) ORDER BY created_at DESC LIMIT 10',
        [userId, 'cancelled', 'expired']
      );
      if (rows.length === 0) {
        await bot.sendMessage(chatId, 'No cancelled/expired orders.');
        return;
      }
      for (const o of rows) {
        const text =
          '❌ CANCELLED/EXPIRED ORDER\n\n' +
          `Service: ${o.service_name}\n` +
          `Number: +${o.phone}\n` +
          `Status: ${o.status.toUpperCase()}\n\n` +
          `Order ID: #${o.id}`;
        await bot.sendMessage(chatId, text);
      }
      return;
    }
  } catch (err) {
    console.error('activation list callback error', err);
  }
});

// safe answerCallback
async function cbAnswerSafe(id) {
  try {
    await bot.answerCallbackQuery(id);
  } catch (e) {}
}

// ============ SIMPLE ADMIN PANEL (HTTP) ============

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// health
app.get('/', (req, res) => {
  res.send('OTP Bot is running ✅');
});

// Admin panel (GET)
app.get('/admin', async (req, res) => {
  const { key, user_id } = req.query;
  if (key !== ADMIN_PANEL_KEY) {
    return res.status(403).send('Forbidden');
  }

  let userHtml = '';
  if (user_id) {
    const user = await getUserById(user_id);
    if (user) {
      userHtml = `<p>User: ${user.first_name || ''} (@${user.username || ''})<br>Balance: ₹${
        user.balance
      }</p>`;
    } else {
      userHtml = '<p>User not found</p>';
    }
  }

  res.send(`
    <html>
      <head><title>OTP Bot Admin</title></head>
      <body>
        <h1>OTP Bot Admin Panel</h1>
        <form method="POST" action="/admin">
          <input type="hidden" name="key" value="${ADMIN_PANEL_KEY}">
          <label>User ID (Telegram user_id):</label><br>
          <input type="text" name="user_id" value="${user_id || ''}"><br><br>
          <label>Action:</label><br>
          <select name="action">
            <option value="add">Add Balance</option>
            <option value="set">Set Balance</option>
          </select><br><br>
          <label>Amount (₹):</label><br>
          <input type="text" name="amount"><br><br>
          <button type="submit">Submit</button>
        </form>
        <hr>
        ${userHtml}
      </body>
    </html>
  `);
});

// Admin panel (POST)
app.post('/admin', async (req, res) => {
  const { key, user_id, action, amount } = req.body;
  if (key !== ADMIN_PANEL_KEY) {
    return res.status(403).send('Forbidden');
  }

  const uid = parseInt(user_id);
  const amt = parseFloat(amount);
  if (!uid || isNaN(amt)) {
    return res.send('Invalid user_id or amount');
  }

  const user = await getUserById(uid);
  if (!user) {
    return res.send('User not found');
  }

  if (action === 'add') {
    await changeBalance(uid, amt);
  } else if (action === 'set') {
    await setBalance(uid, amt);
  } else {
    return res.send('Invalid action');
  }

  const updated = await getUserById(uid);
  res.send(
    `OK. New balance for ${updated.first_name || ''} (@${
      updated.username || ''
    }): ₹${updated.balance}`
  );
});

// Start server
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log('HTTP server listening on port', PORT);
      console.log('Bot started with long polling...');
    });
  })
  .catch((err) => {
    console.error('DB init error', err);
    process.exit(1);
  });
