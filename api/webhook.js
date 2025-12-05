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
  timeout: 30000
});

// Кэш для остатков (чтобы не делать лишние запросы)
let stockCache = {
  timestamp: 0,
  data: [],
  warehouseId: null
};

// Функция для получения всех остатков на складе
async function getAllStockForWarehouse(warehouseId) {
  try {
    // Проверяем кэш (актуальный в течение 1 минуты)
    const now = Date.now();
    if (stockCache.warehouseId === warehouseId && 
        now - stockCache.timestamp < 60000 && 
        stockCache.data.length > 0) {
      console.log(`Используем кэш для склада ${warehouseId}`);
      return stockCache.data;
    }
    
    console.log(`Запрашиваем все остатки для склада ${warehouseId}`);
    
    // Получаем все остатки без фильтра
    const response = await axiosInstance.get(
      `/report/stock/all?limit=1000`
    );
    
    console.log(`Получено ${response.data.rows.length} записей об остатках`);
    
    // Фильтруем на стороне клиента по ID склада
    const filteredData = response.data.rows.filter(item => {
      // Проверяем разными способами ID склада
      return item.storeId === warehouseId || 
             (item.store && item.store.id === warehouseId) ||
             (item.store && item.store.meta && item.store.meta.href && 
              item.store.meta.href.includes(warehouseId));
    });
    
    console.log(`После фильтрации для склада ${warehouseId}: ${filteredData.length} записей`);
    
    // Сохраняем в кэш
    stockCache = {
      timestamp: now,
      data: filteredData,
      warehouseId: warehouseId
    };
    
    return filteredData;
    
  } catch (error) {
    console.error('Ошибка при получении остатков:', error.message);
    return [];
  }
}

// Функция для проверки остатков конкретного товара
async function checkStock(productId, warehouseId) {
  try {
    // Получаем все остатки на складе
    const warehouseStock = await getAllStockForWarehouse(warehouseId);
    
    // Ищем конкретный товар
    const stockItem = warehouseStock.find(item => {
      return item.assortmentId === productId || 
             (item.assortment && item.assortment.id === productId);
    });
    
    if (stockItem) {
      const stock = stockItem.stock || 0;
      console.log(`Товар ${productId} на складе ${warehouseId}: ${stock}`);
      return stock;
    }
    
    console.log(`Товар ${productId} не найден на складе ${warehouseId}`);
    return 0;
    
  } catch (error) {
    console.error('Ошибка при проверке остатков:', error.message);
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
    
    // Получаем ID склада
    let currentWarehouseId = null;
    if (order.store && order.store.meta && order.store.meta.href) {
      currentWarehouseId = order.store.meta.href.split('/').pop();
    }
    
    console.log(`ID склада в заказе: ${currentWarehouseId || 'Не указан'}`);
    
    // Если склад МСК или не указан - обрабатываем
    const isOnMSK = !currentWarehouseId || currentWarehouseId === WAREHOUSE_IDS.MSK;
    const isOnSPB = currentWarehouseId === WAREHOUSE_IDS.SPB;
    
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
    
    console.log(`🔍 Заказ ${!currentWarehouseId ? 'без склада' : 'на складе МСК'}, проверяем остатки...`);
    
    // Проверяем остатки по позициям
    let needWarehouseChange = false;
    let problemProducts = [];
    
    if (order.positions && order.positions.rows) {
      for (const position of order.positions.rows) {
        const assortment = position.assortment;
        if (!assortment) continue;
        
        const productId = assortment.id;
        const productName = assortment.name || 'Неизвестный товар';
        const productType = assortment.meta?.type;
        const orderedQuantity = position.quantity;
        
        // Пропускаем услуги
        if (productType === 'service' || productType === 'bundle') {
          console.log(`↪️ Пропускаем ${productType}: ${productName}`);
          continue;
        }
        
        if (!productId) {
          console.log(`↪️ Пропускаем позицию без ID товара: ${productName}`);
          continue;
        }
        
        console.log(`🔎 Проверяем товар: ${productName} (ID: ${productId}), Количество: ${orderedQuantity}`);
        
        // Проверяем остатки на МСК
        const stockMSK = await checkStock(productId, WAREHOUSE_IDS.MSK);
        console.log(`📊 Остаток на МСК: ${stockMSK}`);
        
        if (stockMSK < orderedQuantity) {
          // Проверяем остатки на СПБ
          const stockSPB = await checkStock(productId, WAREHOUSE_IDS.SPB);
          console.log(`📊 Остаток на СПБ: ${stockSPB}`);
          
          if (stockSPB >= orderedQuantity) {
            needWarehouseChange = true;
            problemProducts.push({
              name: productName,
              ordered: orderedQuantity,
              stockMSK: stockMSK,
              stockSPB: stockSPB
            });
            console.log(`⚠️ ${productName}: недостаточно на МСК, но достаточно на СПБ`);
          } else {
            console.log(`❌ ${productName}: недостаточно на обоих складах`);
            problemProducts.push({
              name: productName,
              ordered: orderedQuantity,
              stockMSK: stockMSK,
              stockSPB: stockSPB,
              insufficient: true
            });
          }
        } else {
          console.log(`✅ ${productName}: достаточно на МСК (${stockMSK} >= ${orderedQuantity})`);
        }
      }
    }
    
    // Если нужно сменить склад
    if (needWarehouseChange) {
      console.log(`🔄 Меняем склад на СПБ. Проблемные товары:`, problemProducts);
      
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
        warehouse: currentWarehouseId ? 'МСК' : 'Не указан',
        problemProducts: problemProducts,
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

export const config = {
  api: {
    bodyParser: true
  }
};
