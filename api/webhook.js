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

// Упрощенная функция проверки - смотрим доступность через простой запрос
async function checkProductAvailability(productId) {
  try {
    console.log(`🔍 Проверяем товар ${productId}...`);
    
    // Просто пытаемся получить информацию о товаре
    const response = await axiosInstance.get(`/entity/variant/${productId}`);
    
    if (response.data) {
      console.log(`✅ Товар ${productId} существует в системе`);
      // Если запрос прошел успешно, считаем что товар доступен
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error(`❌ Ошибка при проверке товара ${productId}:`, error.message);
    
    // Если товар не найден (404) или другая ошибка
    if (error.response && error.response.status === 404) {
      console.log(`❌ Товар ${productId} не найден в системе`);
      return false;
    }
    
    // При других ошибках считаем что товар недоступен
    return false;
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
    
    // ПРОСТАЯ ЛОГИКА: если все товары доступны - оставляем на МСК, иначе меняем на СПБ
    console.log(`🔍 Проверяем доступность товаров...`);
    
    let allProductsAvailable = true;
    let foundAnyProduct = false;
    let unavailableProducts = [];
    
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
        const productType = assortment.meta?.type;
        const orderedQuantity = position.quantity;
        
        // Пропускаем услуги и комплекты
        if (productType === 'service' || productType === 'bundle') {
          console.log(`↪️ Пропускаем ${productType}: ${productName}`);
          continue;
        }
        
        foundAnyProduct = true;
        console.log(`🔎 Товар: ${productName}, ID: ${productId}, Количество: ${orderedQuantity}`);
        
        // Проверяем доступность товара
        const isAvailable = await checkProductAvailability(productId);
        
        if (!isAvailable) {
          console.log(`❌ Товар ${productName} недоступен`);
          allProductsAvailable = false;
          unavailableProducts.push(productName);
        } else {
          console.log(`✅ Товар ${productName} доступен`);
        }
      }
    }
    
    // Если нет товаров для проверки (только услуги)
    if (!foundAnyProduct) {
      console.log(`📭 В заказе только услуги, оставляем на МСК`);
      return res.status(200).json({ 
        success: true,
        message: 'В заказе только услуги, оставляем на МСК',
        order: order.name
      });
    }
    
    // Если все товары доступны - оставляем на МСК
    if (allProductsAvailable) {
      console.log(`✅ Все товары доступны, оставляем заказ на МСК`);
      return res.status(200).json({ 
        success: true,
        message: 'Все товары доступны, оставляем на МСК',
        order: order.name,
        warehouse: 'МСК'
      });
    } else {
      // Если есть недоступные товары - меняем на СПБ
      console.log(`🔄 Меняем склад на СПБ (некоторые товары недоступны)`);
      console.log(`Недоступные товары: ${unavailableProducts.join(', ')}`);
      
      try {
        const updatedOrder = await changeOrderWarehouse(orderId, WAREHOUSE_IDS.SPB);
        
        console.log(`✅ Склад успешно изменен на СПБ для заказа ${order.name}`);
        
        return res.status(200).json({ 
          success: true,
          message: 'Склад изменен на СПБ (товары недоступны на МСК)',
          order: updatedOrder.name,
          orderId: updatedOrder.id,
          oldWarehouse: 'МСК',
          newWarehouse: 'СПБ',
          unavailableProducts: unavailableProducts,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.log(`❌ Ошибка при изменении склада: ${error.message}`);
        return res.status(500).json({ 
          error: 'Ошибка при изменении склада',
          details: error.message,
          order: order.name,
          unavailableProducts: unavailableProducts
        });
      }
    }
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
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
