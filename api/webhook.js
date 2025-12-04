const axios = require('axios');

module.exports = async function handler(req, res) {
  console.log('=== ORDER PROCESSOR ===');
  
  // Разрешаем все методы для тестирования
  if (req.method === 'GET') {
    return res.status(200).json({ 
      status: 'ready', 
      message: 'System is working',
      timestamp: new Date().toISOString()
    });
  }
  
  try {
    // Данные Insales API
    const INSALES_API_URL = 'https://0c2a7555e80a577feb222d2eb8921c25.dtc9369c625872e91dcfa7e5675e5675e6066@myshop-btf167.myinsales.ru';
    const MSK_STOCK_ID = '1513489';  // Склад МСК
    const SPB_STOCK_ID = '1513494';  // Склад СПБ
    
    console.log('Starting order check...');
    
    // Получаем заказы за последние 30 минут
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const fromDate = thirtyMinutesAgo.toISOString().split('.')[0] + '+03:00';
    
    console.log('Checking orders since:', fromDate);
    
    const ordersResponse = await axios.get(
      `${INSALES_API_URL}/admin/orders.json`,
      {
        params: {
          created_at_min: fromDate,
          per_page: 20,
          order: 'created_at desc'
        }
      }
    );
    
    const orders = ordersResponse.data || [];
    console.log(`Found orders: ${orders.length}`);
    
    const results = [];
    
    // Проверяем только заказы на складе МСК
    for (const order of orders) {
      if (order.warehouse_id == MSK_STOCK_ID) {
        console.log(`Processing order #${order.number} on MSK stock`);
        
        // Простая логика: всегда меняем на СПБ для теста
        // В реальности здесь должна быть проверка остатков
        
        try {
          // Меняем склад на СПБ
          await axios.put(
            `${INSALES_API_URL}/admin/orders/${order.id}.json`,
            {
              order: {
                warehouse_id: SPB_STOCK_ID
              }
            }
          );
          
          console.log(`✅ Changed order ${order.number} to SPB stock`);
          results.push({
            order: order.number,
            status: 'changed_to_spb',
            success: true
          });
          
        } catch (error) {
          console.log(`Error changing order ${order.number}:`, error.message);
          results.push({
            order: order.number,
            status: 'error',
            error: error.message
          });
        }
      }
    }
    
    res.status(200).json({
      success: true,
      checked: orders.length,
      processed: results.length,
      results: results
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
