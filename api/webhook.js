// Формат для Vercel Serverless Functions
import axios from 'axios';

// Конфигурация с вашими данными
const MOYSKLAD_API_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MOYSKLAD_TOKEN = '125720136ed9aeb760288b76614c709f590a9ec4';
const WAREHOUSE_IDS = {
  MSK: '495124d9-e42f-11ed-0a80-0f480010433d', // Склад Мск одежда
  SPB: '064ae98f-f40f-11e9-0a80-012300093c25'  // Склад Спб
};

// Маппинг ID складов к их названиям для логов
const WAREHOUSE_NAMES = {
  [WAREHOUSE_IDS.MSK]: 'Склад МСК',
  [WAREHOUSE_IDS.SPB]: 'Склад СПБ'
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
    const response = await axiosInstance.get(
      `/report/stock/bystore/current?filter=store.id=${warehouseId};assortment.id=${productId}`
    );
    
    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
      return response.data[0].stock || 0;
    }
    return 0;
  } catch (error) {
    console.error('Ошибка при проверке остатков:', error.message);
    return 0;
  }
}

// Функция для изменения склада в заказе
async function changeOrderWarehouse(orderId, newWarehouseId) {
  try {
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
    return response.data;
  } catch (error) {
    console.error('Ошибка при изменении склада:', error.message);
    throw error;
  }
}

// Функция для получения названия склада по ID
function getWarehouseName(warehouseId) {
  return WAREHOUSE_NAMES[warehouseId] || 'Неизвестный склад';
}

