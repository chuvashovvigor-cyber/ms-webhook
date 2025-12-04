const axios = require('axios');

module.exports = async function handler(req, res) {
  console.log('=== INSALES ORDER PROCESSOR ===');
  console.log('Time:', new Date().toISOString());
  
  // Разрешаем GET для тестирования
  if (req.method === 'GET') {
    return res.status(200).json({ 
      status: 'online', 
      message: 'Insales order processor is running',
      endpoint: 'Use POST to process orders',
      timestamp: new Date().toISOString()
    });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Проверяем секретный ключ для вызовов из cron
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('Unauthorized access attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Ваш Insales API URL с авторизацией
    const INSALES_API_URL = 'https://0c2a7555e80a577feb222d2eb8921c25.dtc9369c625872e91dcfa7e5675e5675e6066@myshop-btf167.myinsales.ru';
    
    // ID складов
    const MSK_STOCK_ID = '1513489';  // Склад МСК
    const SPB_STOCK_ID = '1513494';  // Склад СПБ
    
    console.log('Склад МСК ID:', MSK_STOCK_ID);
    console.log('Склад СПБ ID:', SPB_STOCK_ID);
    
    // Если запрос пришел от Insales (вебхук) с данными заказа
    if (req.body && req.body.id) {
      console.log('Получен заказ через вебхук:', req.body.id);
      return await processOrderFromWebhook(req.body, INSALES_API_URL, MSK_STOCK_ID, SPB_STOCK_ID, res);
    }
    
    // Если это ручной вызов или вызов из cron - обрабатываем новые заказы
    console.log('Проверка новых заказов...');
    
    // Получаем заказы за последний час
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const fromDate = oneHourAgo.toISOString().split('.')[0] + '+03:00';
    
    console.log('Ищем заказы созданные после:', fromDate);
    
    const ordersResponse = await axios.get(
      `${INSALES_API_URL}/admin/orders.json`,
      {
        params: {
          created_at_min: fromDate,
          per_page: 50,
          order: 'created_at desc'
        }
      }
    );
    
    const orders = ordersResponse.data || [];
    console.log(`Найдено новых заказов: ${orders.length}`);
    
    const results = [];
    
    // Обрабатываем каждый заказ
    for (const order of orders) {
      const result = await processSingleOrder(order, INSALES_API_URL, MSK_STOCK_ID, SPB_STOCK_ID);
      results.push(result);
    }
    
    const changedOrders = results.filter(r => r.changed);
    
    res.status(200).json({
      success: true,
      message: 'Orders processed',
      processed: orders.length,
      changed: changedOrders.length,
      results: results
    });
    
  } catch (error) {
    console.error('Общая ошибка:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// Функция обработки одного заказа
async function processSingleOrder(order, apiUrl, mskStockId, spbStockId) {
  try {
    console.log(`\nОбработка заказа #${order.number || order.id}`);
    
    // Проверяем текущий склад
    const currentStockId = order.warehouse_id;
    console.log(`Текущий склад: ${currentStockId}`);
    
    // Если заказ уже на СПБ, пропускаем
    if (currentStockId == spbStockId) {
      console.log('Заказ уже на СПБ, пропускаем');
      return {
        orderId: order.id,
        orderNumber: order.number,
        status: 'already_on_spb',
        changed: false
      };
    }
    
    // Если заказ не на МСК, пропускаем (может быть на другом складе)
    if (currentStockId != mskStockId) {
      console.log(`Заказ на складе ${currentStockId} (не МСК), пропускаем`);
      return {
        orderId: order.id,
        orderNumber: order.number,
        status: 'not_on_msk',
        changed: false
      };
    }
    
    // Получаем детали заказа
    const orderDetailsResponse = await axios.get(`${apiUrl}/admin/orders/${order.id}.json`);
    const orderDetails = orderDetailsResponse.data;
    const lineItems = orderDetails.order_lines || [];
    
    console.log(`Товаров в заказе: ${lineItems.length}`);
    
    // Проверяем каждый товар
    for (const item of lineItems) {
      if (!item.variant_id) continue;
      
      console.log(`Проверка товара: ${item.title}, variant_id: ${item.variant_id}, quantity: ${item.quantity}`);
      
      // Получаем остатки для варианта товара
      try {
        // Пробуем разные endpoints для остатков
        const endpoints = [
          `${apiUrl}/admin/variants/${item.variant_id}/stock_entries.json`,
          `${apiUrl}/admin/variants/${item.variant_id}/inventory_levels.json`,
          `${apiUrl}/admin/variants/${item.variant_id}/stock_items.json`,
          `${apiUrl}/admin/products/${item.product_id}/variants/${item.variant_id}/stock_entries.json`
        ];
        
        let stockItems = [];
        
        for (const endpoint of endpoints) {
          try {
            const response = await axios.get(endpoint);
            if (response.data && Array.isArray(response.data)) {
              stockItems = response.data;
              console.log(`Найдены остатки через ${endpoint.split('/').pop()}`);
              break;
            }
          } catch (e) {
            // Пробуем следующий endpoint
          }
        }
        
        if (stockItems.length === 0) {
          console.log('Не удалось получить остатки через API');
          // Если не можем проверить остатки, лучше не менять склад
          return {
            orderId: order.id,
            orderNumber: order.number,
            status: 'cant_check_stock',
            changed: false
          };
        }
        
        console.log('Информация об остатках:', stockItems);
        
        // Ищем остатки на МСК и СПБ
        const mskStock = stockItems.find(s => s.stock_id == mskStockId);
        const spbStock = stockItems.find(s => s.stock_id == spbStockId);
        
        const mskQuantity = mskStock ? (mskStock.quantity || mskStock.available || 0) : 0;
        const spbQuantity = spbStock ? (spbStock.quantity || spbStock.available || 0) : 0;
        const requiredQuantity = item.quantity || 1;
        
        console.log(`Остатки: МСК=${mskQuantity}, СПБ=${spbQuantity}, Нужно=${requiredQuantity}`);
        
        // Если на МСК недостаточно, а на СПБ достаточно
        if (mskQuantity < requiredQuantity && spbQuantity >= requiredQuantity) {
          console.log('❌ Недостаточно на МСК, достаточно на СПБ');
          
          // Меняем склад на СПБ
          await axios.put(
            `${apiUrl}/admin/orders/${order.id}.json`,
            {
              order: {
                warehouse_id: spbStockId
              }
            }
          );
          
          console.log(`✅ Склад изменен с ${mskStockId} на ${spbStockId}`);
          
          return {
            orderId: order.id,
            orderNumber: order.number,
            status: 'changed_to_spb',
            changed: true,
            reason: `Недостаточно товара на МСК (${mskQuantity} < ${requiredQuantity})`
          };
        }
        
        console.log('✅ Товар в наличии на МСК');
        
      } catch (stockError) {
        console.log(`Ошибка проверки остатков: ${stockError.message}`);
        // Продолжаем проверку других товаров
      }
    }
    
    // Все товары в наличии на МСК
    console.log('Все товары в наличии на МСК, склад не меняем');
    return {
      orderId: order.id,
      orderNumber: order.number,
      status: 'enough_on_msk',
      changed: false
    };
    
  } catch (error) {
    console.error(`Ошибка обработки заказа ${order.id}:`, error.message);
    return {
      orderId: order.id,
      status: 'error',
      error: error.message,
      changed: false
    };
  }
}

// Функция обработки заказа из вебхука
async function processOrderFromWebhook(order, apiUrl, mskStockId, spbStockId, res) {
  try {
    console.log('Обработка заказа из вебхука:', order.id);
    
    // Проверяем текущий склад
    const currentStockId = order.warehouse_id;
    
    // Если заказ уже на СПБ, пропускаем
    if (currentStockId == spbStockId) {
      console.log('Заказ уже на СПБ');
      return res.status(200).json({
        success: true,
        message: 'Order already on SPB',
        orderId: order.id,
        changed: false
      });
    }
    
    // Если заказ не на МСК, пропускаем
    if (currentStockId != mskStockId) {
      console.log(`Заказ на складе ${currentStockId} (не МСК)`);
      return res.status(200).json({
        success: true,
        message: 'Order not on MSK stock',
        orderId: order.id,
        changed: false
      });
    }
    
    // Получаем детали заказа
    const orderDetailsResponse = await axios.get(`${apiUrl}/admin/orders/${order.id}.json`);
    const orderDetails = orderDetailsResponse.data;
    const lineItems = orderDetails.order_lines || [];
    
    console.log(`Товаров в заказе: ${lineItems.length}`);
    
    // Проверяем остатки
    for (const item of lineItems) {
      if (!item.variant_id) continue;
      
      console.log(`Проверка товара: ${item.title}, variant_id: ${item.variant_id}`);
      
      // Пробуем получить остатки
      try {
        const endpoints = [
          `${apiUrl}/admin/variants/${item.variant_id}/stock_entries.json`,
          `${apiUrl}/admin/variants/${item.variant_id}/inventory_levels.json`
        ];
        
        let stockItems = [];
        
        for (const endpoint of endpoints) {
          try {
            const response = await axios.get(endpoint);
            if (response.data && Array.isArray(response.data)) {
              stockItems = response.data;
              break;
            }
          } catch (e) {
            // Пробуем следующий endpoint
          }
        }
        
        if (stockItems.length === 0) {
          console.log('Не удалось получить остатки');
          continue;
        }
        
        // Ищем остатки на МСК и СПБ
        const mskStock = stockItems.find(s => s.stock_id == mskStockId);
        const spbStock = stockItems.find(s => s.stock_id == spbStockId);
        
        const mskQuantity = mskStock ? (mskStock.quantity || mskStock.available || 0) : 0;
        const spbQuantity = spbStock ? (spbStock.quantity || spbStock.available || 0) : 0;
        const requiredQuantity = item.quantity || 1;
        
        console.log(`Остатки: МСК=${mskQuantity}, СПБ=${spbQuantity}, Нужно=${requiredQuantity}`);
        
        // Если на МСК недостаточно, а на СПБ достаточно
        if (mskQuantity < requiredQuantity && spbQuantity >= requiredQuantity) {
          console.log('Меняем склад на СПБ');
          
          // Меняем склад
          await axios.put(
            `${apiUrl}/admin/orders/${order.id}.json`,
            {
              order: {
                warehouse_id: spbStockId
              }
            }
          );
          
          return res.status(200).json({
            success: true,
            message: 'Stock changed to SPB',
            orderId: order.id,
            changed: true,
            reason: `Insufficient stock on MSK (${mskQuantity} < ${requiredQuantity})`
          });
        }
      } catch (error) {
        console.log(`Ошибка проверки остатков: ${error.message}`);
      }
    }
    
    // Все товары в наличии на МСК
    return res.status(200).json({
      success: true,
      message: 'No stock change needed',
      orderId: order.id,
      changed: false
    });
    
  } catch (error) {
    console.error('Ошибка обработки вебхука:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      orderId: order.id
    });
  }
}
