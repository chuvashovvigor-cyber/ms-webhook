const axios = require('axios');

module.exports = async function handler(req, res) {
  // Проверяем метод запроса
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    const order = req.body;
    
    // Проверяем, что это заказ покупателя
    if (!order || order.meta?.type !== 'customerorder') {
      return res.status(400).json({ error: 'Invalid order data' });
    }
    
    // Получаем переменные окружения
    const {
      MOYSKLAD_TOKEN,
      MOYSKLAD_API_URL = 'https://api.moysklad.ru/api/remap/1.2',
      MSK_STORE_ID,
      SPB_STORE_ID
    } = process.env;
    
    console.log('Processing order:', order.name || order.id);
    
    // Проверяем все позиции заказа
    const positions = order.positions?.rows || [];
    
    let needToChangeStore = false;
    
    for (const position of positions) {
      if (!position.assortment?.id) continue;
      
      const productId = position.assortment.id;
      const quantity = position.quantity || 1;
      
      console.log(`Checking product ${productId}, quantity: ${quantity}`);
      
      // Получаем остатки
      const stocks = await getProductStocks(
        productId, 
        MOYSKLAD_TOKEN, 
        MOYSKLAD_API_URL,
        MSK_STORE_ID,
        SPB_STORE_ID
      );
      
      console.log(`Stocks for ${productId}: MSK=${stocks.msk}, SPB=${stocks.spb}`);
      
      // Если на МСК недостаточно, а на СПБ достаточно
      if (stocks.msk < quantity && stocks.spb >= quantity) {
        console.log(`Insufficient stock in MSK for product ${productId}`);
        needToChangeStore = true;
        break;
      }
    }
    
    // Если нужно поменять склад
    if (needToChangeStore && SPB_STORE_ID) {
      console.log(`Changing store for order ${order.id} to SPB`);
      
      await changeOrderStore(
        order.id,
        SPB_STORE_ID,
        MOYSKLAD_TOKEN,
        MOYSKLAD_API_URL
      );
      
      return res.status(200).json({ 
        success: true, 
        message: 'Store changed to SPB',
        orderId: order.id
      });
    }
    
    console.log(`No store change needed for order ${order.id}`);
    res.status(200).json({ 
      success: true, 
      message: 'No changes needed',
      orderId: order.id
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
};

// Функция получения остатков
async function getProductStocks(productId, token, apiUrl, mskStoreId, spbStoreId) {
  try {
    const response = await axios.get(
      `${apiUrl}/report/stock/bystore?filter=product.id=${productId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept-Encoding': 'gzip',
          'Content-Type': 'application/json'
        }
      }
    );
    
    const stocks = {
      msk: 0,
      spb: 0
    };
    
    if (response.data && response.data.length > 0) {
      response.data.forEach(stock => {
        if (stock.storeId === mskStoreId) {
          stocks.msk = stock.stock || 0;
        } else if (stock.storeId === spbStoreId) {
          stocks.spb = stock.stock || 0;
        }
      });
    }
    
    return stocks;
  } catch (error) {
    console.error('Error getting stocks:', error.response?.data || error.message);
    return { msk: 0, spb: 0 };
  }
}

// Функция изменения склада в заказе
async function changeOrderStore(orderId, storeId, token, apiUrl) {
  try {
    await axios.put(
      `${apiUrl}/entity/customerorder/${orderId}`,
      {
        store: {
          meta: {
            href: `${apiUrl}/entity/store/${storeId}`,
            type: 'store',
            mediaType: 'application/json'
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        }
      }
    );
    
    console.log(`Successfully changed store for order ${orderId}`);
    return true;
  } catch (error) {
    console.error('Error changing store:', error.response?.data || error.message);
    throw error;
  }
}
