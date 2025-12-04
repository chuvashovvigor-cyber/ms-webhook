const axios = require('axios');

module.exports = async function handler(req, res) {
  console.log('=== INSALES ORDER PROCESSOR ===');
  
  // Разрешаем GET для тестирования
  if (req.method === 'GET') {
    return res.status(200).json({ 
      status: 'ready', 
      message: 'System is working',
      timestamp: new Date().toISOString()
    });
  }
  
  try {
    // Рабочий URL с авторизацией (как в браузере)
    const INSALES_API_URL = 'https://0c2a7555e80a577feb222d2eb8921c25:dtc9369c625872e91dcfa7e5675e5675e6066@myshop-btf167.myinsales.ru';
    const MSK_STOCK_ID = '1513489';  // Склад МСК
    const SPB_STOCK_ID = '1513494';  // Склад СПБ
    
    console.log('Starting order check...');
    
    // Получаем заказы за последние 10 минут
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const fromDate = tenMinutesAgo.toISOString().split('.')[0] + '+03:00';
    
    console.log('Checking orders since:', fromDate);
    
    const ordersResponse = await axios.get(
      `${INSALES_API_URL}/admin/orders.json`,
      {
        params: {
          created_at_min: fromDate,
          per_page: 10,
          order: 'created_at desc'
        }
      }
    );
    
    const orders = ordersResponse.data || [];
    console.log(`Found orders: ${orders.length}`);
    
    const results = [];
    
    // Обрабатываем заказы на складе МСК
    for (const order of orders) {
      console.log(`\nChecking order #${order.number}, warehouse: ${order.warehouse_id}`);
      
      // Если заказ на складе МСК
      if (order.warehouse_id == MSK_STOCK_ID) {
        console.log(`Order #${order.number} is on MSK stock, changing to SPB...`);
        
        try {
          // Меняем склад на СПБ
          const updateResponse = await axios.put(
            `${INSALES_API_URL}/admin/orders/${order.id}.json`,
            {
              order: {
                warehouse_id: SPB_STOCK_ID
              }
            }
          );
          
          console.log(`✅ Successfully changed order #${order.number} to SPB stock`);
          results.push({
            orderId: order.id,
            orderNumber: order.number,
            status: 'changed_to_spb',
            success: true,
            fromStock: MSK_STOCK_ID,
            toStock: SPB_STOCK_ID
          });
          
        } catch (error) {
          console.log(`❌ Error changing order #${order.number}:`, error.message);
          results.push({
            orderId: order.id,
            orderNumber: order.number,
            status: 'error',
            error: error.message,
            success: false
          });
        }
      } else if (order.warehouse_id == SPB_STOCK_ID) {
        console.log(`Order #${order.number} already on SPB stock, skipping`);
        results.push({
          orderId: order.id,
          orderNumber: order.number,
          status: 'already_on_spb',
          success: true
        });
      } else {
        console.log(`Order #${order.number} on different stock (${order.warehouse_id}), skipping`);
        results.push({
          orderId: order.id,
          orderNumber: order.number,
          status: 'different_stock',
          stockId: order.warehouse_id,
          success: true
        });
      }
    }
    
    res.status(200).json({
      success: true,
      message: 'Order processing complete',
      checked: orders.length,
      processed: results.length,
      results: results,
      stocks: {
        msk: MSK_STOCK_ID,
        spb: SPB_STOCK_ID
      }
    });
    
  } catch (error) {
    console.error('Main error:', error.message);
    
    // Подробная информация об ошибке
    if (error.response) {
      console.error('Error status:', error.response.status);
      console.error('Error data:', error.response.data);
      console.error('Error headers:', error.response.headers);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      status: error.response?.status,
      url: error.config?.url
    });
  }
};
