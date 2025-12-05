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

// Упрощенная функция проверки остатков
async function checkStock(productId, warehouseId) {
  try {
    console.log(`🔍 Проверка остатков: товар ${productId}, склад ${warehouseId}`);
    
    // Прямой запрос остатков для конкретного товара на конкретном складе
    const response = await axiosInstance.get(
      `/report/stock/all?filter=store=${warehouseId};assortmentId=${productId}`
    );
    
    if (response.data.rows && response.data.rows.length > 0) {
      const stock = response.data.rows[0].stock || 0;
      console.log(`✅ Найдено: ${stock} шт. для товара ${productId} на складе ${warehouseId}`);
      return stock;
    }
    
    console.log(`❌ Товар ${productId} не найден на складе ${warehouseId} или остаток = 0`);
    return 0;
    
  } catch (error) {
    console.error(`Ошибка при проверке остатков для ${productId}:`, error.message);
    return 0;
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
    console.log('✅ Склад успешно изменен:', response.data.name);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка при изменении склада:', error.message);
    throw error;
  }
}

// Вспомогательная функция для извлечения ID из ссылки
function extractIdFromHref(href) {
  if (!href) return null;
  const parts = href.split('/');
  return parts[parts.length - 1];
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
    
    if (currentWarehouseId && !isOnMSK && !isOnSPB) {
      console.log(`⚠️ Заказ на другом складе, пропускаем`);
      return res.status(200).json({ 
        message: 'Заказ на другом складе',
        order: order.name
      });
    }
    
    console.log(`🔍 Заказ на складе МСК, проверяем остатки...`);
    
    // Проверяем остатки по позициям
    let needWarehouseChange = false;
    let problemProducts = [];
    let hasAnyProduct = false;
    
    if (order.positions && order.positions.rows) {
      console.log(`📋 Начинаем проверку ${order.positions.rows.length} позиций...`);
      
      for (let i = 0; i < order.positions.rows.length; i++) {
        const position = order.positions.rows[i];
        console.log(`\n--- Позиция ${i + 1} ---`);
        
        const assortment = position.assortment;
        if (!assortment) {
          console.log('❌ Пропускаем: нет assortment');
          continue;
        }
        
        // Получаем ID товара разными способами
        let productId = assortment.id;
        if (!productId && assortment.meta && assortment.meta.href) {
          productId = extractIdFromHref(assortment.meta.href);
          console.log(`Извлечен ID из href: ${productId}`);
        }
        
        if (!productId) {
          console.log('❌ Пропускаем: не удалось получить ID товара');
          continue;
        }
        
        const productName = assortment.name || 'Неизвестный товар';
        const productType = assortment.meta?.type;
        const orderedQuantity = position.quantity;
        
        // Пропускаем услуги и комплекты
        if (productType === 'service' || productType === 'bundle') {
          console.log(`↪️ Пропускаем ${productType}: ${productName}`);
          continue;
        }
        
        // Пропускаем позиции без цены или с нулевой ценой
        if (!position.price || position.price === 0) {
          console.log(`↪️ Пропускаем товар без цены: ${productName}`);
          continue;
        }
        
        hasAnyProduct = true;
        console.log(`🔎 Проверяем товар: ${productName}`);
        console.log(`   ID: ${productId}`);
        console.log(`   Тип: ${productType}`);
        console.log(`   Заказано: ${orderedQuantity}`);
        console.log(`   Цена: ${position.price}`);
        
        // Проверяем остатки на МСК
        console.log(`   Проверяем остатки на МСК...`);
        const stockMSK = await checkStock(productId, WAREHOUSE_IDS.MSK);
        
        if (stockMSK < orderedQuantity) {
          console.log(`   ❌ На МСК недостаточно: ${stockMSK} < ${orderedQuantity}`);
          
          // Проверяем остатки на СПБ
          console.log(`   Проверяем остатки на СПБ...`);
          const stockSPB = await checkStock(productId, WAREHOUSE_IDS.SPB);
          
          if (stockSPB >= orderedQuantity) {
            needWarehouseChange = true;
            problemProducts.push({
              name: productName,
              productId: productId,
              ordered: orderedQuantity,
              stockMSK: stockMSK,
              stockSPB: stockSPB,
              reason: `На МСК: ${stockMSK} шт., на СПБ: ${stockSPB} шт.`
            });
            console.log(`   ✅ На СПБ достаточно: ${stockSPB} >= ${orderedQuantity}`);
          } else {
            console.log(`   ❌ На СПБ тоже недостаточно: ${stockSPB} < ${orderedQuantity}`);
          }
        } else {
          console.log(`   ✅ На МСК достаточно: ${stockMSK} >= ${orderedQuantity}`);
        }
      }
    }
    
    // Если не было товаров для проверки
    if (!hasAnyProduct) {
      console.log(`📭 В заказе нет товаров для проверки. Причины:`);
      console.log(`   - Могут быть только услуги или комплекты`);
      console.log(`   - Товары могут быть без assortment.id`);
      console.log(`   - Могут быть товары с нулевой ценой`);
      console.log(`   Проверьте логи выше для деталей по каждой позиции`);
      
      return res.status(200).json({ 
        success: true,
        message: 'В заказе нет товаров для проверки',
        order: order.name,
        positionsCount: order.positions?.rows?.length || 0
      });
    }
    
    // Если нужно сменить склад
    if (needWarehouseChange && problemProducts.length > 0) {
      console.log(`🔄 Меняем склад на СПБ. Причина: товары недоступны на МСК`);
      console.log('Проблемные товары:', problemProducts);
      
      try {
        const updatedOrder = await changeOrderWarehouse(orderId, WAREHOUSE_IDS.SPB);
        
        console.log(`✅ Склад успешно изменен на СПБ для заказа ${order.name}`);
        
        return res.status(200).json({ 
          success: true,
          message: 'Склад изменен на СПБ',
          order: updatedOrder.name,
          orderId: updatedOrder.id,
          oldWarehouse: 'МСК',
          newWarehouse: 'СПБ',
          problemProducts: problemProducts,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.log(`❌ Ошибка при изменении склада: ${error.message}`);
        return res.status(500).json({ 
          error: 'Ошибка при изменении склада',
          details: error.message,
          order: order.name,
          problemProducts: problemProducts
        });
      }
    } else {
      console.log(`✅ Заказ не требует изменений`);
      
      // Если склад не указан, устанавливаем МСК
      if (!currentWarehouseId) {
        console.log(`🔧 Заказ без склада, устанавливаем склад МСК...`);
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
        warehouse: 'МСК',
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    if (error.response) {
      console.error('Детали ошибки:', error.response.data);
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
