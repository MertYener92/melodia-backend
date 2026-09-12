// Müzik jeton havuzu — SADECE müzik (şarkı) üretimi için. Video artık bu
// havuzu KULLANMIYOR, kendi ayrı bir kredi bakiyesine (videoCreditsBalance,
// tek seferlik satın alınan, süresi dolmayan) geçti — bkz. melodia-video/
// src/createVideoProject.js.
//
// ÜÇ PLAN, İKİ FARKLI SIFIRLAMA DÖNGÜSÜ:
//  - pro_weekly:  25 jeton, HAFTALIK sıfırlanır
//  - pro_monthly: 120 jeton, AYLIK sıfırlanır
//  - pro_yearly:  120 jeton, AYLIK sıfırlanır (tıpkı pro_monthly gibi —
//    yıllık ödeme sadece FATURALAMA sıklığını değiştiriyor, jeton mantığı
//    pro_monthly ile birebir aynı; bu yüzden Apple'ın yıl içinde ekstra
//    bir "yenileme" bildirimi göndermesine gerek YOK, sıfırlama tamamen
//    bizim tarafımızda, tarihe bakarak, tembel (lazy) şekilde hesaplanıyor)
const AI_CREDIT_LIMITS = {
  free: Number.MAX_SAFE_INTEGER,
  pro_weekly: 25,
  pro_monthly: 120,
  pro_yearly: 120,
};

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
  if (plan === "pro_weekly") return isoWeekKey(now);
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

module.exports = { AI_CREDIT_LIMITS, limitForPlan, currentPeriodKey };