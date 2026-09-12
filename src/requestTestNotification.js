const { getApiClient } = require("./appleIap");

// SADECE TEST AMAÇLI — App Store Server Notifications webhook'unu
// (appleNotifications.js) uçtan uca doğrulamak için Apple'a "bana bir
// test bildirimi gönder" isteği atar. Apple bunu alınca, kaydettiğimiz
// Sandbox Server URL'e (appleNotifications.js) GERÇEK İMZALI bir test
// payload'ı gönderir — CloudWatch'ta AppleNotificationsFunction
// loglarından sonucu görebiliriz.
//
// Webhook doğrulaması bittikten sonra bu dosyayı ve template.yaml'daki
// karşılığını SİLMEK güvenli/temiz — kalıcı bir uç nokta olması
// gerekmiyor, sadece bugünkü kurulum testi için.
exports.handler = async () => {
  try {
    const client = await getApiClient();
    const response = await client.requestTestNotification();
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Apple'a test bildirimi isteği gönderildi. Birkaç saniye içinde CloudWatch > AppleNotificationsFunction loglarına bak.",
        testNotificationToken: response.testNotificationToken,
      }),
    };
  } catch (err) {
    console.error(err);
    // Apple'ın kütüphanesi bazı hatalarda standart .message yerine
    // errorMessage/errorCode/httpStatusCode gibi kendi alanlarını
    // kullanıyor — hepsini birden döndürüp gerçek sebebi görelim.
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: err.message || null,
        errorMessage: err.errorMessage || null,
        errorCode: err.errorCode || null,
        httpStatusCode: err.httpStatusCode || null,
        name: err.name || null,
        raw: JSON.stringify(err, Object.getOwnPropertyNames(err)),
      }),
    };
  }
};