// Müzik jeton havuzu — SADECE müzik (şarkı) üretimi için. Video artık bu
// havuzu KULLANMIYOR, kendi ayrı bir kredi bakiyesine (videoCreditsBalance,
// tek seferlik satın alınan, süresi dolmayan) geçti — bkz. melodia-video/
// src/createVideoProject.js.
//
// DEĞİŞTİ (JETON SİSTEMİ x10 GÜNCELLEMESİ): Önceden "1 credit = 1 şarkı"
// idi. Artık üretim maliyeti moda göre değişiyor (bkz. SONG_CREDIT_COST_BY_MODE
// aşağıda: Hızlı/Standart = 10 jeton, Gelişmiş = 20 jeton) ve plan
// limitleri buna göre x10 (ve biraz üstü) ölçeklendi.
//
// ÜÇ PLAN, İKİ FARKLI SIFIRLAMA DÖNGÜSÜ:
//  - pro_weekly:  250 jeton, HAFTALIK sıfırlanır
//  - pro_monthly: 1000 jeton, AYLIK sıfırlanır
//  - pro_yearly:  250 jeton, AYLIK sıfırlanır (tıpkı pro_monthly gibi —
//    yıllık ödeme sadece FATURALAMA sıklığını değiştiriyor; kullanıcı
//    App Store açıklamasında "3.000 Jeton/yıl" görüyor ama bu YILLIK
//    TOPLAM anlamına geliyor -- ay başına 3000÷12=250 jeton verilerek
//    12 ayda toplam 3000'e ulaşılıyor. DÜZELTME: önceden burada yanlışlıkla
//    3000 yazıyordu -- bu, aylık sıfırlanan bir dönemde HER AY 3000 (yılda
//    36.000) vermek anlamına gelirdi, ciddi bir aşırı-verme hatasıydı.)
const AI_CREDIT_LIMITS = {
  // DÜZELTME: Önceden Number.MAX_SAFE_INTEGER'dı -- yani abonesi
  // olmayan/süresi geçmiş kullanıcı pratikte SINIRSIZ şarkı üretebiliyordu.
  // Artık "free" gerçek bir ömür boyu TEK SEFERLİK deneme jetonu:
  // 20 jeton = Hızlı/Standart'ta 2 şarkı, Gelişmiş'te 1 şarkı. Bu
  // periyodik (haftalık/aylık) sıfırlanmıyor -- bkz. currentPeriodKey'deki
  // "lifetime" özel durumu.
  free: 20,
  pro_weekly: 250,
  pro_monthly: 1000,
  pro_yearly: 250,
};

// YENİ (JETON SİSTEMİ x10 GÜNCELLEMESİ): tek, global bir SONG_CREDIT_COST
// yerine, üretim moduna göre değişen maliyet. Suno bir generation'da 2
// şarkı döndürse bile maliyet GENERATION BAŞINA (yani job başına) TEK
// SEFER uygulanır -- 2 şarkı için ayrı ayrı düşülmez (bkz. generate.js).
// ÖNEMLİ: anahtarlar Flutter'ın library_mode_filter.dart'taki KENDİ mod
// string'leriyle (quick/standard/advanced) BİREBİR aynı olmalı -- "Hızlı"
// modun Flutter karşılığı 'fast' DEĞİL 'quick'.
const SONG_CREDIT_COST_BY_MODE = {
  quick: 10,
  standard: 10,
  advanced: 20,
  // YENİ (Remix): mevcut bir şarkının Suno "upload-cover" ile yeni bir
  // tarzda yeniden üretilmesi. Suno tarafında tam bir üretim olduğu için
  // maliyeti Standart ile aynı; daha ucuz olursa normal üretimi atlatmanın
  // yolu haline gelir. Bkz. generate.js (remixOf).
  remix: 10,
};

// Bilinmeyen/eksik bir mod gelirse (ör. istemcinin eski bir sürümü ya da
// mode hiç gönderilmezse) en düşük maliyete DEĞİL, en YAYGIN/güvenli
// varsayılana (standard) düşüyoruz -- bu, backend'in kazara ucuza
// üretim yapmasını önler.
function songCreditCostForMode(mode) {
  return SONG_CREDIT_COST_BY_MODE[mode] ?? SONG_CREDIT_COST_BY_MODE.standard;
}

function limitForPlan(plan) {
  return AI_CREDIT_LIMITS[plan] ?? AI_CREDIT_LIMITS.free;
}

// ISO hafta numarası (Pazartesi-Pazar), örn. "2026-W37". Kullanıcının
// kendi abonelik başlangıç gününe değil, takvim haftasına göre sıfırlanır
// — mevcut aylık sıfırlamanın (takvim ayına göre, abonelik gününe göre
// DEĞİL) aynı basitleştirmesi, tutarlılık için.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}

// Hangi "dönem" içindeyiz? Plan'a göre haftalık ya da aylık anahtar döner.
// Kullanıcının aiCreditsPeriod alanındaki değerle birebir string
// eşleşmezse (farklı dönem VEYA farklı plan formatı) kullanım otomatik
// olarak sıfırlanmış sayılır — bu yüzden plan değişince (ör. weekly'den
// monthly'ye geçince) elle bir "geçiş" kodu yazmaya gerek yok, doğal
// olarak temiz bir sayfa açılıyor.
function currentPeriodKey(plan, now = new Date()) {
  // DÜZELTME: "free" artık AYLIK sıfırlanan bir dönem DEĞİL -- sabit bir
  // "lifetime" anahtarı dönüyor, böylece tek seferlik 1 jeton kullanılınca
  // bir daha ASLA (ay değişse bile) yenilenmiyor. Kullanıcı Pro'ya
  // geçtiğinde plan değişeceği için (pro_weekly/monthly/yearly) bu dal
  // zaten devreye girmeyecek, doğal olarak temiz bir sayfa açılacak.
  if (plan === "free") return "lifetime";
  if (plan === "pro_weekly") return isoWeekKey(now);
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

module.exports = {
  AI_CREDIT_LIMITS,
  SONG_CREDIT_COST_BY_MODE,
  songCreditCostForMode,
  limitForPlan,
  currentPeriodKey,
};