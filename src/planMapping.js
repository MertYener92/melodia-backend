// App Store Connect'te oluşturulan GERÇEK product ID'ler. "Basic" katmanı
// tamamen kaldırıldı, sadece Pro var (weekly/monthly/yearly — hepsi aynı
// özellikte, sadece faturalama sıklığı ve jeton miktarı farklı, bkz.
// creditPlans.js).
const PRODUCT_ID_TO_PLAN = {
  "com.melodia.app.pro.weekly": "pro_weekly",
  "com.melodia.app.pro.monthly": "pro_monthly",
  // DÜZELTME (SORUN 2754 #2): Flutter (subscription_service.dart) aylık
  // planı App Store'da yeniden oluşturulan "monthly2" ürünüyle satıyor --
  // bu eşleme yokken satın alma doğrulaması "Bilinmeyen ürün" ile düşüyor,
  // kullanıcı ödeme yaptığı halde Pro olamıyordu. Eski ID, varsa eski
  // abonelerin yenilemeleri için duruyor.
  "com.melodia.app.pro.monthly2": "pro_monthly",
  "com.melodia.app.pro.yearly": "pro_yearly",
};

function planFromProductId(productId) {
  return PRODUCT_ID_TO_PLAN[productId] || null;
}

module.exports = { PRODUCT_ID_TO_PLAN, planFromProductId };