// Формат для Vercel Serverless Functions
import axios from 'axios';

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

// Функция для проверки остатков - ИСПРАВЛЕННАЯ ВЕРСИЯ 2
async function checkStock(productId, warehouseId) {
  try {
    console.log(`Запрос остатков: товар=${productId}, склад=${warehouseId}`);
    
    // Используем правильный endpoint
    const response = await axiosInstance.get(
      `/report/stock/bystore/current?filter=store.id=${warehouseId}`
    );
    
    console.log(`Получено позиций в остатках: ${response.data.length}`);
    
    // Ищем наш товар в полученных остатках
    const foundStock = response.data.find(item => {
      return item.assortmentId === productId || 
             (item.assortment && item.assortment.id === productId);
    });
    
    if (foundStock) {
      const stock = foundStock.stock || 0;
      console.log(`Найдено остатков: ${stock}`);
      return stock;
    }
    
    console.log('Товар не найден в остатках этого склада');
    return 0;
    
  } catch (error) {
    console.error('Ошибка при проверке остатков:', error.message);
    console.error('Детали ошибки:', error.response?.data || error.message);
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
    console.log('Склад успешно изменен:', response.data.name);
    return response.data;
  } catch (error) {
    console.error('Ошибка при изменении склада:', error.message);
    console.error('Детали ошибки:', error.response?.data || error.message);
    throw error;
  }
}

// Функция для получения детальной информации о позициях заказа
async function getOrderPositionsDetails(orderId) {
  try {
    console.log(`Получаем детали позиций для заказа ${orderId}`);
    
    // Получаем позиции заказа с расширенной информацией
    const response = await axiosInstance.get(
      `/entity/customerorder/${orderId}/positions?expand=assortment`
    );
    
    console.log(`Позиции заказа: ${response.data.rows.length}`);
    return response.data.rows || [];
  } catch (error) {
    console.error('Ошибка при получении позиций:', error.message);
    return [];
  }
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
    const orderResponse = await axiosInstance.get(`/entity/customerorder/${orderId}`);
    const order = orderResponse.data;
    
    console.log(`Заказ: ${order.name}`);
    
    // Получаем ID склада из meta.href (правильный способ)
    const storeHref = order.store?.meta?.href;
    const currentWarehouseId = storeHref ? storeHref.split('/').pop() : null;
    
    console.log(`ID склада в заказе: ${currentWarehouseId || 'Не указан'}`);
    
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
    
    // Получаем детализированные позиции заказа
    const positions = await getOrderPositionsDetails(orderId);
    
    // Проверяем остатки по всем позициям
    let needWarehouseChange = false;
    let checkedPositions = 0;
    let reasons = [];
    
    console.log(`📦 Всего позиций для проверки: ${positions.length}`);
    
    for (const position of positions) {
      const assortment = position.assortment;
      if (!assortment) {
        console.log(`↪️ Пропускаем позицию без товара`);
        continue;
      }
      
      const productId = assortment.id;
      const productName = assortment.name || 'Неизвестный товар';
      const productType = assortment.meta?.type;
      const orderedQuantity = position.quantity;
      
      // Пропускаем услуги (services)
      if (productType === 'service' || productType === 'bundle') {
        console.log(`↪️ Пропускаем ${productType}: ${productName}`);
        continue;
      }
      
      if (!productId) {
        console.log(`↪️ Пропускаем позицию без ID товара: ${productName}`);
        continue;
      }
      
      checkedPositions++;
      console.log(`🔎 Проверяем товар: ${productName} (ID: ${productId}), Количество: ${orderedQuantity}`);
      
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
    
    console.log(`✅ Проверено позиций: ${checkedPositions} из ${positions.length}`);
    
    // Если не было проверено ни одной позиции
    if (checkedPositions === 0) {
      console.log(`⚠️ Не было проверено ни одной позиции`);
      
      return res.status(200).json({ 
        success: true,
        message: 'Заказ без проверяемых товаров',
        order: order.name,
        orderId: order.id,
        note: 'Позиции заказа не содержат товаров с остатками',
        timestamp: new Date().toISOString()
      });
    }
    
    // Если нужно сменить склад
    if (needWarehouseChange) {
      console.log(`🔄 Меняем склад на СПБ`);
      
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
      console.log(`✅ Заказ не требует изменений`);
      
      // Если склад не был указан, устанавливаем склад МСК
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
        warehouse: currentWarehouseId ? 'МСК' : 'Не указан',
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    console.error('Детали ошибки:', error.response?.data || error.message);
    
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
}

// Добавим GET endpoint для проверки
export const config = {
  api: {
    bodyParser: true
  }
};
