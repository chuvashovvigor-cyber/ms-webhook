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

// Основной обработчик
export default async function handler(req, res) {
  // Разрешаем только POST запросы
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('=== НОВЫЙ ВЕБХУК ПОЛУЧЕН ===');
    console.log('Тело запроса:', JSON.stringify(req.body, null, 2));
    
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
    const orderResponse = await axiosInstance.get(`/entity/customerorder/${orderId}?expand=positions`);
    const order = orderResponse.data;
    
    console.log(`Заказ: ${order.name}, Склад: ${order.store?.name || 'Не указан'}`);
    
    // Проверяем, нужно ли обрабатывать этот заказ
    if (order.store?.id !== WAREHOUSE_IDS.MSK) {
      console.log(`Заказ не на складе МСК, пропускаем`);
      return res.status(200).json({ 
        message: 'Заказ не требует обработки',
        order: order.name
      });
    }
    
    console.log(`Заказ на складе МСК, проверяем остатки...`);
    
    // Проверяем остатки по всем позициям
    let needWarehouseChange = false;
    
    if (order.positions && order.positions.rows) {
      for (const position of order.positions.rows) {
        const productId = position.assortment?.id;
        if (!productId) continue;
        
        const stockMSK = await checkStock(productId, WAREHOUSE_IDS.MSK);
        const orderedQuantity = position.quantity;
        
        console.log(`Товар ${position.assortment?.name}: заказано ${orderedQuantity}, на МСК: ${stockMSK}`);
        
        // Если остатка недостаточно
        if (stockMSK < orderedQuantity) {
          const stockSPB = await checkStock(productId, WAREHOUSE_IDS.SPB);
          console.log(`На СПБ: ${stockSPB}`);
          
          if (stockSPB >= orderedQuantity) {
            needWarehouseChange = true;
          }
          break;
        }
      }
    }
    
    // Если нужно сменить склад
    if (needWarehouseChange) {
      console.log('Меняем склад на СПБ');
      const updatedOrder = await changeOrderWarehouse(orderId, WAREHOUSE_IDS.SPB);
      
      return res.status(200).json({ 
        success: true,
        message: 'Склад изменен на СПБ',
        order: updatedOrder.name,
        oldWarehouse: 'МСК',
        newWarehouse: 'СПБ'
      });
    }
    
    return res.status(200).json({ 
      success: true,
      message: 'Заказ не требует изменений',
      order: order.name
    });
    
  } catch (error) {
    console.error('Ошибка:', error.response?.data || error.message);
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
