const axios = require('axios');

module.exports = async function handler(req, res) {
  console.log('=== INSALES ORDER PROCESSOR ===');
  
  if (req.method === 'GET') {
    return res.status(200).json({ 
      status: 'ready', 
      message: 'System is working',
      timestamp: new Date().toISOString()
    });
  }
  
  try {
    // Используем тот же формат URL, что работает в браузере
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
    
    // Простая логика: меняем все заказы с МСК на СПБ
    for (const order of orders) {
      if (order.warehouse_id == MSK_STOCK_ID) {
        console.log(`Processing order #${order.number} on MSK stock`);
        
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
          
          console.log(`✅ Changed order ${order.number} to SPB stock`);
          results.push({
            order: order.number,
            status: 'changed_to_spb',
            success: true
          });
          
        } catch (error) {
          console.log(`Error changing order ${order.number}:`, error.message);
          console.log('Error response:', error.response?.data);
          results.push({
            order: order.number,
            status: 'error',
            error: error.message
          });
        }
      } else {
        console.log(`Order #${order.number} not on MSK stock (warehouse: ${order.warehouse_id})`);
      }
    }
    
    res.status(200).json({
      success: true,
      checked: orders.length,
      processed: results.length,
      results: results
    });
    
  } catch (error) {
    console.error('Main error:', error.message);
    console.error('Error config:', {
      url: error.config?.url,
      method: error.config?.method,
      params: error.config?.params
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
      url: error.config?.url
    });
  }
};
