// App Store Connect'te oluşturulacak TÜKETİLEBİLİR (consumable) IAP
// ürünleri. planMapping.js'deki abonelik ürünleriyle (pro.weekly/
// .monthly/.yearly) AYNI isimlendirme üslubu -- bunlar süresi
// DOLMAYAN, kullanıcının "bonusCredits" bakiyesine tek seferlik eklenen
// ekstra jetonlar. Abonelik jetonları (aiCreditsUsed/aiCreditsPeriod,
// periyodik sıfırlanan) ile KARIŞTIRILMAMALI -- iki ayrı havuz.
//
// DEĞİŞTİ (JETON SİSTEMİ x10 GÜNCELLEMESİ): miktarlar ve ürün ID'leri
// yeni jeton ölçeğine göre güncellendi (50/100/300/500 -> 500/1000/
// 3000/5000). Bu ürünler App Store Connect'te HENÜZ oluşturulmadı --
// eski (50/100/300/500) ID'lerle hiç karışıklık olmasın diye baştan
// yeni ID'lerle açılacak.
const PRODUCT_ID_TO_CREDITS = {
  "com.melodia.app.credits.500": 500,
  "com.melodia.app.credits.1000": 1000,
  "com.melodia.app.credits.3000": 3000,
  "com.melodia.app.credits.5000": 5000,
};

function creditsFromProductId(productId) {
  return PRODUCT_ID_TO_CREDITS[productId] || null;
}

module.exports = { PRODUCT_ID_TO_CREDITS, creditsFromProductId };
