const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Конфигурация с вашими данными
const MOYSKLAD_API_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MOYSKLAD_TOKEN = '125720136ed9aeb760288b76614c709f590a9ec4';
const WAREHOUSE_IDS = {
  MSK: '495124d9-e42f-11ed-0a80-0f480010433d', // Склад Мск одежда
  SPB: '064ae98f-f40f-11e9-0a80-012300093c25'  // Склад Спб
};

const axiosInstance = axios.create({
  baseURL: MOYSKLAD_API_URL,
  headers: {
    'Authorization': `Bearer ${MOYSKLAD_TOKEN}`,
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

// Функция для проверки остатков
async function checkStock(productId, warehouseId) {
  try {
    console.log(`Запрос остатков: товар=${productId}, склад=${warehouseId}`);
    
    const response = await axiosInstance.get(
      `/report/stock/bystore/current?filter=store.id=${warehouseId};assortment.id=${productId}`
    );
    
    console.log('Ответ по остаткам:', JSON.stringify(response.data, null, 2));
    
    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
      return response.data[0].stock || 0;
    }
    return 0;
  } catch (error) {
    console.error('Ошибка при проверке остатков:', error.message);
    console.error('Детали ошибки:', error.response?.data || error.message);
    return 0;
  }
}

// Функция для получения полной информации о товаре
async function getProductInfo(productId) {
  try {
    const response = await axiosInstance.get(`/entity/product/${productId}`);
    return response.data;
  } catch (error) {
    console.error('Ошибка при получении информации о товаре:', error.message);
    return null;
  }
}

// Функция для изменения склада в заказе
async function changeOrderWarehouse(orderId, newWarehouseId) {
  try {
    console.log(`Изменение склада в заказе ${orderId} на ${newWarehouseId}`);
    
    const updateData = {
      store: {
        meta: {
          href: `${MOYSKLAD_API_URL}/entity/store/${newWarehouseId}`,
          type: 'store',
          mediaType: 'application/json'
        }
      }
    };

    const response = await axiosInstance.put(`/entity/customerorder/${orderId}`, updateData);
    console.log('Склад успешно изменен:', response.data.name);
    return response.data;
  } catch (error) {
    console.error('Ошибка при изменении склада:', error.message);
    console.error('Детали ошибки:', error.response?.data || error.message);
    throw error;
  }
}

// Функция для логирования в консоль Vercel
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Основной обработчик вебхука
app.post('/api/webhook', async (req, res) => {
  try {
    log('=== НОВЫЙ ВЕБХУК ПОЛУЧЕН ===');
    log('Тело запроса:', req.body);
    
    // Проверяем наличие события
    if (!req.body.events || req.body.events.length === 0) {
      log('Нет событий в вебхуке');
      return res.status(400).json({ error: 'Нет событий в вебхуке' });
    }

    // Получаем информацию о заказе из вебхука
    const orderMeta = req.body.events[0].meta;
    if (!orderMeta || !orderMeta.href) {
      log('Нет метаданных заказа в вебхуке');
      return res.status(400).json({ error: 'Неверный формат вебхука' });
    }

    // Извлекаем ID заказа из URL
    const orderId = orderMeta.href.split('/').pop();
    log(`ID заказа: ${orderId}`);
    
    // Получаем полные данные заказа
    log('Получаем детали заказа из МойСклад...');
    const orderResponse = await axiosInstance.get(`/entity/customerorder/${orderId}?expand=positions`);
    const order = orderResponse.data;
    
    log(`Заказ: ${order.name}, Склад: ${order.store?.name || 'Не указан'}, ID склада: ${order.store?.id}`);
    
    // Проверяем, нужно ли обрабатывать этот заказ
    if (order.store?.id !== WAREHOUSE_IDS.MSK) {
      log(`Заказ не на складе МСК (${order.store?.name}), пропускаем обработку`);
      return res.status(200).json({ 
        message: 'Заказ не требует обработки',
        order: order.name,
        currentWarehouse: order.store?.name
      });
    }
    
    log(`Заказ на складе МСК, проверяем остатки...`);
    
    // Проверяем остатки по всем позициям
    let needWarehouseChange = false;
    let reasons = [];
    
    if (order.positions && order.positions.rows) {
      log(`Позиций в заказе: ${order.positions.rows.length}`);
      
      for (const position of order.positions.rows) {
        const productId = position.assortment?.id;
        const productName = position.assortment?.name || 'Неизвестный товар';
        const orderedQuantity = position.quantity;
        
        if (!productId) {
          log(`Пропускаем позицию без ID товара: ${productName}`);
          continue;
        }
        
        log(`Проверяем товар: ${productName}, Количество: ${orderedQuantity}`);
        
        // Получаем остаток на складе МСК
        const stockMSK = await checkStock(productId, WAREHOUSE_IDS.MSK);
        log(`Остаток на МСК: ${stockMSK}`);
        
        // Если остатка недостаточно
        if (stockMSK < orderedQuantity) {
          // Проверяем наличие на складе СПБ
          const stockSPB = await checkStock(productId, WAREHOUSE_IDS.SPB);
          log(`Остаток на СПБ: ${stockSPB}`);
          
          if (stockSPB >= orderedQuantity) {
            needWarehouseChange = true;
            reasons.push({
              product: productName,
              ordered: orderedQuantity,
              stockMSK: stockMSK,
              stockSPB: stockSPB,
              reason: `Недостаточно на МСК (${stockMSK} < ${orderedQuantity}), но есть на СПБ (${stockSPB})`
            });
            log(`Товар ${productName}: недостаточно на МСК, но достаточно на СПБ`);
          } else {
            log(`Товар ${productName}: недостаточно на обоих складах`);
            reasons.push({
              product: productName,
              ordered: orderedQuantity,
              stockMSK: stockMSK,
              stockSPB: stockSPB,
              reason: `Недостаточно на обоих складах (МСК: ${stockMSK}, СПБ: ${stockSPB})`
            });
          }
        } else {
          log(`Товар ${productName}: достаточно на МСК (${stockMSK} >= ${orderedQuantity})`);
        }
      }
    } else {
      log('Нет позиций в заказе');
    }
    
    // Если нужно сменить склад
    if (needWarehouseChange) {
      log(`Меняем склад на СПБ. Причины:`, reasons);
      
      try {
        const updatedOrder = await changeOrderWarehouse(orderId, WAREHOUSE_IDS.SPB);
        
        log(`✅ Склад успешно изменен на СПБ для заказа ${order.name}`);
        
        return res.status(200).json({ 
          success: true,
          message: 'Склад изменен на СПБ',
          order: updatedOrder.name,
          orderId: updatedOrder.id,
          oldWarehouse: 'МСК',
          newWarehouse: 'СПБ',
          reasons: reasons,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        log(`❌ Ошибка при изменении склада: ${error.message}`);
        return res.status(500).json({ 
          error: 'Ошибка при изменении склада',
          details: error.message,
          order: order.name,
          reasons: reasons
        });
      }
    } else {
      log(`✅ Заказ не требует изменений. Все товары в наличии на МСК`);
      
      return res.status(200).json({ 
        success: true,
        message: 'Заказ не требует изменений',
        order: order.name,
        orderId: order.id,
        warehouse: 'МСК',
        reasons: reasons,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    log(`❌ КРИТИЧЕСКАЯ ОШИБКА: ${error.message}`);
    log('Детали ошибки:', error.response?.data || error.message);
    
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Тестовый endpoint для проверки
app.get('/api/webhook', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      webhook: 'POST /api/webhook',
      test: 'GET /api/test'
    }
  });
});

// Тестовый endpoint для ручной проверки
app.get('/api/test', async (req, res) => {
  try {
    // Проверяем доступность API МойСклад
    const storeResponse = await axiosInstance.get('/entity/store');
    
    res.json({
      status: 'success',
      moysklad: {
        connected: true,
        stores: storeResponse.data.rows.length
      },
      warehouses: WAREHOUSE_IDS,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      details: error.response?.data
    });
  }
});

// Для Vercel
module.exports = app;
