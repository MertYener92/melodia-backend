// Suno API (sunoapi.org), /generate ve /lyrics isteklerinde zorunlu bir
// callBackUrl ister ve işlem bitince oraya bir POST atar. Biz sonucu zaten
// /status ve /lyrics-status ile polling yaparak aldığımız için bu isteğin
// içeriğiyle ilgilenmemize gerek yok — sadece 200 OK dönen geçerli bir
// adres olması yeterli. Auth: NONE, çünkü bu isteği Suno'nun sunucusu
// atıyor, giriş yapmış bir kullanıcı değil.
//
// NOT: Suno maliyeti (12 kredi/şarkı, ~$0.06) tek seferlik ölçümle zaten
// kesinleşti, bu yüzden burada artık canlı bakiye ölçümü yapmıyoruz —
// bu callback'i mümkün olduğunca hafif ve hızlı tutuyoruz.
exports.handler = async (event) => {
  try {
    console.log("Suno callback alındı:", event.body);
  } catch (err) {
    console.error("Callback log hatası:", err);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
};