// Основной обработчик
export default async function handler(req, res) {
  // Разрешаем только POST запросы
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('=== НОВЫЙ ВЕБХУК ПОЛУЧЕН ===');
    
    // Проверяем наличие события
    if (!req.body.events || req.body.events.length === 0) {
      return res.status(400).json({ error: 'Нет событий в вебхуке' });
    }

    // Получаем информацию о заказе из вебхука
    const orderMeta = req.body.events[0].meta;
    if (!orderMeta?.href) {
      return res.status(400).json({ error: 'Неверный формат вебхука' });
    }

    // Извлекаем ID заказа из URL
    const orderId = orderMeta.href.split('/').pop();
    console.log(`ID заказа: ${orderId}`);
    
    // Получаем полные данные заказа
    console.log('Получаем детали заказа из МойСклад...');
    const orderResponse = await axiosInstance.get(`/entity/customerorder/${orderId}?expand=positions`);
    const order = orderResponse.data;
    
    console.log(`Заказ: ${order.name}`);
    
    // Определяем текущий склад
    const currentWarehouseId = order.store?.id;
    const currentWarehouseName = currentWarehouseId ? getWarehouseName(currentWarehouseId) : 'Склад не указан';
    
    console.log(`ID склада в заказе: ${currentWarehouseId || 'Не указан'}`);
    console.log(`Склад: ${currentWarehouseName}`);
    
    // ВАЖНО: Если склад не указан, считаем что заказ на основном складе (МСК)
    const isOnMSK = !currentWarehouseId || currentWarehouseId === WAREHOUSE_IDS.MSK;
    const isOnSPB = currentWarehouseId === WAREHOUSE_IDS.SPB;
    
    // Если заказ уже на СПБ - пропускаем
    if (isOnSPB) {
      console.log(`✅ Заказ уже на складе СПБ, пропускаем`);
      return res.status(200).json({ 
        message: 'Заказ уже на СПБ',
        order: order.name,
        currentWarehouse: 'СПБ'
      });
    }
    
    // Если заказ не на МСК и не на СПБ (какой-то другой склад) - пропускаем
    if (currentWarehouseId && !isOnMSK && !isOnSPB) {
      console.log(`⚠️ Заказ на другом складе (ID: ${currentWarehouseId}), пропускаем`);
      return res.status(200).json({ 
        message: 'Заказ на другом складе',
        order: order.name,
        currentWarehouseId: currentWarehouseId
      });
    }
    
    // Если дошли сюда - либо склад не указан, либо это МСК
    console.log(`🔍 Заказ ${!currentWarehouseId ? 'без склада' : 'на складе МСК'}, проверяем остатки...`);
    
    // Проверяем остатки по всем позициям
    let needWarehouseChange = false;
    let reasons = [];
    
    if (order.positions && order.positions.rows) {
      console.log(`📦 Позиций в заказе: ${order.positions.rows.length}`);
      
      for (const position of order.positions.rows) {
        const productId = position.assortment?.id;
        const productName = position.assortment?.name || 'Неизвестный товар';
        const orderedQuantity = position.quantity;
        
        if (!productId) {
          console.log(`↪️ Пропускаем позицию без ID товара: ${productName}`);
          continue;
        }
        
        console.log(`🔎 Проверяем товар: ${productName}, Количество: ${orderedQuantity}`);
        
        // Получаем остаток на складе МСК
        const stockMSK = await checkStock(productId, WAREHOUSE_IDS.MSK);
        console.log(`📊 Остаток на МСК: ${stockMSK}`);
        
        // Если остатка недостаточно
        if (stockMSK < orderedQuantity) {
          // Проверяем наличие на складе СПБ
          const stockSPB = await checkStock(productId, WAREHOUSE_IDS.SPB);
          console.log(`📊 Остаток на СПБ: ${stockSPB}`);
          
          if (stockSPB >= orderedQuantity) {
            needWarehouseChange = true;
            reasons.push({
              product: productName,
              ordered: orderedQuantity,
              stockMSK: stockMSK,
              stockSPB: stockSPB,
              reason: `Недостаточно на МСК (${stockMSK} < ${orderedQuantity}), но есть на СПБ (${stockSPB})`
            });
            console.log(`⚠️ Товар ${productName}: недостаточно на МСК, но достаточно на СПБ`);
          } else {
            console.log(`❌ Товар ${productName}: недостаточно на обоих складах`);
            reasons.push({
              product: productName,
              ordered: orderedQuantity,
              stockMSK: stockMSK,
              stockSPB: stockSPB,
              reason: `Недостаточно на обоих складах (МСК: ${stockMSK}, СПБ: ${stockSPB})`
            });
          }
        } else {
          console.log(`✅ Товар ${productName}: достаточно на МСК (${stockMSK} >= ${orderedQuantity})`);
        }
      }
    } else {
      console.log('📭 Нет позиций в заказе');
    }
    
    // Если нужно сменить склад
    if (needWarehouseChange) {
      console.log(`🔄 Меняем склад на СПБ. Причины:`, reasons);
      
      try {
        const updatedOrder = await changeOrderWarehouse(orderId, WAREHOUSE_IDS.SPB);
        
        console.log(`✅ Склад успешно изменен на СПБ для заказа ${order.name}`);
        
        return res.status(200).json({ 
          success: true,
          message: 'Склад изменен на СПБ',
          order: updatedOrder.name,
          orderId: updatedOrder.id,
          oldWarehouse: currentWarehouseId ? 'МСК' : 'Не указан',
          newWarehouse: 'СПБ',
          reasons: reasons,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.log(`❌ Ошибка при изменении склада: ${error.message}`);
        return res.status(500).json({ 
          error: 'Ошибка при изменении склада',
          details: error.message,
          order: order.name,
          reasons: reasons
        });
      }
    } else {
      console.log(`✅ Заказ не требует изменений. Все товары в наличии на МСК`);
      
      // Если склад не был указан, но все есть на МСК - можно установить склад МСК
      if (!currentWarehouseId) {
        console.log(`🔧 Заказ без склада, но товары есть на МСК. Устанавливаем склад МСК...`);
        try {
          const updatedOrder = await changeOrderWarehouse(orderId, WAREHOUSE_IDS.MSK);
          console.log(`✅ Склад установлен: МСК`);
          
          return res.status(200).json({ 
            success: true,
            message: 'Склад установлен: МСК',
            order: updatedOrder.name,
            orderId: updatedOrder.id,
            warehouse: 'МСК',
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.log(`⚠️ Не удалось установить склад: ${error.message}`);
        }
      }
      
      return res.status(200).json({ 
        success: true,
        message: 'Заказ не требует изменений',
        order: order.name,
        orderId: order.id,
        warehouse: currentWarehouseId ? 'МСК' : 'Не указан',
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    console.error('Детали ошибки:', error.response?.data || error.message);
    
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Добавим GET endpoint для проверки
export const config = {
  api: {
    bodyParser: true
  }
};
