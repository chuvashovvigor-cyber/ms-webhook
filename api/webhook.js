// Формат для Vercel Serverless Functions
import axios from 'axios';

// Конфигурация с вашими данными
const MOYSKLAD_API_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MOYSKLAD_TOKEN = '125720136ed9aeb760288b76614c709f590a9ec4';
const WAREHOUSE_IDS = {
  MSK: '495124d9-e42f-11ed-0a80-0f480010433d', // Склад Мск одежда
  SPB: '064ae98f-f40f-11e9-0a80-012300093c25'  // Склад Спб
};

// Создаем экземпляр axios с настройками
const axiosInstance = axios.create({
  baseURL: MOYSKLAD_API_URL,
  headers: {
    'Authorization': `Bearer ${MOYSKLAD_TOKEN}`,
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// Вспомогательная функция для извлечения ID из ссылки
function extractIdFromHref(href) {
  if (!href) return null;
  const parts = href.split('/');
  return parts[parts.length - 1];
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
    console.log('✅ Склад успешно изменен:', response.data.name);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка при изменении склада:', error.message);
    throw error;
  }
}

// Функция для проверки остатков товара на складе (с правильным фильтром от поддержки)
async function checkStockOnWarehouse(productId, productType, warehouseId) {
  try {
    console.log(`🔍 Проверка остатков: ${productId} (${productType}), склад ${warehouseId}`);
    
    let filter = '';
    
    // Создаем правильный фильтр в зависимости от типа товара
    if (productType === 'variant') {
      filter = `variant=${MOYSKLAD_API_URL}/entity/variant/${productId}`;
    } else if (productType === 'product') {
      filter = `product=${MOYSKLAD_API_URL}/entity/product/${productId}`;
    } else if (productType === 'service') {
      console.log(`↪️ Пропускаем услугу ${productId}`);
      return 999; // Возвращаем большое число для услуг, чтобы они всегда были "в наличии"
    } else {
      console.log(`⚠️ Неизвестный тип товара: ${productType}, пробуем как variant`);
      filter = `variant=${MOYSKLAD_API_URL}/entity/variant/${productId}`;
    }
    
    // Добавляем фильтр по складу
    const fullFilter = `${filter};store.id=${warehouseId}`;
    
    console.log(`Фильтр: ${fullFilter}`);
    
    // Делаем запрос к расширенному отчету
    const response = await axiosInstance.get(
      `/report/stock/all?filter=${fullFilter}`
    );
    
    console.log(`Ответ получен, строк: ${response.data.rows?.length || 0}`);
    
    if (response.data.rows && response.data.rows.length > 0) {
      // Берем первую запись (должна быть только одна для данного товара на данном складе)
      const stock = response.data.rows[0].stock || 0;
      console.log(`✅ Найдено остатков на складе ${warehouseId}: ${stock}`);
      return stock;
    }
    
    console.log(`❌ Товар не найден на складе ${warehouseId} (0 остатков)`);
    return 0;
    
  } catch (error) {
    console.error(`Ошибка при проверке остатков для ${productId}:`, error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Данные:', error.response.data);
    }
    return 0;
  }
}

// Основной обработчик
export default async function handler(req, res) {
  // Разрешаем только POST запросы
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const requestTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`=== НОВЫЙ ВЕБХУК ПОЛУЧЕН === ${requestTime} (МСК)`);
    
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
    console.log(`Общее количество позиций: ${order.positions?.rows?.length || 0}`);
    
    // Получаем ID склада
    let currentWarehouseId = null;
    if (order.store && order.store.meta && order.store.meta.href) {
      currentWarehouseId = order.store.meta.href.split('/').pop();
    }
    
    console.log(`ID склада в заказе: ${currentWarehouseId || 'Не указан'}`);
    
    // Определяем на каком складе заказ
    const isOnMSK = !currentWarehouseId || currentWarehouseId === WAREHOUSE_IDS.MSK;
    const isOnSPB = currentWarehouseId === WAREHOUSE_IDS.SPB;
    
    // Если заказ уже на СПБ - пропускаем
    if (isOnSPB) {
      console.log(`✅ Заказ уже на складе СПБ, пропускаем`);
      return res.status(200).json({ 
        message: 'Заказ уже на СПБ',
        order: order.name
      });
    }
    
    // Если заказ не на МСК и не на СПБ - устанавливаем МСК
    if (currentWarehouseId && !isOnMSK && !isOnSPB) {
      console.log(`⚠️ Заказ на другом складе, меняем на МСК...`);
      try {
        await changeOrderWarehouse(orderId, WAREHOUSE_IDS.MSK);
        console.log(`✅ Склад изменен на МСК`);
        currentWarehouseId = WAREHOUSE_IDS.MSK;
      } catch (error) {
        console.log(`⚠️ Не удалось изменить склад: ${error.message}`);
      }
    }
    
    // Если склад не указан - устанавливаем МСК
    if (!currentWarehouseId) {
      console.log(`🔧 Заказ без склада, устанавливаем склад МСК...`);
      try {
        await changeOrderWarehouse(orderId, WAREHOUSE_IDS.MSK);
        console.log(`✅ Склад установлен: МСК`);
        currentWarehouseId = WAREHOUSE_IDS.MSK;
      } catch (error) {
        console.log(`⚠️ Не удалось установить склад: ${error.message}`);
      }
    }
    
    // Проверяем остатки товаров на МСК
    console.log(`🔍 Проверяем остатки товаров на МСК...`);
    
    let hasMissingProducts = false;
    let foundAnyProduct = false;
    let missingProductsInfo = [];
    
    if (order.positions && order.positions.rows) {
      for (let i = 0; i < order.positions.rows.length; i++) {
        const position = order.positions.rows[i];
        const assortment = position.assortment;
        
        if (!assortment) {
          console.log(`↪️ Пропускаем позицию без assortment`);
          continue;
        }
        
        // Получаем ID товара
        let productId = assortment.id;
        if (!productId && assortment.meta && assortment.meta.href) {
          productId = extractIdFromHref(assortment.meta.href);
        }
        
        if (!productId) {
          console.log(`↪️ Пропускаем позицию без ID товара`);
          continue;
        }
        
        const productName = assortment.name || 'Неизвестный товар';
        const productType = assortment.meta?.type; // variant, product, service
        const orderedQuantity = position.quantity;
        
        // Пропускаем комплекты
        if (productType === 'bundle') {
          console.log(`↪️ Пропускаем комплект: ${productName}`);
          continue;
        }
        
        foundAnyProduct = true;
        console.log(`\n🔎 Проверяем товар: ${productName}`);
        console.log(`   ID: ${productId}, Тип: ${productType}, Количество: ${orderedQuantity}`);
        
        // Проверяем остатки на МСК
        const stockOnMSK = await checkStockOnWarehouse(productId, productType, WAREHOUSE_IDS.MSK);
        
        if (stockOnMSK < orderedQuantity) {
          console.log(`   ❌ На МСК недостаточно: ${stockOnMSK} < ${orderedQuantity}`);
          hasMissingProducts = true;
          
          missingProductsInfo.push({
            name: productName,
            productId: productId,
            type: productType,
            ordered: orderedQuantity,
            availableMSK: stockOnMSK,
            warehouse: 'МСК'
          });
          
          // Если это услуга, то всегда доступна, не проверяем СПБ
          if (productType === 'service') {
            console.log(`   ⚠️ Это услуга, всегда доступна`);
            hasMissingProducts = false; // Услуги не влияют на смену склада
            continue;
          }
          
          // Если нет на МСК, проверяем на СПБ (только для товаров, не услуг)
          console.log(`   Проверяем остатки на СПБ...`);
          const stockOnSPB = await checkStockOnWarehouse(productId, productType, WAREHOUSE_IDS.SPB);
          
          if (stockOnSPB >= orderedQuantity) {
            console.log(`   ✅ На СПБ достаточно: ${stockOnSPB} >= ${orderedQuantity}`);
            missingProductsInfo[missingProductsInfo.length - 1].availableSPB = stockOnSPB;
            missingProductsInfo[missingProductsInfo.length - 1].hasOnSPB = true;
          } else {
            console.log(`   ❌ На СПБ тоже недостаточно: ${stockOnSPB} < ${orderedQuantity}`);
            missingProductsInfo[missingProductsInfo.length - 1].availableSPB = stockOnSPB;
            missingProductsInfo[missingProductsInfo.length - 1].hasOnSPB = false;
          }
        } else {
          console.log(`   ✅ На МСК достаточно: ${stockOnMSK} >= ${orderedQuantity}`);
        }
      }
    }
    
    // Если нет товаров для проверки (только услуги/комплекты)
    if (!foundAnyProduct) {
      console.log(`📭 В заказе нет товаров для проверки, оставляем на МСК`);
      return res.status(200).json({ 
        success: true,
        message: 'В заказе нет товаров для проверки, оставляем на МСК',
        order: order.name
      });
    }
    
    // Если есть недостающие товары на МСК И они есть на СПБ - меняем на СПБ
    if (hasMissingProducts) {
      // Проверяем, есть ли хотя бы один товар, которого нет на МСК, но есть на СПБ
      const hasProductsAvailableOnSPB = missingProductsInfo.some(item => 
        item.hasOnSPB === true && item.type !== 'service'
      );
      
      if (hasProductsAvailableOnSPB) {
        console.log(`🔄 Меняем склад на СПБ (товаров нет на МСК, но есть на СПБ)`);
        console.log('Информация о товарах:', missingProductsInfo);
        
        try {
          const updatedOrder = await changeOrderWarehouse(orderId, WAREHOUSE_IDS.SPB);
          
          console.log(`✅ Склад успешно изменен на СПБ для заказа ${order.name}`);
          
          return res.status(200).json({ 
            success: true,
            message: 'Склад изменен на СПБ (товаров нет на МСК, но есть на СПБ)',
            order: updatedOrder.name,
            orderId: updatedOrder.id,
            oldWarehouse: 'МСК',
            newWarehouse: 'СПБ',
            missingProducts: missingProductsInfo.filter(item => item.hasOnSPB === true),
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.log(`❌ Ошибка при изменении склада: ${error.message}`);
          return res.status(500).json({ 
            error: 'Ошибка при изменении склада',
            details: error.message,
            order: order.name,
            missingProducts: missingProductsInfo
          });
        }
      } else {
        console.log(`⚠️ Товаров нет на МСК, но их также нет и на СПБ, оставляем на МСК`);
        console.log('Информация о товарах:', missingProductsInfo);
        
        return res.status(200).json({ 
          success: true,
          message: 'Товаров нет ни на МСК, ни на СПБ, оставляем на МСК',
          order: order.name,
          missingProducts: missingProductsInfo,
          warehouse: 'МСК'
        });
      }
    } else {
      console.log(`✅ Все товары есть на МСК, оставляем как есть`);
      return res.status(200).json({ 
        success: true,
        message: 'Все товары есть на МСК',
        order: order.name,
        warehouse: 'МСК'
      });
    }
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Данные:', error.response.data);
    }
    
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
}

export const config = {
  api: {
    bodyParser: true
  }
};
